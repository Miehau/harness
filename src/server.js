import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { artifactPathForOpen, persistArtifact, persistProductContext, readProductContext, safeName, visualEvidenceComment, visualEvidenceHandoffSection, visualEvidenceMedia } from "./artifacts.js";
import { admissionCandidates } from "./admission.js";
import { diffTrees, normalizeReviewNotes, outsideWriteScope, restoreTree, reviewNoteFeedback, snapshotTree } from "./git.js";
import { deliveryForRemote, pushTicketBranch, rebaseOntoRemote, remoteContext, safeSyncLocal } from "./delivery.js";
import { JiraClient } from "./jira.js";
import { acceptJjChange, beginJjChange, initializeJjWorkspace, prepareJjForGit, snapshotJjChange } from "./jj.js";
import { LinearClient } from "./linear.js";
import { loadLocalFixture } from "./local.js";
import { enqueueSerial } from "./merge-queue.js";
import { ensureVerificationContractStep, formatTicketHorizon, PiHarness, workerWriteScope } from "./pi-harness.js";
import { projectConfigPath } from "./project-config.js";
import { blockingReasons, dependencyArtifacts, dependencySteps, diffReviewBudget, findNode, flattenSteps, normalizeEditedPlan, normalizePlan, planReviewViolations, reviewBudgetRequiresRollback } from "./plan.js";
import { JsonStore, normalizeSettings } from "./store.js";
import { TrackerHub } from "./trackers.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, ensureTicketWorktree, integrateBranch, needsLocalWorkspaceRepair, repairZeroStateWorkspace } from "./worktrees.js";
import { actionableFindings, archiveRun, clearInactiveRuns, compactRun, correctionPauseReason, createActivityCapture, createTicketRun, findingsFingerprint, interruptedStepFeedback, localStages, markRunCancelled, markRunPaused, nextCorrectionRound, nextRunnableBatch, pendingReviewFix, planApprovalPending, prepareRunResume, publicPreviewState, publicRun, publicState, resumeStage, rewindRun, selectWorkerSession, shouldPauseCorrection, supervisorReviewCheckpoint, unaddressedReviewClusters, verificationFocusFindings, workerReportCheckpoint, workflowResumeStage } from "./execution.js";
import { normalizeStageProfiles } from "./profiles.js";
import { PreviewManager } from "./previews.js";
import { cleanupRetainedRun, retentionInventory } from "./retention.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { CredentialStore, effectiveTrackerCredentials, publicTrackerSettings } from "./credentials.js";
import { applyPendingWorkflowGate, applyWorkflowContinuation, bindWorkflowSkill, executionBlockedByWorkflow, initialWorkflow, isWorkflowRunCheckpoint, runCheckpointFromWorkflow, workflowBlockers } from "./workflow.js";
import { body, createHandleRequest, json } from "./http.js";
import { earlyFailureStatusSet, replaceableRunStatusSet, terminalRunStatusSet } from "./run-status.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const runFile = promisify(execFile);
const publicDir = join(here, "public");
const packageMetadata = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
function cliOption(name, fallback, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function repositoryCheckReview(checks) {
  const missingVisualEvidence = checks.failureKind === "visual-evidence";
  return {
    role: "deterministic",
    summary: checks.summary,
    findings: checks.status === "failed" ? [{
      severity: "blocking",
      category: missingVisualEvidence ? "evidence" : "tests",
      claim: missingVisualEvidence ? checks.summary : `Repository check failed: ${checks.command}`,
      evidence: [],
      suggestedFix: missingVisualEvidence
        ? "Configure a preview command or make the verification contract capture the required visual evidence."
        : `Make ${checks.command} pass.${checks.failureHighlights ? `\n\nFailure highlights:\n${checks.failureHighlights}` : `\n\n${checks.output}`}`,
      confidence: "high"
    }] : [],
    checks
  };
}

export function reconcileVisualChecks(checks, evidence = [], { required = false, requiredVideo = false } = {}) {
  checks.evidence = [...new Map([...(checks.evidence || []), ...evidence].map((item) => [item.path, item])).values()];
  const hasImage = checks.evidence.some((item) => item.mediaKind === "image");
  const hasVideo = checks.evidence.some((item) => item.mediaKind === "video");
  if (checks.failureKind === "visual-evidence" && hasImage && (!requiredVideo || hasVideo)) {
    checks.status = "passed";
    checks.summary = `${checks.command} passed with ${checks.evidence.length} visual artifact${checks.evidence.length === 1 ? "" : "s"}.`;
    delete checks.failureKind;
  }
  if (required && (!hasImage || (requiredVideo && !hasVideo))) Object.assign(checks, {
    status: "failed",
    failureKind: "visual-evidence",
    summary: requiredVideo && hasImage
      ? "Visual verification produced no video evidence."
      : "Visual verification produced no desktop or mobile evidence."
  });
  return checks;
}

export function closeSseClients(clients) {
  for (const client of clients) {
    try { client.response.end(); } catch {}
  }
  clients.clear();
}

export function auditHarnessWriteScopes(run, at = new Date().toISOString()) {
  const changes = [];
  for (const step of flattenSteps(run?.plan)) {
    const before = String(step.writeScope || "");
    const after = workerWriteScope(step);
    if (after === before) continue;
    const paths = after.split(",").filter((path) => !before.split(",").includes(path));
    step.writeScope = after;
    step.expectedFiles = [...new Set([...(step.expectedFiles || []), ...paths])];
    step.scopeChanges ||= [];
    step.scopeChanges.push({
      at, paths, source: "harness",
      reason: "Visual verification must be able to correct its repository-owned evidence contract."
    });
    changes.push({ stepId: step.id, paths });
  }
  return changes;
}

export async function createDaemon(options = {}) {
  const initialCwd = options.cwd || cliOption("--cwd", process.cwd());
  const port = Number(options.port ?? cliOption("--port", process.env.PORT || 4317));
  const host = options.host || cliOption("--host", process.env.HOST || "127.0.0.1");
  const vcsMode = options.vcsMode || cliOption("--vcs", process.env.AGENT_PLAN_VCS || "jj");
  if (!["git", "jj"].includes(vcsMode)) throw new Error(`Unsupported VCS mode: ${vcsMode}`);
  const dataDir = options.dataDir || process.env.AGENT_PLAN_DATA_DIR || join(homedir(), ".agent-plan-workspace");
  const apiToken = options.apiToken ?? process.env.AGENT_PLAN_API_TOKEN ?? "";
  const listen = Boolean(options.listen);
  const useLock = options.lock !== false;
  const daemonLock = useLock ? await acquireDaemonLock(join(dataDir, "daemon.lock")) : { async release() {} };
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
let trackers = options.trackers || trackerHub();
const harness = options.harness || new PiHarness({ dataDir, publish });
const previews = new PreviewManager({ dataDir });
const clients = new Set();
const activeSteps = new Map();
const activeTickets = new Map();
const activeMerges = new Set();
const mergeQueues = new Map();
let ticketCache = new Map();
let trackerRefresh = null;
let pollTimer = null;

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

function captureStepActivity(ticketId, stepId, runId) {
  const existing = store.read().ticketRuns[ticketId]?.activeRuns?.[stepId]?.activity;
  return createActivityCapture({
    existing,
    persist: (activity) => update((state) => {
      const active = state.ticketRuns[ticketId]?.activeRuns?.[stepId];
      if (active?.runId === runId) active.activity = activity;
    }, { publish: false }),
    emit: (event) => publishStepEvent(ticketId, stepId, runId, event)
  });
}

async function runChecksWithPreview({ ticketId, previewId, cwd, signal, required, requiredVideo = false, stepId = null }) {
  let preview = null;
  let evidence = [];
  if (required) {
    preview = await previews.ensure({ id: previewId, cwd, seedState: publicPreviewState(store.read(), ticketId) });
    if (preview) evidence = await previews.capture(previewId);
  }
  const checks = await harness.runRepositoryChecks({ cwd, signal, requireVisualEvidence: required, requireVideoEvidence: requiredVideo });
  reconcileVisualChecks(checks, evidence, { required, requiredVideo });
  if (preview || checks.evidence.length) await update((state) => {
    const run = ticketRun(state, ticketId);
    run.previews ||= {};
    if (preview) run.previews[previewId] = preview;
    for (const item of checks.evidence) if (!run.artifacts.some((artifact) => artifact.path === item.path)) run.artifacts.push({
      id: randomUUID(), name: item.name, path: item.path, kind: "visual-evidence", stageId: "verify", stepId,
      mediaType: item.mediaType, mediaKind: item.mediaKind,
      summary: item.viewport ? `${item.viewport.width}×${item.viewport.height} · ${item.url}` : item.mediaType,
      createdAt: new Date().toISOString()
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

async function pauseTicket(ticketId) {
  const active = activeTickets.get(ticketId);
  if (!active) throw new Error("This run is not active");
  active.controller.abort(new Error("Run paused"));
  await active.promise.catch(() => {});
  let audit;
  const state = await update((draft) => {
    audit = markRunPaused(ticketRun(draft, ticketId));
  });
  const run = ticketRun(state, ticketId);
  const artifact = await persistArtifact(dataDir, run.ticket, {
    runId: run.runId,
    stageId: audit.stageId,
    name: `${audit.id}-checkpoint.json`,
    kind: "pause-checkpoint",
    content: JSON.stringify(audit, null, 2)
  });
  await update((draft) => {
    const current = ticketRun(draft, ticketId);
    current.artifacts.push(artifact);
    const saved = current.pauseHistory?.find((item) => item.id === audit.id);
    if (saved) saved.artifactId = artifact.id;
  });
  await stopTicketPreviews(ticketId, "run_paused");
  return { auditId: audit.id, artifactId: artifact.id };
}

function saveRunSession(ticketId, field = "sessionFile") {
  return async (sessionFile) => {
    if (!sessionFile) return;
    await update((state) => { ticketRun(state, ticketId)[field] = sessionFile; }, { publish: false });
  };
}

function saveStepSession(ticketId, stepId, runId) {
  return async (sessionFile) => {
    if (!sessionFile) return;
    await update((state) => {
      const run = ticketRun(state, ticketId);
      const step = findNode(run.plan, stepId);
      if (step) step.sessionFile = sessionFile;
      const active = run.activeRuns?.[stepId];
      if (active?.runId === runId) active.sessionFile = sessionFile;
    }, { publish: false });
  };
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

async function promptsForStage(run, stage) {
  const prompts = [];
  const seen = new Set();
  const add = ({ prompt, content, at, actor, title, status }) => {
    const value = String(prompt || content || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    prompts.push({ prompt: value, at: at || null, title: title || actor || stage.title, status: status || stage.status });
  };
  for (const prompt of stage.activity?.prompts || []) add(prompt);
  const trace = async (sessionFile, meta = {}, bounds = {}) => {
    if (!sessionFile) return;
    const saved = await harness.sessionTrace(sessionFile, bounds);
    for (const prompt of saved.prompts || (saved.prompt ? [{ prompt: saved.prompt }] : [])) add({ ...prompt, ...meta });
  };
  const bounds = { after: stage.activity?.startedAt, before: stage.activity?.completedAt };
  if (stage.id === "requirements") await trace(run.requirementsSessionFile, {}, bounds);
  if (["explore", "design"].includes(stage.id)) await trace(run.sessionFile, {}, bounds);
  if (stage.id === "implement") {
    for (const step of flattenSteps(run.plan).filter((item) => (item.stageId || "implement") === stage.id)) {
      await trace(step.sessionFile, { title: step.title, status: step.status });
    }
  }
  if (stage.id === "verify") {
    for (const review of run.reviews || []) for (const item of review.reviews || []) {
      await trace(item.sessionFile, { title: `${item.role} review · round ${review.round}`, status: "completed" });
    }
  }
  return prompts.sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
}

function skillSession(state, run) {
  return {
    cwd: run?.workspace?.cwd || state.workspace.cwd,
    sessionFile: run?.sessionFile || null,
    sessionKey: run ? `${run.ticket.id}-${run.runId}` : undefined
  };
}

function persistWorkflowActivation(run, skillName, activation) {
  run.workflow = bindWorkflowSkill(initialWorkflow(run.workflow), skillName, activation);
  if (activation.sessionFile) run.sessionFile = activation.sessionFile;
  applyPendingWorkflowGate(run);
  return run.workflow;
}

function pauseIfWorkflowBlocked(run) {
  if (!workflowBlockers(run?.workflow).length) return false;
  applyPendingWorkflowGate(run);
  return true;
}

async function surfaceImmediateFailure(ticketId, work) {
  const tracked = Promise.resolve(work).catch(async (error) => {
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (!run || run.lastError) return;
      run.status = earlyFailureStatusSet.has(run.status) ? "failed" : "needs_attention";
      run.lastError = error.message;
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  const run = store.read().ticketRuns?.[ticketId];
  if (run && ["failed", "needs_attention"].includes(run.status) && run.lastError) throw new Error(run.lastError);
  return tracked;
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
  await update((state) => {
    state.selectedTicketId = automaticAdmission ? state.selectedTicketId : ticket.id;
    if (!state.ticketRuns[ticket.id] || replaceableRunStatusSet.has(state.ticketRuns[ticket.id].status)) state.ticketRuns[ticket.id] = newTicketRun(ticket, state.stageProfiles, { automaticAdmission });
  });
  await surfaceImmediateFailure(ticket.id, prepareTicket(ticket.id));
  return ticket.id;
}

function newTicketRun(ticket, stageProfiles, { automaticAdmission = false, runId = randomUUID() } = {}) {
  return createTicketRun(ticket, stageProfiles, { automaticAdmission, runId });
}

async function acceptCheckpointAnswer(ticketId, answers, source, { checkpointId } = {}) {
  const before = ticketRun(store.read(), ticketId);
  let checkpoint = before.checkpoint;
  if (checkpointId && checkpoint?.id !== checkpointId) {
    const workflowCheckpoint = (before.workflow?.checkpoints || []).find((item) => item.id === checkpointId && item.status === "pending");
    if (workflowCheckpoint) checkpoint = runCheckpointFromWorkflow(workflowCheckpoint);
  }
  if (!checkpoint || checkpoint.answerAcceptedAt) return false;
  const answeredAt = new Date().toISOString();
  await update((state) => {
    const current = ticketRun(state, ticketId);
    if (current.checkpoint?.id === checkpoint.id) Object.assign(current.checkpoint, {
      answerAcceptedAt: answeredAt, answerSource: source
    });
    current.clarificationHistory ||= [];
    current.clarificationHistory.push({
      checkpointId: checkpoint.id,
      kind: checkpoint.kind,
      title: checkpoint.title,
      questions: checkpoint.questions || [],
      answer: answers || "Approved without changes.",
      askedAt: checkpoint.createdAt || null,
      answeredAt,
      answerSource: source
    });
  });
  if (source === "dashboard" && trackerBacked(before.ticket)) {
    trackers.comment(before.ticket, `Answer (dashboard):\n\n${answers || "Approved without changes."}\n\n[agent-plan-answer:${checkpoint.id}]`).catch(async (error) => {
      await update((state) => { if (state.ticketRuns[ticketId]) state.ticketRuns[ticketId].trackerSyncError = `Could not mirror dashboard answer: ${error.message}`; });
    });
  }
  if (isWorkflowRunCheckpoint(checkpoint)) await surfaceImmediateFailure(ticketId, continueWorkflowThenResume(ticketId, checkpoint, answers));
  else if (checkpoint.kind === "requirements_review") await surfaceImmediateFailure(ticketId, continueAfterRequirements(ticketId, answers));
  else if (checkpoint.stepId) await surfaceImmediateFailure(ticketId, resumeStepCheckpoint(ticketId, checkpoint, answers));
  else await surfaceImmediateFailure(ticketId, startTicketWork(ticketId, (signal) => designTicket(ticketId, answers, signal)));
  return true;
}

async function continueWorkflowThenResume(ticketId, checkpoint, answers) {
  try {
    const run = ticketRun(store.read(), ticketId);
    const activation = await harness.continueWorkflow({
      ...skillSession(store.read(), run),
      checkpoint,
      response: String(answers || "Approved"),
      profile: run.stageProfiles.architecture
    });
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.workflow = initialWorkflow(current.workflow);
      applyWorkflowContinuation(current.workflow, checkpoint.id, answers, activation);
      if (activation.sessionFile) current.sessionFile = activation.sessionFile;
      applyPendingWorkflowGate(current);
    });
    const latest = ticketRun(store.read(), ticketId);
    if (executionBlockedByWorkflow(latest)) {
      await mirrorCheckpoint(ticketId);
      return;
    }
  } catch (error) {
    await update((state) => {
      const current = state.ticketRuns[ticketId];
      if (!current) return;
      current.status = "needs_attention";
      current.lastError = error.message;
    });
    return;
  }
  if (activeTickets.has(ticketId)) return;
  await resumeTicketPipeline(ticketId);
}

async function resumeTicketPipeline(ticketId) {
  const run = ticketRun(store.read(), ticketId);
  const stage = workflowResumeStage(run);
  if (stage === "blocked") return;
  if (stage === "requirements") return prepareTicket(ticketId);
  if (stage === "requirements_review") {
    const draft = [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "requirements-draft");
    if (!run.checkpoint && draft) {
      await update((state) => {
        const current = ticketRun(state, ticketId);
        current.status = "awaiting_requirements";
        current.checkpoint = {
          id: randomUUID(), kind: "requirements_review", title: "Approve ticket requirements",
          prompt: draft.content, questions: [], createdAt: new Date().toISOString()
        };
        setStage(current, "requirements", "blocked", "Requirement approval needed before repository access");
      });
      await mirrorCheckpoint(ticketId);
    }
    return;
  }
  if (stage === "explore") return continueAfterRequirements(ticketId, "");
  if (stage === "design") return startTicketWork(ticketId, (signal) => designTicket(ticketId, "Continue after the supervisor workflow gate.", signal));
  if (stage === "plan_approval") {
    if (!run.checkpoint) {
      await update((state) => {
        const current = ticketRun(state, ticketId);
        current.status = "awaiting_approval";
        const design = [...(current.artifacts || [])].reverse().find((artifact) => artifact.kind === "architecture");
        current.checkpoint = { id: randomUUID(), kind: "awaiting_approval", title: "Approve implementation plan", prompt: design?.content || "", createdAt: new Date().toISOString() };
        setStage(current, "design", "blocked", "Plan ready for approval");
      });
    }
    return;
  }
  return runTicket(ticketId);
}

async function resumeStepCheckpoint(ticketId, checkpoint, answers) {
  const feedback = String(answers || "").trim() || "Approved";
  if (checkpoint.source === "supervisor") {
    return startTicketWork(ticketId, async (signal) => {
      try {
        const run = ticketRun(store.read(), ticketId);
        const step = findNode(run.plan, checkpoint.stepId);
        if (!step) throw new Error("Checkpoint step not found");
        await update((state) => {
          const current = ticketRun(state, ticketId);
          current.checkpoint = null;
          current.status = "reviewing";
          setStage(current, "implement", "active", `Supervisor continuing review of ${step.title}`);
        });
        const continued = await harness.continueWorkflow({
          ...skillSession(store.read(), run),
          checkpoint,
          response: feedback,
          profile: run.stageProfiles.architecture,
          signal
        });
        await update((state) => {
          const current = ticketRun(state, ticketId);
          current.workflow = initialWorkflow(current.workflow);
          if (continued.sessionFile) current.sessionFile = continued.sessionFile;
          const target = findNode(current.plan, checkpoint.stepId);
          if (target) target.supervisorReview = { reply: continued.reply, error: null, at: new Date().toISOString() };
        });
        const latest = ticketRun(store.read(), ticketId);
        const currentStep = findNode(latest.plan, checkpoint.stepId);
        const nextGate = supervisorReviewCheckpoint(currentStep, continued);
        if (nextGate) {
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, checkpoint.stepId);
            target.status = nextGate.kind;
            current.status = nextGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...nextGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", nextGate.title);
          });
          await mirrorCheckpoint(ticketId);
          return;
        }
        const cwd = currentStep.workspace?.cwd || latest.workspace.cwd;
        const commitMessage = currentStep.commitMessage || await harness.generateCommitMessage({
          cwd, ticket: latest.ticket, step: currentStep, diff: currentStep.diff || { files: [], patch: "", stat: "" },
          runId: latest.runId, profile: latest.stageProfiles.commit, signal
        });
        await update((state) => {
          const current = ticketRun(state, ticketId);
          const target = findNode(current.plan, checkpoint.stepId);
          target.status = "review_ready";
          target.commitMessage = commitMessage;
          if (target.reviewBudgetResult?.exceeded) current.auto = false;
          current.status = "awaiting_step_review";
          current.checkpoint = { id: randomUUID(), kind: "step_review", stepId: checkpoint.stepId, title: `${target.reviewBudgetResult?.exceeded ? "Oversized review required" : "Review"}: ${target.title}`, createdAt: new Date().toISOString() };
          setStage(current, "implement", "blocked", target.reviewBudgetResult?.exceeded ? target.reviewBudgetResult.reasons.join("; ") : `${target.title} is verified and awaiting your review`);
        });
        if (ticketRun(store.read(), ticketId).auto) await advanceTicket(ticketId, signal);
      } catch (error) {
        if (signal.aborted) return;
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (!current) return;
          current.status = "needs_attention";
          current.lastError = error.message;
          setStage(current, "implement", "blocked", error.message);
        });
      }
    });
  }
  await update((state) => {
    const current = ticketRun(state, ticketId);
    current.checkpoint = null;
    current.status = "running";
  });
  return startTicketWork(ticketId, async (signal) => {
    await executeStep(ticketId, checkpoint.stepId, { feedback, signal });
    if (ticketRun(store.read(), ticketId).auto) await advanceTicket(ticketId, signal);
  });
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
      workflow: initialWorkflow(), createdAt: new Date().toISOString()
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
    if (executionBlockedByWorkflow(run)) {
      await update((state) => { pauseIfWorkflowBlocked(ticketRun(state, ticketId)); });
      await mirrorCheckpoint(ticketId);
      return;
    }
    activity = captureStageActivity(ticketId, "requirements", run.runId);
    const productContext = await readProductContext(dataDir, before.workspace.cwd);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.status = "clarifying";
      setStage(current, "requirements", "active", "Pi is shaping requirements without repository access");
    });
    const clarified = await harness.clarifyRequirements({
      cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, sessionFile: run.requirementsSessionFile,
      productContext: productContext.content,
      profile: run.stageProfiles.requirements, onEvent: activity.onEvent,
      onSessionFile: saveRunSession(ticketId, "requirementsSessionFile"), signal
    });
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
      if (pauseIfWorkflowBlocked(current)) {
        setStage(current, "requirements", "blocked", current.checkpoint.title).activity = activity.snapshot();
        return;
      }
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
    if (executionBlockedByWorkflow(run)) {
      await update((state) => { pauseIfWorkflowBlocked(ticketRun(state, ticketId)); });
      await mirrorCheckpoint(ticketId);
      return;
    }
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
        profile: run.stageProfiles.requirements, onEvent: activity.onEvent,
        onSessionFile: saveRunSession(ticketId, "requirementsSessionFile"), signal
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
    if (vcsMode === "jj") {
      await initializeJjWorkspace(workspace.cwd);
      workspace.vcs = "jj";
    }
    const baselineTree = await snapshotTree(workspace.cwd);
    await update((state) => {
      const current = ticketRun(state, ticketId);
      current.workspace = workspace;
      current.baselineTree = baselineTree;
      current.status = "exploring";
      setStage(current, "explore", "active", "Pi is mapping code, tests, and nearby tickets");
    });
    const latestRun = ticketRun(store.read(), ticketId);
    const explorationResults = await Promise.allSettled([
      harness.exploreTicket({
        cwd: workspace.cwd, ticket: run.ticket, sessionFile: latestRun.sessionFile, runId: run.runId,
        productContext: productContext.content, requirements, profile: run.stageProfiles.exploration,
        onEvent: (event) => activity.onEvent(event, "code explorer"),
        onSessionFile: saveRunSession(ticketId), signal
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
      if (pauseIfWorkflowBlocked(current)) return;
      if (explored.questions.length) {
        current.status = "awaiting_input";
        current.checkpoint = {
          id: randomUUID(), kind: "technical_input", title: "Resolve technical exception",
          questions: explored.questions, createdAt: new Date().toISOString()
        };
      }
    });
    if (executionBlockedByWorkflow(ticketRun(store.read(), ticketId))) {
      await mirrorCheckpoint(ticketId);
      return;
    }
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
  if (executionBlockedByWorkflow(run)) {
    await update((draft) => { pauseIfWorkflowBlocked(ticketRun(draft, ticketId)); });
    await mirrorCheckpoint(ticketId);
    return;
  }
  await update((draft) => {
    const current = ticketRun(draft, ticketId);
    if (pauseIfWorkflowBlocked(current)) return;
    current.checkpoint = null;
    current.status = "planning";
    setStage(current, "explore", "completed", "Repository map and technical decisions persisted");
    setStage(current, "design", "active", "Pi is choosing an approach and executable steps");
  });
  if (executionBlockedByWorkflow(ticketRun(store.read(), ticketId))) {
    await mirrorCheckpoint(ticketId);
    return;
  }
  try {
    const result = await harness.designTicket({
      cwd: run.workspace.cwd, ticket: run.ticket, sessionFile: run.sessionFile, runId: run.runId,
      productContext: productContext.content, requirements: requirements.content, exploration: exploration.content, ticketLookAhead, answers,
      profile: run.stageProfiles.architecture, onEvent: activity.onEvent,
      onSessionFile: saveRunSession(ticketId), signal
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
    if (!step || (!correction && blockingReasons(run.plan, step).length) || (!correction && !["ready", "interrupted", "needs_input", "awaiting_approval"].includes(step.status))) return;
    let attemptEvidence = null;
    try {
      const stepCwd = step.workspace?.cwd || run.workspace.cwd;
      let vcsChange = null;
      if (run.workspace.vcs === "jj" && step.permission === "write" && !step.workspace?.isolated) {
        vcsChange = await beginJjChange(stepCwd, { changeId: step.vcsChange?.changeId, title: step.title });
        await update((state) => { findNode(ticketRun(state, ticketId).plan, stepId).vcsChange = vcsChange; });
      }
      let beforeTree = await snapshotTree(stepCwd);
      const stepBaseTree = step.baseTree || beforeTree;
      await update((state) => {
        const target = findNode(ticketRun(state, ticketId).plan, stepId);
        target.baseTree ||= stepBaseTree;
      });
      let rollbackFeedback = "";
      if (step.baseTree && beforeTree) {
        const existingDiff = await diffTrees(stepCwd, step.baseTree, beforeTree);
        const existingBudget = diffReviewBudget(step, existingDiff);
        if (reviewBudgetRequiresRollback(existingBudget)) {
          beforeTree = await restoreTree(stepCwd, step.baseTree);
          rollbackFeedback = `The harness rolled back a runaway prior diff before this attempt: ${existingBudget.reasons.join("; ")}. Re-implement this slice from its clean step checkpoint with focused edits; do not copy whole files from another worktree.`;
          await update((state) => {
            const target = findNode(ticketRun(state, ticketId).plan, stepId);
            target.rollbackHistory ||= [];
            target.rollbackHistory.push({ at: new Date().toISOString(), reason: rollbackFeedback, diff: existingDiff, reviewBudgetResult: existingBudget });
            target.diff = null;
            target.reviewBudgetResult = null;
          });
        }
      }
      let nextFeedback = feedback || rollbackFeedback;
      const priorVerification = [...(step.attempts || [])].reverse().find((attempt) => attempt.verification)?.verification || {};
      if (!nextFeedback && step.status === "interrupted") nextFeedback = interruptedStepFeedback(step);
      let previousFindings = actionableFindings([priorVerification]);
      let previousFingerprint = findingsFingerprint(previousFindings);
      for (let round = nextCorrectionRound(step); ; round++) {
        signal?.throwIfAborted();
        const latest = ticketRun(store.read(), ticketId);
        const currentStep = findNode(latest.plan, stepId);
        const workerRunId = randomUUID();
        const startedAt = new Date().toISOString();
        const attemptId = `attempt-${(currentStep.attempts?.length || 0) + 1}`;
        attemptEvidence = { runId: workerRunId, attemptId, startedAt, feedback: nextFeedback || null };
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
          current.activeRuns[stepId] = { runId: workerRunId, attemptId, startedAt, lastEventAt: startedAt, lastEvent: nextFeedback ? "Starting focused fix" : "Starting Pi worker", warning: false };
          setStage(current, "implement", "active", `${nextFeedback ? "Fixing" : "Implementing"} ${target.title}`);
        });
        const activity = captureStepActivity(ticketId, stepId, workerRunId);
        const cwd = currentStep.workspace?.cwd || latest.workspace.cwd;
        const attemptBaseTree = await snapshotTree(cwd);
        const sessionChoice = selectWorkerSession(currentStep, {
          forkSessionFile: findForkSession(latest.plan, currentStep),
          feedback: nextFeedback
        });
        const result = await harness.runStep({
          cwd, plan: latest.plan, step: currentStep, artifacts: contextArtifacts, images: [],
          ...sessionChoice,
          feedback: nextFeedback, ticketId, runId: latest.runId,
          profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation,
          onEvent: activity.onEvent,
          onSessionFile: saveStepSession(ticketId, stepId, workerRunId),
          signal
        });
        Object.assign(attemptEvidence, { report: result.report, rawOutput: result.rawOutput || "", sessionFile: result.sessionFile || null });
        signal?.throwIfAborted();
        let checks = { status: "skipped", command: null, summary: "No repository changes require a deterministic check.", output: "" };
        if (currentStep.permission === "write" && result.report.status === "completed") {
          activity.onEvent({ type: "phase", label: "Running repository checks" });
          checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:${stepId}`, cwd, signal, required: currentStep.requiresVisualEvidence, requiredVideo: currentStep.requiresVideoEvidence, stepId });
        }
        attemptEvidence.checks = checks;
        signal?.throwIfAborted();
        if (latest.workspace.vcs === "jj" && currentStep.permission === "write" && !currentStep.workspace?.isolated) vcsChange = await snapshotJjChange(cwd);
        const afterTree = await snapshotTree(cwd);
        const diff = await diffTrees(cwd, stepBaseTree, afterTree);
        const attemptDiff = await diffTrees(cwd, attemptBaseTree, afterTree);
        const reviewNotes = normalizeReviewNotes(result.reviewNotes, diff, currentStep.reviewNotes);
        const reviewBudget = diffReviewBudget(currentStep, diff);
        const runawayDiff = reviewBudgetRequiresRollback(reviewBudget);
        const violations = currentStep.permission !== "write" ? diff.files : outsideWriteScope(diff.files, workerWriteScope(currentStep));
        const artifactInput = { runId: latest.runId, stageId: "implement", stepId, attemptId };
        const reviewNotesArtifact = reviewNotes.length ? await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "review-notes.json", content: JSON.stringify(reviewNotes, null, 2), kind: "review-notes" }) : null;
        const artifacts = [
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: currentStep.expectedArtifacts[0] || `${currentStep.id}-result.md`, content: result.output, kind: "agent-output" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "prompt.md", content: result.prompt, kind: "agent-prompt" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "context.json", content: JSON.stringify({ profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation, contextPolicy: currentStep.contextPolicy, permission: currentStep.permission, writeScope: currentStep.writeScope, skills: currentStep.skills, references: currentStep.references, requirementIds: currentStep.requirementIds, capabilityIds: currentStep.capabilityIds, deltaIds: currentStep.deltaIds, productContext: currentStep.productContext, artifacts: contextArtifacts.map(({ id, name, path }) => ({ id, name, path })) }, null, 2), kind: "context-manifest" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "diff.patch", content: diff.patch, kind: "git-diff" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "attempt-diff.patch", content: attemptDiff.patch, kind: "git-attempt-diff" })
        ];
        Object.assign(attemptEvidence, { diff: attemptDiff, aggregateDiff: diff, reviewNotes, reviewBudgetResult: reviewBudget, violations, vcsChange, artifacts });
        const workerGate = workerReportCheckpoint(currentStep, result.report);
        if (runawayDiff) await restoreTree(cwd, stepBaseTree);
        if (violations.length || runawayDiff || (result.report.status !== "completed" && !workerGate)) {
          const error = violations.length
            ? `Changes outside permission or write scope: ${violations.join(", ")}`
            : runawayDiff
              ? `Runaway diff rolled back to the step checkpoint: ${reviewBudget.reasons.join("; ")}`
              : (result.report.request || result.report.summary);
          const attemptActivity = activity.snapshot();
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = "needs_attention";
            target.diff = diff;
            target.reviewNotes = reviewNotes;
            target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
            target.reviewBudgetResult = reviewBudget;
            if (vcsChange) target.vcsChange = vcsChange;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            target.lastError = error;
            target.attempts.push({ runId: workerRunId, attemptId, startedAt, completedAt: new Date().toISOString(), status: "needs_attention", events: attemptActivity.events, activityGroups: attemptActivity.groups, rawOutput: attemptActivity.rawOutput || result.rawOutput, report: result.report, violations, feedback: nextFeedback || null, diff: attemptDiff, vcsChange, rolledBack: runawayDiff });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            current.status = "needs_attention";
            setStage(current, "implement", "blocked", error);
          });
          return;
        }
        if (workerGate) {
          const attemptActivity = activity.snapshot();
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = workerGate.kind;
            target.diff = diff;
            target.reviewNotes = reviewNotes;
            target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
            target.reviewBudgetResult = reviewBudget;
            if (vcsChange) target.vcsChange = vcsChange;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            target.lastError = null;
            target.attempts.push({ runId: workerRunId, attemptId, startedAt, completedAt: new Date().toISOString(), status: workerGate.kind, events: attemptActivity.events, activityGroups: attemptActivity.groups, rawOutput: attemptActivity.rawOutput || result.rawOutput, report: result.report, violations, feedback: nextFeedback || null, diff: attemptDiff, vcsChange });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            current.status = workerGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...workerGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", workerGate.title);
          });
          await mirrorCheckpoint(ticketId);
          return;
        }
        await update((state) => {
          const current = ticketRun(state, ticketId);
          findNode(current.plan, stepId).status = "verifying";
          current.status = "verifying";
          current.activeRuns[stepId].lastEvent = `Fresh verification round ${round}`;
          current.activeRuns[stepId].lastEventAt = new Date().toISOString();
          current.activeRuns[stepId].warning = false;
          setStage(current, "implement", "active", `Fresh verification: ${currentStep.title}`);
        });
        const design = [...latest.artifacts].reverse().find((artifact) => artifact.kind === "architecture")?.content || "";
        activity.onEvent({ type: "phase", label: `Verifying ${currentStep.title}` });
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
            design, diff, output: result.output, checks, runId: latest.runId, round,
            focusFindings: verificationFocusFindings(nextFeedback, previousFindings),
            images: await harness.evidenceImages(checks.evidence),
            profile: latest.stageProfiles.verification,
            onEvent: activity.onEvent,
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
        let supervisorReview = null;
        if (!findings.length && latest.sessionFile) {
          try {
            activity.onEvent({ type: "phase", label: "Supervisor reviewing worker report" });
            supervisorReview = await harness.reviewWorkerReport({
              cwd: latest.workspace.cwd, sessionFile: latest.sessionFile, sessionKey: `${latest.ticket.id}-${latest.runId}`,
              step: currentStep, report: result.report, diff,
              profile: latest.stageProfiles.architecture,
              onEvent: activity.onEvent,
              signal
            });
          } catch (error) {
            if (signal?.aborted) throw error;
            supervisorReview = { reply: error.message, checkpoints: [], error: error.message };
          }
        }
        const supervisorGate = supervisorReviewCheckpoint(currentStep, supervisorReview);
        if (!findings.length && !supervisorGate) {
          activity.onEvent({ type: "phase", label: "Drafting the requirement-linked commit" });
          commitMessage = await harness.generateCommitMessage({
            cwd, ticket: latest.ticket, step: currentStep, diff, runId: latest.runId,
            profile: latest.stageProfiles.commit, signal
          });
        }
        const attemptActivity = activity.snapshot();
        await update((state) => {
          const current = ticketRun(state, ticketId);
          const target = findNode(current.plan, stepId);
          target.diff = diff;
          target.reviewNotes = reviewNotes;
          target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
          target.reviewBudgetResult = reviewBudget;
          if (vcsChange) target.vcsChange = vcsChange;
          target.sessionFile = result.sessionFile;
          if (supervisorReview) target.supervisorReview = { reply: supervisorReview.reply, error: supervisorReview.error || null, at: new Date().toISOString() };
          target.artifacts = [artifacts[0], verificationArtifact];
          target.attempts.push({ runId: workerRunId, attemptId, startedAt, completedAt: new Date().toISOString(), status: findings.length ? "verification_failed" : "verified", events: attemptActivity.events, activityGroups: attemptActivity.groups, rawOutput: attemptActivity.rawOutput || result.rawOutput, report: result.report, violations, feedback: nextFeedback || null, checks, verification, diff: attemptDiff, vcsChange });
          current.artifacts.push(...artifacts, verificationArtifact);
          delete current.activeRuns[stepId];
        });
        if (supervisorGate && !findings.length) {
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = supervisorGate.kind;
            current.status = supervisorGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...supervisorGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", supervisorGate.title);
          });
          await mirrorCheckpoint(ticketId);
          return;
        }
        if (!findings.length) {
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = "review_ready";
            target.commitMessage = commitMessage;
            if (target.reviewBudgetResult?.exceeded) current.auto = false;
            current.status = "awaiting_step_review";
            current.checkpoint = { id: randomUUID(), kind: "step_review", stepId, title: `${target.reviewBudgetResult?.exceeded ? "Oversized review required" : "Review"}: ${target.title}`, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", target.reviewBudgetResult?.exceeded ? target.reviewBudgetResult.reasons.join("; ") : `${target.title} is verified and awaiting your review`);
          });
          return;
        }
        const decision = shouldPauseCorrection({ round, findings, previousFingerprint });
        if (decision.pause) {
          const pauseReason = correctionPauseReason(decision.reason, findings);
          await update((state) => {
            const current = ticketRun(state, ticketId);
            const target = findNode(current.plan, stepId);
            target.status = "needs_attention";
            target.lastError = pauseReason;
            current.status = "needs_attention";
            current.lastError = pauseReason;
            current.checkpoint = {
              id: randomUUID(), kind: "needs_attention", title: "Correction stalled",
              prompt: pauseReason, stepId, source: "verification", createdAt: new Date().toISOString()
            };
            setStage(current, "implement", "blocked", pauseReason);
          });
          return;
        }
        previousFingerprint = decision.fingerprint;
        previousFindings = findings;
        nextFeedback = `Fresh verification found these actionable issues. Fix them with the smallest focused change, then run deterministic checks:\n\n${JSON.stringify(findings, null, 2)}`;
      }
    } catch (error) {
      if (signal?.aborted) return;
      await update((state) => {
        const current = ticketRun(state, ticketId);
        const failed = findNode(current.plan, stepId);
        const active = current.activeRuns[stepId] || {};
        const activity = active.activity || {};
        failed.attempts ||= [];
        const failedAttempt = {
          ...(attemptEvidence || {}),
          runId: attemptEvidence?.runId || active.runId || null,
          attemptId: attemptEvidence?.attemptId || active.attemptId || `attempt-${failed.attempts.length + 1}`,
          startedAt: attemptEvidence?.startedAt || active.startedAt || new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "failed",
          events: activity.events || [],
          activityGroups: activity.groups || [],
          rawOutput: activity.rawOutput || attemptEvidence?.rawOutput || "",
          sessionFile: active.sessionFile || attemptEvidence?.sessionFile || failed.sessionFile || null,
          error: error.message
        };
        const prior = failed.attempts.findIndex((attempt) => attempt.attemptId === failedAttempt.attemptId);
        if (prior >= 0) failed.attempts[prior] = { ...failed.attempts[prior], ...failedAttempt };
        else failed.attempts.push(failedAttempt);
        if (attemptEvidence?.aggregateDiff) failed.diff = attemptEvidence.aggregateDiff;
        if (attemptEvidence?.reviewNotes) failed.reviewNotes = attemptEvidence.reviewNotes;
        if (attemptEvidence?.reviewBudgetResult) failed.reviewBudgetResult = attemptEvidence.reviewBudgetResult;
        if (attemptEvidence?.artifacts?.length) {
          failed.artifacts = [attemptEvidence.artifacts[0]];
          for (const artifact of attemptEvidence.artifacts) if (!current.artifacts.some((item) => item.id === artifact.id)) current.artifacts.push(artifact);
        }
        failed.status = "failed";
        failed.lastError = error.message;
        delete current.activeRuns[stepId];
        current.status = "needs_attention";
        current.lastError = error.message;
        current.checkpoint = {
          id: randomUUID(), kind: "needs_attention", title: `Step failed: ${failed.title}`,
          prompt: error.message, stepId, source: "execution", createdAt: new Date().toISOString()
        };
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
  const beforeTree = await snapshotTree(current.workspace.cwd);
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
  const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:remote-feedback`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((item) => item.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((item) => item.requiresVideoEvidence) });
  if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
  const afterTree = await snapshotTree(current.workspace.cwd);
  const diff = await diffTrees(current.workspace.cwd, beforeTree, afterTree);
  const commit = await commitWorkspace(current.workspace.cwd, `fix: address remote review feedback\n\nWhy: The reviewed change must resolve concrete maintainer feedback before merge.\nRequirement: ${current.ticket.identifier}`);
  const artifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: "remote-review-fix.md", content: result.output, stageId: "handoff", kind: "remote-review-fix"
  });
  await update((state) => {
    const run = ticketRun(state, ticketId);
    run.artifacts.push(artifact);
    run.merge.feedbackFixes ||= [];
    run.merge.feedbackFixes.push({ feedback, diff, artifact, commit, createdAt: new Date().toISOString() });
  });
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
      checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:delivery`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((step) => step.requiresVideoEvidence) });
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

    const deliveredTree = await snapshotTree(current.workspace.cwd);
    const deliveredDiff = await diffTrees(current.workspace.cwd, `origin/${base}^{tree}`, deliveredTree);
    const sync = await safeSyncLocal(sourceCwd, base);
    const integratedAt = new Date().toISOString();
    const productContext = contextContent == null ? null : await persistProductContext(dataDir, sourceCwd, contextContent);
    const evidenceArtifacts = ticketRun(store.read(), ticketId).artifacts;
    const handoff = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
      content: `# ${current.ticket.identifier} handoff\n\nRemote review: ${change.url}\n\nSquash commit: \`${mergeResult.commit}\`\n\nLocal sync: ${sync.status}${sync.reason ? ` — ${sync.reason}` : ""}.${visualEvidenceHandoffSection(evidenceArtifacts)}`
    });
    await trackerAction(ticketId, "delivery_complete", (ticket) => trackers.comment(ticket, `Merged after remote checks and review: ${change.url}\n\nSquash commit: ${mergeResult.commit}${visualEvidenceComment(evidenceArtifacts)}`));
    await trackerAction(ticketId, "tracker_done", (ticket) => trackers.transition(ticket, "done"));
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.integration = { sourceCwd, branch: current.workspace.branch, commit: mergeResult.commit, integratedAt, change, sync, diff: deliveredDiff };
      run.deliveredDiff = deliveredDiff;
      Object.assign(run.stages.find((stage) => stage.id === "handoff"), { diff: deliveredDiff });
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
  if (diff?.available && diff.files?.length === 0) {
    const integratedAt = new Date().toISOString();
    const productContext = contextContent === null ? null : await persistProductContext(dataDir, queuedRun.workspace.sourceCwd, contextContent);
    const handoff = await persistArtifact(dataDir, queuedRun.ticket, {
      runId: queuedRun.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
      content: `# ${queuedRun.ticket.identifier} handoff\n\nVerified as already satisfied. No repository changes or remote review were required.`
    });
    await trackerAction(ticketId, "delivery_complete", (ticket) => trackers.comment(ticket, "Verified as already satisfied. No repository changes or remote review were required."));
    await trackerAction(ticketId, "tracker_done", (ticket) => trackers.transition(ticket, "done"));
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.integration = { sourceCwd: run.workspace.sourceCwd, branch: run.workspace.branch, commit: null, integratedAt, diff, noChange: true };
      run.deliveredDiff = diff;
      run.merge = { status: "not_required", reason: "no_changes", integratedAt };
      if (productContext) run.productContextPath = productContext.path;
      run.artifacts.push(handoff);
      run.checkpoint = null;
      setStage(run, "handoff", "completed", "Verified with no repository changes");
      run.status = "completed";
      run.lastError = null;
      run.completedAt = integratedAt;
    });
    await stopTicketPreviews(ticketId, "run_completed");
    return { position: 0, promise: Promise.resolve({ noChange: true }) };
  }
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
        const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:integration`, cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((step) => step.requiresVideoEvidence) });
        if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
        await update((state) => { Object.assign(ticketRun(state, ticketId).merge, { checks, verifiedAt: new Date().toISOString() }); });
      }
    });
    const integratedAt = new Date().toISOString();
    const productContext = contextContent === null ? null : await persistProductContext(dataDir, sourceCwd, contextContent);
    const evidenceArtifacts = ticketRun(store.read(), ticketId).artifacts;
    const handoff = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
      content: `# ${current.ticket.identifier} handoff\n\nCompleted ${flattenSteps(current.plan).length} accepted implementation slices.\n\nIntegrated into: \`${sourceCwd}\`\n\nSource branch: \`${current.workspace.branch}\`\n\nCommit: \`${integration.commit}\`${productContext ? `\n\nLiving product context: \`${productContext.path}\`.` : ""}\n\n${diff?.stat || "No changed files."}${visualEvidenceHandoffSection(evidenceArtifacts)}`
    });
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.integration = { sourceCwd, branch: current.workspace.branch, commit: integration.commit, integratedAt, diff: integration.diff };
      run.deliveredDiff = integration.diff;
      Object.assign(run.stages.find((stage) => stage.id === "handoff"), { diff: integration.diff });
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

