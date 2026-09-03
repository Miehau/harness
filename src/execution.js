import { randomUUID } from "node:crypto";
import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";
import { gateStepStatusSet, inFlightRunStatusSet, inFlightStepStatusSet, restartableStepStatusSet, resumeRunStatusSet, runnableStepStatusSet } from "./run-status.js";
import { initialWorkflow, workflowBlockers } from "./workflow.js";
import { inspectionFocus } from "./inspection.js";
import { boundedText, redactRecord, redactText, safeArtifactMetadata, safeReasoningSummary } from "./redaction.js";

export const runStageDefs = [
  ["requirements", "Clarify requirements"],
  ["explore", "Explore code & ticket horizon"],
  ["design", "Design & plan"],
  ["implement", "Implement"],
  ["verify", "Review & verify"],
  ["handoff", "Handoff"]
];

export function initialStages() {
  return runStageDefs.map(([id, title], index) => ({ id, title, status: index ? "pending" : "active", summary: "" }));
}

export function localStages() {
  const stages = initialStages();
  for (const stage of stages.slice(0, 3)) Object.assign(stage, { status: "completed", summary: "Loaded from the local fixture" });
  return stages;
}

export function createTicketRun(ticket, stageProfiles, extras = {}) {
  const {
    runId = randomUUID(),
    automaticAdmission = false,
    status = "preparing",
    workspace = null,
    stages,
    checkpoint = null,
    plan = null,
    artifacts = [],
    activeRuns = {},
    trackerEvents = {},
    sessionFile = null,
    auto = false,
    lastError = null,
    workflow,
    createdAt = new Date().toISOString(),
    ...rest
  } = extras;
  return {
    id: ticket.id,
    runId,
    ticket,
    automaticAdmission,
    status,
    workspace,
    stageProfiles: structuredClone(stageProfiles),
    stages: stages || initialStages(),
    checkpoint,
    plan,
    artifacts,
    activeRuns,
    trackerEvents,
    sessionFile,
    auto,
    lastError,
    workflow: workflow || initialWorkflow(),
    createdAt,
    ...rest
  };
}

export function appendBounded(value, addition, limit) {
  const chunk = String(addition || "");
  if (chunk.length >= limit) return chunk.slice(-limit);
  const current = String(value || "");
  return `${current.slice(Math.max(0, current.length + chunk.length - limit))}${chunk}`;
}

