import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { persistArtifact, persistProductContext, readProductContext, safeName } from "./artifacts.js";
import { diffTrees, isGitRepository, outsideWriteScope, snapshotTree } from "./git.js";
import { LinearClient } from "./linear.js";
import { loadLocalFixture } from "./local.js";
import { PiHarness } from "./pi-harness.js";
import { blockingReasons, dependencyArtifacts, dependencySteps, findNode, flattenSteps, normalizePlan } from "./plan.js";
import { JsonStore } from "./store.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, ensureTicketWorktree, repairZeroStateWorkspace } from "./worktrees.js";
import { actionableFindings, clearInactiveRuns, markRunCancelled, nextRunnableBatch } from "./execution.js";
import { normalizeStageProfiles } from "./profiles.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(here, "public");
const packageMetadata = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const initialCwd = option("--cwd", process.cwd());
const port = Number(option("--port", process.env.PORT || 4317));
const host = option("--host", process.env.HOST || "127.0.0.1");
const dataDir = process.env.AGENT_PLAN_DATA_DIR || join(homedir(), ".agent-plan-workspace");
const store = new JsonStore(join(dataDir, "state-v3.json"), initialCwd);
await store.init();

const linear = new LinearClient();
const harness = new PiHarness({ dataDir, publish });
const clients = new Set();
const activeSteps = new Map();
const activeTickets = new Map();
let ticketCache = new Map();

function publish(event) {
  const encoded = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(encoded);
}

function publishState(state = store.read()) { publish({ type: "state", state }); }

function publishStepEvent(ticketId, stepId, runId, event) {
  publish({ channel: "run", ticketId, stepId, runId, ...event });
  if (!["prompt", "phase", "tool_start", "tool_end", "agent_error"].includes(event.type)) return;
  update((state) => {
    const active = state.ticketRuns[ticketId]?.activeRuns?.[stepId];
    if (!active || active.runId !== runId) return;
    if (event.type === "prompt") active.prompt = event.content;
    active.lastEvent = event.label;
    active.lastEventAt = new Date().toISOString();
    active.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
  }, { publish: false }).catch(() => {});
}

function repositoryCheckReview(checks) {
  return {
    role: "deterministic",
    summary: checks.summary,
    findings: checks.status === "failed" ? [{
      severity: "blocking",
      category: "tests",
      claim: `Repository check failed: ${checks.command}`,
      evidence: [],
      suggestedFix: `Make ${checks.command} pass.\n\n${checks.output}`,
      confidence: "high"
    }] : [],
    checks
  };
}

async function update(change, { publish: shouldPublish = true } = {}) {
  const state = await store.update(change);
  if (shouldPublish) publishState(state);
  return state;
}

function startTicketWork(ticketId, work) {
  if (activeTickets.has(ticketId)) return activeTickets.get(ticketId).promise;
  const controller = new AbortController();
  const promise = Promise.resolve()
    .then(() => work(controller.signal))
    .finally(() => {
      if (activeTickets.get(ticketId)?.controller === controller) activeTickets.delete(ticketId);
    });
  activeTickets.set(ticketId, { controller, promise });
  return promise;
}

async function cancelTicket(ticketId) {
  const active = activeTickets.get(ticketId);
  if (!active) throw new Error("This run is not active");
  active.controller.abort(new Error("Run cancelled"));
  await active.promise.catch(() => {});
  await update((state) => {
    const run = ticketRun(state, ticketId);
    markRunCancelled(run);
  });
}