async function applyFinalReviewFix({ ticketId, round, findings, reviewImages, verificationBaseTree, activity, signal, rootCauseClusters = [] }) {
  const current = ticketRun(store.read(), ticketId);
  const rootCauseInstruction = rootCauseClusters.length ? `\n\nThese findings recur across at least three review rounds on the same code surface (${rootCauseClusters.join(", ")}). Fix the general invariant, not only the reported examples or additional deny-list words. Prefer a positive decision tied to approved requirements, capabilities, or architecture, with data-driven counterexamples. If that general correction is impossible within the approved scope, report needs_input with the exact boundary.` : "";
  const fixStep = {
    id: `review-fix-${round}`,
    title: `Fix final review findings — round ${round}`,
    prompt: `Correct these independently verified actionable findings:\n\n${JSON.stringify(findings, null, 2)}\n\nKeep the fix focused. Add or update regression coverage where practical and run the relevant deterministic checks.${rootCauseInstruction}`,
    contextPolicy: "seeded", harness: "pi", agentId: `review-fixer:round-${round}`,
    permission: "write", writeScope: "**", skills: [], references: [],
    expectedArtifacts: [`review-fixes-round-${round}.md`],
    acceptanceCriteria: findings.map((finding) => finding.claim), dependsOn: [], required: true,
    status: "ready", attempts: [], artifacts: [], attachments: [], diff: null, sessionFile: null, lastError: null
  };
  await update((state) => {
    const run = ticketRun(state, ticketId);
    run.status = "fixing";
    Object.assign(setStage(run, "verify", "active", `Fixing ${findings.length} actionable review finding${findings.length === 1 ? "" : "s"} · round ${round}`), { activity: activity.snapshot() });
  });
  const beforeFix = await snapshotTree(current.workspace.cwd);
  const result = await harness.runStep({
    cwd: current.workspace.cwd, plan: current.plan, step: fixStep, artifacts: [],
    images: reviewImages, forkSessionFile: null, resumeSessionFile: null, feedback: "", ticketId, runId: current.runId,
    profile: current.stageProfiles.implementation,
    onEvent: (event) => activity.onEvent(event, "review fixer"),
    signal
  });
  signal?.throwIfAborted();
  const afterFix = await snapshotTree(current.workspace.cwd);
  const fixDiff = await diffTrees(current.workspace.cwd, beforeFix, afterFix);
  const verificationDiffAfterFix = await diffTrees(current.workspace.cwd, verificationBaseTree, afterFix);
  if (result.report.status !== "completed") {
    await update((state) => {
      const run = ticketRun(state, ticketId);
      const review = run.reviews.find((item) => item.round === round) || run.reviews.at(-1);
      Object.assign(setStage(run, "verify", "blocked", result.report.request || result.report.summary || "Review fixer needs attention"), { diff: verificationDiffAfterFix });
      review.fix = { report: result.report, diff: fixDiff, rootCauseClusters, createdAt: new Date().toISOString() };
      run.status = "needs_attention";
      run.checkpoint = { id: randomUUID(), kind: "review_blocked", title: "Review fixer needs attention", findings, createdAt: new Date().toISOString() };
    });
    return false;
  }
  const fixArtifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: fixStep.expectedArtifacts[0], content: result.output, stageId: `review-round-${round}`, kind: "review-fix"
  });
  await update((state) => {
    const run = ticketRun(state, ticketId);
    const review = run.reviews.find((item) => item.round === round) || run.reviews.at(-1);
    run.artifacts.push(fixArtifact);
    review.fix = { report: result.report, diff: fixDiff, artifact: fixArtifact, rootCauseClusters };
    run.status = "reviewing";
    Object.assign(setStage(run, "verify", "active", `Review round ${round + 1} follows focused fixes`), { activity: activity.snapshot(), diff: verificationDiffAfterFix });
  });
  return true;
}