export function pushBounded(items, item, limit) {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function activityGroupMeta(event = {}) {
  if (event.type === "phase") return { title: event.label || "Workflow step", note: "", focus: true };
  if (event.type === "reasoning_summary") return { title: safeReasoningSummary(String(event.detail || "Plan next action").split(/\r?\n/).find((line) => line.trim()) || "Plan next action", 120) || "Plan next action", note: safeReasoningSummary(event.detail || "", 1000), focus: true };
  if (event.type === "thinking") return { title: "Plan next action", note: "", focus: true };
  if (event.type === "agent_error") return { title: "Investigate failure", note: event.label || "", focus: false };
  const tool = event.tool || "";
  if (["read", "grep", "find", "ls"].includes(tool)) return { title: "Explore repository", note: "", focus: false };
  if (["edit", "write"].includes(tool)) return { title: "Change implementation", note: "", focus: false };
  if (tool === "worker_report") return { title: "Record worker outcome", note: "", focus: false };
  if (tool === "bash") return { title: /\b(test|check|verify)\b/i.test(event.args || "") ? "Run verification" : "Run command", note: "", focus: false };
  return { title: "Agent activity", note: "", focus: false };
}

export function groupActivityEvents(events = []) {
  const groups = [];
  const openTools = new Map();
  let current = null;
  for (const event of events) {
    if (["agent_start", "turn_start", "turn_end", "agent_settled", "usage"].includes(event.type)) continue;
    let group = event.callId ? openTools.get(event.callId) : null;
    if (!group) {
      const meta = activityGroupMeta(event);
      const keepFocus = current?.focus && !["phase", "reasoning_summary", "agent_error"].includes(event.type);
      if (keepFocus) group = current;
      else if (current?.title === meta.title && current.note === meta.note) group = current;
      else {
        group = { key: `group:${groups.length}:${event.at || ""}`, title: meta.title, note: meta.note, at: event.at, endedAt: event.at, focus: meta.focus, events: [], isError: false };
        groups.push(group);
      }
    }
    group.events.push(event);
    group.endedAt = event.at || group.endedAt;
    group.isError ||= event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    current = group;
    if (event.type === "tool_start" && event.callId) openTools.set(event.callId, group);
    if (event.type === "tool_end" && event.callId) openTools.delete(event.callId);
  }
  const activeGroups = new Set(openTools.values());
  return groups.map((group) => {
    const { focus, ...saved } = group;
    return { ...saved, status: group.isError ? "failed" : activeGroups.has(group) ? "running" : "complete" };
  });
}

export function createActivityCapture({ existing = {}, persist, emit, now = Date.now, outputLimit = 100000, eventLimit = 200 }) {
  const startedAt = existing.startedAt || new Date(now()).toISOString();
  const events = redactRecord((existing.events || []).slice(-eventLimit));
  const prompts = redactRecord((existing.prompts || []).slice(-20));
  let rawOutput = appendBounded("", redactText(existing.rawOutput), outputLimit);
  let lastEventAt = existing.lastEventAt || startedAt;
  let lastEvent = existing.lastEvent || "";
  let warning = Boolean(existing.warning);
  let completedAt = existing.completedAt;
  let persistence;
  let dirty = false;
  const lastThinkingAt = new Map();
  const current = () => ({
    startedAt, lastEventAt, lastEvent, warning, rawOutput, events: events.slice(), prompts: prompts.slice(), groups: groupActivityEvents(events),
    ...(completedAt ? { completedAt } : {})
  });
  const save = () => {
    dirty = true;
    if (persistence || !persist) return;
    persistence = (async () => {
      while (dirty) {
        dirty = false;
        await persist(current());
      }
    })().catch(() => {}).finally(() => {
      persistence = null;
      if (dirty) save();
    });
  };
  return {
    onEvent(event, actor) {
      const timestamp = now();
      const activityKey = actor || "stage";
      if (event.type === "thinking" && timestamp - (lastThinkingAt.get(activityKey) || 0) < 2000) return;
      if (event.type === "thinking") lastThinkingAt.set(activityKey, timestamp);
      const item = redactRecord({ ...event, ...(actor ? { actor } : {}), at: new Date(timestamp).toISOString() });
      if (item.type === "prompt") {
        const prompt = boundedText(item.content || item.prompt, 16000);
        item.content = prompt.value;
        item.truncated = Boolean(item.truncated) || prompt.truncated;
        item.total = Math.max(prompt.total, Number(item.total) || 0);
        delete item.prompt;
        pushBounded(prompts, item, 20);
        lastEventAt = item.at;
        lastEvent = item.label || lastEvent;
        save();
      } else if (item.type === "text_delta") {
        rawOutput = appendBounded(rawOutput, redactText(item.delta), outputLimit);
        // Deltas carry the only copy of streamed output while the worker is live.
        // Use the existing coalescing writer so abort/restart recovery sees its tail.
        save();
      } else {
        pushBounded(events, item, eventLimit);
        lastEventAt = item.at;
        lastEvent = item.label || lastEvent;
        warning = item.type === "agent_error" || (item.type === "tool_end" && item.isError);
        save();
      }
      emit?.(item);
    },
    snapshot() {
      completedAt ||= new Date(now()).toISOString();
      return current();
    },
    async flush() {
      do {
        if (dirty && !persistence) save();
        await persistence;
      } while (dirty || persistence);
    }
  };
}

const attemptEventLimit = 200;
const attemptOutputLimit = 100000;

function boundedAttemptActivity(activity = {}, rawOutput = "") {
  return {
    events: redactRecord(structuredClone((activity.events || []).slice(-attemptEventLimit))),
    activityGroups: redactRecord(structuredClone((activity.groups || []).slice(-attemptEventLimit))),
    prompts: (activity.prompts || []).slice(-20).map((item) => {
      const { prompt: legacyPrompt, ...saved } = item;
      const bounded = boundedText(saved.content || legacyPrompt, 4000);
      return redactRecord({
        ...saved,
        content: bounded.value,
        truncated: Boolean(saved.truncated) || bounded.truncated,
        total: Math.max(bounded.total, Number(saved.total) || 0)
      });
    }),
    rawOutput: appendBounded("", redactText(activity.rawOutput || rawOutput), attemptOutputLimit)
  };
}

export function failureDetails(error, { status, reason, phase = "execution" } = {}) {
  const message = String(error || reason || "");
  if (!["failed", "needs_attention", "verification_failed", "cancelled", "paused", "interrupted"].includes(status)) {
    return { kind: null, phase: null, message: null };
  }
  const kind = status === "cancelled" ? "cancellation"
    : status === "paused" || status === "interrupted" ? "interruption"
    : /provider|model request|rate limit|quota|authentication|api key|timeout/i.test(message) ? "provider"
    : /check|test|verification/i.test(message) ? "verification"
    : "execution";
  return { kind, phase, message: redactText(message) || null };
}

// This is the sole conversion from mutable active state into durable history. Callers
// may add new attempts, but must never mutate an attempt returned by this helper.
export function snapshotActiveAttempt(step, active = {}, {
  status, completedAt = new Date().toISOString(), reason = null, error = null, phase = "execution",
  activity = active.activity || {}, rawOutput = "", report, verification, diff, vcsChange,
  feedback, violations, artifactRefs = []
} = {}) {
  const attemptId = active.attemptId || `attempt-${(step.attempts?.length || 0) + 1}`;
  const bounded = boundedAttemptActivity(activity, rawOutput);
  const promptSource = active.prompt || activity.prompts?.at(-1)?.content || activity.prompts?.at(-1)?.prompt || "";
  const prompt = boundedText(promptSource, 16000);
  const activityPrompt = activity.prompts?.at(-1);
  const promptTruncated = Boolean(active.promptTruncated ?? activityPrompt?.truncated) || prompt.truncated;
  const promptTotal = Math.max(prompt.total, Number(active.promptTotal ?? activityPrompt?.total) || 0);
  const failure = failureDetails(error, { status, reason, phase });
  return {
    runId: active.runId || null,
    attemptId,
    startedAt: active.startedAt || activity.startedAt || completedAt,
    completedAt,
    status,
    terminationReason: reason || status,
    termination: { reason: reason || status, at: completedAt },
    failureKind: failure.kind,
    failurePhase: failure.phase,
    failure,
    lastEvent: redactText(activity.lastEvent || active.lastEvent || ""),
    lastEventAt: activity.lastEventAt || active.lastEventAt || null,
    ...bounded,
    ...(prompt.value ? { prompt: prompt.value, promptTruncated, promptTotal } : {}),
    sessionFile: active.sessionFile || step.sessionFile || null,
    ...(report === undefined ? {} : { report: redactRecord(structuredClone(report)) }),
    ...(verification === undefined ? {} : { verification: redactRecord(structuredClone(verification)) }),
    ...(diff === undefined ? {} : { diff: redactRecord(structuredClone(diff)) }),
    ...(vcsChange === undefined ? {} : { vcsChange: redactRecord(structuredClone(vcsChange)) }),
    ...(feedback === undefined ? {} : { feedback: redactText(feedback) }),
    ...(violations === undefined ? {} : { violations: redactRecord(structuredClone(violations)) }),
    ...(artifactRefs.length ? { artifactRefs: redactRecord(structuredClone(artifactRefs)) } : {}),
    ...(error ? { error: redactText(error) } : {})
  };
}

export function materializeActiveAttempt(step, active, options) {
  step.attempts ||= [];
  const attempt = snapshotActiveAttempt(step, active, options);
  step.attempts.push(attempt);
  if (attempt.sessionFile) step.sessionFile = attempt.sessionFile;
  return attempt;
}

export function markRunCancelled(run, at = new Date().toISOString()) {
  run.status = "cancelled";
  run.cancelledAt = at;
  run.checkpoint = null;
  for (const step of flattenSteps(run.plan)) {
    if (!inFlightStepStatusSet.has(step.status)) continue;
    materializeActiveAttempt(step, run.activeRuns?.[step.id] || {}, { status: "cancelled", completedAt: at, reason: "run_cancelled" });
    step.status = "cancelled";
  }
  run.activeRuns = {};
  const stage = run.stages.find((item) => item.status === "active");
  if (stage) Object.assign(stage, { status: "blocked", summary: "Run cancelled" });
}

export function markRunPaused(run, at = new Date().toISOString()) {
  const stage = run.stages?.find((item) => item.status === "active") || null;
  const activeRuns = structuredClone(run.activeRuns || {});
  const steps = flattenSteps(run.plan);
  const audit = {
    id: `pause-${(run.pauseHistory?.length || 0) + 1}`,
    at,
    fromStatus: run.status,
    stageId: stage?.id || null,
    sessionFile: stage?.id === "requirements" ? run.requirementsSessionFile || null : run.sessionFile || null,
    steps: Object.entries(activeRuns).map(([stepId, active]) => ({
      stepId,
      runId: active.runId || null,
      sessionFile: active.sessionFile || steps.find((step) => step.id === stepId)?.sessionFile || null,
      startedAt: active.startedAt || null,
      lastEventAt: active.activity?.lastEventAt || active.lastEventAt || null,
      lastEvent: active.activity?.lastEvent || active.lastEvent || ""
    }))
  };
  for (const step of steps) {
    if (!inFlightStepStatusSet.has(step.status)) continue;
    materializeActiveAttempt(step, activeRuns[step.id] || {}, { status: "paused", completedAt: at, reason: "run_paused" });
    step.status = "interrupted";
  }
  run.status = "paused";
  run.pausedAt = at;
  run.checkpoint = null;
  run.activeRuns = {};
  run.lastError = null;
  run.pauseHistory ||= [];
  run.pauseHistory.push(audit);
  if (stage) Object.assign(stage, { status: "paused", summary: "Paused with the current session and activity saved" });
  return audit;
}

export function clearInactiveRuns(state, activeTicketIds) {
  let cleared = 0;
  for (const id of Object.keys(state.ticketRuns)) {
    const run = state.ticketRuns[id];
    if (activeTicketIds.has(id) && inFlightRunStatusSet.has(run.status)) continue;
    state.retainedRuns ||= {};
    state.retainedRuns[`${id}:${run.runId || "legacy"}`] = run;
    delete state.ticketRuns[id];
    cleared++;
  }
  if (state.selectedTicketId && !state.ticketRuns[state.selectedTicketId]) state.selectedTicketId = null;
  return cleared;
}

export function archiveRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  state.retainedRuns ||= {};
  state.retainedRuns[`${ticketId}:${run.runId || "legacy"}`] = run;
  delete state.ticketRuns[ticketId];
  return run;
}