function ticketRun(state, ticketId) {
  const run = state.ticketRuns[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

function setStage(run, id, status, summary = "") {
  const stage = run.stages.find((item) => item.id === id);
  if (!stage) return;
  if (status === "active") {
    for (const other of run.stages) if (other.status === "active") other.status = "completed";
  }
  Object.assign(stage, { status, summary, updatedAt: new Date().toISOString() });
}

function initialStages() {
  return [
    ["requirements", "Clarify requirements"],
    ["explore", "Explore code"],
    ["design", "Design & plan"],
    ["implement", "Implement"],
    ["verify", "Review & verify"],
    ["handoff", "Handoff"]
  ].map(([id, title], index) => ({ id, title, status: index ? "pending" : "active", summary: "" }));
}

function localStages() {
  const stages = initialStages();
  for (const stage of stages.slice(0, 3)) Object.assign(stage, { status: "completed", summary: "Loaded from the local fixture" });
  return stages;
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request exceeds the 8 MB local limit");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function findForkSession(plan, step) {
  return [...dependencySteps(plan, step)].reverse().find((dependency) => dependency.sessionFile)?.sessionFile || null;
}

async function loadLocalRun(inputPath) {
  const currentState = store.read();
  const source = currentState.workspace.cwd;
  const stageProfiles = currentState.stageProfiles;
  const fixture = await loadLocalFixture(source, inputPath);
  const runId = randomUUID();
  const slug = safeName(fixture.plan.title).slice(0, 32);
  const id = `local-${slug}-${runId.slice(0, 8)}`;
  const ticket = {
    id,
    identifier: `LOCAL-${slug}`,
    title: fixture.plan.title,
    description: fixture.plan.summary || fixture.feature.split("\n").find((line) => line.trim() && !line.startsWith("#")) || "Local zero-state fixture",
    source: "local",
    fixturePath: fixture.directory,
    state: { name: "Local fixture", type: "local", color: "#8b7cf6" },
    team: { name: "Local" }
  };
  const artifacts = await Promise.all([
    persistArtifact(dataDir, ticket, { runId, name: "feature.md", content: fixture.feature, stageId: "requirements", kind: "feature-brief" }),
    persistArtifact(dataDir, ticket, { runId, name: "plan.json", content: fixture.planSource, stageId: "design", kind: "plan-source" }),
    persistArtifact(dataDir, ticket, {
      runId, name: "run-manifest.json", stageId: "design", kind: "run-manifest",
      content: JSON.stringify({
        frameworkVersion: packageMetadata.version,
        piDependency: packageMetadata.dependencies["@earendil-works/pi-coding-agent"],
        nodeVersion: process.version,
        stageProfiles,
        baselineTree: null,
        featureSha256: createHash("sha256").update(fixture.feature).digest("hex"),
        planSha256: createHash("sha256").update(fixture.planSource).digest("hex")
      }, null, 2)
    })
  ]);
  const state = await update((draft) => {
    draft.selectedTicketId = id;
    draft.ticketRuns[id] = {
      id, runId, ticket, workspace: null, baselineTree: null, status: "awaiting_approval",
      stages: localStages(), checkpoint: {
        id: randomUUID(), kind: "awaiting_approval", title: "Approve local execution plan",
        prompt: fixture.feature, createdAt: new Date().toISOString()
      },
      plan: fixture.plan, stageProfiles, artifacts, activeRuns: {}, auto: false, sessionFile: null, lastError: null,
      createdAt: new Date().toISOString()
    };
  });
  return { ticketId: id, state };
}

async function prepareTicket(ticketId) {
  return startTicketWork(ticketId, async (signal) => {
   try {
    signal.throwIfAborted();
    const before = store.read();
    const run = ticketRun(before, ticketId);
    const productContext = await readProductContext(dataDir, before.workspace.cwd);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.status = "clarifying";
      setStage(current, "requirements", "active", "Pi is shaping requirements without repository access");
    });
    const clarified = await harness.clarifyRequirements({ cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, productContext: productContext.content, profile: run.stageProfiles.requirements, signal });
    signal.throwIfAborted();
    const contextSnapshot = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "product-context-snapshot.md", content: productContext.content,
      stageId: "requirements", kind: "product-context-snapshot"
    });
    const artifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "requirements-draft.md", content: clarified.artifact,
      stageId: "requirements", kind: "requirements-draft"
    });
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.requirementsSessionFile = clarified.sessionFile;
      current.artifacts.push(contextSnapshot, artifact);
      current.status = "awaiting_requirements";
      setStage(current, "requirements", "blocked", "Requirement approval needed before repository access");
      current.checkpoint = {
        id: randomUUID(), kind: "requirements_review", title: "Approve ticket requirements",
        prompt: clarified.artifact, questions: clarified.questions, createdAt: new Date().toISOString()
      };
    });
  } catch (error) {
    if (signal.aborted) return;
    await update((state) => {
      const current = state.ticketRuns[ticketId];
      if (current) { current.status = "failed"; current.lastError = error.message; }
    });
   }
  });
}

async function continueAfterRequirements(ticketId, answers) {
  return startTicketWork(ticketId, async (signal) => {
   try {
    signal.throwIfAborted();
    const before = store.read();
    const run = ticketRun(before, ticketId);
    const draft = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements-draft");
    const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
    if (!draft || !productContext) throw new Error("Requirements draft or product context snapshot not found");
    const requirements = `${draft.content}\n\n## User clarification\n${answers || "Approved without changes."}`;
    const requirementArtifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "requirements.md", content: requirements,
      stageId: "requirements", kind: "requirements"
    });
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.artifacts.push(requirementArtifact);
      current.checkpoint = null;
      current.status = "preparing";
      setStage(current, "requirements", "completed", "Approved requirements persisted");
      setStage(current, "explore", "active", "Preparing isolated repository exploration");
    });
    const workspace = await ensureTicketWorktree({
      sourceCwd: before.workspace.cwd, dataDir, ticket: run.ticket, runId: run.runId
    });
    const baselineTree = await snapshotTree(workspace.cwd);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.workspace = workspace;
      current.baselineTree = baselineTree;
      current.status = "exploring";
      setStage(current, "explore", "active", "Pi is mapping relevant code and tests");
    });
    const explored = await harness.exploreTicket({
      cwd: workspace.cwd, ticket: run.ticket, sessionFile: null, runId: run.runId,
      productContext: productContext.content, requirements, profile: run.stageProfiles.exploration, signal
    });
    signal.throwIfAborted();
    const explorationArtifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "implementation-delta.md", content: explored.artifact,
      stageId: "explore", kind: "implementation-delta"
    });
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.sessionFile = explored.sessionFile;
      current.artifacts.push(explorationArtifact);
      setStage(current, "explore", explored.questions.length ? "blocked" : "completed", explored.questions.length ? "Technical decision required" : "Repository map persisted");
      if (explored.questions.length) {
        current.status = "awaiting_input";
        current.checkpoint = {
          id: randomUUID(), kind: "technical_input", title: "Resolve technical exception",
          questions: explored.questions, createdAt: new Date().toISOString()
        };
      }
    });
    if (!explored.questions.length) await designTicket(ticketId, "No technical exceptions were raised.", signal);
  } catch (error) {
    if (signal.aborted) return;
    await update((state) => {
      const current = state.ticketRuns[ticketId];
      if (current) { current.status = "failed"; current.lastError = error.message; }
    });
   }
  });
}

