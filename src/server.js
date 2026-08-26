import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { persistArtifact, persistProductContext, readProductContext, safeName } from "./artifacts.js";
import { persistLinearApiKey, readLinearApiKey } from "./credentials.js";
import { diffTrees, outsideWriteScope, snapshotTree } from "./git.js";
import { LinearClient } from "./linear.js";
import { loadLocalFixture } from "./local.js";
import { enqueueSerial } from "./merge-queue.js";
import { formatTicketHorizon, PiHarness } from "./pi-harness.js";
import { blockingReasons, dependencyArtifacts, dependencySteps, findNode, flattenSteps, normalizePlan } from "./plan.js";
import { JsonStore } from "./store.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, ensureTicketWorktree, integrateBranch, needsLocalWorkspaceRepair, repairZeroStateWorkspace } from "./worktrees.js";
import { actionableFindings, clearInactiveRuns, markRunCancelled, nextRunnableBatch, planApprovalPending, resumeStage } from "./execution.js";
import { normalizeStageProfiles } from "./profiles.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const runFile = promisify(execFile);
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

const linear = new LinearClient({ apiKey: await readLinearApiKey(dataDir, store.read().workspace.cwd) || process.env.LINEAR_API_KEY });
const harness = new PiHarness({ dataDir, publish });
const clients = new Set();
const activeSteps = new Map();
const activeTickets = new Map();
const activeMerges = new Set();
const mergeQueues = new Map();
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

function captureStageActivity(ticketId, stageId, runId) {
  const startedAt = new Date().toISOString();
  const events = [];
  let rawOutput = "";
  const lastThinkingAt = new Map();
  return {
    onEvent(event, actor) {
      const now = Date.now();
      const activityKey = actor || "stage";
      if (event.type === "thinking" && now - (lastThinkingAt.get(activityKey) || 0) < 2000) return;
      if (event.type === "thinking") lastThinkingAt.set(activityKey, now);
      const item = { ...event, ...(actor ? { actor } : {}), at: new Date(now).toISOString() };
      if (item.type === "text_delta") rawOutput += item.delta || "";
      else events.push(item);
      publish({ channel: "stage", ticketId, stageId, runId, ...item });
    },
    snapshot() {
      return { startedAt, completedAt: new Date().toISOString(), rawOutput: rawOutput.slice(-100000), events: events.slice(-200) };
    }
  };
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
  return stage;
}

function initialStages() {
  return [
    ["requirements", "Clarify requirements"],
    ["explore", "Explore code & ticket horizon"],
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

async function pickDirectory() {
  if (process.platform !== "darwin") throw new Error("Native repository selection currently requires macOS");
  try {
    const { stdout } = await runFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Open repository")']);
    return normalize(stdout.trim());
  } catch (error) {
    if (error.code === 1) throw new Error("Repository selection cancelled");
    throw error;
  }
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
   let activity;
   try {
    signal.throwIfAborted();
    const before = store.read();
    const run = ticketRun(before, ticketId);
    activity = captureStageActivity(ticketId, "requirements", run.runId);
    const productContext = await readProductContext(dataDir, before.workspace.cwd);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.status = "clarifying";
      setStage(current, "requirements", "active", "Pi is shaping requirements without repository access");
    });
    const clarified = await harness.clarifyRequirements({ cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, productContext: productContext.content, profile: run.stageProfiles.requirements, onEvent: activity.onEvent, signal });
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
      setStage(current, "requirements", "blocked", "Requirement approval needed before repository access").activity = activity.snapshot();
      current.checkpoint = {
        id: randomUUID(), kind: "requirements_review", title: "Approve ticket requirements",
        prompt: clarified.artifact, questions: clarified.questions, createdAt: new Date().toISOString()
      };
    });
  } catch (error) {
    if (signal.aborted) return;
    await update((state) => {
      const current = state.ticketRuns[ticketId];
      if (current) {
        current.status = "failed";
        current.lastError = error.message;
        if (activity) current.stages.find((stage) => stage.id === "requirements").activity = activity.snapshot();
      }
    });
   }
  });
}