function resetStagesFrom(run, stageId) {
  const index = run.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) throw new Error(`Unknown restart stage: ${stageId}`);
  for (const [stageIndex, stage] of run.stages.entries()) {
    if (stageIndex < index) continue;
    Object.assign(stage, { status: "pending", summary: stageIndex === index ? "Queued for restart" : "" });
    delete stage.activity;
    delete stage.diff;
    delete stage.baseTree;
  }
}

function resetStep(step) {
  const attempts = step.attempts?.length || 0;
  // A restart changes the live worker state, not its prior durable attempts.
  Object.assign(step, { status: "ready", artifacts: [], diff: null, vcsChange: null, sessionFile: null, supervisorReview: null, lastError: null });
  for (const key of ["acceptedAt", "commit", "commitMessage", "workspace", "workspaceCommit", "baseTree", "reviewMap", "reviewNotes", "reviewNotesArtifact", "reviewBudgetResult"]) delete step[key];
  return attempts;
}

export function rewindRun(run, target, at = new Date().toISOString()) {
  if (!run?.plan && !["stage:explore", "stage:design"].includes(target)) throw new Error("This run has no plan to restart");
  const previousStages = (run.stages || []).map(({ id, status }) => ({ id, status }));
  const previousSteps = flattenSteps(run.plan).map((step) => ({
    id: step.id, title: step.title, status: step.status, baseTree: step.baseTree || null,
    commit: step.commit || null, vcsChange: step.vcsChange || null, attempts: step.attempts?.length || 0,
    attemptHistory: structuredClone(step.attempts || [])
  }));
  const previousStatus = run.status;
  const previousCheckpoint = run.checkpoint?.kind || null;
  let stageId;
  let restoredTree = null;
  let resetStepIds = [];
  let discardedAttempts = 0;
  let retainedAttempts = 0;

  if (target === "stage:explore" || target === "stage:design") {
    stageId = target.slice(6);
    restoredTree = run.baselineTree;
    if (!restoredTree) throw new Error("This stage has no recorded repository baseline");
    run.plan = null;
    run.sessionFile = null;
    delete run.planApprovedAt;
  } else if (target === "stage:verify") {
    if (!flattenSteps(run.plan).length || flattenSteps(run.plan).some((step) => step.status !== "accepted")) throw new Error("Verification can restart only after every implementation step is accepted");
    stageId = "verify";
    run.reviews = [];
  } else {
    const stepId = String(target || "").replace(/^step:/, "");
    const steps = flattenSteps(run.plan);
    const selectedIndex = steps.findIndex((step) => step.id === stepId);
    if (selectedIndex < 0) throw new Error("Restart step not found");
    const selected = steps[selectedIndex];
    restoredTree = selected.baseTree || run.baselineTree;
    if (!restoredTree) throw new Error("This step has no recorded code checkpoint");
    const firstIndex = selected.baseTree ? steps.findIndex((step) => step.baseTree === selected.baseTree) : selectedIndex;
    const reset = steps.slice(Math.max(0, firstIndex));
    resetStepIds = reset.map((step) => step.id);
    // Keep the count for audit compatibility; restart no longer discards attempts.
    retainedAttempts = reset.reduce((total, step) => total + resetStep(step), 0);
    // Kept for existing audit readers; none of these durable attempts were discarded.
    discardedAttempts = 0;
    stageId = "implement";
  }

  resetStagesFrom(run, stageId);
  run.status = "interrupted";
  run.checkpoint = null;
  run.activeRuns = {};
  run.lastError = null;
  run.recovery = null;
  for (const key of ["completedAt", "merge", "integration", "deliveredDiff", "productContextPath"]) delete run[key];
  const audit = {
    id: `restart-${(run.restartHistory?.length || 0) + 1}`,
    at,
    target,
    fromStatus: previousStatus,
    fromCheckpoint: previousCheckpoint,
    previousStages,
    previousSteps,
    restoredTree,
    resetStepIds,
    discardedAttempts,
    retainedAttempts
  };
  run.restartHistory ||= [];
  run.restartHistory.push(audit);
  return audit;
}

