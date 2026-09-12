import { createOrchestratorService, guardOrchestratorUpdate } from "./orchestration.js";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { createArtifactReader, persistArtifact } from "./artifacts.js";
import { boundedText, redactRecord, redactText } from "./redaction.js";
import { admissionCandidates } from "./admission.js";
import { deliveryForRemote } from "./delivery.js";
import { JiraClient } from "./jira.js";
import { LinearClient } from "./linear.js";
import { PiHarness } from "./pi-harness.js";
import { flattenSteps } from "./plan.js";
import { JsonStore, normalizeSettings } from "./store.js";
import { TrackerHub } from "./trackers.js";
import { migrateFinalProofLocators, publicState } from "./execution.js";
import { PreviewManager } from "./previews.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { CredentialStore, effectiveTrackerCredentials, publicTrackerSettings } from "./credentials.js";
import { createHandleRequest } from "./http.js";
import { createSteeringService } from "./steering.js";
import { createInspectionService, createRouteInspectionService } from "./inspection.js";
import { RunRuntime } from "./run-runtime.js";
import { stageActivity, stepActivity } from "./activity.js";
import { createDeliveryRunner } from "./delivery-runner.js";
export { deliveryFeedbackReferences, deliveryFailureNeedsFix } from "./delivery-runner.js";
import { createFinalReviewRunner } from "./final-review.js";
import { createStepRunner } from "./step-runner.js";
import { createPlanningRunner } from "./planning.js";
import { createTicketRunner } from "./ticket-runner.js";
import { createCoordinationService } from "./coordination-service.js";
import { createPreviewOrchestrator } from "./preview-orchestration.js";
import { auditHarnessWriteScopes } from "./pi-prompts.js";
export { auditHarnessWriteScopes } from "./pi-prompts.js";
export { captureProofCriteria, reconcileVisualChecks } from "./preview-orchestration.js";
import { createSettingsService, createWorkspaceService } from "./operator-services.js";
import { createRoutes } from "./routes.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const runFile = promisify(execFile);
const publicDir = join(here, "public");
const packageMetadata = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
const maxProofFeedbackLength = 4000;
function cliOption(name, fallback, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function repositoryCheckReview(checks) {
  const missingVisualEvidence = ["visual-evidence", "capture-configuration", "capture-preflight"].includes(checks.failureKind);
  const failed = checks.failedRepositories || [];
  const where = failed.length ? ` in ${failed.map((item) => item.displayPath || item.repositoryId).join(", ")}` : "";
  const failureDiagnostic = String(checks.failureHighlights || "").trim().slice(-1500);
  return {
    role: "deterministic",
    summary: checks.summary,
    findings: checks.status !== "passed" ? [{
      severity: "blocking",
      category: missingVisualEvidence ? "evidence" : "tests",
      claim: missingVisualEvidence ? checks.summary : `Repository check failed${where}: ${checks.command}${failureDiagnostic ? `\n${failureDiagnostic}` : ""}`,
      evidence: failed.map((item) => ({ file: item.displayPath || item.repositoryId, line: 1 })),
      suggestedFix: missingVisualEvidence
        ? `Repair the separate capture-proof command or fixture; keep the canonical verifier independent of browser capture. Produce enough ticket-bound evidence to cover every required visual criterion, with journey assertions and a final-proof-manifest.json.\n\n${checks.summary}\n${checks.failureHighlights || (["capture-proof", "test-capture-proof"].includes(checks.command) ? checks.output : "") || ""}`
        : `Make ${checks.command} pass.${checks.failureHighlights ? `\n\nFailure highlights:\n${checks.failureHighlights}` : `\n\n${checks.output}`}`,
      confidence: "high"
    }] : [],
    checks
  };
}

export function closeSseClients(clients) {
  for (const client of clients) {
    try { client.response.end(); } catch {}
  }
  clients.clear();
}

export function settleScheduledDelivery(scheduled) {
  return Promise.resolve(scheduled).then(({ promise }) => promise).catch(() => {});
}

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

export async function createDaemon(options = {}) {
  const asyncActionResponse = new AsyncLocalStorage();
  const initialCwd = options.cwd || cliOption("--cwd", process.cwd());
  const port = Number(options.port ?? cliOption("--port", process.env.PORT || 4317));
  const host = options.host || cliOption("--host", process.env.HOST || "127.0.0.1");
  const vcsMode = options.vcsMode || cliOption("--vcs", process.env.AGENT_PLAN_VCS || "jj");
  if (!["git", "jj"].includes(vcsMode)) throw new Error(`Unsupported VCS mode: ${vcsMode}`);
  const dataDir = options.dataDir || process.env.AGENT_PLAN_DATA_DIR || join(homedir(), ".agent-plan-workspace");
  const apiToken = options.apiToken ?? process.env.AGENT_PLAN_API_TOKEN ?? "";
  const lifecycleCleanupTimeoutMs = Math.max(1, Number(options.lifecycleCleanupTimeoutMs) || 5_000);
  const workerAbortWaitMs = Math.max(1, Number(options.workerAbortWaitMs) || 1_000);
  const shutdownTimeoutMs = Math.max(1, Number(options.shutdownTimeoutMs) || 5_000);
  const listen = Boolean(options.listen);
  const useLock = options.lock !== false;
  const daemonLock = useLock ? await acquireDaemonLock(join(dataDir, "daemon.lock")) : { async release() {} };
  const store = new JsonStore(join(dataDir, "state-v3.json"), initialCwd);
  await store.init();
  // Stored runs predate proofStorageRoot. Migrate them once so evidence adoption
  // and every later projection use the daemon's canonical storage boundary.
  await store.update((state) => {
    for (const bucket of [state.ticketRuns, state.retainedRuns]) for (const run of Object.values(bucket || {})) {
      run.proofStorageRoot ||= dataDir;
      migrateFinalProofLocators(run);
    }
  });

const credentialStore = new CredentialStore(join(dataDir, "credentials.json"));
let savedCredentials = await credentialStore.load();
function trackerHub() {
  const credentials = effectiveTrackerCredentials(savedCredentials);
  return new TrackerHub([
    new LinearClient({ apiKey: credentials.linear.apiKey }),
    new JiraClient(credentials.jira)
  ]);
}
let trackers = options.trackers || trackerHub();
const harness = options.harness || new PiHarness({ dataDir, publish });
const previews = new PreviewManager({ dataDir });
const clients = new Set();
const runtime = new RunRuntime({
  readState: store.read.bind(store),
  update,
  harness,
  mockRepositoryChecks: options.harness?.runRepositoryChecks ?? null,
  isClosed: () => closed,
  cleanupTimeoutMs: lifecycleCleanupTimeoutMs,
  workerAbortWaitMs
});
const previewService = createPreviewOrchestrator({
  state: { read: store.read.bind(store), update },
  runtime,
  previews,
  address: () => server.address()
});
const {
  runChecksWithPreview,
  runChangedRepositoryChecks,
  startOperatorPreview,
  stopOperatorPreview,
  stopTicketPreviews
} = previewService;
const artifactReader = createArtifactReader({ dataDir });
const {
  artifactContent,
  artifactText,
  hydrateArtifacts
} = artifactReader;
const inspectionService = createInspectionService({
  artifactContent,
  sessionTrace: (...args) => harness.sessionTrace(...args)
});
const {
  artifactForIdentity,
  attemptDetails,
  detailActivityEvent,
  inspectionHistories,
  promptsForStage,
  runForIdentity,
  textDetail
} = inspectionService;
const steeringService = createSteeringService({
  readState: store.read.bind(store),
  update,
  runtime,
  harness,
  mirrorCheckpoint
});
const {
  clearDrain: clearSteeringDrain,
  drain: drainSteering,
  deliver: deliverSteering
} = steeringService;
const { activeSteps, activeTickets, activeContainments, activeMerges, mergeQueues } = runtime;
const { steeringDrainTimers } = runtime;
const resolveDeliveryForRemote = options.deliveryForRemote || deliveryForRemote;
const deliveryPollMs = Math.max(1, Number(options.deliveryPollMs) || 20_000);
let ticketCache = new Map();
let trackerRefresh = null;
let pollTimer = null;
const deliveryService = createDeliveryRunner({
  state: { read: store.read.bind(store), update },
  runtime,
  checks: { runWithPreview: runChecksWithPreview, runRepository: runtime.runContainedRepositoryChecks.bind(runtime) },
  worker: { run: runtime.runContainedWorker.bind(runtime) },
  activity: { capture: captureStageActivity },
  tracker: { action: trackerAction, comment: (ticket, message) => trackers.comment(ticket, message), done: (ticket) => trackers.transition(ticket, "done") },
  artifacts: { dataDir, hydrate: hydrateArtifacts },
  lifecycle: { stopPreviews: stopTicketPreviews, mirrorBlocker: mirrorExecutionBlocker },
  options: { deliveryForRemote: resolveDeliveryForRemote, deliveryPollMs }
});
const finalReviewService = createFinalReviewRunner({
  state: { read: store.read.bind(store), update },
  checks: { runChanged: runChangedRepositoryChecks, repositoryCheckReview },
  worker: { run: runtime.runContainedWorker.bind(runtime), updateProductContext: (input) => harness.updateProductContext(input), evidenceImages: (input) => harness.evidenceImages(input), reviewTicket: (input) => harness.reviewTicket(input) },
  activity: { capture: captureStageActivity },
  artifacts: { dataDir, hydrate: hydrateArtifacts },
  proof: { snapshot: persistProofSnapshot }
});
const stepService = createStepRunner({
  state: { read: store.read.bind(store), update }, runtime,
  worker: { run: runtime.runContainedWorker.bind(runtime), verifyStep: (input) => harness.verifyStep(input), reviewWorkerReport: (input) => harness.reviewWorkerReport(input), generateCommitMessage: (input) => harness.generateCommitMessage(input), evidenceImages: (input) => harness.evidenceImages(input) },
  checks: { runChanged: runChangedRepositoryChecks, repositoryCheckReview }, proof: { snapshot: persistProofSnapshot },
  artifacts: { hydrate: hydrateArtifacts, persist: persistArtifact, text: artifactText, dataDir }, activity: { capture: captureStepActivity },
  steering: { drain: drainSteering, clear: clearSteeringDrain },
  lifecycle: { mirrorCheckpoint },
  coordination: { forWorker: (target) => coordinationService.forWorker(target) }
});
const coordinationService = createCoordinationService({ readState: store.read.bind(store), update, runtime, harness, dataDir });
const planningService = createPlanningRunner({
  state: { read: store.read.bind(store), update },
  runtime,
  harness,
  artifacts: { dataDir, artifactText },
  activity: { capture: captureStageActivity },
  lifecycle: {
    mirrorCheckpoint,
    saveSession: saveRunSession
  },
  ticketSources: () => ticketCache.values(),
  vcsMode
});

const ticketService = createTicketRunner({
  state: { read: store.read.bind(store), update },
  runtime,
  dataDir,
  lifecycle: { mirrorCheckpoint, stopPreviews: stopTicketPreviews },
  tracker: {
    ensureExecutionStarted: ensureTrackerExecutionStarted,
    mirrorBlocker: mirrorExecutionBlocker,
    answer: (ticket, message) => trackers.comment(ticket, message)
  },
  steps: {
    execute: (ticketId, stepId, options) => stepService.executeStep(ticketId, stepId, options),
    accept: (ticketId, stepId) => stepService.acceptStep(ticketId, stepId)
  },
  finalReview: { run: (ticketId, signal) => finalReviewService.finalReviewLoop(ticketId, signal) },
  delivery: { schedule: (ticketId, options) => deliveryService.scheduleAllDeliveries(ticketId, options) },
  artifacts: { artifactText, persist: persistArtifact },
  proof: { persistSnapshot: persistProofSnapshot },
  planning: {
    prepare: planningService.prepareTicket,
    continueRequirements: planningService.continueAfterRequirements,
    reviseProposal: planningService.reviseUiProposal,
    design: planningService.designTicket
  },
  harness: {
    continueWorkflow: harness.continueWorkflow.bind(harness),
    activateWorkflow: harness.activateWorkflow
      ? harness.activateWorkflow.bind(harness)
      : async () => { throw new Error("Workflow activation is unavailable"); },
    generateReviewMap: harness.generateReviewMap
      ? harness.generateReviewMap.bind(harness)
      : async () => { throw new Error("Review map generation is unavailable"); },
    generateCommitMessage: harness.generateCommitMessage
      ? harness.generateCommitMessage.bind(harness)
      : async () => { throw new Error("Commit message generation is unavailable"); }
  },
  config: {
    packageMetadata,
    isAsyncResponse: () => Boolean(asyncActionResponse.getStore()),
    ticketById: (ticketId) => ticketCache.get(ticketId),
    publishSelection: (selection) => publish({ type: "selection", ...selection })
  }
});

function subscribeEvents(request, response, state) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const client = { response, queue: [] };
  response.on("drain", () => flushSse(client));
  response.write(`data: ${JSON.stringify({ type: "state", state })}\n\n`);
  clients.add(client);
  request.on("close", () => clients.delete(client));
}

const routeInspection = createRouteInspectionService({
  state: { read: store.read.bind(store) },
  details: inspectionService,
  artifactContent,
  harness,
  dataDir,
  trackers: { refresh: refreshTrackers },
  events: { subscribe: subscribeEvents }
});

const workspaceService = createWorkspaceService({
  vcsMode, runtime,
  state: { read: store.read.bind(store), update },
  harness,
  ticketSources: { clear: () => { ticketCache = new Map(); } },
  loadLocal: ticketService.loadLocalRun
});

const settingsService = createSettingsService({
  state: { read: store.read.bind(store), update },
  runtime,
  previews,
  dataDir,
  harness,
  credentials: {
    public: (saved = savedCredentials) => publicTrackerSettings(saved),
    save: async (input) => {
      savedCredentials = await credentialStore.save(input);
      return savedCredentials;
    }
  },
  trackers: {
    waitForRefresh: () => trackerRefresh?.catch(() => {}),
    replace: async () => { trackers = trackerHub(); ticketCache = new Map(); },
    refresh: refreshTrackers,
    schedulePolling: scheduleTrackerPolling
  }
});

function writeSse(client, chunk) {
  if (client.response.destroyed) {
    clients.delete(client);
    return;
  }
  if (client.response.writableNeedDrain || client.queue.length) {
    client.queue.push(chunk);
    if (client.queue.length > 200) client.queue.shift();
    return;
  }
  if (!client.response.write(chunk)) client.draining = true;
}

function flushSse(client) {
  while (client.queue.length && !client.response.destroyed && !client.response.writableNeedDrain) {
    if (!client.response.write(client.queue.shift())) break;
  }
}

function publish(event) {
  const encoded = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) writeSse(client, encoded);
}