async function continueAfterRequirements(ticketId, answers) {
  return startTicketWork(ticketId, async (signal) => {
   let activity;
   let activityStage = "explore";
   try {
    signal.throwIfAborted();
    const before = store.read();
    const run = ticketRun(before, ticketId);
    if (answers.trim()) {
      activityStage = "requirements";
      activity = captureStageActivity(ticketId, "requirements", run.runId);
      await update((state) => {
        const current = ticketRun(state, ticketId);
        current.status = "clarifying";
        setStage(current, "requirements", "active", "Pi is revising requirements from your answers");
        current.checkpoint = null;
      });
      const clarified = await harness.refineRequirements({
        cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId,
        sessionFile: run.requirementsSessionFile, answers,
        profile: run.stageProfiles.requirements, onEvent: activity.onEvent, signal
      });
      signal.throwIfAborted();
      const artifact = await persistArtifact(dataDir, run.ticket, {
        runId: run.runId, name: "requirements-draft.md", content: clarified.artifact,
        stageId: "requirements", kind: "requirements-draft"
      });
      await update((state) => {
        const current = ticketRun(state, ticketId);
        current.requirementsSessionFile = clarified.sessionFile;
        current.artifacts.push(artifact);
        current.status = "awaiting_requirements";
        setStage(current, "requirements", "blocked", "Review the revised requirements or answer a follow-up").activity = activity.snapshot();
        current.checkpoint = {
          id: randomUUID(), kind: "requirements_review", title: "Review revised ticket requirements",
          prompt: clarified.artifact, questions: clarified.questions, createdAt: new Date().toISOString()
        };
      });
      return;
    }
    activity = captureStageActivity(ticketId, "explore", run.runId);
    const approved = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements");
    const draft = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements-draft");
    const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
    if ((!approved && !draft) || !productContext) throw new Error("Requirements draft or product context snapshot not found");
    const requirements = approved?.content || `${draft.content}\n\n## User clarification\nApproved without changes.`;
    const ticketHorizon = formatTicketHorizon(run.ticket, [
      ...ticketCache.values(),
      ...Object.values(before.ticketRuns).map((ticketRun) => ticketRun.ticket)
    ]);
    const requirementArtifact = approved ? null : await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, name: "requirements.md", content: requirements,
      stageId: "requirements", kind: "requirements"
    });
    await update((state) => {
      const current = ticketRun(state, ticketId);
      if (requirementArtifact) current.artifacts.push(requirementArtifact);
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
      setStage(current, "explore", "active", "Pi is mapping code, tests, and nearby tickets");
    });
    const explorationResults = await Promise.allSettled([
      harness.exploreTicket({
        cwd: workspace.cwd, ticket: run.ticket, sessionFile: null, runId: run.runId,
        productContext: productContext.content, requirements, profile: run.stageProfiles.exploration,
        onEvent: (event) => activity.onEvent(event, "code explorer"), signal
      }),
      harness.lookAheadTickets({
        cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId,
        productContext: productContext.content, requirements, ticketHorizon, profile: run.stageProfiles.exploration,
        onEvent: (event) => activity.onEvent(event, "ticket look-ahead"), signal
      })
    ]);
    const failedExploration = explorationResults.find((result) => result.status === "rejected");
    if (failedExploration) throw failedExploration.reason;
    const [explored, lookedAhead] = explorationResults.map((result) => result.value);
    signal.throwIfAborted();
    const [explorationArtifact, lookAheadArtifact] = await Promise.all([
      persistArtifact(dataDir, run.ticket, {
        runId: run.runId, name: "implementation-delta.md", content: explored.artifact,
        stageId: "explore", kind: "implementation-delta"
      }),
      persistArtifact(dataDir, run.ticket, {
        runId: run.runId, name: "ticket-lookahead.md", content: lookedAhead.artifact,
        stageId: "explore", kind: "ticket-lookahead"
      })
    ]);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.sessionFile = explored.sessionFile;
      current.artifacts.push(explorationArtifact, lookAheadArtifact);
      setStage(current, "explore", explored.questions.length ? "blocked" : "completed", explored.questions.length ? "Technical decision required" : "Code map and ticket look-ahead persisted").activity = activity.snapshot();
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
      if (current) {
        current.status = "failed";
        current.lastError = error.message;
        if (activity) current.stages.find((stage) => stage.id === activityStage).activity = activity.snapshot();
      }
    });
   }
  });
}