async function finalReviewLoop(ticketId, signal) {
  signal?.throwIfAborted();
  const started = ticketRun(store.read(), ticketId);
  const activity = captureStageActivity(ticketId, "verify", started.runId);
  const implementationTree = await snapshotTree(started.workspace.cwd);
  const implementationDiff = await diffTrees(started.workspace.cwd, started.baselineTree, implementationTree);
  const verificationBaseTree = started.stages.find((stage) => stage.id === "verify")?.baseTree || implementationTree;
  await update((state) => {
    const run = ticketRun(state, ticketId);
    Object.assign(setStage(run, "implement", "completed", `${flattenSteps(run.plan).length} implementation slices accepted`), { diff: implementationDiff });
    Object.assign(setStage(run, "verify", "active", "Independent reviewers are inspecting the combined implementation"), { baseTree: verificationBaseTree });
    run.status = "reviewing";
    run.checkpoint = null;
    run.reviews ||= [];
  });
  const pendingFix = pendingReviewFix(started.reviews);
  if (pendingFix) {
    const current = ticketRun(store.read(), ticketId);
    const savedImages = await harness.evidenceImages((current.artifacts || []).filter((artifact) => artifact.kind === "visual-evidence"));
    const rootCauseClusters = unaddressedReviewClusters(current.reviews);
    if (!await applyFinalReviewFix({ ticketId, ...pendingFix, reviewImages: savedImages, verificationBaseTree, activity, signal, rootCauseClusters })) return;
  }
  const resumed = ticketRun(store.read(), ticketId);
  const firstRound = Math.max(0, ...(resumed.reviews || []).map((review) => Number(review.round) || 0)) + 1;
  const previousReview = resumed.reviews?.at(-1);
  let previousFingerprint = previousReview?.fix?.report?.status === "completed"
    ? findingsFingerprint(previousReview.actionableFindings || [])
    : "";
  for (let round = firstRound; ; round++) {
    signal?.throwIfAborted();
    const current = ticketRun(store.read(), ticketId);
    activity.onEvent({ type: "thinking", label: `Running deterministic checks · round ${round}` }, "checks");
    const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:combined`, cwd: current.workspace.cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((step) => step.requiresVideoEvidence) });
    const reviewImages = await harness.evidenceImages(checks.evidence);
    signal?.throwIfAborted();
    const afterTree = await snapshotTree(current.workspace.cwd);
    const diff = await diffTrees(current.workspace.cwd, current.baselineTree, afterTree);
    const verificationDiff = await diffTrees(current.workspace.cwd, verificationBaseTree, afterTree);
    const focusFindings = actionableFindings((current.reviews || []).map((review) => ({ findings: review.actionableFindings || [] })));
    const reviews = [repositoryCheckReview(checks), ...await Promise.all(["requirements", "integration", "verification"].map((role) => harness.reviewTicket({
      cwd: current.workspace.cwd,
      ticket: current.ticket,
      plan: current.plan,
      artifacts: current.artifacts,
      diff,
      checks,
      focusFindings,
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
    const humanEvidenceFinding = current.pendingEvidenceFeedback ? [{
      severity: "blocking", category: "human-proof-review", claim: current.pendingEvidenceFeedback,
      evidence: [], suggestedFix: current.pendingEvidenceFeedback, confidence: "high"
    }] : [];
    const findings = [...actionableFindings(reviews), ...humanEvidenceFinding];
    await update((state) => {
      const run = ticketRun(state, ticketId);
      run.artifacts.push(...persisted);
      run.reviews.push({ round, reviews, actionableFindings: findings, diff, createdAt: new Date().toISOString() });
      delete run.pendingEvidenceFeedback;
      Object.assign(run.stages.find((stage) => stage.id === "verify"), { activity: activity.snapshot(), diff: verificationDiff });
    });
    if (!findings.length) {
      await commitWorkspace(current.workspace.cwd, `fix: resolve independent review findings\n\nWhy: The accepted ticket must pass the final combined review.\nRequirement: ${flattenSteps(current.plan).flatMap((step) => step.requirementIds).filter((id, index, all) => all.indexOf(id) === index).join(", ") || "Complete every approved ticket requirement"}`);
      let contextArtifact = null;
      let contextContent = null;
      let handoffActivity = null;
      if (current.ticket.source !== "local") {
        const currentContext = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot")?.content || "";
        handoffActivity = captureStageActivity(ticketId, "handoff", current.runId);
        contextContent = await harness.updateProductContext({
          cwd: current.workspace.cwd, ticket: current.ticket, currentContext,
          artifacts: current.artifacts.filter((artifact) => ["requirements", "implementation-delta", "architecture", "agent-output", "step-verification"].includes(artifact.kind)),
          diff, runId: current.runId, profile: current.stageProfiles.handoff, onEvent: handoffActivity.onEvent, signal
        });
        signal?.throwIfAborted();
        if (!contextContent.trim()) throw new Error("Product context update was empty");
        contextArtifact = await persistArtifact(dataDir, current.ticket, {
          runId: current.runId, name: "product-context-update.md", content: contextContent,
          stageId: "handoff", kind: "product-context-update"
        });
      }
      const finalEvidencePaths = new Set((checks.evidence || []).map((item) => item.path));
      const media = (ticketRun(store.read(), ticketId).artifacts || [])
        .filter((artifact) => artifact.kind === "visual-evidence" && finalEvidencePaths.has(artifact.path))
        .map(({ id, name, path, summary, mediaType, mediaKind, stageId, stepId }) => ({ id, name, path, summary, mediaType, mediaKind, stageId, stepId }));
      const finalChecks = {
        status: checks.status, command: checks.command || null, summary: checks.summary || "", durationMs: checks.durationMs || null,
        evidence: (checks.evidence || []).map(({ name, path, viewport, url }) => ({ name, path, viewport, url }))
      };
      const videoRequired = flattenSteps(current.plan).some((step) => step.requiresVideoEvidence);
      if (current.ticket.source === "local") {
        await update((state) => {
          const run = ticketRun(state, ticketId);
          setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
          setStage(run, "handoff", "blocked", "Review final proof before integration");
          run.status = "awaiting_evidence_review";
          run.checkpoint = {
            id: randomUUID(), kind: "evidence_review", title: "Review final proof before integration",
            prompt: finalChecks.summary, finalChecks, media, evidenceArtifactIds: media.map((artifact) => artifact.id), videoRequired, createdAt: new Date().toISOString()
          };
        });
        return;
      }
      await update((state) => {
        const run = ticketRun(state, ticketId);
        run.artifacts.push(contextArtifact);
        setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
        setStage(run, "handoff", "blocked", "Review final proof before remote merge").activity = handoffActivity.snapshot();
        run.status = "awaiting_evidence_review";
        run.checkpoint = {
          id: randomUUID(), kind: "evidence_review", title: "Review final proof before remote merge",
          prompt: finalChecks.summary, finalChecks, media, evidenceArtifactIds: media.map((artifact) => artifact.id), videoRequired, productContext: contextContent, createdAt: new Date().toISOString()
        };
      });
      return;
    }
    const decision = shouldPauseCorrection({ round, findings, previousFingerprint });
    if (decision.pause) {
      const pauseReason = correctionPauseReason(decision.reason, findings);
      await update((state) => {
        const run = ticketRun(state, ticketId);
        run.status = "needs_attention";
        run.lastError = pauseReason;
        run.checkpoint = {
          id: randomUUID(), kind: "needs_attention", title: "Correction stalled",
          prompt: pauseReason, source: "verification", createdAt: new Date().toISOString()
        };
        setStage(run, "verify", "blocked", pauseReason).activity = activity.snapshot();
      });
      return;
    }
    previousFingerprint = decision.fingerprint;
    const reviewsWithCurrent = [...(current.reviews || []), { actionableFindings: findings }];
    const rootCauseClusters = unaddressedReviewClusters(reviewsWithCurrent);
    if (!await applyFinalReviewFix({ ticketId, round, findings, reviewImages, verificationBaseTree, activity, signal, rootCauseClusters })) return;
  }
}

async function finishHandoff(ticketId) {
  const current = ticketRun(store.read(), ticketId);
  if (current.checkpoint?.kind !== "evidence_review") throw new Error("No final proof review is awaiting approval");
  const proposal = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-update");
  const contextContent = current.ticket.source === "local" ? null : proposal?.content;
  if (current.ticket.source !== "local" && !contextContent) throw new Error("Product-context proposal not found");
  const queued = await scheduleTicketIntegration(ticketId, { diff: current.reviews?.at(-1)?.diff, contextContent });
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
  let vcsChange = step.vcsChange || null;
  const noChanges = step.diff?.available && step.diff.files?.length === 0;
  if (!noChanges && current.workspace.vcs === "jj" && step.permission === "write" && !step.workspace?.isolated) {
    if (!vcsChange?.changeId) throw new Error("The editable Jujutsu change is missing for this step");
    vcsChange = await acceptJjChange(current.workspace.cwd, { changeId: vcsChange.changeId, message, bookmark: current.workspace.branch });
    commit = vcsChange.commitId;
  } else if (!noChanges && step.workspace?.isolated) {
    let workspaceCommit = step.workspaceCommit;
    if (!workspaceCommit) {
      workspaceCommit = await commitWorkspace(step.workspace.cwd, message);
      await update((state) => { findNode(ticketRun(state, ticketId).plan, stepId).workspaceCommit = workspaceCommit; });
    }
    if (workspaceCommit) commit = await cherryPickCommit(current.workspace.cwd, workspaceCommit);
  } else if (!noChanges) {
    commit = await commitWorkspace(current.workspace.cwd, message);
  }
  await update((state) => {
    const run = ticketRun(state, ticketId);
    const accepted = findNode(run.plan, stepId);
    accepted.status = "accepted";
    accepted.acceptedAt = new Date().toISOString();
    if (commit) accepted.commit = commit;
    if (vcsChange) accepted.vcsChange = vcsChange;
    run.status = "running";
    run.checkpoint = null;
  });
}

function approvedScopePaths(values) {
  const paths = [...new Set((Array.isArray(values) ? values : []).map((value) => normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "")))];
  if (!paths.length || paths.length > 10) throw new Error("Approve between one and ten explicit repository paths");
  for (const path of paths) {
    if (!path || path === "." || path === ".." || path.startsWith("../") || isAbsolute(path) || path.includes(",") || /[*?[\]{}]/.test(path)) {
      throw new Error(`Scope expansion must name an explicit repository-relative path: ${path}`);
    }
  }
  return paths;
}

async function advanceTicket(ticketId, signal) {
  signal?.throwIfAborted();
  const currentRun = ticketRun(store.read(), ticketId);
  if (executionBlockedByWorkflow(currentRun)) {
    await update((state) => { pauseIfWorkflowBlocked(ticketRun(state, ticketId)); });
    await mirrorCheckpoint(ticketId);
    return;
  }
  const run = await ensureLocalWorkspace(ticketId);
  const reviews = flattenSteps(run.plan).filter((step) => step.status === "review_ready");
  if (reviews.length) {
    if (!run.auto) return;
    for (const step of reviews) await acceptStep(ticketId, step.id);
    return advanceTicket(ticketId, signal);
  }
  const ready = nextRunnableBatch(run.plan);
  const batch = run.workspace.vcs === "jj" ? ready.slice(0, 1) : ready;
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
  if (flattenSteps(run.plan).every((step) => step.status === "accepted")) {
    if (run.workspace.vcs === "jj" && !run.workspace.jjFinalized) {
      await prepareJjForGit(run.workspace.cwd, run.workspace.branch);
      await update((state) => { ticketRun(state, ticketId).workspace.jjFinalized = true; });
    }
    await finalReviewLoop(ticketId, signal);
  }
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
      let blocked = false;
      await update((state) => {
        const run = ticketRun(state, ticketId);
        if (pauseIfWorkflowBlocked(run)) { blocked = true; return; }
        run.status = "running";
        run.recovery = null;
        run.checkpoint = null;
        setStage(run, "design", "completed", "Plan approved");
        setStage(run, "implement", "active", "Executing dependency-ready steps");
      });
      if (blocked) {
        await mirrorCheckpoint(ticketId);
        return;
      }
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

function assertRestartable(run) {
  if (activeTickets.has(run.id) || activeMerges.has(run.id)) throw new Error("Cancel the active run before restarting it");
  if (run.merge || run.integration) throw new Error("A run that reached delivery cannot be restarted automatically; start a new ticket instead");
}

async function restartAuditArtifact(run, audit) {
  return persistArtifact(dataDir, run.ticket, {
    runId: run.runId,
    stageId: "restart-audit",
    name: `${audit.id}.json`,
    kind: "restart-audit",
    content: JSON.stringify({ ...audit, runId: run.runId, ticketId: run.id }, null, 2)
  });
}

async function freshLocalRun(previous, runId) {
  const source = store.read().workspace.cwd;
  const fixture = await loadLocalFixture(source, previous.ticket.fixturePath);
  const [contractExists, projectConfigExists] = await Promise.all([
    stat(join(source, ".agent-plan/verify.mjs")).then(() => true, () => false),
    stat(join(source, projectConfigPath)).then(() => true, () => false)
  ]);
  const plan = ensureVerificationContractStep(fixture.plan, contractExists, projectConfigExists);
  const artifacts = await Promise.all([
    persistArtifact(dataDir, previous.ticket, { runId, name: "feature.md", content: fixture.feature, stageId: "requirements", kind: "feature-brief" }),
    persistArtifact(dataDir, previous.ticket, { runId, name: "plan.json", content: fixture.planSource, stageId: "design", kind: "plan-source" }),
    persistArtifact(dataDir, previous.ticket, {
      runId, name: "run-manifest.json", stageId: "design", kind: "run-manifest",
      content: JSON.stringify({
        frameworkVersion: packageMetadata.version,
        piDependency: packageMetadata.dependencies["@earendil-works/pi-coding-agent"],
        nodeVersion: process.version,
        stageProfiles: previous.stageProfiles,
        baselineTree: null,
        featureSha256: createHash("sha256").update(fixture.feature).digest("hex"),
        planSha256: createHash("sha256").update(fixture.planSource).digest("hex")
      }, null, 2)
    })
  ]);
  return {
    id: previous.id, runId, ticket: previous.ticket, workspace: null, baselineTree: null, status: "awaiting_approval",
    stages: localStages(), checkpoint: {
      id: randomUUID(), kind: "awaiting_approval", title: "Approve fresh local execution plan",
      prompt: fixture.feature, createdAt: new Date().toISOString()
    },
    plan, stageProfiles: structuredClone(previous.stageProfiles), artifacts, activeRuns: {}, auto: false,
    sessionFile: null, lastError: null, createdAt: new Date().toISOString()
  };
}

async function startFreshRun(ticketId) {
  const previous = ticketRun(store.read(), ticketId);
  assertRestartable(previous);
  const at = new Date().toISOString();
  const audit = {
    id: `restart-${(previous.restartHistory?.length || 0) + 1}`,
    at, target: "fresh", fromStatus: previous.status, fromCheckpoint: previous.checkpoint?.kind || null,
    previousRunId: previous.runId, nextRunId: randomUUID(),
    previousStages: previous.stages.map(({ id, status }) => ({ id, status })),
    previousSteps: flattenSteps(previous.plan).map((step) => ({ id: step.id, title: step.title, status: step.status, baseTree: step.baseTree || null, commit: step.commit || null, vcsChange: step.vcsChange || null, attempts: step.attempts?.length || 0 }))
  };
  const fixture = previous.ticket.source === "local" && previous.ticket.fixturePath ? await freshLocalRun(previous, audit.nextRunId) : null;
  if (previous.ticket.source === "local" && previous.workspace?.cwd && previous.baselineTree) await restoreTree(previous.workspace.cwd, previous.baselineTree);
  const artifact = await restartAuditArtifact(previous, audit);
  previews.stopMatching(`${ticketId}:`);
  await update((state) => {
    const old = ticketRun(state, ticketId);
    old.restartHistory ||= [];
    old.restartHistory.push(audit);
    old.artifacts.push(artifact);
    archiveRun(state, ticketId);
    state.ticketRuns[ticketId] = fixture || newTicketRun(old.ticket, old.stageProfiles, { runId: audit.nextRunId });
    state.ticketRuns[ticketId].startedFreshFrom = { runId: old.runId, auditArtifactId: artifact.id, at };
    state.selectedTicketId = ticketId;
  });
  if (!fixture) await surfaceImmediateFailure(ticketId, prepareTicket(ticketId));
  return audit;
}

async function restartFrom(ticketId, target) {
  const previous = ticketRun(store.read(), ticketId);
  assertRestartable(previous);
  const at = new Date().toISOString();
  const preview = structuredClone(previous);
  const audit = rewindRun(preview, target, at);
  if (audit.restoredTree) {
    if (!previous.workspace?.cwd) throw new Error("The run has no worktree to restore");
    const restored = await restoreTree(previous.workspace.cwd, audit.restoredTree);
    if (restored !== audit.restoredTree) throw new Error("The worktree did not match the selected restart checkpoint");
  }
  const artifact = await restartAuditArtifact(previous, audit);
  previews.stopMatching(`${ticketId}:`);
  await update((state) => {
    const run = ticketRun(state, ticketId);
    rewindRun(run, target, at);
    run.artifacts.push(artifact);
    for (const previewState of Object.values(run.previews || {})) Object.assign(previewState, { status: "stopped", stoppedReason: "run_restart", stoppedAt: at });
  });
  if (target === "stage:explore") await surfaceImmediateFailure(ticketId, continueAfterRequirements(ticketId, ""));
  else if (target === "stage:design") await surfaceImmediateFailure(ticketId, startTicketWork(ticketId, (signal) => designTicket(ticketId, "Restart design from the persisted exploration.", signal)));
  else await surfaceImmediateFailure(ticketId, runTicket(ticketId));
  return audit;
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, version: packageMetadata.version });
  if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, publicState(store.read()));
  const compactTicketRun = url.pathname.match(/^\/api\/tickets\/([^/]+)\/run$/);
  if (request.method === "GET" && compactTicketRun) {
    const state = store.read();
    const run = ticketRun(state, decodeURIComponent(compactTicketRun[1]));
    return json(response, 200, url.searchParams.get("detail") === "1" ? publicRun(run) : compactRun(run, state.revision));
  }
  if (request.method === "GET" && url.pathname === "/api/models") {
    const models = await harness.models("openai-codex");
    const providers = [...new Set(models.map((model) => model.provider).filter(Boolean))];
    return json(response, 200, {
      models,
      ...(providers.length === 1 ? { provider: providers[0] } : providers.length ? { providers } : {})
    });
  }
  if (request.method === "GET" && url.pathname === "/api/skills") {
    const state = store.read();
    const run = state.selectedTicketId ? state.ticketRuns[state.selectedTicketId] : null;
    return json(response, 200, { skills: await harness.listSkills(skillSession(state, run)), skillName: run?.workflow?.skillName || null });
  }
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
    if (process.platform !== "darwin") throw new Error("Opening artifacts in Zed currently requires macOS");
    const run = ticketRun(store.read(), decodeURIComponent(openArtifact[1]));
    const path = artifactPathForOpen(run.artifacts, decodeURIComponent(openArtifact[2]), dataDir);
    const file = path ? await stat(path).catch(() => null) : null;
    if (!file?.isFile()) throw new Error("Artifact file not found");
    await runFile("open", ["-a", "Zed", path]);
    return json(response, 200, { opened: true });
  }
  if (request.method === "POST" && url.pathname === "/api/queue/clear") {
    let cleared = 0;
    const state = await update((draft) => { cleared = clearInactiveRuns(draft, new Set([...activeTickets.keys(), ...activeMerges])); });
    return json(response, 200, { cleared, state });
  }
  const forget = url.pathname.match(/^\/api\/tickets\/([^/]+)\/forget$/);
  if (request.method === "POST" && forget) {
    const id = decodeURIComponent(forget[1]);
    if (!(await body(request)).confirmed) throw new Error("Confirm permanently forgetting this run");
    if (activeTickets.has(id) || activeMerges.has(id)) throw new Error("Cancel the active run before forgetting it");
    const run = ticketRun(store.read(), id);
    await cleanupRetainedRun({ run, dataDir, previewManager: previews });
    const state = await update((draft) => {
      delete draft.ticketRuns[id];
      if (draft.selectedTicketId === id) draft.selectedTicketId = null;
    });
    return json(response, 200, { forgotten: true, ticketId: id, state });
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
      const snapshot = store.read();
      const run = snapshot.ticketRuns[id] || snapshot.retainedRuns?.[id];
      if (!run) throw new Error(`Retained run not found: ${id}`);
      if (activeTickets.has(run.id) || activeMerges.has(run.id)) throw new Error(`Cannot clean active run ${run.id}`);
      if (!terminalRunStatusSet.has(run.status)) throw new Error(`Run ${id} is not safe to clean`);
      cleaned.push(await cleanupRetainedRun({ run, dataDir, previewManager: snapshot.ticketRuns[run.id] && id !== run.id ? null : previews }));
      await update((draft) => {
        delete draft.ticketRuns[id];
        delete draft.retainedRuns?.[id];
        if (draft.selectedTicketId === id) draft.selectedTicketId = null;
      });
    }
    return json(response, 200, { cleaned, inventory: await retentionInventory(store.read(), dataDir), state: store.read() });
  }
  const artifactMedia = url.pathname.match(/^\/api\/tickets\/([^/]+)\/artifacts\/([^/]+)\/media$/);
  if (request.method === "GET" && artifactMedia) {
    const run = ticketRun(store.read(), decodeURIComponent(artifactMedia[1]));
    const artifactId = decodeURIComponent(artifactMedia[2]);
    const artifact = (run.artifacts || []).find((item) => item.id === artifactId);
    const path = artifactPathForOpen(run.artifacts, artifactId, dataDir);
    const media = artifact?.kind === "visual-evidence" && visualEvidenceMedia(artifact.name || path);
    if (!path || !media) throw new Error("Visual evidence not found");
    response.writeHead(200, { "content-type": media.mediaType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(await readFile(path));
    return;
  }
  const artifactGet = url.pathname.match(/^\/api\/tickets\/([^/]+)\/artifacts\/([^/]+)$/);
  if (request.method === "GET" && artifactGet) {
    const run = ticketRun(store.read(), decodeURIComponent(artifactGet[1]));
    const artifact = (run.artifacts || []).find((item) => item.id === decodeURIComponent(artifactGet[2]));
    if (!artifact) throw new Error("Artifact not found");
    return json(response, 200, artifact);
  }
  const sessionTrace = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/session-trace$/);
  if (request.method === "GET" && sessionTrace) {
    const run = ticketRun(store.read(), decodeURIComponent(sessionTrace[1]));
    const step = findNode(run.plan, decodeURIComponent(sessionTrace[2]));
    if (!step) throw new Error("Step not found");
    return json(response, 200, await harness.sessionTrace(step.sessionFile));
  }
  const stagePrompts = url.pathname.match(/^\/api\/tickets\/([^/]+)\/stages\/([^/]+)\/prompts$/);
  if (request.method === "GET" && stagePrompts) {
    const run = ticketRun(store.read(), decodeURIComponent(stagePrompts[1]));
    const stage = run.stages.find((item) => item.id === decodeURIComponent(stagePrompts[2]));
    if (!stage) throw new Error("Stage not found");
    return json(response, 200, { prompts: await promptsForStage(run, stage) });
  }
  const reviewMapRoute = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/review-map$/);
  if (request.method === "POST" && reviewMapRoute) {
    const ticketId = decodeURIComponent(reviewMapRoute[1]);
    const stepId = decodeURIComponent(reviewMapRoute[2]);
    const run = ticketRun(store.read(), ticketId);
    const step = findNode(run.plan, stepId);
    if (!step?.diff?.available || !step.diff.patch) throw new Error("This step has no textual diff to map");
    const reviewMap = await harness.generateReviewMap({
      cwd: step.workspace?.cwd || run.workspace.cwd, ticket: run.ticket, step, diff: step.diff, runId: run.runId,
      profile: run.stageProfiles.verification
    });
    const artifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, stageId: "implement", stepId, name: "review-map.json", content: JSON.stringify(reviewMap, null, 2), kind: "semantic-review-map"
    });
    const state = await update((draft) => {
      const current = ticketRun(draft, ticketId);
      const target = findNode(current.plan, stepId);
      target.reviewMap = reviewMap;
      target.artifacts ||= [];
      target.artifacts.push(artifact);
      current.artifacts.push(artifact);
    });
    return json(response, 200, { reviewMap, state });
  }
  if (request.method === "POST" && url.pathname === "/api/stage-profiles") {
    const input = await body(request);
    const profiles = normalizeStageProfiles(input.profiles);
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
  const ticketStageProfile = url.pathname.match(/^\/api\/tickets\/([^/]+)\/stage-profiles\/([^/]+)$/);
  if (request.method === "POST" && ticketStageProfile) {
    const ticketId = decodeURIComponent(ticketStageProfile[1]);
    const profileId = decodeURIComponent(ticketStageProfile[2]);
    const input = await body(request);
    const run = ticketRun(store.read(), ticketId);
    if (activeTickets.has(ticketId)) throw new Error("Pause the run before changing its stage profile");
    if (!run.stageProfiles?.[profileId]) throw new Error("Unknown stage profile");
    const profiles = normalizeStageProfiles({
      ...run.stageProfiles,
      [profileId]: { ...run.stageProfiles[profileId], model: input.model, thinking: input.thinking }
    });
    await harness.validateProfiles({ [profileId]: profiles[profileId] });
    await update((draft) => {
      if (activeTickets.has(ticketId)) throw new Error("Pause the run before changing its stage profile");
      ticketRun(draft, ticketId).stageProfiles[profileId] = profiles[profileId];
    });
    return json(response, 200, { ticketId, profile: profiles[profileId] });
  }
  if (request.method === "GET" && url.pathname === "/api/tickets") {
    return json(response, 200, await refreshTrackers());
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const client = { response, queue: [] };
    response.on("drain", () => flushSse(client));
    response.write(`data: ${JSON.stringify({ type: "state", state: publicState(store.read()) })}\n\n`);
    clients.add(client);
    request.on("close", () => clients.delete(client));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workspace/pick") return json(response, 200, { cwd: await pickDirectory() });
  if (request.method === "POST" && url.pathname === "/api/workspace") {
    const input = await body(request);
    const cwd = normalize(String(input.cwd || ""));
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Workspace must be an existing absolute directory");
    const previous = store.read().workspace?.cwd;
    const state = await update((draft) => { draft.workspace = { cwd }; });
    if (previous !== cwd) harness.reset();
    ticketCache = new Map();
    return json(response, 200, publicState(state));
  }
  if (request.method === "POST" && url.pathname === "/api/local/load") {
    const input = await body(request);
    return json(response, 201, await loadLocalRun(String(input.path || "fixtures/zero-state-task-board")));
  }

  if (request.method === "POST" && url.pathname === "/api/tickets/start") {
    const input = await body(request);
    const ids = [...new Set(Array.isArray(input.ticketIds) ? input.ticketIds.map(String) : [])];
    if (!ids.length) throw new Error("Select at least one ticket");
    const tickets = ids.map((id) => ticketCache.get(id));
    if (tickets.some((ticket) => !ticket)) throw new Error("Refresh the ticket sources before starting the selection");
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
    const state = await update((draft) => { draft.selectedTicketId = id; }, { publish: false });
    const selection = { selectedTicketId: id, revision: state.revision, run: state.ticketRuns[id] ? publicRun(state.ticketRuns[id]) : null };
    publish({ type: "selection", ...selection });
    return json(response, 200, selection);
  }

  const listSkills = url.pathname.match(/^\/api\/tickets\/([^/]+)\/skills$/);
  if (request.method === "GET" && listSkills) {
    const id = decodeURIComponent(listSkills[1]);
    const state = store.read();
    const run = ticketRun(state, id);
    return json(response, 200, { skills: await harness.listSkills(skillSession(state, run)), skillName: run.workflow?.skillName || null });
  }

  const bindWorkflow = url.pathname.match(/^\/api\/tickets\/([^/]+)\/workflow$/);
  if (request.method === "POST" && bindWorkflow) {
    const id = decodeURIComponent(bindWorkflow[1]);
    const skillName = String((await body(request)).skillName || "").trim();
    if (!skillName) throw new Error("Choose a Pi skill to bind");
    const before = store.read();
    const run = ticketRun(before, id);
    const activation = await harness.activateWorkflow({ ...skillSession(before, run), skillName });
    const state = await update((draft) => {
      persistWorkflowActivation(ticketRun(draft, id), skillName, activation);
    });
    return json(response, 200, { skillName, state: publicState(state) });
  }

  const continueWorkflow = url.pathname.match(/^\/api\/tickets\/([^/]+)\/workflow\/continue$/);
  if (request.method === "POST" && continueWorkflow) {
    const id = decodeURIComponent(continueWorkflow[1]);
    const input = await body(request);
    const before = store.read();
    const run = ticketRun(before, id);
    const workflow = initialWorkflow(run.workflow);
    const checkpoint = workflow.checkpoints.find((item) => item.id === input.checkpointId);
    if (!checkpoint || checkpoint.status !== "pending") throw new Error("Workflow checkpoint not found");
    await acceptCheckpointAnswer(id, String(input.response || "Approved"), "dashboard", { checkpointId: checkpoint.id });
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const resume = url.pathname.match(/^\/api\/tickets\/([^/]+)\/resume$/);
  if (request.method === "POST" && resume) {
    const id = decodeURIComponent(resume[1]);
    const run = ticketRun(store.read(), id);
    if (run.recovery?.kind === "delivery") {
      if (run.recovery.uncertainExternalActions && !run.merge?.change) throw new Error(run.recovery.message);
      const contextContent = [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "product-context-update")?.content || null;
      const diff = run.reviews?.at(-1)?.diff || null;
      scheduleTicketIntegration(id, { diff, contextContent }).catch(() => {});
      return json(response, 202, { accepted: true, ticketId: id, recovery: "delivery" });
    }
    const stage = resumeStage(run);
    if (!["run", "requirements", "explore", "design"].includes(stage)) throw new Error("This run cannot be resumed from its current stage");
    if (["cancelled", "needs_attention", "failed", "paused"].includes(run.status)) await update((state) => {
      const current = ticketRun(state, id);
      auditHarnessWriteScopes(current);
      prepareRunResume(current);
    });
    if (stage === "requirements") await surfaceImmediateFailure(id, prepareTicket(id));
    else if (stage === "explore") await surfaceImmediateFailure(id, continueAfterRequirements(id, ""));
    else if (stage === "design") await surfaceImmediateFailure(id, startTicketWork(id, (signal) => designTicket(id, "Resume the interrupted design.", signal)));
    else await surfaceImmediateFailure(id, runTicket(id));
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const restart = url.pathname.match(/^\/api\/tickets\/([^/]+)\/restart$/);
  if (request.method === "POST" && restart) {
    const id = decodeURIComponent(restart[1]);
    const input = await body(request);
    if (input.confirmed !== true) throw new Error("Confirm the restart after reviewing its impact");
    const target = String(input.target || "");
    if (target === "fresh") await startFreshRun(id);
    else if (/^(?:stage:(?:explore|design|verify)|step:[a-z0-9][a-z0-9-]*)$/.test(target)) await restartFrom(id, target);
    else throw new Error("Choose a valid stage or step restart point");
    return json(response, 202, { accepted: true, ticketId: id, target });
  }

  const cancel = url.pathname.match(/^\/api\/tickets\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancel) {
    const id = decodeURIComponent(cancel[1]);
    await cancelTicket(id);
    return json(response, 200, { cancelled: true, ticketId: id });
  }

  const pause = url.pathname.match(/^\/api\/tickets\/([^/]+)\/pause$/);
  if (request.method === "POST" && pause) {
    const id = decodeURIComponent(pause[1]);
    const checkpoint = await pauseTicket(id);
    return json(response, 200, { paused: true, ticketId: id, ...checkpoint });
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
    else if (["technical_input", "needs_input"].includes(run.checkpoint?.kind) || (run.checkpoint?.kind === "awaiting_approval" && (run.checkpoint.stepId || run.checkpoint.source === "supervisor"))) {
      if (run.checkpoint.kind !== "awaiting_approval" && !answers.trim()) throw new Error("Answer the open question before continuing");
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
    const violations = planReviewViolations(plan);
    if (violations.length) throw new Error(violations.join("; "));
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
    const run = ticketRun(store.read(), id);
    if (!planApprovalPending(run)) throw new Error("This ticket has no plan awaiting approval");
    const violations = planReviewViolations(run.plan);
    if (violations.length) throw new Error(`Split or justify oversized plan steps before approval: ${violations.join("; ")}`);
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
    await surfaceImmediateFailure(id, runTicket(id));
    return json(response, 202, { accepted: true, ticketId: id });
  }

  const approveEvidence = url.pathname.match(/^\/api\/tickets\/([^/]+)\/evidence\/approve$/);
  if (request.method === "POST" && approveEvidence) {
    const id = decodeURIComponent(approveEvidence[1]);
    await finishHandoff(id);
    return json(response, 200, { accepted: true, ticketId: id });
  }

  const changeEvidence = url.pathname.match(/^\/api\/tickets\/([^/]+)\/evidence\/changes$/);
  if (request.method === "POST" && changeEvidence) {
    const id = decodeURIComponent(changeEvidence[1]);
    const input = await body(request);
    const feedback = String(input.feedback || "").trim();
    if (!feedback) throw new Error("Describe the final-proof changes required before continuing");
    const run = ticketRun(store.read(), id);
    if (run.checkpoint?.kind !== "evidence_review") throw new Error("No final proof review is awaiting changes");
    await update((state) => {
      const current = ticketRun(state, id);
      current.pendingEvidenceFeedback = feedback;
      current.checkpoint = null;
      current.status = "reviewing";
      setStage(current, "verify", "active", "Addressing final proof review feedback");
    });
    await surfaceImmediateFailure(id, startTicketWork(id, (signal) => finalReviewLoop(id, signal)));
    return json(response, 202, { accepted: true, ticketId: id });
  }

  // Keep the former context-only action working for saved dashboard clients; it now
  // resolves the same final proof gate rather than skipping any evidence review.
  const approveContext = url.pathname.match(/^\/api\/tickets\/([^/]+)\/context\/approve$/);
  if (request.method === "POST" && approveContext) {
    const id = decodeURIComponent(approveContext[1]);
    await finishHandoff(id);
    return json(response, 200, { accepted: true, ticketId: id });
  }

  const stepScope = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/scope$/);
  if (request.method === "POST" && stepScope) {
    const ticketId = decodeURIComponent(stepScope[1]);
    const stepId = decodeURIComponent(stepScope[2]);
    const input = await body(request);
    const paths = approvedScopePaths(input.paths);
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Explain why the approved scope must expand");
    if (activeTickets.has(ticketId)) throw new Error("Pause the run before changing a step scope");
    const state = await update((draft) => {
      const run = ticketRun(draft, ticketId);
      const step = findNode(run.plan, stepId);
      if (!step || !["needs_attention", "needs_input", "awaiting_approval", "failed", "interrupted"].includes(step.status)) throw new Error("Only a stopped blocked step can receive a scope expansion");
      const existing = step.writeScope.split(",").map((path) => path.trim()).filter(Boolean);
      step.writeScope = [...new Set([...existing, ...paths])].join(",");
      step.expectedFiles = [...new Set([...(step.expectedFiles || []), ...paths])];
      step.scopeChanges ||= [];
      const change = { at: new Date().toISOString(), paths, reason, source: "operator" };
      step.scopeChanges.push(change);
      const note = `Approved scope expansion: ${paths.join(", ")} — ${reason}`;
      step.lastError = [step.lastError, note].filter(Boolean).join("\n\n");
      run.lastError = [run.lastError, note].filter(Boolean).join("\n\n");
      if (run.checkpoint?.stepId === stepId) run.checkpoint.prompt = [run.checkpoint.prompt, note].filter(Boolean).join("\n\n");
    });
    const step = findNode(ticketRun(state, ticketId).plan, stepId);
    return json(response, 200, { ticketId, stepId, writeScope: step.writeScope, expectedFiles: step.expectedFiles, scopeChange: step.scopeChanges.at(-1) });
  }

  const stepWaiver = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/waive$/);
  if (request.method === "POST" && stepWaiver) {
    const ticketId = decodeURIComponent(stepWaiver[1]);
    const stepId = decodeURIComponent(stepWaiver[2]);
    const input = await body(request);
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Explain why the verifier finding is false or outside this slice");
    if (activeTickets.has(ticketId)) throw new Error("Pause the run before waiving a verifier finding");
    const state = await update((draft) => {
      const run = ticketRun(draft, ticketId);
      const step = findNode(run.plan, stepId);
      if (!step || step.status !== "needs_attention" || run.checkpoint?.stepId !== stepId || run.checkpoint?.source !== "verification") {
        throw new Error("Only a stopped verifier finding can be waived");
      }
      const attempt = [...(step.attempts || [])].reverse().find((item) => item.verification);
      if (!attempt) throw new Error("No verifier finding is available to waive");
      const waiver = { at: new Date().toISOString(), reason, source: "operator", findings: actionableFindings([attempt?.verification]) };
      attempt.verificationDisposition = { status: "waived", at: waiver.at, reason, source: waiver.source };
      step.verificationWaivers ||= [];
      step.verificationWaivers.push(waiver);
      step.status = "review_ready";
      step.lastError = null;
      run.status = "awaiting_step_review";
      run.lastError = null;
      run.checkpoint = { id: randomUUID(), kind: "step_review", stepId, title: `Review after verification waiver: ${step.title}`, prompt: reason, createdAt: waiver.at };
      setStage(run, "implement", "blocked", `Verifier finding waived for review: ${reason}`);
    });
    const step = findNode(ticketRun(state, ticketId).plan, stepId);
    return json(response, 200, { ticketId, stepId, status: step.status, waiver: step.verificationWaivers.at(-1) });
  }

  const stepDecision = url.pathname.match(/^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/(accept|changes)$/);
  if (request.method === "POST" && stepDecision) {
    const [, encodedTicketId, encodedStepId, decision] = stepDecision;
    const ticketId = decodeURIComponent(encodedTicketId);
    const stepId = decodeURIComponent(encodedStepId);
    const input = await body(request);
    const current = ticketRun(store.read(), ticketId);
    const step = findNode(current.plan, stepId);
    if (!step) throw new Error("This step is not ready for review");
    if (decision === "accept" && input.auto === true) {
      await update((state) => { ticketRun(state, ticketId).auto = true; });
    }
    if (decision === "accept" && step.status === "accepted") return json(response, 200, { accepted: true, alreadyAccepted: true, ticketId, stepId, auto: input.auto === true });
    if (step.status !== "review_ready") throw new Error("This step is not ready for review");
    if (decision === "changes") {
      const noteRequests = Array.isArray(input.noteRequests)
        ? input.noteRequests
        : [...(Array.isArray(input.noteIds) ? input.noteIds : []), input.noteId].map((id) => ({ id, feedback: input.feedback }));
      const feedback = reviewNoteFeedback(step.reviewNotes, noteRequests, input.feedback);
      await update((state) => {
        const run = ticketRun(state, ticketId);
        delete findNode(run.plan, stepId).workspaceCommit;
        run.status = "running";
        run.checkpoint = null;
        setStage(run, "implement", "active", `Revising ${step.title}`);
      });
      await surfaceImmediateFailure(ticketId, startTicketWork(ticketId, (signal) => executeStep(ticketId, stepId, { feedback, signal })));
      return json(response, 202, { accepted: true, ticketId, stepId });
    }
    await acceptStep(ticketId, stepId);
    await surfaceImmediateFailure(ticketId, startTicketWork(ticketId, async (signal) => {
      try { await advanceTicket(ticketId, signal); }
      catch (error) {
        if (signal.aborted) return;
        await update((state) => {
          const run = ticketRun(state, ticketId);
          run.status = "needs_attention";
          run.lastError = error.message;
        });
      }
    }));
    return json(response, 202, { accepted: true, ticketId, stepId, auto: input.auto === true });
  }

  json(response, 404, { error: "Not found" });
}

const handleRequest = createHandleRequest({ publicDir, apiToken, host, port, api });
const server = createServer(handleRequest);
const sseHeartbeat = setInterval(() => {
  for (const client of clients) writeSse(client, ":\n\n");
}, 15000);
sseHeartbeat.unref();

let closed = false;
async function close({ exit = false } = {}) {
  if (closed) return;
  closed = true;
  clearInterval(pollTimer);
  clearInterval(sseHeartbeat);
  closeSseClients(clients);
  previews.stopAll();
  for (const active of [...activeTickets.values()]) active.controller.abort(new Error("Daemon shutting down"));
  await Promise.all([...activeTickets.values()].map((active) => active.promise.catch(() => {})));
  try { harness.reset(); } catch {}
  await new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  await daemonLock.release().catch(() => {});
  if (exit) process.exit(0);
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