function publishState(state = store.read()) { publish({ type: "state", state: publicState(state) }); }

function publishStepEvent(ticketId, stepId, runId, event) {
  const publicEvent = redactRecord(event);
  if (publicEvent.type === "prompt") {
    const prompt = boundedText(publicEvent.content || publicEvent.prompt, 16000);
    publicEvent.content = prompt.value;
    publicEvent.truncated = Boolean(publicEvent.truncated) || prompt.truncated;
    publicEvent.total = Math.max(prompt.total, Number(publicEvent.total) || 0);
    delete publicEvent.prompt;
  }
  publish({ channel: "run", ticketId, stepId, runId, ...publicEvent });
  if (!["prompt", "phase", "tool_start", "tool_end", "agent_error"].includes(publicEvent.type)) return;
  update((state) => {
    const active = state.ticketRuns[ticketId]?.activeRuns?.[stepId];
    if (!active || active.runId !== runId) return;
    if (publicEvent.type === "prompt") Object.assign(active, {
      prompt: publicEvent.content,
      promptTruncated: publicEvent.truncated,
      promptTotal: publicEvent.total
    });
    active.lastEvent = redactText(publicEvent.label);
    active.lastEventAt = new Date().toISOString();
    active.warning = publicEvent.type === "agent_error" || (publicEvent.type === "tool_end" && publicEvent.isError);
  }, { publish: false }).catch(() => {});
}