async function designTicket(ticketId, answers, signal) {
  signal?.throwIfAborted();
  const state = store.read();
  const run = ticketRun(state, ticketId);
  const requirements = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements");
  const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
  const exploration = [...run.artifacts].reverse().find((artifact) => artifact.kind === "implementation-delta");
  if (!requirements || !productContext || !exploration) throw new Error("Approved requirements, product context, and implementation delta are required before design");
  await update((draft) => {
    const current = ticketRun(draft, ticketId);
    current.checkpoint = null;
    current.status = "planning";
    setStage(current, "explore", "completed", "Repository map and technical decisions persisted");
    setStage(current, "design", "active", "Pi is choosing an approach and executable steps");
  });
  try {
    const result = await harness.designTicket({
      cwd: run.workspace.cwd, ticket: run.ticket, sessionFile: run.sessionFile, runId: run.runId,
      productContext: productContext.content, requirements: requirements.content, exploration: exploration.content, answers,
      profile: run.stageProfiles.architecture, signal
    });
    signal?.throwIfAborted();
    const artifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "design.md", content: result.artifact, stageId: "design", kind: "architecture"
    });
    await update((draft) => {
      const current = ticketRun(draft, ticketId);
      current.sessionFile = result.sessionFile;
      current.plan = result.plan;
      current.artifacts.push(artifact);
      current.status = "awaiting_approval";
      setStage(current, "design", "blocked", "Plan ready for approval");
      current.checkpoint = { id: randomUUID(), kind: "awaiting_approval", title: "Approve implementation plan", prompt: result.artifact, createdAt: new Date().toISOString() };
    });
  } catch (error) {
    if (signal?.aborted) return;
    await update((draft) => {
      const current = ticketRun(draft, ticketId);
      current.status = "failed";
      current.lastError = error.message;
      setStage(current, "design", "blocked", error.message);
    });
  }
}