export function planApprovalPending(run) {
  return Boolean(run?.plan && run.checkpoint?.kind === "awaiting_approval" && !run.checkpoint.stepId && run.checkpoint.source !== "supervisor");
}

export function selectWorkerSession(step, { forkSessionFile = null, feedback = "" } = {}) {
  const resume = Boolean(feedback) || ["needs_input", "awaiting_approval", "interrupted", "fixing"].includes(step?.status);
  if (resume && step?.sessionFile && step.contextPolicy !== "fresh") {
    return { resumeSessionFile: step.sessionFile, forkSessionFile: null };
  }
  return {
    resumeSessionFile: null,
    forkSessionFile: step?.contextPolicy === "fork" ? forkSessionFile || null : null
  };
}

export function workerReportCheckpoint(step, report, { source = "worker" } = {}) {
  if (!report || !["needs_input", "awaiting_approval"].includes(report.status)) return null;
  const request = String(report.request || report.summary || "").trim();
  return {
    kind: report.status,
    title: String(report.summary || (report.status === "needs_input" ? `${step.title} needs a decision` : `Approve ${step.title}`)).trim(),
    prompt: request || "The worker paused for a user decision before continuing.",
    questions: report.status === "needs_input" ? [request || "How should this worker continue?"] : [],
    stepId: step.id,
    source
  };
}