function captureStageActivity(ticketId, stageId, runId) {
  return stageActivity({ store, update, emit: publish, ticketId, stageId, runId });
}

function captureStepActivity(ticketId, stepId, runId) {
  return stepActivity({ store, update, emit: (event) => publishStepEvent(ticketId, stepId, runId, event), ticketId, stepId, runId });
}





async function update(change, { publish: shouldPublish = true } = {}) {
  const state = await store.update((draft) => guardOrchestratorUpdate(draft, change), { snapshot: false });
  if (shouldPublish) publishState(state);
  return state;
}





function saveRunSession(ticketId, runId, field = "sessionFile", signal) {
  return async (sessionFile) => {
    if (!sessionFile || signal?.aborted) return;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (!signal?.aborted && run?.runId === runId) run[field] = sessionFile;
    }, { publish: false });
  };
}











async function persistProofSnapshot(ticketId, { stageId = "proof", stepId = null, attemptId = null, name = "proof-map.json" } = {}) {
  const run = ticketRun(store.read(), ticketId);
  if (!run.proofMap) return null;
  const artifact = await persistArtifact(dataDir, run.ticket, {
    runId: run.runId, stageId, stepId, attemptId, name, kind: "proof-map",
    content: JSON.stringify(run.proofMap, null, 2)
  });
  await update((state) => {
    const current = state.ticketRuns[ticketId];
    if (current?.runId === run.runId && current.proofMap) current.artifacts.push(artifact);
  });
  return artifact;
}