async function executeStep(ticketId, stepId, { feedback = "", signal } = {}) {
  const key = `${ticketId}:${stepId}`;
  if (activeSteps.has(key)) return activeSteps.get(key);
  const work = (async () => {
    signal?.throwIfAborted();
    const beforeState = store.read();
    const run = ticketRun(beforeState, ticketId);
    const step = findNode(run.plan, stepId);
    const correction = Boolean(feedback);
    if (!step || (!correction && blockingReasons(run.plan, step).length) || (!correction && !["ready", "interrupted"].includes(step.status))) return;
    try {
      const stepCwd = step.workspace?.cwd || run.workspace.cwd;
      const beforeTree = await snapshotTree(stepCwd);
      const stepBaseTree = step.baseTree || beforeTree;
      await update((state) => {
        const target = findNode(ticketRun(state, ticketId).plan, stepId);
        target.baseTree ||= stepBaseTree;
      });
      let nextFeedback = feedback;
      if (!nextFeedback && step.status === "interrupted") {
        const findings = actionableFindings([step.attempts?.at(-1)?.verification || {}]);
        if (findings.length) nextFeedback = `Resume the interrupted correction for these verified issues:\n\n${JSON.stringify(findings, null, 2)}`;
      }
      for (let round = 1; ; round++) {
        signal?.throwIfAborted();
        const latest = ticketRun(store.read(), ticketId);
        const currentStep = findNode(latest.plan, stepId);
        const workerRunId = randomUUID();
        const startedAt = new Date().toISOString();
        const attemptId = `attempt-${(currentStep.attempts?.length || 0) + 1}`;
        const contextArtifacts = [
          ...latest.artifacts.filter((artifact) => ["feature-brief", "architecture"].includes(artifact.kind)),
          ...dependencyArtifacts(latest.plan, currentStep)
        ];
        await update((state) => {
          const current = ticketRun(state, ticketId);
          const target = findNode(current.plan, stepId);
          target.status = nextFeedback ? "fixing" : "running";
          target.lastError = null;
          current.status = target.status;
          current.activeRuns[stepId] = { runId: workerRunId, startedAt, lastEventAt: startedAt, lastEvent: nextFeedback ? "Starting focused fix" : "Starting Pi worker", warning: false };
          setStage(current, "implement", "active", `${nextFeedback ? "Fixing" : "Implementing"} ${target.title}`);
        });
        const cwd = currentStep.workspace?.cwd || latest.workspace.cwd;
        const result = await harness.runStep({
          cwd, plan: latest.plan, step: currentStep, artifacts: contextArtifacts, images: [],
          forkSessionFile: nextFeedback ? null : findForkSession(latest.plan, currentStep), resumeSessionFile: null,
          feedback: nextFeedback, ticketId, runId: latest.runId,
          profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation,
          onEvent: (event) => publishStepEvent(ticketId, stepId, workerRunId, event),
          signal
        });
        signal?.throwIfAborted();
        let checks = { status: "skipped", command: null, summary: "No repository changes require a deterministic check.", output: "" };
        if (currentStep.permission === "write" && result.report.status === "completed") {
          publishStepEvent(ticketId, stepId, workerRunId, { type: "phase", label: "Running repository checks" });
          checks = await harness.runRepositoryChecks({ cwd, signal });
        }
        signal?.throwIfAborted();
        const afterTree = await snapshotTree(cwd);
        const diff = await diffTrees(cwd, stepBaseTree, afterTree);
        const violations = currentStep.permission !== "write" ? diff.files : outsideWriteScope(diff.files, currentStep.writeScope);
        const artifactInput = { runId: latest.runId, stageId: "implement", stepId, attemptId };
        const artifacts = [
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: currentStep.expectedArtifacts[0] || `${currentStep.id}-result.md`, content: result.output, kind: "agent-output" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "prompt.md", content: result.prompt, kind: "agent-prompt" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "context.json", content: JSON.stringify({ profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation, contextPolicy: currentStep.contextPolicy, permission: currentStep.permission, writeScope: currentStep.writeScope, skills: currentStep.skills, references: currentStep.references, requirementIds: currentStep.requirementIds, capabilityIds: currentStep.capabilityIds, deltaIds: currentStep.deltaIds, productContext: currentStep.productContext, artifacts: contextArtifacts.map(({ id, name, path }) => ({ id, name, path })) }, null, 2), kind: "context-manifest" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "diff.patch", content: diff.patch, kind: "git-diff" })
        ];
        if (violations.length || result.report.status !== "completed") {
          const error = violations.length ? `Changes outside permission or write scope: ${violations.join(", ")}` : (result.report.request || result.report.summary);
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = "needs_attention";
            target.diff = diff;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            target.lastError = error;
            target.attempts.push({ runId: workerRunId, attemptId, startedAt, completedAt: new Date().toISOString(), status: "needs_attention", events: result.events, rawOutput: result.rawOutput, violations, feedback: nextFeedback || null });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            current.status = "needs_attention";
            setStage(current, "implement", "blocked", error);
          });
          return;
        }
        await update((state) => {
          const current = ticketRun(state, ticketId);
          current.status = "verifying";
          current.activeRuns[stepId].lastEvent = `Fresh verification round ${round}`;
          current.activeRuns[stepId].lastEventAt = new Date().toISOString();
          current.activeRuns[stepId].warning = false;
          setStage(current, "implement", "active", `Fresh verification: ${currentStep.title}`);
        });
        const design = [...latest.artifacts].reverse().find((artifact) => artifact.kind === "architecture")?.content || "";
        publishStepEvent(ticketId, stepId, workerRunId, { type: "phase", label: `Verifying ${currentStep.title}` });
        const deterministicReview = repositoryCheckReview(checks);
        const verification = deterministicReview.findings.length ? {
          summary: deterministicReview.summary,
          findings: deterministicReview.findings,
          rawOutput: checks.output,
          sessionFile: null,
          checks
        } : {
          ...(await harness.verifyStep({
            cwd, ticket: latest.ticket, plan: latest.plan, step: currentStep,
            design, diff, output: result.output, runId: latest.runId, round,
            profile: latest.stageProfiles.verification,
            onEvent: (event) => publishStepEvent(ticketId, stepId, workerRunId, event),
            signal
          })),
          checks
        };
        signal?.throwIfAborted();
        const verificationArtifact = await persistArtifact(dataDir, latest.ticket, {
          runId: latest.runId, stageId: "verify", stepId, attemptId, name: "verification.json",
          content: JSON.stringify(verification, null, 2), kind: "step-verification"
        });
        const findings = actionableFindings([verification]);
        let commitMessage = null;
        if (!findings.length) {
          publishStepEvent(ticketId, stepId, workerRunId, { type: "phase", label: "Drafting the requirement-linked commit" });
          commitMessage = await harness.generateCommitMessage({
            cwd, ticket: latest.ticket, step: currentStep, diff, runId: latest.runId,
            profile: latest.stageProfiles.commit, signal
          });
        }
        await update((state) => {
          const current = ticketRun(state, ticketId);
          const target = findNode(current.plan, stepId);
          target.diff = diff;
          target.sessionFile = result.sessionFile;
          target.artifacts = [artifacts[0], verificationArtifact];
          target.attempts.push({ runId: workerRunId, attemptId, startedAt, completedAt: new Date().toISOString(), status: findings.length ? "verification_failed" : "verified", events: result.events, rawOutput: result.rawOutput, violations, feedback: nextFeedback || null, verification });
          current.artifacts.push(...artifacts, verificationArtifact);
          delete current.activeRuns[stepId];
        });
        if (!findings.length) {
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = "review_ready";
            target.commitMessage = commitMessage;
            current.status = "awaiting_step_review";
            current.checkpoint = { id: randomUUID(), kind: "step_review", stepId, title: `Review: ${target.title}`, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", `${target.title} is verified and awaiting your review`);
          });
          return;
        }
        nextFeedback = `Fresh verification found these actionable issues. Fix them with the smallest focused change, then run deterministic checks:\n\n${JSON.stringify(findings, null, 2)}`;
      }
    } catch (error) {
      if (signal?.aborted) return;
      await update((state) => {
        const current = ticketRun(state, ticketId);
        const failed = findNode(current.plan, stepId);
        failed.status = "failed";
        failed.lastError = error.message;
        delete current.activeRuns[stepId];
        current.status = "needs_attention";
        setStage(current, "implement", "blocked", error.message);
      });
    }
  })().finally(() => activeSteps.delete(key));
  activeSteps.set(key, work);
  return work;
}