export function workflowGateCheckpoint(signal, { step = null, source = "supervisor" } = {}) {
  if (!signal) return null;
  const kind = signal.kind === "needs_input" ? "needs_input" : "awaiting_approval";
  const prompt = String(signal.prompt || "").trim() || "The supervisor paused for a user decision before continuing.";
  const title = String(signal.title || (kind === "needs_input" ? "Supervisor needs a decision" : "Supervisor approval required")).trim();
  return {
    kind,
    title,
    prompt,
    questions: kind === "needs_input"
      ? (Array.isArray(signal.questions) && signal.questions.length ? signal.questions.map(String) : [prompt])
      : [],
    stepId: signal.stepId || step?.id || null,
    source
  };
}

export function supervisorReviewCheckpoint(step, review) {
  return workflowGateCheckpoint(review?.checkpoints?.[0], { step, source: "supervisor" });
}

export function stepCheckpointResumeKind(checkpoint) {
  if (!checkpoint?.stepId) return null;
  return checkpoint.source === "supervisor" ? "supervisor" : "worker";
}

export function resumeStage(run) {
  if (!resumeRunStatusSet.has(run?.status)) return null;
  if (run.plan) return "run";
  const active = run.stages?.find((stage) => stage.status === "active")?.id;
  if (active) return active;
  const inferred = workflowResumeStage(run);
  return ["requirements", "explore", "design"].includes(inferred) ? inferred : null;
}

