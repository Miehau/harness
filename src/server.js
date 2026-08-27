import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { artifactPathForOpen, persistArtifact, persistProductContext, readProductContext, safeName } from "./artifacts.js";
import { admissionCandidates, occupiedTicketIds } from "./admission.js";
import { diffTrees, outsideWriteScope, snapshotTree } from "./git.js";
import { deliveryForRemote, pushTicketBranch, rebaseOntoRemote, remoteContext, safeSyncLocal } from "./delivery.js";
import { JiraClient } from "./jira.js";
import { LinearClient } from "./linear.js";
import { loadLocalFixture } from "./local.js";
import { enqueueSerial } from "./merge-queue.js";
import { ensureVerificationContractStep, formatTicketHorizon, PiHarness } from "./pi-harness.js";
import { projectConfigPath } from "./project-config.js";
import { blockingReasons, dependencyArtifacts, dependencySteps, findNode, flattenSteps, normalizeEditedPlan, normalizePlan } from "./plan.js";
import { JsonStore, normalizeSettings } from "./store.js";
import { TrackerHub } from "./trackers.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, ensureTicketWorktree, integrateBranch, needsLocalWorkspaceRepair, repairZeroStateWorkspace } from "./worktrees.js";
import { actionableFindings, clearInactiveRuns, createActivityCapture, markRunCancelled, nextRunnableBatch, planApprovalPending, resumeStage } from "./execution.js";
import { normalizeStageProfiles } from "./profiles.js";
import { PreviewManager } from "./previews.js";
import { cleanupRetainedRun, retentionInventory } from "./retention.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { CredentialStore, effectiveTrackerCredentials, publicTrackerSettings } from "./credentials.js";

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
const daemonLock = await acquireDaemonLock(join(dataDir, "daemon.lock"));
const store = new JsonStore(join(dataDir, "state-v3.json"), initialCwd);
await store.init();

const credentialStore = new CredentialStore(join(dataDir, "credentials.json"));
let savedCredentials = await credentialStore.load();
function trackerHub() {
  const credentials = effectiveTrackerCredentials(savedCredentials);
  return new TrackerHub([
    new LinearClient({ apiKey: credentials.linear.apiKey }),
    new JiraClient(credentials.jira)
  ]);
}
let trackers = trackerHub();
const harness = new PiHarness({ dataDir, publish });
const previews = new PreviewManager({ dataDir });
const clients = new Set();
const activeSteps = new Map();
const activeTickets = new Map();
const activeMerges = new Set();
const mergeQueues = new Map();
let ticketCache = new Map();
let trackerRefresh = null;
let pollTimer = null;

function executionCapacity(state = store.read()) {
  return normalizeSettings(state.settings).maxConcurrentTickets;
}

function ensureTicketCapacity(ticketId, state = store.read()) {
  const occupied = occupiedTicketIds(state);
  const capacity = executionCapacity(state);
  if (!occupied.has(ticketId) && occupied.size >= capacity) throw new Error(`${capacity} ticket slots are occupied, including approval checkpoints`);
}

function publish(event) {
  const encoded = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) {
    if (response.destroyed) clients.delete(response);
    else if (!response.writableNeedDrain) response.write(encoded);
  }
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
  const existing = store.read().ticketRuns[ticketId]?.stages?.find((stage) => stage.id === stageId)?.activity;
  return createActivityCapture({
    existing,
    persist: (activity) => update((state) => {
      const stage = state.ticketRuns[ticketId]?.stages?.find((candidate) => candidate.id === stageId);
      if (stage) stage.activity = activity;
    }, { publish: false }),
    emit: (event) => publish({ channel: "stage", ticketId, stageId, runId, ...event })
  });
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

async function runChecksWithPreview({ ticketId, previewId, cwd, signal, required, stepId = null }) {
  let preview = null;
  let evidence = [];
  if (required) {
    preview = await previews.ensure({ id: previewId, cwd });
    if (preview) evidence = await previews.capture(previewId);
  }
  const checks = await harness.runRepositoryChecks({ cwd, signal, requireVisualEvidence: required && !preview });
  checks.evidence = [...(checks.evidence || []), ...evidence];
  if (required && !checks.evidence.length) Object.assign(checks, { status: "failed", summary: "Visual verification produced no desktop or mobile evidence." });
  if (preview || evidence.length) await update((state) => {
    const run = ticketRun(state, ticketId);
    run.previews ||= {};
    if (preview) run.previews[previewId] = preview;
    for (const item of evidence) if (!run.artifacts.some((artifact) => artifact.path === item.path)) run.artifacts.push({
      id: randomUUID(), name: item.name, path: item.path, kind: "visual-evidence", stageId: "verify", stepId,
      summary: `${item.viewport.width}×${item.viewport.height} · ${item.url}`, createdAt: new Date().toISOString()
    });
  });
  return checks;
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
  await stopTicketPreviews(ticketId, "run_cancelled");
}

