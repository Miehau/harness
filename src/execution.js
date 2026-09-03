import { randomUUID } from "node:crypto";
import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";
import { gateStepStatusSet, inFlightRunStatusSet, inFlightStepStatusSet, restartableStepStatusSet, resumeRunStatusSet, runnableStepStatusSet } from "./run-status.js";
import { initialWorkflow, workflowBlockers } from "./workflow.js";

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
  if (event.type === "reasoning_summary") return { title: String(event.detail || "Plan next action").split(/\r?\n/).find((line) => line.trim())?.replace(/[*`]/g, "").slice(0, 120) || "Plan next action", note: event.detail || "", focus: true };
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
  const events = (existing.events || []).slice(-eventLimit);
  const prompts = (existing.prompts || []).slice(-20);
  let rawOutput = appendBounded("", existing.rawOutput, outputLimit);
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
      const item = { ...event, ...(actor ? { actor } : {}), at: new Date(timestamp).toISOString() };
      if (item.type === "prompt") {
        pushBounded(prompts, item, 20);
        lastEventAt = item.at;
        lastEvent = item.label || lastEvent;
        save();
      } else if (item.type === "text_delta") rawOutput = appendBounded(rawOutput, item.delta, outputLimit);
      else {
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

export function markRunCancelled(run, at = new Date().toISOString()) {
  run.status = "cancelled";
  run.cancelledAt = at;
  run.checkpoint = null;
  run.activeRuns = {};
  for (const step of flattenSteps(run.plan)) if (inFlightStepStatusSet.has(step.status)) step.status = "cancelled";
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
    const active = activeRuns[step.id] || {};
    const activity = active.activity || {};
    step.attempts ||= [];
    step.attempts.push({
      runId: active.runId || null,
      attemptId: `attempt-${step.attempts.length + 1}`,
      startedAt: active.startedAt || at,
      completedAt: at,
      status: "paused",
      events: activity.events || [],
      activityGroups: activity.groups || [],
      rawOutput: activity.rawOutput || "",
      sessionFile: active.sessionFile || step.sessionFile || null
    });
    if (active.sessionFile) step.sessionFile = active.sessionFile;
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
  Object.assign(step, { status: "ready", attempts: [], artifacts: [], diff: null, vcsChange: null, sessionFile: null, supervisorReview: null, lastError: null });
  for (const key of ["acceptedAt", "commit", "commitMessage", "workspace", "workspaceCommit", "baseTree", "reviewMap", "reviewNotes", "reviewNotesArtifact", "reviewBudgetResult"]) delete step[key];
  return attempts;
}

export function rewindRun(run, target, at = new Date().toISOString()) {
  if (!run?.plan && !["stage:explore", "stage:design"].includes(target)) throw new Error("This run has no plan to restart");
  const previousStages = (run.stages || []).map(({ id, status }) => ({ id, status }));
  const previousSteps = flattenSteps(run.plan).map((step) => ({ id: step.id, title: step.title, status: step.status, baseTree: step.baseTree || null, commit: step.commit || null, vcsChange: step.vcsChange || null, attempts: step.attempts?.length || 0 }));
  const previousStatus = run.status;
  const previousCheckpoint = run.checkpoint?.kind || null;
  let stageId;
  let restoredTree = null;
  let resetStepIds = [];
  let discardedAttempts = 0;

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
    discardedAttempts = reset.reduce((total, step) => total + resetStep(step), 0);
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
    discardedAttempts
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

export function correctionPauseReason(reason, findings = []) {
  const details = actionableFindings([{ findings }]).map((finding) => {
    const evidence = finding.evidence?.[0] || {};
    const location = evidence.file ? ` (${evidence.file}${evidence.line ? `:${evidence.line}` : ""})` : "";
    const fix = String(finding.suggestedFix || finding.suggested_fix || "").trim();
    return `- [${String(finding.severity || "issue").toUpperCase()}] ${finding.claim || "Verification finding"}${location}${fix ? ` — ${fix}` : ""}`;
  });
  return details.length ? `${reason}\nLatest actionable findings:\n${details.join("\n")}` : reason;
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
  if (!artifact || typeof artifact !== "object") return artifact;
  const { content, ...rest } = artifact;
  return rest;
}

export function publicRun(run) {
  if (!run) return run;
  const clone = structuredClone(run);
  if (Array.isArray(clone.artifacts)) clone.artifacts = clone.artifacts.map(artifactMetadata);
  for (const stage of clone.stages || []) if (stage.activity) delete stage.activity.prompts;
  for (const step of flattenSteps(clone.plan)) {
    if (Array.isArray(step.artifacts)) step.artifacts = step.artifacts.map(artifactMetadata);
  }
  return clone;
}

export function publicState(state) {
  if (!state) return state;
  const clone = structuredClone(state);
  for (const bucket of ["ticketRuns", "retainedRuns"]) {
    for (const [id, run] of Object.entries(clone[bucket] || {})) clone[bucket][id] = publicRun(run);
  }
  return clone;
}

export function compactRun(run, revision = null) {
  return {
    id: run?.id || null,
    runId: run?.runId || null,
    status: run?.status || null,
    checkpoint: run?.checkpoint || null,
    lastError: run?.lastError || null,
    workflow: run?.workflow || null,
    revision
  };
}