export function prepareRunResume(run) {
  if (!["cancelled", "needs_attention", "failed", "paused"].includes(run?.status)) return false;
  if (run.status === "paused") {
    const pause = run.pauseHistory?.at(-1);
    if (pause && !pause.resumedAt) pause.resumedAt = new Date().toISOString();
  }
  run.status = "interrupted";
  run.lastError = null;
  for (const step of flattenSteps(run.plan)) {
    if (restartableStepStatusSet.has(step.status)) step.status = "interrupted";
  }
  return true;
}

export function nextRunnableStep(plan) {
  return flattenSteps(plan).find((step) =>
    runnableStepStatusSet.has(step.status) && blockingReasons(plan, step).length === 0
  ) || null;
}

export function nextRunnableBatch(plan) {
  if (flattenSteps(plan).some((step) => gateStepStatusSet.has(step.status))) return [];
  const first = nextRunnableStep(plan);
  if (!first) return [];
  const group = parentGroup(plan, first.id);
  return group ? group.children.filter((step) =>
    runnableStepStatusSet.has(step.status) && blockingReasons(plan, step).length === 0
  ) : [first];
}

const actionableSeverities = new Set(["critical", "high", "medium", "blocking", "warning"]);

export function actionableFindings(reviews) {
  const seen = new Set();
  return reviews.flatMap((review) => review.findings || [])
    .filter((finding) => {
      const severity = String(finding.severity || "").toLowerCase();
      if (!actionableSeverities.has(severity)) return false;
      const evidence = finding.evidence?.[0] || {};
      const key = `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const MAX_CORRECTION_ROUNDS = 3;

export function findingsFingerprint(findings = []) {
  return actionableFindings([{ findings }])
    .map((finding) => {
      const evidence = finding.evidence?.[0] || {};
      return `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
    })
    .sort()
    .join("|");
}