async function designTicket(ticketId, answers, signal) {
  signal?.throwIfAborted();
  const state = store.read();
  const run = ticketRun(state, ticketId);
  const activity = captureStageActivity(ticketId, "design", run.runId);
  const requirements = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements");
  const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
  const exploration = [...run.artifacts].reverse().find((artifact) => artifact.kind === "implementation-delta");
  const ticketLookAhead = [...run.artifacts].reverse().find((artifact) => artifact.kind === "ticket-lookahead")?.content || "No nearby ticket implications were found.";
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
      productContext: productContext.content, requirements: requirements.content, exploration: exploration.content, ticketLookAhead, answers,
      profile: run.stageProfiles.architecture, onEvent: activity.onEvent, signal
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
      setStage(current, "design", "blocked", "Plan ready for approval").activity = activity.snapshot();
      current.checkpoint = { id: randomUUID(), kind: "awaiting_approval", title: "Approve implementation plan", prompt: result.artifact, createdAt: new Date().toISOString() };
    });
  } catch (error) {
    if (signal?.aborted) return;
    await update((draft) => {
      const current = ticketRun(draft, ticketId);
      current.status = "failed";
      current.lastError = error.message;
      setStage(current, "design", "blocked", error.message).activity = activity.snapshot();
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

async function resolveMergeConflicts(ticketId, { cwd, conflicts, activity, signal, attempt }) {
  signal?.throwIfAborted();
  const current = ticketRun(store.read(), ticketId);
  await update((state) => {
    const run = ticketRun(state, ticketId);
    Object.assign(run.merge, { status: "resolving_conflicts", conflicts, resolverStartedAt: new Date().toISOString() });
    run.status = "resolving_conflicts";
    setStage(run, "handoff", "active", `Resolving ${conflicts.length} merge conflict${conflicts.length === 1 ? "" : "s"}`);
  });
  activity.onEvent({ type: "phase", label: `Merge conflicts detected · ${conflicts.join(", ")}` }, "merge queue");
  const requirementIds = flattenSteps(current.plan).flatMap((step) => step.requirementIds || []).filter((id, index, all) => all.indexOf(id) === index);
  const step = {
    id: `merge-conflict-${attempt}`, type: "step", role: "implementation",
    title: "Resolve merge-queue conflicts", description: `Reconcile ${current.ticket.identifier} with the latest opened repository state.`,
    prompt: `A Git merge is already in progress in this isolated integration worktree. Resolve only these conflicted files: ${conflicts.join(", ")}. Preserve the verified ticket behavior and compatible changes already integrated into the target branch. Do not abort, restart, or commit the merge. Run focused checks, leave every conflict resolved, and report exactly what was reconciled.`,
    contextPolicy: "seeded", harness: "pi", agentId: `merge-conflict-resolver:${current.ticket.identifier}`,
    permission: "write", writeScope: conflicts.join(", "), skills: [], references: conflicts,
    requirementIds, capabilityIds: [], deltaIds: [], productContext: "Resolve only the concrete merge conflict without expanding ticket scope.",
    expectedArtifacts: [`merge-conflict-resolution-${attempt}.md`], acceptanceCriteria: ["Every Git conflict is resolved", "Verified behavior from both branches is preserved"],
    dependsOn: [], required: true, status: "ready", attempts: [], artifacts: [], attachments: []
  };
  const result = await harness.runStep({
    cwd, plan: current.plan, step, artifacts: current.artifacts, images: [], forkSessionFile: null, resumeSessionFile: null, feedback: "",
    ticketId, runId: current.runId, profile: current.stageProfiles.implementation,
    onEvent: (event) => activity.onEvent(event, "merge conflict resolver"), signal
  });
  signal?.throwIfAborted();
  if (result.report.status !== "completed") throw new Error(result.report.request || result.report.summary || "Merge conflict resolver needs attention");
  const artifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: step.expectedArtifacts[0], content: result.output, stageId: "handoff", kind: "merge-conflict-resolution"
  });
  await update((state) => {
    const run = ticketRun(state, ticketId);
    run.artifacts.push(artifact);
    Object.assign(run.merge, { resolverCompletedAt: new Date().toISOString(), resolutionArtifact: artifact });
  });
}

async function scheduleTicketIntegration(ticketId, { diff, contextContent = null, signal } = {}) {
  const queuedRun = ticketRun(store.read(), ticketId);
  if (["queued", "merging", "resolving_conflicts", "verifying"].includes(queuedRun.merge?.status)) throw new Error("This ticket is already in the merge queue");
  const sourceCwd = queuedRun.workspace.sourceCwd;
  const attempt = (queuedRun.merge?.attempt || 0) + 1;
  const queuedAt = new Date().toISOString();
  let queuedState;
  const queued = enqueueSerial(mergeQueues, sourceCwd, (position) => {
    activeMerges.add(ticketId);
    queuedState = update((state) => {
      const run = ticketRun(state, ticketId);
      run.merge = { status: "queued", position, attempt, queuedAt, sourceCwd, branch: run.workspace.branch, conflicts: [] };
      run.status = "queued_for_merge";
      run.checkpoint = null;
      setStage(run, "handoff", "active", `Merge queue position ${position}`);
    });
    return queuedState;
  }, async () => {
    signal?.throwIfAborted();
    const current = ticketRun(store.read(), ticketId);
    const activity = captureStageActivity(ticketId, "handoff", current.runId);
    await update((state) => {
      const run = ticketRun(state, ticketId);
      Object.assign(run.merge, { status: "merging", position: 1, startedAt: new Date().toISOString() });
      run.status = "merging";
      run.lastError = null;
      setStage(run, "handoff", "active", `Merging ${run.workspace.branch}`);
    });
    activity.onEvent({ type: "phase", label: "Automated merge started" }, "merge queue");
    const integrationCwd = join(dataDir, "ticket-runs", safeName(current.ticket.identifier || current.ticket.id), "runs", safeName(current.runId), "integration");
    const integration = await integrateBranch({
      sourceCwd, branch: current.workspace.branch, integrationCwd, dependencyCwd: current.workspace.cwd,
      resolveConflicts: (input) => resolveMergeConflicts(ticketId, { ...input, activity, signal, attempt }),
      verify: async ({ cwd, conflicts }) => {
        signal?.throwIfAborted();
        await update((state) => {
          const run = ticketRun(state, ticketId);
          Object.assign(run.merge, { status: "verifying", conflicts, verificationStartedAt: new Date().toISOString() });
          run.status = "verifying_merge";
          setStage(run, "handoff", "active", "Verifying merged result");
        });
        activity.onEvent({ type: "phase", label: "Running post-merge repository checks" }, "merge queue");
        const checks = await harness.runRepositoryChecks({ cwd, signal });
        if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
        await update((state) => { Object.assign(ticketRun(state, ticketId).merge, { checks, verifiedAt: new Date().toISOString() }); });
      }
    });
    const integratedAt = new Date().toISOString();
    const productContext = contextContent === null ? null : await persistProductContext(dataDir, sourceCwd, contextContent);
    const handoff = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
      content: `# ${current.ticket.identifier} handoff\n\nCompleted ${flattenSteps(current.plan).length} accepted implementation slices.\n\nIntegrated into: \`${sourceCwd}\`\n\nSource branch: \`${current.workspace.branch}\`\n\nCommit: \`${integration.commit}\`${productContext ? `\n\nLiving product context: \`${productContext.path}\`.` : ""}\n\n${diff?.stat || "No changed files."}`
    });
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.integration = { sourceCwd, branch: current.workspace.branch, commit: integration.commit, integratedAt };
      Object.assign(run.merge, { status: "integrated", commit: integration.commit, conflicts: integration.conflicts, integratedAt });
      if (productContext) run.productContextPath = productContext.path;
      run.artifacts.push(handoff);
      run.checkpoint = null;
      setStage(run, "handoff", "completed", `Merged into ${sourceCwd}`).activity = activity.snapshot();
      run.status = "completed";
      run.lastError = null;
      run.completedAt = integratedAt;
    });
    return integration;
  });
  await queuedState;
  const tracked = queued.promise.catch(async (error) => {
    if (!signal?.aborted) await update((state) => {
      const run = ticketRun(state, ticketId);
      Object.assign(run.merge, { status: "failed", error: error.message, failedAt: new Date().toISOString() });
      run.status = "needs_attention";
      run.lastError = error.message;
      setStage(run, "handoff", "blocked", error.message);
    });
    throw error;
  }).finally(() => activeMerges.delete(ticketId));
  return { position: queued.position, promise: tracked };
}

async function finalReviewLoop(ticketId, signal) {
  signal?.throwIfAborted();
  const started = ticketRun(store.read(), ticketId);
  const activity = captureStageActivity(ticketId, "verify", started.runId);
  await update((state) => {
    const run = ticketRun(state, ticketId);
    setStage(run, "implement", "completed", `${flattenSteps(run.plan).length} implementation slices accepted`);
    setStage(run, "verify", "active", "Independent reviewers are inspecting the combined implementation");
    run.status = "reviewing";
    run.checkpoint = null;
    run.reviews ||= [];
  });
  const firstRound = Math.max(0, ...(started.reviews || []).map((review) => Number(review.round) || 0)) + 1;
  for (let round = firstRound; ; round++) {
    signal?.throwIfAborted();
    const current = ticketRun(store.read(), ticketId);
    activity.onEvent({ type: "thinking", label: `Running deterministic checks · round ${round}` }, "checks");
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
      onEvent: (event) => activity.onEvent(event, role),
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
      run.stages.find((stage) => stage.id === "verify").activity = activity.snapshot();
    });
    if (!findings.length) {
      await commitWorkspace(current.workspace.cwd, `fix: resolve independent review findings\n\nWhy: The accepted ticket must pass the final combined review.\nRequirement: ${flattenSteps(current.plan).flatMap((step) => step.requirementIds).filter((id, index, all) => all.indexOf(id) === index).join(", ") || "Complete every approved ticket requirement"}`);
      if (current.ticket.source === "local") {
        await update((state) => {
          const run = ticketRun(state, ticketId);
          setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
          setStage(run, "handoff", "active", "Waiting for merge queue");
        });
        const queued = await scheduleTicketIntegration(ticketId, { diff, signal });
        await queued.promise;
        return;
      }
      const currentContext = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot")?.content || "";
      const handoffActivity = captureStageActivity(ticketId, "handoff", current.runId);
      const contextContent = await harness.updateProductContext({
        cwd: current.workspace.cwd, ticket: current.ticket, currentContext,
        artifacts: current.artifacts.filter((artifact) => ["requirements", "implementation-delta", "architecture", "agent-output", "step-verification"].includes(artifact.kind)),
        diff, runId: current.runId, profile: current.stageProfiles.handoff, onEvent: handoffActivity.onEvent, signal
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
        setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
        setStage(run, "handoff", "blocked", "Approve the living product-context update").activity = handoffActivity.snapshot();
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
      onEvent: (event) => activity.onEvent(event, "review fixer"),
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
      setStage(run, "verify", "active", `Review round ${round + 1} follows focused fixes`).activity = activity.snapshot();
    });
  }
}

async function finishHandoff(ticketId) {
  const current = ticketRun(store.read(), ticketId);
  if (current.checkpoint?.kind !== "product_context_review") throw new Error("No product-context update is awaiting approval");
  const proposal = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-update");
  if (!proposal) throw new Error("Product-context proposal not found");
  const queued = await scheduleTicketIntegration(ticketId, { diff: current.reviews?.at(-1)?.diff, contextContent: proposal.content });
  queued.promise.catch(() => {});
}

async function ensureLocalWorkspace(ticketId) {
  const before = store.read();
  const previous = ticketRun(before, ticketId);
  if (!(await needsLocalWorkspaceRepair(previous.ticket, previous.workspace))) return previous;
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
  if (request.method === "GET" && url.pathname === "/api/models") return json(response, 200, { provider: "openai-codex", models: await harness.models() });
  if (request.method === "POST" && url.pathname === "/api/queue/clear") {
    let cleared = 0;
    const state = await update((draft) => { cleared = clearInactiveRuns(draft, new Set([...activeTickets.keys(), ...activeMerges])); });
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
    const apiKey = String(input.apiKey || "").trim();
    if (!apiKey) throw new Error("Linear API key is required");
    const previousApiKey = linear.apiKey;
    linear.apiKey = apiKey;
    let result;
    try {
      result = await linear.tickets();
      await persistLinearApiKey(dataDir, store.read().workspace.cwd, apiKey);
    } catch (error) {
      linear.apiKey = previousApiKey;
      throw error;
    }
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
  if (request.method === "POST" && url.pathname === "/api/workspace/pick") return json(response, 200, { cwd: await pickDirectory() });
  if (request.method === "POST" && url.pathname === "/api/workspace") {
    const input = await body(request);
    const cwd = normalize(String(input.cwd || ""));
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Workspace must be an existing absolute directory");
    const linearApiKey = await readLinearApiKey(dataDir, cwd) || process.env.LINEAR_API_KEY;
    const state = await update((draft) => { draft.workspace = { cwd }; });
    linear.apiKey = linearApiKey;
    ticketCache = new Map();
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
    const stage = resumeStage(run);
    if (!["run", "requirements", "explore", "design"].includes(stage)) throw new Error("This run cannot be resumed from its current stage");
    if (activeTickets.size >= 2 && !activeTickets.has(id)) throw new Error("Two tickets are already active; wait for one to reach a checkpoint");
    if (run.status === "cancelled") await update((state) => {
      const current = ticketRun(state, id);
      current.status = "interrupted";
      for (const step of flattenSteps(current.plan)) if (step.status === "cancelled") step.status = "interrupted";
    });
    if (stage === "requirements") prepareTicket(id).catch(() => {});
    else if (stage === "explore") continueAfterRequirements(id, "").catch(() => {});
    else if (stage === "design") startTicketWork(id, (signal) => designTicket(id, "Resume the interrupted design.", signal)).catch(() => {});
    else runTicket(id).catch(() => {});
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
    if (run.checkpoint?.kind === "requirements_review") {
      if (!answers.trim() && run.checkpoint.questions?.length) throw new Error("Answer the open requirements questions before approval");
      continueAfterRequirements(id, answers).catch(() => {});
    }
    else startTicketWork(id, (signal) => designTicket(id, answers, signal)).catch(() => {});
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const approve = url.pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/);
  if (request.method === "POST" && approve) {
    const id = decodeURIComponent(approve[1]);
    if (activeTickets.size >= 2 && !activeTickets.has(id)) throw new Error("Two tickets are already running");
    const run = ticketRun(store.read(), id);
    if (!planApprovalPending(run)) throw new Error("This ticket has no plan awaiting approval");
    const input = await body(request);
    await update((state) => {
      const current = ticketRun(state, id);
      current.auto = Boolean(input.auto);
      current.status = "awaiting_approval";
      current.lastError = null;
    });
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