async function stopTicketPreviews(ticketId, reason) {
  previews.stopMatching(`${ticketId}:`);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    for (const preview of Object.values(run?.previews || {})) Object.assign(preview, { status: "stopped", stoppedReason: reason, stoppedAt: new Date().toISOString() });
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

function trackerBacked(ticket) { return ["linear", "jira"].includes(ticket?.provider); }

async function trackerAction(ticketId, key, action) {
  const run = ticketRun(store.read(), ticketId);
  if (!trackerBacked(run.ticket)) return null;
  if (run.trackerEvents?.[key]) return run.trackerEvents[key].result;
  const result = await action(run.ticket);
  await update((state) => {
    const current = ticketRun(state, ticketId);
    current.trackerEvents ||= {};
    current.trackerEvents[key] = { at: new Date().toISOString(), result: result || null };
    current.trackerSyncError = null;
  });
  return result;
}

function checkpointMessage(run, checkpoint) {
  const questions = (checkpoint.questions || []).map((question, index) => `${index + 1}. ${question}`).join("\n");
  return [
    `[agent-plan-question:${checkpoint.id}]`,
    checkpoint.title,
    questions || checkpoint.prompt,
    "Reply in this ticket with `Answer: ...`. The first such reply continues the run. You can also answer in the local dashboard."
  ].filter(Boolean).join("\n\n");
}

async function mirrorCheckpoint(ticketId) {
  const run = ticketRun(store.read(), ticketId);
  const checkpoint = run.checkpoint;
  if (!checkpoint || checkpoint.trackerQuestion || !trackerBacked(run.ticket)) return;
  try {
    const comment = await trackers.comment(run.ticket, checkpointMessage(run, checkpoint));
    await update((state) => {
      const current = ticketRun(state, ticketId);
      if (current.checkpoint?.id === checkpoint.id) current.checkpoint.trackerQuestion = {
        commentId: comment?.id, createdAt: comment?.createdAt || new Date().toISOString()
      };
      current.trackerSyncError = null;
    });
  } catch (error) {
    await update((state) => {
      const current = state.ticketRuns[ticketId];
      if (current) current.trackerSyncError = `Could not mirror checkpoint: ${error.message}`;
    });
  }
}

async function beginTicket(ticket, { automaticAdmission = false } = {}) {
  if (!ticket?.id) throw new Error("Refresh the ticket sources and select a ticket first");
  ensureTicketCapacity(ticket.id);
  await update((state) => {
    state.selectedTicketId = automaticAdmission ? state.selectedTicketId : ticket.id;
    if (!state.ticketRuns[ticket.id] || ["completed", "failed", "needs_attention"].includes(state.ticketRuns[ticket.id].status)) state.ticketRuns[ticket.id] = {
      id: ticket.id,
      runId: randomUUID(),
      ticket,
      automaticAdmission,
      status: "preparing",
      workspace: null,
      stageProfiles: structuredClone(state.stageProfiles),
      stages: initialStages(),
      checkpoint: null,
      plan: null,
      artifacts: [],
      activeRuns: {},
      trackerEvents: {},
      sessionFile: null,
      auto: false,
      lastError: null,
      createdAt: new Date().toISOString()
    };
  });
  prepareTicket(ticket.id).catch(() => {});
  return ticket.id;
}

async function acceptCheckpointAnswer(ticketId, answers, source) {
  const before = ticketRun(store.read(), ticketId);
  const checkpoint = before.checkpoint;
  if (!checkpoint || checkpoint.answerAcceptedAt) return false;
  await update((state) => {
    const current = ticketRun(state, ticketId);
    if (current.checkpoint?.id === checkpoint.id) Object.assign(current.checkpoint, {
      answerAcceptedAt: new Date().toISOString(), answerSource: source
    });
  });
  if (source === "dashboard" && trackerBacked(before.ticket)) {
    trackers.comment(before.ticket, `Answer (dashboard):\n\n${answers || "Approved without changes."}\n\n[agent-plan-answer:${checkpoint.id}]`).catch(async (error) => {
      await update((state) => { if (state.ticketRuns[ticketId]) state.ticketRuns[ticketId].trackerSyncError = `Could not mirror dashboard answer: ${error.message}`; });
    });
  }
  if (checkpoint.kind === "requirements_review") continueAfterRequirements(ticketId, answers).catch(() => {});
  else startTicketWork(ticketId, (signal) => designTicket(ticketId, answers, signal)).catch(() => {});
  return true;
}

async function syncTrackerAnswers() {
  const unanswered = Object.values(store.read().ticketRuns).filter((run) =>
    trackerBacked(run.ticket) && run.checkpoint && !run.checkpoint.trackerQuestion && ["requirements_review", "technical_input", "needs_input"].includes(run.checkpoint.kind)
  );
  await Promise.all(unanswered.map((run) => mirrorCheckpoint(run.id)));
  const runs = Object.values(store.read().ticketRuns).filter((run) =>
    trackerBacked(run.ticket) && run.checkpoint?.trackerQuestion && !run.checkpoint.answerAcceptedAt && ["requirements_review", "technical_input", "needs_input"].includes(run.checkpoint.kind)
  );
  await Promise.all(runs.map(async (run) => {
    try {
      const checkpoint = run.checkpoint;
      const comments = await trackers.comments(run.ticket);
      const answer = comments
        .filter((comment) => comment.id !== checkpoint.trackerQuestion.commentId)
        .filter((comment) => !checkpoint.trackerQuestion.createdAt || !comment.createdAt || Date.parse(comment.createdAt) >= Date.parse(checkpoint.trackerQuestion.createdAt))
        .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))
        .map((comment) => String(comment.body || "").match(/^\s*Answer\s*:\s*([\s\S]+)/i)?.[1]?.trim())
        .find(Boolean);
      if (answer) await acceptCheckpointAnswer(run.id, answer, "tracker");
    } catch (error) {
      await update((state) => { if (state.ticketRuns[run.id]) state.ticketRuns[run.id].trackerSyncError = `Could not read tracker answers: ${error.message}`; });
    }
  }));
}