export function shouldPauseCorrection({ round, findings, previousFingerprint, maxRounds = MAX_CORRECTION_ROUNDS } = {}) {
  const fingerprint = findingsFingerprint(findings);
  if (Number(round) >= maxRounds) {
    return { pause: true, reason: `Paused after ${maxRounds} verification attempts without a passing result.`, fingerprint };
  }
  if (previousFingerprint && fingerprint && fingerprint === previousFingerprint) {
    return { pause: true, reason: "The same verification findings repeated without meaningful progress.", fingerprint };
  }
  return { pause: false, fingerprint };
}

export function workflowResumeStage(run) {
  if (workflowBlockers(run?.workflow).length) return "blocked";
  const has = (kind) => (run?.artifacts || []).some((artifact) => artifact.kind === kind);
  const stage = (id) => run?.stages?.find((item) => item.id === id);
  if (!has("requirements-draft") && !has("requirements")) return "requirements";
  if (stage("requirements")?.status !== "completed") return "requirements_review";
  if (!has("implementation-delta")) return "explore";
  if (!run.plan) return "design";
  if (!run.planApprovedAt) return "plan_approval";
  return "run";
}

export function artifactMetadata(artifact) {
  return safeArtifactMetadata(artifact);
}

function compactActivityEvent(event = {}) {
  return redactRecord({
    type: event.type || "activity", tool: event.tool || null, label: boundedText(event.label, 240).value,
    at: event.at || null, isError: Boolean(event.isError), ...(event.actor ? { actor: boundedText(event.actor, 120).value } : {})
  });
}

function publicAttempt(attempt) {
  const clone = structuredClone(attempt);
  for (const key of ["rawOutput", "activityGroups", "sessionFile", "prompt", "artifactRefs"]) delete clone[key];
  if (Array.isArray(clone.events)) clone.events = clone.events.slice(-20).map(compactActivityEvent);
  if (clone.report) clone.report = redactRecord({ status: clone.report.status, summary: boundedText(clone.report.summary, 240).value, request: boundedText(clone.report.request, 240).value });
  if (clone.verification) clone.verification = redactRecord({ summary: boundedText(clone.verification.summary, 240).value, findings: clone.verification.findings, checks: clone.verification.checks && { status: clone.verification.checks.status, command: clone.verification.checks.command, summary: boundedText(clone.verification.checks.summary, 240).value } });
  if (clone.diff) clone.diff = redactRecord({ available: clone.diff.available, files: clone.diff.files, stat: boundedText(clone.diff.stat, 1000).value });
  return redactRecord(clone);
}

function removePrivateLocations(value) {
  if (Array.isArray(value)) return value.map(removePrivateLocations);
  if (!value || typeof value !== "object") return value;
  for (const [key, item] of Object.entries(value)) {
    if (["path", "cwd", "sourceCwd", "sessionFile", "requirementsSessionFile", "productContextPath", "fixturePath"].includes(key)) delete value[key];
    else value[key] = removePrivateLocations(item);
  }
  return value;
}

function publicWorkflow(workflow) {
  if (!workflow) return workflow;
  return redactRecord({
    skillName: workflow.skillName || null,
    status: workflow.status || "idle",
    stages: (workflow.stages || []).map((stage) => ({ id: stage.id, status: stage.status, title: boundedText(stage.title, 240).value, summary: boundedText(stage.summary, 240).value, createdAt: stage.createdAt || null, updatedAt: stage.updatedAt || null })),
    checkpoints: (workflow.checkpoints || []).map(publicCheckpoint)
  });
}