async function finalReviewLoop(ticketId, signal) {
  signal?.throwIfAborted();
  await update((state) => {
    const run = ticketRun(state, ticketId);
    setStage(run, "implement", "completed", `${flattenSteps(run.plan).length} implementation slices accepted`);
    setStage(run, "verify", "active", "Independent reviewers are inspecting the combined implementation");
    run.status = "reviewing";
    run.checkpoint = null;
    run.reviews ||= [];
  });
  for (let round = 1; ; round++) {
    signal?.throwIfAborted();
    const current = ticketRun(store.read(), ticketId);
    const checks = await harness.runRepositoryChecks({ cwd: current.workspace.cwd, signal });
    signal?.throwIfAborted();
    const afterTree = await snapshotTree(current.workspace.cwd);
    const diff = await diffTrees(current.workspace.cwd, current.baselineTree, afterTree);
    const reviews = [repositoryCheckReview(checks), ...await Promise.all(["requirements", "integration", "verification"].map((role) => harness.reviewTicket({
      cwd: current.workspace.cwd,
      ticket: current.ticket,
      plan: current.plan,
      artifacts: current.artifacts,
      diff,
      role,
      round,
      runId: current.runId,
      profile: current.stageProfiles.verification,
      signal
    })))];
    signal?.throwIfAborted();
    const persisted = [];
    for (const review of reviews) {
      persisted.push(await persistArtifact(dataDir, current.ticket, {
        runId: current.runId,
        name: `${review.role}.json`,
        content: JSON.stringify(review, null, 2),
        stageId: `review-round-${round}`,
        kind: "independent-review"
      }));
    }
    const findings = actionableFindings(reviews);
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.artifacts.push(...persisted);
      run.reviews.push({ round, reviews, actionableFindings: findings, diff, createdAt: new Date().toISOString() });
    });
    if (!findings.length) {
      await commitWorkspace(current.workspace.cwd, `fix: resolve independent review findings\n\nWhy: The accepted ticket must pass the final combined review.\nRequirement: ${flattenSteps(current.plan).flatMap((step) => step.requirementIds).filter((id, index, all) => all.indexOf(id) === index).join(", ") || "Complete every approved ticket requirement"}`);
      if (current.ticket.source === "local") {
        const handoff = await persistArtifact(dataDir, current.ticket, {
          runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
          content: `# ${current.ticket.identifier} handoff\n\nCompleted ${flattenSteps(current.plan).length} accepted tickets from a zero-state repository.\n\nRepository: \`${current.workspace.cwd}\`\n\nBranch: \`${current.workspace.branch}\`.\n\n${diff.stat || "No changed files."}`
        });
        await update((state) => {
          const run = ticketRun(state, ticketId);
          run.artifacts.push(handoff);
          setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`);
          setStage(run, "handoff", "completed", `Zero-state app ready on ${run.workspace.branch}`);
          run.status = "completed";
          run.checkpoint = null;
          run.completedAt = new Date().toISOString();
        });
        return;
      }
      const currentContext = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot")?.content || "";
      const contextContent = await harness.updateProductContext({
        cwd: current.workspace.cwd, ticket: current.ticket, currentContext,
        artifacts: current.artifacts.filter((artifact) => ["requirements", "implementation-delta", "architecture", "agent-output", "step-verification"].includes(artifact.kind)),
        diff, runId: current.runId, profile: current.stageProfiles.handoff, signal
      });
      signal?.throwIfAborted();
      if (!contextContent.trim()) throw new Error("Product context update was empty");
      const contextArtifact = await persistArtifact(dataDir, current.ticket, {
        runId: current.runId, name: "product-context-update.md", content: contextContent,
        stageId: "handoff", kind: "product-context-update"
      });
      await update((state) => {
        const run = ticketRun(state, ticketId);
        run.artifacts.push(contextArtifact);
        setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`);
        setStage(run, "handoff", "blocked", "Approve the living product-context update");
        run.status = "awaiting_product_context";
        run.checkpoint = {
          id: randomUUID(), kind: "product_context_review", title: "Approve living product context",
          prompt: contextContent, createdAt: new Date().toISOString()
        };
      });
      return;
    }
    const fixStep = {
      id: `review-fix-${round}`,
      title: `Fix final review findings — round ${round}`,
      prompt: `Correct these independently verified actionable findings:\n\n${JSON.stringify(findings, null, 2)}\n\nKeep the fix focused. Add or update regression coverage where practical and run the relevant deterministic checks.`,
      contextPolicy: "seeded", harness: "pi", agentId: `review-fixer:round-${round}`,
      permission: "write", writeScope: "**", skills: [], references: [],
      expectedArtifacts: [`review-fixes-round-${round}.md`],
      acceptanceCriteria: findings.map((finding) => finding.claim), dependsOn: [], required: true,
      status: "ready", attempts: [], artifacts: [], attachments: [], diff: null, sessionFile: null, lastError: null
    };
    const beforeFix = await snapshotTree(current.workspace.cwd);
    const result = await harness.runStep({
      cwd: current.workspace.cwd, plan: current.plan, step: fixStep, artifacts: current.artifacts,
      images: [], forkSessionFile: null, resumeSessionFile: null, feedback: "", ticketId, runId: current.runId,
      profile: current.stageProfiles.implementation,
      onEvent: (event) => publish({ channel: "review", ticketId, round, ...event }),
      signal
    });
    signal?.throwIfAborted();
    if (result.report.status !== "completed") {
      await update((state) => {
        const run = ticketRun(state, ticketId);
        setStage(run, "verify", "blocked", result.report.request || result.report.summary || "Review fixer needs attention");
        run.status = "needs_attention";
        run.checkpoint = { id: randomUUID(), kind: "review_blocked", title: "Review fixer needs attention", findings, createdAt: new Date().toISOString() };
      });
      return;
    }
    const afterFix = await snapshotTree(current.workspace.cwd);
    const fixDiff = await diffTrees(current.workspace.cwd, beforeFix, afterFix);
    const fixArtifact = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: fixStep.expectedArtifacts[0], content: result.output, stageId: `review-round-${round}`, kind: "review-fix"
    });
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.artifacts.push(fixArtifact);
      run.reviews.at(-1).fix = { report: result.report, diff: fixDiff, artifact: fixArtifact };
      setStage(run, "verify", "active", `Review round ${round + 1} follows focused fixes`);
    });
  }
}