function trackerBacked(ticket) { return ["linear", "jira"].includes(ticket?.provider); }

async function trackerAction(ticketId, key, action) {
  const run = ticketRun(store.read(), ticketId);
  if (!trackerBacked(run.ticket)) return null;
  if (run.trackerEvents?.[key]) return run.trackerEvents[key].result;
  let result;
  try { result = await action(run.ticket); }
  catch (error) {
    await update((state) => { ticketRun(state, ticketId).trackerSyncError = `Could not sync ${key}: ${redactText(error.message)}`; });
    throw error;
  }
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
      if (current) current.trackerSyncError = `Could not mirror checkpoint: ${redactText(error.message)}`;
    });
  }
}



async function beginTicket(ticket, options = {}) { return ticketService.beginTicket(ticket, options); }

async function acceptCheckpointAnswer(ticketId, answers, source, options = {}) {
  return ticketService.acceptCheckpointAnswer(ticketId, answers, source, options);
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
      await update((state) => { if (state.ticketRuns[run.id]) state.ticketRuns[run.id].trackerSyncError = `Could not read tracker answers: ${redactText(error.message)}`; });
    }
  }));
}

async function admitAutomaticTickets(tickets) {
  const state = store.read();
  if (state.settings.projectMode !== "automatic") return [];
  const admitted = [];
  for (const ticket of admissionCandidates(tickets, state)) admitted.push(await beginTicket(ticket, { automaticAdmission: true }));
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
    `Agent Plan Workspace paused this run and needs attention.\n\n${redactText(error.message)}\n\nResume from the local dashboard after resolving the blocker.`
  )).catch(() => {});
}