async function admitAutomaticTickets(tickets) {
  const state = store.read();
  if (state.settings.projectMode !== "automatic") return [];
  const admitted = [];
  for (const ticket of admissionCandidates(tickets, state, executionCapacity(state))) admitted.push(await beginTicket(ticket, { automaticAdmission: true }));
  return admitted;
}

async function refreshTrackers({ admit = true } = {}) {
  if (trackerRefresh) return trackerRefresh;
  trackerRefresh = (async () => {
    const result = await trackers.tickets();
    ticketCache = new Map(result.tickets.map((ticket) => [ticket.id, ticket]));
    await syncTrackerAnswers();
    if (admit) await admitAutomaticTickets(result.tickets);
    publish({ type: "tickets", ticketSources: result });
    return result;
  })().finally(() => { trackerRefresh = null; });
  return trackerRefresh;
}

function scheduleTrackerPolling() {
  clearInterval(pollTimer);
  const interval = normalizeSettings(store.read().settings).pollIntervalSeconds * 1000;
  pollTimer = setInterval(() => refreshTrackers().catch(() => {}), interval);
  pollTimer.unref();
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
  const [contractExists, projectConfigExists] = await Promise.all([
    stat(join(source, ".agent-plan/verify.mjs")).then(() => true, () => false),
    stat(join(source, projectConfigPath)).then(() => true, () => false)
  ]);
  const plan = ensureVerificationContractStep(fixture.plan, contractExists, projectConfigExists);
  const runId = randomUUID();
  const slug = safeName(plan.title).slice(0, 32);
  const id = `local-${slug}-${runId.slice(0, 8)}`;
  const ticket = {
    id,
    identifier: `LOCAL-${slug}`,
    title: plan.title,
    description: plan.summary || fixture.feature.split("\n").find((line) => line.trim() && !line.startsWith("#")) || "Local zero-state fixture",
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
      plan, stageProfiles, artifacts, activeRuns: {}, auto: false, sessionFile: null, lastError: null,
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
    await mirrorCheckpoint(ticketId);
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
      await mirrorCheckpoint(ticketId);
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
    if (explored.questions.length) await mirrorCheckpoint(ticketId);
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
          checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:${stepId}`, cwd, signal, required: currentStep.requiresVisualEvidence, stepId });
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
            images: await harness.evidenceImages(checks.evidence),
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

async function resolveMergeConflicts(ticketId, { cwd, conflicts, activity, signal, attempt, operation = "merge" }) {
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
    title: `Resolve ${operation} conflicts`, description: `Reconcile ${current.ticket.identifier} with the latest target branch.`,
    prompt: `A Git ${operation} is already in progress in this isolated ticket worktree. Resolve only these conflicted files: ${conflicts.join(", ")}. Preserve the verified ticket behavior and compatible target-branch changes. Do not abort, restart, or commit the ${operation}. Run focused checks, leave every conflict resolved, and report exactly what was reconciled.`,
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

function waitForDelivery(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("Delivery cancelled")); }, { once: true });
  });
}

async function fixRemoteFeedback(ticketId, feedback, signal) {
  const current = ticketRun(store.read(), ticketId);
  const step = {
    id: `remote-feedback-${Date.now()}`, type: "step", role: "implementation",
    title: "Address remote review feedback", description: "Apply the smallest change that resolves concrete pull-request feedback.",
    prompt: `Address these remote review comments. Preserve approved behavior and avoid unrelated changes:\n\n${feedback.map((item) => `- ${item.path ? `${item.path}${item.line ? `:${item.line}` : ""}: ` : ""}${item.body}`).join("\n")}`,
    contextPolicy: "seeded", harness: "pi", agentId: `remote-review-fixer:${current.ticket.identifier}`,
    permission: "write", writeScope: "*", skills: [], references: [], requirementIds: [], capabilityIds: [], deltaIds: [], productContext: "Only resolve the concrete remote review feedback.",
    expectedArtifacts: ["remote-review-fix.md"], acceptanceCriteria: feedback.map((item) => item.body), dependsOn: [], required: true, status: "ready", attempts: [], artifacts: [], attachments: []
  };
  const result = await harness.runStep({
    cwd: current.workspace.cwd, plan: current.plan, step, artifacts: current.artifacts, images: [], forkSessionFile: null, resumeSessionFile: null, feedback: "",
    ticketId, runId: current.runId, profile: current.stageProfiles.implementation, signal,
    onEvent: (event) => publishStepEvent(ticketId, step.id, step.id, event)
  });
  if (result.report.status !== "completed") throw new Error(result.report.request || result.report.summary || "Remote review fixer needs attention");
  const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:remote-feedback`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((item) => item.requiresVisualEvidence) });
  if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
  const commit = await commitWorkspace(current.workspace.cwd, `fix: address remote review feedback\n\nWhy: The reviewed change must resolve concrete maintainer feedback before merge.\nRequirement: ${current.ticket.identifier}`);
  const artifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: "remote-review-fix.md", content: result.output, stageId: "handoff", kind: "remote-review-fix"
  });
  await update((state) => { ticketRun(state, ticketId).artifacts.push(artifact); });
  return commit;
}