async function finishHandoff(ticketId) {
  const current = ticketRun(store.read(), ticketId);
  if (current.checkpoint?.kind !== "product_context_review") throw new Error("No product-context update is awaiting approval");
  const proposal = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-update");
  if (!proposal) throw new Error("Product-context proposal not found");
  const productContext = await persistProductContext(dataDir, current.workspace.sourceCwd, proposal.content);
  const handoff = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
    content: `# ${current.ticket.identifier} handoff\n\nCompleted ${flattenSteps(current.plan).length} accepted implementation slices.\n\nBranch: \`${current.workspace.branch}\`\n\nLiving product context: \`${productContext.path}\`.`
  });
  await update((state) => {
    const run = ticketRun(state, ticketId);
    run.productContextPath = productContext.path;
    run.artifacts.push(handoff);
    run.checkpoint = null;
    setStage(run, "handoff", "completed", `Changes ready on ${run.workspace.branch}`);
    run.status = "completed";
    run.completedAt = new Date().toISOString();
  });
}

async function ensureLocalWorkspace(ticketId) {
  const before = store.read();
  const previous = ticketRun(before, ticketId);
  if (previous.ticket.source !== "local" || (previous.workspace?.cwd === before.workspace.cwd && await isGitRepository(previous.workspace.cwd))) return previous;
  const { workspace, recovered } = await repairZeroStateWorkspace({ cwd: before.workspace.cwd, ticket: previous.ticket, runId: previous.runId, previousCwd: previous.workspace?.cwd });
  await update((state) => {
    const run = ticketRun(state, ticketId);
    run.workspace = workspace;
    run.baselineTree = workspace.baselineTree;
    run.lastError = null;
    for (const step of flattenSteps(run.plan)) {
      if (!recovered && step.status === "accepted") step.status = "ready";
      if (step.status !== "accepted") {
        if (!["ready", "interrupted"].includes(step.status)) step.status = "interrupted";
        delete step.workspace;
        delete step.baseTree;
      }
    }
  });
  return ticketRun(store.read(), ticketId);
}

async function acceptStep(ticketId, stepId) {
  const current = ticketRun(store.read(), ticketId);
  const step = findNode(current.plan, stepId);
  if (!step || step.status !== "review_ready") throw new Error("This step is not ready for review");
  const message = step.commitMessage || `feat: ${step.title}\n\nWhy: ${step.description || step.title}\nRequirement: ${step.requirementIds.join(", ") || step.acceptanceCriteria.join("; ") || "Complete the approved execution-plan slice"}`;
  let commit;
  if (step.workspace?.isolated) {
    let workspaceCommit = step.workspaceCommit;
    if (!workspaceCommit) {
      workspaceCommit = await commitWorkspace(step.workspace.cwd, message);
      await update((state) => { findNode(ticketRun(state, ticketId).plan, stepId).workspaceCommit = workspaceCommit; });
    }
    if (workspaceCommit) commit = await cherryPickCommit(current.workspace.cwd, workspaceCommit);
  } else {
    commit = await commitWorkspace(current.workspace.cwd, message);
  }
  await update((state) => {
    const run = ticketRun(state, ticketId);
    const accepted = findNode(run.plan, stepId);
    accepted.status = "accepted";
    accepted.acceptedAt = new Date().toISOString();
    if (commit) accepted.commit = commit;
    run.status = "running";
    run.checkpoint = null;
  });
}