// CLI actions acknowledge launch; their existing wait command observes completion.
// Request-local state keeps concurrent dashboard/test callers' waiting behavior.
function api(request, response, url) {
  const respondAsync = String(request.headers?.prefer || "").split(",").some((value) => value.trim().toLowerCase() === "respond-async");
  return asyncActionResponse.run(respondAsync, () => routeApi(request, response, url));
}



const ticketRoutes = {
  ...ticketService,
  cancel: ticketService.cancelTicket,
  pause: ticketService.pauseTicket,
  async finishHandoff(ticketId) {
    const result = await ticketService.finishHandoff(ticketId);
    void settleScheduledDelivery(result.queued);
  }
};

const orchestrator = createOrchestratorService({ state: { read: store.read.bind(store), update }, tickets: ticketService, dataDir });
const routeApi = createRoutes({
  orchestrator,
  version: packageMetadata.version,
  inspection: routeInspection,
  tickets: ticketRoutes,
  workspace: workspaceService,
  previews: { start: startOperatorPreview, stop: stopOperatorPreview, replay: previewService.replayJourneys },
  steering: { submit: steeringService.submit },
  coordination: coordinationService,
  settings: settingsService
});

const handleRequest = createHandleRequest({ publicDir, apiToken, host, port, api });
const server = createServer(handleRequest);
const sseHeartbeat = setInterval(() => {
  for (const client of clients) writeSse(client, ":\n\n");
}, 15000);
sseHeartbeat.unref();

let closed = false;
let closePromise = null;
function closeHttpServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, shutdownTimeoutMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function close({ exit = false } = {}) {
  if (closePromise) return closePromise;
  closed = true;
  closePromise = (async () => {
    clearInterval(pollTimer);
    clearInterval(sseHeartbeat);
    runtime.clearSteeringTimers();
    coordinationService.close();
    closeSseClients(clients);
    for (const active of [...activeTickets.values()]) active.controller.abort(new Error("Daemon shutting down"));
    await Promise.all([
      ...[...activeTickets.values()].map((active) => runtime.waitForWorkerAbort(active.promise)),
      ...[...new Set([...activeContainments.values()].map((entry) => entry.ticketId))].map((ticketId) => runtime.cleanupTicketContainments(ticketId, "daemon-shutdown"))
    ]);
    try { harness.reset(); } catch {}
    previews.stopAll({ trigger: "preview-stop", reason: "daemon-shutdown" });
    await previews.settleAll(lifecycleCleanupTimeoutMs);
    await closeHttpServer();
    await daemonLock.release().catch(() => {});
    if (exit) process.exit(0);
  })();
  return closePromise;
}

if (listen) {
  scheduleTrackerPolling();
  server.listen(port, host, () => {
    console.log(`Agent Plan Workspace: http://${host}:${port}`);
    console.log(`Repository: ${store.read().workspace.cwd}`);
    console.log(`Trackers: ${trackers.configured ? "configured" : "add Linear or Jira credentials in the dashboard"}`);
    console.log(`Data: ${dataDir}`);
    refreshTrackers().catch((error) => console.error(`Tracker refresh failed: ${error.message}`));
  });
  for (const signalName of ["SIGINT", "SIGTERM"]) process.once(signalName, () => { close({ exit: true }); });
}
server.once("close", () => daemonLock.release().catch(() => {}));

return { handleRequest, api, close, store, server, harness, previews, host, port, dataDir };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await createDaemon({ listen: true });