async function scheduleRemoteDelivery(ticketId, { diff, contextContent, signal } = {}) {
  if (activeMerges.has(ticketId)) throw new Error("This ticket is already being delivered");
  activeMerges.add(ticketId);
  const promise = (async () => {
    const current = ticketRun(store.read(), ticketId);
    const sourceCwd = current.workspace.sourceCwd;
    const resumedChange = current.merge?.change || null;
    const remoteDetails = current.merge?.remote && current.merge?.base
      ? { remote: current.merge.remote, base: current.merge.base }
      : await remoteContext(sourceCwd);
    const { remote, base } = remoteDetails;
    const forge = deliveryForRemote(remote);
    const attempt = (current.merge?.attempt || 0) + 1;
    const activity = captureStageActivity(ticketId, "handoff", current.runId);
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.merge = resumedChange
        ? { ...run.merge, status: "waiting_for_checks", attempt, sourceCwd, branch: run.workspace.branch, base, remote }
        : { status: "rebasing", attempt, sourceCwd, branch: run.workspace.branch, base, remote, feedbackIds: run.merge?.feedbackIds || [] };
      run.status = resumedChange ? "waiting_for_checks" : "rebasing";
      run.recovery = null;
      run.checkpoint = null;
      setStage(run, "handoff", "active", resumedChange ? `Inspecting existing remote review: ${resumedChange.url}` : `Rebasing onto origin/${base}`);
    });
    const rebase = () => rebaseOntoRemote(current.workspace.cwd, base, {
      resolveConflicts: (input) => resolveMergeConflicts(ticketId, { ...input, activity, signal, attempt, operation: "rebase" })
    });
    let checks = current.merge?.checks || null;
    let change = resumedChange;
    if (!change) {
      await rebase();
      checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:delivery`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence) });
      if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
      await pushTicketBranch(current.workspace.cwd, current.workspace.branch);
      await update((state) => { ticketRun(state, ticketId).merge.externalActionPending = "create_remote_change"; });
      change = await forge.create({
        branch: current.workspace.branch, base, title: `${current.ticket.identifier}: ${current.ticket.title}`,
        body: [`## Outcome`, current.plan.summary || current.ticket.description, `## Verification`, checks.summary, `## Change`, diff?.stat || "See changed files."].join("\n\n")
      });
      await trackerAction(ticketId, "remote_change", (ticket) => trackers.comment(ticket, `Remote review opened: ${change.url}`));
      await update((state) => {
        const run = ticketRun(state, ticketId);
        Object.assign(run.merge, { status: "waiting_for_checks", change, checks, openedAt: new Date().toISOString(), externalActionPending: null });
        run.status = "waiting_for_checks";
        setStage(run, "handoff", "active", `Waiting for checks and review: ${change.url}`);
      });
    }

    let mergeResult = null;
    let lastRebaseHead = null;
    for (;;) {
      signal?.throwIfAborted();
      const delivery = await forge.status(change);
      const processed = new Set(ticketRun(store.read(), ticketId).merge.feedbackIds || []);
      const feedback = delivery.feedback.filter((item) => !processed.has(item.id));
      await update((state) => {
        const run = ticketRun(state, ticketId);
        Object.assign(run.merge, { status: feedback.length ? "addressing_feedback" : delivery.checks === "pending" ? "waiting_for_checks" : "waiting_for_merge", remoteStatus: delivery, checkedAt: new Date().toISOString() });
        run.status = run.merge.status;
        setStage(run, "handoff", "active", feedback.length ? `Addressing ${feedback.length} review comment${feedback.length === 1 ? "" : "s"}` : `Remote checks: ${delivery.checks}; merge: ${delivery.mergeState}`);
      });
      if (delivery.merged) { mergeResult = { commit: delivery.headSha, externallyMerged: true }; break; }
      if (feedback.length) {
        await fixRemoteFeedback(ticketId, feedback, signal);
        await rebase();
        await pushTicketBranch(current.workspace.cwd, current.workspace.branch);
        await forge.comment(change, `Addressed review feedback in the latest pushed revision:\n\n${feedback.map((item) => `- ${item.body}`).join("\n")}`);
        await update((state) => { ticketRun(state, ticketId).merge.feedbackIds.push(...feedback.map((item) => item.id)); });
        continue;
      }
      if (delivery.checks === "failed") throw new Error(`Remote CI failed for ${change.url}`);
      const unresolvedReview = delivery.feedback.some((item) => item.id.startsWith("review:"));
      if (delivery.mergeable && delivery.checks === "passed" && !unresolvedReview) {
        await update((state) => { ticketRun(state, ticketId).merge.externalActionPending = "squash_merge"; });
        mergeResult = await forge.merge(change, `${current.ticket.identifier}: ${current.ticket.title}`);
        break;
      }
      if (!delivery.mergeable && delivery.headSha !== lastRebaseHead && /(behind|dirty|conflict|rebase)/i.test(delivery.mergeState || "")) {
        lastRebaseHead = delivery.headSha;
        await rebase();
        await pushTicketBranch(current.workspace.cwd, current.workspace.branch);
        continue;
      }
      await waitForDelivery(20000, signal);
    }

    const sync = await safeSyncLocal(sourceCwd, base);
    const integratedAt = new Date().toISOString();
    const productContext = contextContent == null ? null : await persistProductContext(dataDir, sourceCwd, contextContent);
    const handoff = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
      content: `# ${current.ticket.identifier} handoff\n\nRemote review: ${change.url}\n\nSquash commit: \`${mergeResult.commit}\`\n\nLocal sync: ${sync.status}${sync.reason ? ` — ${sync.reason}` : ""}.`
    });
    await trackerAction(ticketId, "delivery_complete", (ticket) => trackers.comment(ticket, `Merged after remote checks and review: ${change.url}\n\nSquash commit: ${mergeResult.commit}`));
    await trackerAction(ticketId, "tracker_done", (ticket) => trackers.transition(ticket, "done"));
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.integration = { sourceCwd, branch: current.workspace.branch, commit: mergeResult.commit, integratedAt, change, sync };
      Object.assign(run.merge, { status: "integrated", commit: mergeResult.commit, integratedAt, sync, externalActionPending: null });
      if (productContext) run.productContextPath = productContext.path;
      run.artifacts.push(handoff);
      run.status = "completed";
      run.lastError = null;
      run.completedAt = integratedAt;
      setStage(run, "handoff", "completed", `Merged via ${change.url}`).activity = activity.snapshot();
    });
    await stopTicketPreviews(ticketId, "run_completed");
    return { commit: mergeResult.commit, change, sync };
  })().catch(async (error) => {
    if (!signal?.aborted) await update((state) => {
      const run = ticketRun(state, ticketId);
      run.status = "needs_attention";
      run.lastError = error.message;
      if (run.merge) Object.assign(run.merge, { status: "failed", error: error.message, failedAt: new Date().toISOString() });
      setStage(run, "handoff", "blocked", error.message);
    });
    await mirrorExecutionBlocker(ticketId, error);
    throw error;
  }).finally(() => activeMerges.delete(ticketId));
  return { position: 1, promise };
}