async function advanceTicket(ticketId, signal) {
  signal?.throwIfAborted();
  const run = await ensureLocalWorkspace(ticketId);
  const reviews = flattenSteps(run.plan).filter((step) => step.status === "review_ready");
  if (reviews.length) {
    if (!run.auto) return;
    for (const step of reviews) await acceptStep(ticketId, step.id);
    return advanceTicket(ticketId, signal);
  }
  const batch = nextRunnableBatch(run.plan);
  if (batch.length) {
    if (batch.length > 1) {
      const tree = await snapshotTree(run.workspace.cwd);
      const workspaces = await createParallelWorktrees({
        sourceCwd: run.workspace.cwd, dataDir, ticket: run.ticket, runId: run.runId, steps: batch, tree
      });
      await update((state) => {
        const current = ticketRun(state, ticketId);
        for (const [stepId, workspace] of workspaces) Object.assign(findNode(current.plan, stepId), { workspace, baseTree: tree });
      });
    }
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.status = "running";
      current.checkpoint = null;
      setStage(current, "implement", "active", batch.length > 1 ? `Running ${batch.length} tickets in parallel` : `Running ${batch[0].title}`);
    });
    await Promise.all(batch.map((step) => executeStep(ticketId, step.id, { signal })));
    if (ticketRun(store.read(), ticketId).auto) return advanceTicket(ticketId, signal);
    return;
  }
  if (flattenSteps(run.plan).every((step) => step.status === "accepted")) await finalReviewLoop(ticketId, signal);
}