function publicCheckpoint(checkpoint) {
  if (!checkpoint) return checkpoint;
  const { prompt, productContext, finalChecks, media, questions, ...rest } = checkpoint;
  return redactRecord({ ...rest,
    title: boundedText(rest.title, 240).value,
    questions: (questions || []).map((question) => boundedText(question, 240).value),
    ...(finalChecks ? { finalChecks: { status: finalChecks.status, command: finalChecks.command || null, summary: boundedText(finalChecks.summary, 240).value } } : {}),
    ...(media ? { media: media.map(safeArtifactMetadata) } : {})
  });
}

export function publicRun(run) {
  if (!run) return run;
  const clone = structuredClone(run);
  clone.inspectionFocus = inspectionFocus(run);
  clone.checkpoint = publicCheckpoint(clone.checkpoint);
  clone.workflow = publicWorkflow(clone.workflow);
  clone.lastError = boundedText(clone.lastError, 1000).value || null;
  if (Array.isArray(clone.artifacts)) clone.artifacts = clone.artifacts.map(artifactMetadata);
  for (const stage of clone.stages || []) if (stage.activity) {
    delete stage.activity.prompts;
    if (Array.isArray(stage.activity.events)) stage.activity.events = stage.activity.events.slice(-20).map(compactActivityEvent);
    delete stage.activity.groups;
    delete stage.activity.rawOutput;
  }
  for (const step of flattenSteps(clone.plan)) {
    delete step.prompt;
    delete step.productContext;
    if (Array.isArray(step.artifacts)) step.artifacts = step.artifacts.map(artifactMetadata);
    if (Array.isArray(step.attempts)) step.attempts = step.attempts.map(publicAttempt);
    if (step.diff) step.diff = redactRecord({ available: step.diff.available, files: step.diff.files, stat: boundedText(step.diff.stat, 1000).value });
    delete step.sessionFile;
  }
  if (Array.isArray(clone.reviews)) clone.reviews = clone.reviews.map((review) => ({ round: review.round, createdAt: review.createdAt, actionableFindings: redactRecord(review.actionableFindings || []), reviews: (review.reviews || []).map((item) => ({ role: item.role, summary: boundedText(item.summary, 240).value, checks: item.checks && { status: item.checks.status, command: item.checks.command || null, summary: boundedText(item.checks.summary, 240).value } })) }));
  if (clone.deliveredDiff) clone.deliveredDiff = redactRecord({ available: clone.deliveredDiff.available, files: clone.deliveredDiff.files, stat: boundedText(clone.deliveredDiff.stat, 1000).value });
  if (clone.integration?.diff) clone.integration.diff = redactRecord({ available: clone.integration.diff.available, files: clone.integration.diff.files, stat: boundedText(clone.integration.diff.stat, 1000).value });
  for (const stage of clone.stages || []) if (stage.diff) stage.diff = redactRecord({ available: stage.diff.available, files: stage.diff.files, stat: boundedText(stage.diff.stat, 1000).value });
  for (const active of Object.values(clone.activeRuns || {})) {
    delete active.prompt;
    delete active.sessionFile;
    if (active.activity) {
      delete active.activity.prompts;
      if (Array.isArray(active.activity.events)) active.activity.events = active.activity.events.slice(-20).map(compactActivityEvent);
      delete active.activity.groups;
      delete active.activity.rawOutput;
    }
  }
  return redactRecord(removePrivateLocations(clone));
}

export function publicState(state) {
  if (!state) return state;
  const clone = structuredClone(state);
  for (const bucket of ["ticketRuns", "retainedRuns"]) {
    for (const [id, run] of Object.entries(clone[bucket] || {})) clone[bucket][id] = publicRun(run);
  }
  return removePrivateLocations(clone);
}

export function compactRun(run, revision = null) {
  return {
    id: run?.id || null,
    runId: run?.runId || null,
    status: run?.status || null,
    checkpoint: publicCheckpoint(run?.checkpoint),
    lastError: boundedText(run?.lastError, 1000).value || null,
    workflow: publicWorkflow(run?.workflow),
    revision
  };
}