async function scheduleTicketIntegration(ticketId, { diff, contextContent = null, signal } = {}) {
  const queuedRun = ticketRun(store.read(), ticketId);
  if (queuedRun.ticket.source !== "local") return scheduleRemoteDelivery(ticketId, { diff, contextContent, signal });
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
      run.recovery = null;
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
        const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:integration`, cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence) });
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
    await stopTicketPreviews(ticketId, "run_completed");
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
    const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:combined`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence) });
    const reviewImages = await harness.evidenceImages(checks.evidence);
    signal?.throwIfAborted();
    const afterTree = await snapshotTree(current.workspace.cwd);
    const diff = await diffTrees(current.workspace.cwd, current.baselineTree, afterTree);
    const reviews = [repositoryCheckReview(checks), ...await Promise.all(["requirements", "integration", "verification"].map((role) => harness.reviewTicket({
      cwd: current.workspace.cwd,
      ticket: current.ticket,
      plan: current.plan,
      artifacts: current.artifacts,
      diff,
      images: reviewImages,
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
      images: reviewImages, forkSessionFile: null, resumeSessionFile: null, feedback: "", ticketId, runId: current.runId,
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

function approvedPlanComment(run) {
  const steps = flattenSteps(run.plan).map((step, index) => `${index + 1}. ${step.title}${step.dependsOn?.length ? ` (after ${step.dependsOn.join(", ")})` : ""}`);
  return [
    "Implementation plan approved in Agent Plan Workspace.",
    run.plan.summary,
    ...steps,
    "The ticket snapshot is now frozen for this run. Progress and blockers will be posted here."
  ].filter(Boolean).join("\n\n");
}

async function ensureTrackerExecutionStarted(ticketId) {
  const run = ticketRun(store.read(), ticketId);
  if (!trackerBacked(run.ticket)) return;
  await trackerAction(ticketId, "execution_started", (ticket) => trackers.transition(ticket, "in_progress"));
  await trackerAction(ticketId, "approved_plan", (ticket) => trackers.comment(ticket, approvedPlanComment(ticketRun(store.read(), ticketId))));
}

async function mirrorExecutionBlocker(ticketId, error) {
  const run = store.read().ticketRuns[ticketId];
  if (!trackerBacked(run?.ticket)) return;
  const digest = createHash("sha256").update(error.message).digest("hex").slice(0, 12);
  await trackerAction(ticketId, `blocker:${digest}`, (ticket) => trackers.comment(ticket,
    `Agent Plan Workspace paused this run and needs attention.\n\n${error.message}\n\nResume from the local dashboard after resolving the blocker.`
  )).catch(() => {});
}

async function runTicket(ticketId) {
  return startTicketWork(ticketId, async (signal) => {
    try {
      signal.throwIfAborted();
      await ensureTrackerExecutionStarted(ticketId);
      await ensureLocalWorkspace(ticketId);
      await update((state) => {
        const run = ticketRun(state, ticketId);
        run.status = "running";
        run.recovery = null;
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
      await mirrorExecutionBlocker(ticketId, error);
    }
  });
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, store.read());
  if (request.method === "GET" && url.pathname === "/api/models") return json(response, 200, { provider: "openai-codex", models: await harness.models() });
  if (request.method === "GET" && url.pathname === "/api/tracker-settings") return json(response, 200, publicTrackerSettings(savedCredentials));
  if (request.method === "POST" && url.pathname === "/api/tracker-settings") {
    if (trackerRefresh) await trackerRefresh.catch(() => {});
    savedCredentials = await credentialStore.save(await body(request));
    trackers = trackerHub();
    ticketCache = new Map();
    const ticketSources = await refreshTrackers({ admit: false });
    return json(response, 200, { settings: publicTrackerSettings(savedCredentials), ticketSources });
  }
  const openArtifact = url.pathname.match(/^\/api\/tickets\/([^/]+)\/artifacts\/([^/]+)\/open$/);
  if (request.method === "POST" && openArtifact) {
    if (process.platform !== "darwin") throw new Error("Opening artifacts in the default editor currently requires macOS");
    const run = ticketRun(store.read(), decodeURIComponent(openArtifact[1]));
    const path = artifactPathForOpen(run.artifacts, decodeURIComponent(openArtifact[2]), dataDir);
    const file = path ? await stat(path).catch(() => null) : null;
    if (!file?.isFile()) throw new Error("Artifact file not found");
    await runFile("open", [path]);
    return json(response, 200, { opened: true });
  }
  if (request.method === "POST" && url.pathname === "/api/queue/clear") {
    let cleared = 0;
    const state = await update((draft) => { cleared = clearInactiveRuns(draft, new Set([...activeTickets.keys(), ...activeMerges])); });
    return json(response, 200, { cleared, state });
  }
  if (request.method === "GET" && url.pathname === "/api/retention") {
    return json(response, 200, await retentionInventory(store.read(), dataDir));
  }
  if (request.method === "POST" && url.pathname === "/api/retention/cleanup") {
    const input = await body(request);
    const ticketIds = [...new Set(Array.isArray(input.ticketIds) ? input.ticketIds.map(String) : [])];
    if (!input.confirmed || !ticketIds.length) throw new Error("Confirm at least one retained run for cleanup");
    const cleaned = [];
    for (const id of ticketIds) {
      if (activeTickets.has(id) || activeMerges.has(id)) throw new Error(`Cannot clean active run ${id}`);
      const snapshot = store.read();
      const run = snapshot.ticketRuns[id] || snapshot.retainedRuns?.[id];
      if (!run) throw new Error(`Retained run not found: ${id}`);
      if (!["completed", "failed", "needs_attention", "cancelled", "interrupted"].includes(run.status)) throw new Error(`Run ${id} is not safe to clean`);
      cleaned.push(await cleanupRetainedRun({ run, dataDir, previewManager: previews }));
      await update((draft) => {
        delete draft.ticketRuns[id];
        delete draft.retainedRuns?.[id];
        if (draft.selectedTicketId === id) draft.selectedTicketId = null;
      });
    }
    return json(response, 200, { cleaned, inventory: await retentionInventory(store.read(), dataDir), state: store.read() });
  }
  const sessionTrace = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/session-trace$/);
  if (request.method === "GET" && sessionTrace) {
    const run = ticketRun(store.read(), decodeURIComponent(sessionTrace[1]));
    const step = findNode(run.plan, decodeURIComponent(sessionTrace[2]));
    if (!step) throw new Error("Step not found");
    return json(response, 200, await harness.sessionTrace(step.sessionFile));
  }
  if (request.method === "POST" && url.pathname === "/api/stage-profiles") {
    const input = await body(request);
    const profiles = normalizeStageProfiles(input.profiles);
    const requestedCapacity = Number(input.settings?.maxConcurrentTickets);
    if (!Number.isInteger(requestedCapacity) || requestedCapacity < 1 || requestedCapacity > 32) throw new Error("Maximum concurrent tickets must be an integer from 1 to 32");
    if (!["manual", "automatic"].includes(input.settings?.projectMode)) throw new Error("Project mode must be manual or automatic");
    const requestedPollInterval = Number(input.settings?.pollIntervalSeconds);
    if (!Number.isInteger(requestedPollInterval) || requestedPollInterval < 15 || requestedPollInterval > 3600) throw new Error("Polling interval must be an integer from 15 to 3600 seconds");
    const settings = normalizeSettings(input.settings);
    await harness.validateProfiles(profiles);
    const state = await update((draft) => {
      draft.stageProfiles = profiles;
      draft.settings = settings;
    });
    scheduleTrackerPolling();
    if (settings.projectMode === "automatic") refreshTrackers().catch(() => {});
    return json(response, 200, state);
  }
  if (request.method === "GET" && url.pathname === "/api/tickets") {
    return json(response, 200, await refreshTrackers());
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
    const state = await update((draft) => { draft.workspace = { cwd }; });
    ticketCache = new Map();
    return json(response, 200, state);
  }
  if (request.method === "POST" && url.pathname === "/api/local/load") {
    const input = await body(request);
    ensureTicketCapacity("new-local-run");
    return json(response, 201, await loadLocalRun(String(input.path || "fixtures/zero-state-task-board")));
  }

  if (request.method === "POST" && url.pathname === "/api/tickets/start") {
    const input = await body(request);
    const ids = [...new Set(Array.isArray(input.ticketIds) ? input.ticketIds.map(String) : [])];
    if (!ids.length) throw new Error("Select at least one ticket");
    const tickets = ids.map((id) => ticketCache.get(id));
    if (tickets.some((ticket) => !ticket)) throw new Error("Refresh the ticket sources before starting the selection");
    const available = executionCapacity() - occupiedTicketIds(store.read()).size;
    if (tickets.length > available) throw new Error(`Only ${Math.max(0, available)} ticket slots are available`);
    for (const ticket of tickets) await beginTicket(ticket);
    return json(response, 202, { accepted: true, ticketIds: ids });
  }

  const start = url.pathname.match(/^\/api\/tickets\/([^/]+)\/start$/);
  if (request.method === "POST" && start) {
    const id = decodeURIComponent(start[1]);
    const input = await body(request);
    const ticket = ticketCache.get(id) || input.ticket;
    await beginTicket(ticket);
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
    if (run.recovery?.kind === "delivery") {
      if (run.recovery.uncertainExternalActions && !run.merge?.change) throw new Error(run.recovery.message);
      ensureTicketCapacity(id);
      const contextContent = [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "product-context-update")?.content || null;
      const diff = run.reviews?.at(-1)?.diff || null;
      scheduleTicketIntegration(id, { diff, contextContent }).catch(() => {});
      return json(response, 202, { accepted: true, ticketId: id, recovery: "delivery" });
    }
    const stage = resumeStage(run);
    if (!["run", "requirements", "explore", "design"].includes(stage)) throw new Error("This run cannot be resumed from its current stage");
    ensureTicketCapacity(id);
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
      await acceptCheckpointAnswer(id, answers, "dashboard");
    }
    else if (["technical_input", "needs_input"].includes(run.checkpoint?.kind)) {
      if (!answers.trim()) throw new Error("Answer the open technical questions before continuing");
      await acceptCheckpointAnswer(id, answers, "dashboard");
    }
    else throw new Error("This ticket has no open question");
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const editPlan = url.pathname.match(/^\/api\/tickets\/([^/]+)\/plan$/);
  if (request.method === "POST" && editPlan) {
    const id = decodeURIComponent(editPlan[1]);
    const run = ticketRun(store.read(), id);
    if (!planApprovalPending(run)) throw new Error("Plans can only be edited at the approval checkpoint");
    const input = await body(request);
    const plan = normalizeEditedPlan(input.plan);
    const state = await update((draft) => {
      const current = ticketRun(draft, id);
      current.plan = plan;
      current.planEditedAt = new Date().toISOString();
    });
    return json(response, 200, state);
  }

  const approve = url.pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/);
  if (request.method === "POST" && approve) {
    const id = decodeURIComponent(approve[1]);
    ensureTicketCapacity(id);
    const run = ticketRun(store.read(), id);
    if (!planApprovalPending(run)) throw new Error("This ticket has no plan awaiting approval");
    const input = await body(request);
    await update((state) => {
      const current = ticketRun(state, id);
      current.auto = input.auto === undefined ? Boolean(current.automaticAdmission) : Boolean(input.auto);
      current.status = "awaiting_approval";
      current.ticketSnapshot = structuredClone(current.ticket);
      current.trackerRevision = current.ticket.updatedAt || null;
      current.planApprovedAt = new Date().toISOString();
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

scheduleTrackerPolling();
server.listen(port, host, () => {
  console.log(`Agent Plan Workspace: http://${host}:${port}`);
  console.log(`Repository: ${store.read().workspace.cwd}`);
  console.log(`Trackers: ${trackers.configured ? "configured" : "add Linear or Jira credentials in the dashboard"}`);
  console.log(`Data: ${dataDir}`);
  refreshTrackers().catch((error) => console.error(`Tracker refresh failed: ${error.message}`));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  await daemonLock.release();
  process.exit(0);
});
server.once("close", () => daemonLock.release().catch(() => {}));