async function runTicket(ticketId) {
  return startTicketWork(ticketId, async (signal) => {
    try {
      signal.throwIfAborted();
      await ensureLocalWorkspace(ticketId);
      await update((state) => {
        const run = ticketRun(state, ticketId);
        run.status = "running";
        run.checkpoint = null;
        setStage(run, "design", "completed", "Plan approved");
        setStage(run, "implement", "active", "Executing dependency-ready steps");
      });
      await advanceTicket(ticketId, signal);
    } catch (error) {
      if (signal.aborted) return;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (!run) return;
        run.status = "needs_attention";
        run.lastError = error.message;
        const activeStage = run.stages.find((stage) => stage.status === "active");
        if (activeStage) { activeStage.status = "blocked"; activeStage.summary = error.message; }
      });
    }
  });
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, store.read());
  if (request.method === "POST" && url.pathname === "/api/queue/clear") {
    let cleared = 0;
    const state = await update((draft) => { cleared = clearInactiveRuns(draft, new Set(activeTickets.keys())); });
    return json(response, 200, { cleared, state });
  }
  const sessionTrace = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/session-trace$/);
  if (request.method === "GET" && sessionTrace) {
    const run = ticketRun(store.read(), decodeURIComponent(sessionTrace[1]));
    const step = findNode(run.plan, decodeURIComponent(sessionTrace[2]));
    if (!step) throw new Error("Step not found");
    return json(response, 200, await harness.sessionTrace(step.sessionFile));
  }
  if (request.method === "POST" && url.pathname === "/api/stage-profiles") {
    const profiles = normalizeStageProfiles((await body(request)).profiles);
    await harness.validateProfiles(profiles);
    const state = await update((draft) => { draft.stageProfiles = profiles; });
    return json(response, 200, state);
  }
  if (request.method === "GET" && url.pathname === "/api/tickets") {
    const result = await linear.tickets();
    ticketCache = new Map(result.tickets.map((ticket) => [ticket.id, ticket]));
    return json(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/linear/connect") {
    const input = await body(request);
    linear.apiKey = String(input.apiKey || "").trim();
    const result = await linear.tickets();
    ticketCache = new Map(result.tickets.map((ticket) => [ticket.id, ticket]));
    return json(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ type: "state", state: store.read() })}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workspace") {
    const input = await body(request);
    const cwd = normalize(String(input.cwd || ""));
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Workspace must be an existing absolute directory");
    const state = await update((draft) => { draft.workspace = { cwd }; });
    return json(response, 200, state);
  }
  if (request.method === "POST" && url.pathname === "/api/local/load") {
    const input = await body(request);
    return json(response, 201, await loadLocalRun(String(input.path || "fixtures/zero-state-task-board")));
  }

  const start = url.pathname.match(/^\/api\/tickets\/([^/]+)\/start$/);
  if (request.method === "POST" && start) {
    const id = decodeURIComponent(start[1]);
    if (activeTickets.size >= 2 && !activeTickets.has(id)) throw new Error("Two tickets are already active; wait for one to reach a checkpoint");
    const input = await body(request);
    const ticket = ticketCache.get(id) || input.ticket;
    if (!ticket?.id) throw new Error("Refresh Linear and select a ticket first");
    await update((state) => {
      state.selectedTicketId = id;
      if (!state.ticketRuns[id] || ["completed", "failed", "needs_attention"].includes(state.ticketRuns[id].status)) state.ticketRuns[id] = {
        id,
        runId: randomUUID(),
        ticket,
        status: "preparing",
        workspace: null,
        stageProfiles: structuredClone(state.stageProfiles),
        stages: initialStages(),
        checkpoint: null,
        plan: null,
        artifacts: [],
        activeRuns: {},
        sessionFile: null,
        auto: false,
        lastError: null,
        createdAt: new Date().toISOString()
      };
    });
    prepareTicket(id).catch(() => {});
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const select = url.pathname.match(/^\/api\/tickets\/([^/]+)\/select$/);
  if (request.method === "POST" && select) {
    const id = decodeURIComponent(select[1]);
    const state = await update((draft) => { draft.selectedTicketId = id; });
    return json(response, 200, state);
  }

  const resume = url.pathname.match(/^\/api\/tickets\/([^/]+)\/resume$/);
  if (request.method === "POST" && resume) {
    const id = decodeURIComponent(resume[1]);
    const run = ticketRun(store.read(), id);
    if (!["interrupted", "cancelled", "needs_attention"].includes(run.status) || !run.plan) throw new Error("This run cannot be resumed from its current stage");
    if (activeTickets.size >= 2 && !activeTickets.has(id)) throw new Error("Two tickets are already active; wait for one to reach a checkpoint");
    if (run.status === "cancelled") await update((state) => {
      const current = ticketRun(state, id);
      current.status = "interrupted";
      for (const step of flattenSteps(current.plan)) if (step.status === "cancelled") step.status = "interrupted";
    });
    runTicket(id).catch(() => {});
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const cancel = url.pathname.match(/^\/api\/tickets\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancel) {
    const id = decodeURIComponent(cancel[1]);
    await cancelTicket(id);
    return json(response, 200, { cancelled: true, ticketId: id });
  }

  const clarify = url.pathname.match(/^\/api\/tickets\/([^/]+)\/clarify$/);
  if (request.method === "POST" && clarify) {
    const id = decodeURIComponent(clarify[1]);
    const input = await body(request);
    const run = ticketRun(store.read(), id);
    const answers = String(input.answers || "");
    if (run.checkpoint?.kind === "requirements_review") continueAfterRequirements(id, answers).catch(() => {});
    else startTicketWork(id, (signal) => designTicket(id, answers, signal)).catch(() => {});
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const approve = url.pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/);
  if (request.method === "POST" && approve) {
    const id = decodeURIComponent(approve[1]);
    if (activeTickets.size >= 2 && !activeTickets.has(id)) throw new Error("Two tickets are already running");
    const run = ticketRun(store.read(), id);
    if (run.status !== "awaiting_approval" || !run.plan) throw new Error("This ticket has no plan awaiting approval");
    const input = await body(request);
    await update((state) => { ticketRun(state, id).auto = Boolean(input.auto); });
    runTicket(id).catch(() => {});
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const approveContext = url.pathname.match(/^\/api\/tickets\/([^/]+)\/context\/approve$/);
  if (request.method === "POST" && approveContext) {
    const id = decodeURIComponent(approveContext[1]);
    await finishHandoff(id);
    return json(response, 200, { accepted: true, ticketId: id });
  }

  const stepDecision = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/(accept|changes)$/);
  if (request.method === "POST" && stepDecision) {
    const [, encodedTicketId, encodedStepId, decision] = stepDecision;
    const ticketId = decodeURIComponent(encodedTicketId);
    const stepId = decodeURIComponent(encodedStepId);
    const input = await body(request);
    const current = ticketRun(store.read(), ticketId);
    const step = findNode(current.plan, stepId);
    if (!step || step.status !== "review_ready") throw new Error("This step is not ready for review");
    if (decision === "changes") {
      const feedback = String(input.feedback || "").trim();
      if (!feedback) throw new Error("Describe the changes you want");
      await update((state) => {
        const run = ticketRun(state, ticketId);
        delete findNode(run.plan, stepId).workspaceCommit;
        run.status = "running";
        run.checkpoint = null;
        setStage(run, "implement", "active", `Revising ${step.title}`);
      });
      startTicketWork(ticketId, (signal) => executeStep(ticketId, stepId, { feedback, signal })).catch(() => {});
      return json(response, 202, { accepted: true, ticketId, stepId });
    }
    await acceptStep(ticketId, stepId);
    startTicketWork(ticketId, async (signal) => {
      try { await advanceTicket(ticketId, signal); }
      catch (error) {
        if (signal.aborted) return;
        await update((state) => {
          const run = ticketRun(state, ticketId);
          run.status = "needs_attention";
          run.lastError = error.message;
        });
      }
    }).catch(() => {});
    return json(response, 202, { accepted: true, ticketId, stepId });
  }

  json(response, 404, { error: "Not found" });
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
async function staticFile(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(publicDir, relative));
  if (!file.startsWith(publicDir)) return json(response, 403, { error: "Forbidden" });
  try { if (!(await stat(file)).isFile()) return json(response, 404, { error: "Not found" }); }
  catch { return json(response, 404, { error: "Not found" }); }
  response.writeHead(200, {
    "content-type": contentTypes[extname(file)] || "application/octet-stream",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    "x-content-type-options": "nosniff"
  });
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try { if (url.pathname.startsWith("/api/")) await api(request, response, url); else await staticFile(response, url.pathname); }
  catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
});

server.listen(port, host, () => {
  console.log(`Agent Plan Workspace: http://${host}:${port}`);
  console.log(`Repository: ${store.read().workspace.cwd}`);
  console.log(`Linear: ${linear.configured ? "configured" : "set LINEAR_API_KEY or connect in the UI"}`);
  console.log(`Data: ${dataDir}`);
});
