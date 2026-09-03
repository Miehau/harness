import { randomUUID } from "node:crypto";
import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";
import { gateStepStatusSet, inFlightRunStatusSet, inFlightStepStatusSet, restartableStepStatusSet, resumeRunStatusSet, runnableStepStatusSet } from "./run-status.js";
import { initialWorkflow, workflowBlockers } from "./workflow.js";

export const visualEvidencePolicy = "contract-only-v1";
export const finalReviewRepositoryBoundary = "Harness boundary: review-fixes-round-*.md files are external audit records, not product artifacts. The harness removes its legacy copies; do not create or restore them in the repository.";

export function finalReviewFixFeedback(findings) {
  return `${finalReviewRepositoryBoundary}\n\nCanonical current findings (this list supersedes any earlier duplicated or stale finding list in the session):\n${JSON.stringify(findings, null, 2)}\n\nRe-evaluate these findings against the current harness runtime before editing. If a harness or environment correction made a finding pass without a repository change, preserve the repository and report it completed for fresh verification; do not add a synthetic fallback.`;
}

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
    harnessEvidencePolicy = visualEvidencePolicy,
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
    harnessEvidencePolicy,
    createdAt,
    ...rest
  };
}

export function finalReviewFixStep(round, findings, rootCauseClusters = [], restartFeedback = "") {
  const rootCauseInstruction = rootCauseClusters.length ? `\n\nThese findings recur across at least three review rounds on the same code surface (${rootCauseClusters.join(", ")}). Fix the general invariant, not only the reported examples or additional deny-list words. Prefer a positive decision tied to approved requirements, capabilities, or architecture, with data-driven counterexamples. If that general correction is impossible within the approved scope, report needs_input with the exact boundary.` : "";
  const restartInstruction = restartFeedback ? `\n\nOperator restart directive: ${restartFeedback}\n\nThis fresh conversation inherits the existing worktree. Before editing, inspect its complete current diff. Account for every inherited changed file, revert carried work that the directive does not justify, and name every file remaining in the final diff in the worker report.` : "";
  return {
    id: `review-fix-${round}`,
    title: `Fix final review findings — round ${round}`,
    prompt: `Correct these independently verified actionable findings:\n\n${JSON.stringify(findings, null, 2)}\n\n${finalReviewRepositoryBoundary}\n\nKeep the fix focused. Add or update regression coverage where practical and run the relevant deterministic checks.${rootCauseInstruction}${restartInstruction}`,
    contextPolicy: "seeded", harness: "pi", agentId: `review-fixer:round-${round}`,
    permission: "write", writeScope: "**", skills: [], references: [],
    // Review prose belongs in the harness audit store, never in the product repository.
    expectedArtifacts: [],
    acceptanceCriteria: findings.map((finding) => finding.claim), dependsOn: [], required: true,
    requiresVisualEvidence: findingsRequireVisualEvidence(findings),
    status: "ready", attempts: [], artifacts: [], attachments: [], diff: null, sessionFile: null, lastError: null
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
  if (run.status === "needs_attention" && run.checkpoint?.title === "Correction stalled") {
    const afterRound = Math.max(0, ...(run.reviews || []).map((review) => Number(review.round) || 0));
    run.correctionWindowStartRound = afterRound + 1;
    (run.correctionResumes ||= []).push({ afterRound, at: new Date().toISOString(), reason: run.lastError || run.checkpoint.prompt || "Correction stalled" });
  }
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

function similarFinding(left, right) {
  const leftCategory = String(left.category || "general").toLowerCase();
  const rightCategory = String(right.category || "general").toLowerCase();
  if (leftCategory !== rightCategory && leftCategory !== "tests" && rightCategory !== "tests") return false;
  const sharedSurfaces = (left.evidence || []).filter((leftEvidence) => (right.evidence || []).some((rightEvidence) =>
    leftEvidence.file
    && String(leftEvidence.file).toLowerCase() === String(rightEvidence.file || "").toLowerCase()
    && (!leftEvidence.line || !rightEvidence.line || Math.abs(leftEvidence.line - rightEvidence.line) <= 5)
  )).length;
  if (!sharedSurfaces) return false;
  const leftMechanism = `${left.claim || ""} ${left.suggestedFix || left.suggested_fix || ""}`;
  const rightMechanism = `${right.claim || ""} ${right.suggestedFix || right.suggested_fix || ""}`;
  const sameLocator = (value) => /\b(?:same|identical)\b/i.test(value);
  const differentLocator = (value) => /\b(?:different|distinct|another|pre-existing)\b/i.test(value);
  if ((sameLocator(leftMechanism) && differentLocator(rightMechanism))
    || (differentLocator(leftMechanism) && sameLocator(rightMechanism))) return false;
  const technicalIds = (value) => new Set(value.match(/\b[a-z][a-z0-9_]*(?:At|Id|ID)\b/g) || []);
  const leftIds = technicalIds(leftMechanism);
  const rightIds = technicalIds(rightMechanism);
  if (leftIds.size && rightIds.size && ![...leftIds].some((id) => rightIds.has(id))) return false;
  const words = (value) => new Set((String(value || "").toLowerCase().match(/[a-z]{5,}/g) || []).map((word) => {
    if (word.length > 7 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 6 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 6 && word.endsWith("es")) return word.slice(0, -2);
    if (word.length > 5 && word.endsWith("s")) return word.slice(0, -1);
    return word;
  }));
  const leftWords = words(leftMechanism);
  const rightWords = words(rightMechanism);
  if (Math.min(leftWords.size, rightWords.size) < 4) return false;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  const ratio = overlap / Math.min(leftWords.size, rightWords.size);
  return (sharedSurfaces >= 2 && overlap >= 4 && ratio >= 0.25)
    || (overlap >= 6 && ratio >= 0.6);
}

export function actionableFindings(reviews) {
  const findings = reviews.flatMap((review) => review.findings || [])
    .filter((finding) => actionableSeverities.has(String(finding.severity || "").toLowerCase()));
  const genericGateClaim = (finding) => {
    const claim = String(finding.claim || "");
    return /^repository check failed:/i.test(claim)
      || /^(?:the\s+)?(?:(?:required|canonical|supplied)\s+)?(?:verification\s+)?(?:gate|suite)\b.{0,80}\b(?:red|not green|failed|failing|reports?\s+failures?)\b/i.test(claim);
  };
  const hasSpecificTestFinding = findings.some((finding) =>
    String(finding.category || "").toLowerCase() === "tests"
    && (finding.evidence?.[0]?.file || finding.acceptanceCriterion)
    && !genericGateClaim(finding)
  );
  const unique = new Map();
  for (const finding of findings) {
    if (hasSpecificTestFinding
      && String(finding.category || "").toLowerCase() === "tests"
      && genericGateClaim(finding)) continue;
    const evidence = finding.evidence?.[0] || {};
    const category = String(finding.category || "general").toLowerCase();
    const criterion = String(finding.acceptanceCriterion || "").trim().toLowerCase();
    const file = String(evidence.file || "").trim().toLowerCase();
    let key = category === "tests" && criterion && file
      ? `${category}:${criterion}:${file}`
      : `${file}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
    let previous = unique.get(key);
    if (!previous) {
      const similar = [...unique.entries()].find(([, item]) => similarFinding(item.finding, finding));
      if (similar) [key, previous] = similar;
    }
    const evidenceFiles = new Set((finding.evidence || []).map((item) => item.file).filter(Boolean));
    const detail = evidenceFiles.size * 100 + String(finding.claim || "").length + String(finding.suggestedFix || finding.suggested_fix || "").length;
    if (!previous || detail > previous.detail) unique.set(key, { finding, detail });
  }
  return [...unique.values()].map(({ finding }) => finding);
}

export function refreshedReviewFindings(review = {}) {
  if (!Array.isArray(review.reviews) || !review.reviews.length) return review.actionableFindings || [];
  const humanFindings = (review.actionableFindings || [])
    .filter((finding) => finding.category === "human-proof-review")
    .flatMap((finding) => humanProofFindings(finding.claim));
  return humanFindings.length ? humanFindings : actionableFindings(review.reviews);
}

export function reviewScopeExpanded(previous = [], refreshed = []) {
  const before = actionableFindings([{ findings: previous }]);
  const after = actionableFindings([{ findings: refreshed }]);
  return after.some((finding) => !before.some((prior) =>
    findingsFingerprint([prior]) === findingsFingerprint([finding]) || similarFinding(prior, finding)
  ));
}

export const MAX_CORRECTION_ROUNDS = 12;

export function findingsFingerprint(findings = []) {
  return actionableFindings([{ findings }])
    .map((finding) => {
      const evidence = finding.evidence?.[0] || {};
      const diagnostic = !evidence.file || /^repository check failed:/i.test(String(finding.claim || ""))
        ? finding.suggestedFix || finding.suggested_fix || ""
        : "";
      return `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}:${diagnostic}`.toLowerCase();
    })
    .sort()
    .join("|");
}

export function storedFindingsFingerprint(findings = []) {
  return findings
    .map((finding) => {
      const evidence = finding.evidence?.[0] || {};
      return `${finding.severity || ""}:${finding.category || ""}:${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
    })
    .sort()
    .join("|");
}

export function pendingReviewAttempt(run, round) {
  const attempt = run?.pendingReviewAttempt;
  return Number(attempt?.round) === Number(round) && attempt?.checks && attempt?.diff ? attempt : null;
}

export function humanProofFindings(feedback) {
  const claim = String(feedback || "").trim();
  if (!claim) return [];
  const numbered = [...claim.matchAll(/\(\d+\)\s+([\s\S]*?)(?=\s+\(\d+\)\s+|$)/g)].map((match) => match[1].trim());
  return (numbered.length ? numbered : [claim]).map((item) => ({
    severity: "blocking", category: "human-proof-review", claim: item,
    evidence: [], suggestedFix: item, confidence: "high"
  }));
}

export function liveCaptureEnvironment(target, ticketId, runId) {
  const url = typeof target === "string" ? target.replace(/\/$/, "") : target?.port ? `http://127.0.0.1:${target.port}` : null;
  if (!url || !ticketId || !runId) return {};
  return {
    AGENT_PLAN_CAPTURE_URL: url,
    AGENT_PLAN_CAPTURE_TICKET_ID: ticketId,
    AGENT_PLAN_CAPTURE_RUN_ID: runId
  };
}

export function proofCaptureUrl(address, ticketId) {
  if (!address?.port || !ticketId) return null;
  return `http://127.0.0.1:${address.port}/?proof-ticket=${encodeURIComponent(ticketId)}`;
}

export function recurringReviewClusters(reviews = [], minRounds = 3) {
  const counts = new Map();
  for (const review of reviews) {
    const keys = new Set(actionableFindings([{ findings: review.actionableFindings || review.findings || [] }]).map((finding) => {
      const evidence = finding.evidence?.[0] || {};
      const surface = String(evidence.file || finding.acceptanceCriterion || "").trim().toLowerCase();
      if (!surface) return null;
      const location = evidence.file && evidence.line ? `${surface}:${evidence.line}` : surface;
      return `${String(finding.category || "general").toLowerCase()}:${location}`;
    }).filter(Boolean));
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= minRounds).map(([key]) => key).sort();
}

export function unaddressedReviewClusters(reviews = []) {
  const corrected = new Set(reviews.flatMap((review) => review.fix?.rootCauseClusters || []));
  return recurringReviewClusters(reviews).filter((key) => !corrected.has(key));
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

export function correctionWindowRound(round, reviews = [], resumedAtRound = null) {
  const latestHumanRound = [...reviews].reverse().find((review) =>
    (review.actionableFindings || review.findings || []).some((finding) => finding.category === "human-proof-review")
  )?.round;
  const windowStart = Math.max(Number(latestHumanRound) || 0, Number(resumedAtRound) || 0);
  return windowStart ? Math.max(1, Number(round) - windowStart + 1) : Number(round);
}

export function pendingReviewFix(reviews = []) {
  const review = reviews.at(-1);
  const findings = actionableFindings([{ findings: review?.actionableFindings || [] }]);
  if (!review || !findings.length || review.fix?.report?.status === "completed") return null;
  return { round: Number(review.round) || reviews.length, findings, sessionFile: review.fix?.sessionFile || null, restartFeedback: review.fix?.restartFeedback || "" };
}

export function reviewFixConstraints(run = {}) {
  return [...new Set((run.reviewFixSessionRestarts || [])
    .map((item) => String(item.reason || "").trim())
    .filter(Boolean))]
    .map((reason) => `- ${reason}`)
    .join("\n");
}

export function restartReviewFixSession(run, reason, inheritedFiles = []) {
  const feedback = String(reason || "").trim();
  if (!feedback) throw new Error("Describe why the fixer session must restart");
  if (!["paused", "needs_attention", "failed"].includes(run?.status)) throw new Error("Pause or stop the run before restarting its fixer session");
  const review = run.reviews?.at(-1);
  const findings = actionableFindings([{ findings: review?.actionableFindings || [] }]);
  if (!review || !findings.length || !review.fix?.sessionFile) throw new Error("No active final-review fixer session is available to restart");
  const previousSessionFile = review.fix.sessionFile;
  const files = [...new Set((inheritedFiles || []).map(String).filter(Boolean))].sort();
  const restartFeedback = `${feedback}${files.length ? `\n\nInherited changed files at restart:\n${files.map((file) => `- ${file}`).join("\n")}` : ""}`;
  (run.reviewFixSessionRestarts ||= []).push({ round: review.round, previousSessionFile, reason: feedback, inheritedFiles: files, at: new Date().toISOString() });
  review.fix = { ...review.fix, sessionFile: null, restartFeedback };
  delete review.fix.report;
  run.status = "interrupted";
  run.checkpoint = null;
  run.lastError = null;
  return { round: review.round, previousSessionFile };
}

export function recoverableCleanReview(run = {}) {
  if (run.pendingEvidenceFeedback || run.checkpoint?.kind === "evidence_review") return null;
  const review = run.reviews?.at(-1);
  if (!review || !Array.isArray(review.actionableFindings) || review.actionableFindings.length) return null;
  const checks = review.reviews?.find((item) => item.role === "deterministic")?.checks;
  if (checks?.status !== "passed") return null;
  return { round: Number(review.round) || run.reviews.length, checks, diff: review.diff };
}

export function findingsRequireVisualEvidence(findings = []) {
  return findings.some((finding) => {
    const context = [finding.category, finding.claim, finding.suggestedFix, finding.suggested_fix, ...(finding.evidence || []).map((item) => item.file)].join(" ");
    return String(finding.category || "").toLowerCase() === "accessibility"
      || /\b(?:screenshot|image|video|visual|layout|viewport|pixel|desktop|mobile)\b/i.test(context);
  });
}

export function reviewFixImages(sessionFile, findings = [], images = []) {
  if (sessionFile) return [];
  return findingsRequireVisualEvidence(findings) ? images : [];
}

export function interruptedStepFeedback(step = {}) {
  const attempts = Array.isArray(step.attempts) ? step.attempts : [];
  const latest = attempts.at(-1);
  if (latest?.status === "failed"
    && latest.report?.status === "completed"
    && latest.checks?.status === "passed"
    && !latest.verification) {
    return "The worker result and deterministic checks are already complete. The independent verifier failed before producing a result. Preserve the current implementation, make no edits, and report completed so the harness can retry verification.";
  }
  const priorVerification = [...attempts].reverse().find((attempt) => attempt.verification)?.verification;
  const findings = actionableFindings([priorVerification || {}]);
  return findings.length ? `Resume the interrupted correction for these verified issues:\n\n${JSON.stringify(findings, null, 2)}` : "";
}

export function verificationFocusFindings(feedback, findings = []) {
  return feedback ? findings : [];
}

export function providerWaitCheckpoint(error) {
  const message = String(error?.message || error || "").trim();
  if (!/(usage limit (?:has been )?reached|hit your usage limit)/i.test(message)) return null;
  const retryAt = message.match(/try again at\s+(.+?)(?:\.|$)/i)?.[1]?.trim() || null;
  return {
    kind: "provider_wait",
    title: "Paused for provider capacity",
    prompt: message,
    ...(retryAt ? { retryAt } : {})
  };
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

export function nextCorrectionRound(step = {}) {
  const changedAt = Math.max(
    Date.parse(step.scopeChanges?.at(-1)?.at || "") || 0,
    Date.parse(step.correctionResets?.at(-1)?.at || "") || 0
  );
  const attempts = Array.isArray(step.attempts) ? step.attempts : [];
  return attempts.filter((attempt) =>
    (!Number.isFinite(changedAt) || Date.parse(attempt.completedAt || "") >= changedAt)
    && attempt.verification && actionableFindings([attempt.verification]).length
  ).length + 1;
}

export function auditVisualEvidencePolicy(run, at = new Date().toISOString()) {
  if (!run || run.harnessEvidencePolicy === visualEvidencePolicy) return [];
  const changes = [];
  for (const step of flattenSteps(run.plan)) {
    if (!step.requiresVisualEvidence) continue;
    step.correctionResets ||= [];
    step.correctionResets.push({
      at, source: "harness", policy: visualEvidencePolicy,
      reason: "Generic preview captures are diagnostic only; the repository contract must emit acceptance evidence."
    });
    changes.push(step.id);
  }
  run.harnessEvidencePolicy = visualEvidencePolicy;
  return changes;
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

function publicEvent(event, detailed) {
  const clone = { ...event };
  for (const key of ["args", "output", "result", "detail"]) {
    if (typeof clone[key] !== "string") continue;
    if (!detailed) delete clone[key];
    else if (clone[key].length > 2000) clone[key] = `${clone[key].slice(0, 2000)}\n… output truncated; open the saved session for full detail`;
  }
  return clone;
}

function publicActivity(activity, detailed = true) {
  if (!activity) return activity;
  const clone = { ...activity, events: (activity.events || []).map((event) => publicEvent(event, detailed)) };
  delete clone.prompts;
  delete clone.rawOutput;
  delete clone.groups;
  return clone;
}

function diffSummary(diff) {
  if (!diff) return diff;
  const { patch, ...summary } = diff;
  return summary;
}

export function publicRun(run) {
  if (!run) return run;
  const clone = structuredClone(run);
  if (Array.isArray(clone.artifacts)) clone.artifacts = clone.artifacts.map(artifactMetadata);
  for (const stage of clone.stages || []) {
    stage.activity = publicActivity(stage.activity);
    stage.diff = diffSummary(stage.diff);
  }
  for (const step of flattenSteps(clone.plan)) {
    step.diff = diffSummary(step.diff);
    if (Array.isArray(step.artifacts)) step.artifacts = step.artifacts.map(artifactMetadata);
    for (const [index, attempt] of (step.attempts || []).entries()) {
      const detailed = index === step.attempts.length - 1;
      attempt.events = (attempt.events || []).map((event) => publicEvent(event, detailed));
      delete attempt.activityGroups;
      delete attempt.rawOutput;
      if (attempt.verification) delete attempt.verification.rawOutput;
      attempt.diff = diffSummary(attempt.diff);
      attempt.checkDiff = diffSummary(attempt.checkDiff);
      attempt.aggregateDiff = diffSummary(attempt.aggregateDiff);
      if (Array.isArray(attempt.artifacts)) attempt.artifacts = attempt.artifacts.map(artifactMetadata);
    }
  }
  for (const review of clone.reviews || []) {
    review.diff = diffSummary(review.diff);
    if (review.fix) review.fix.diff = diffSummary(review.fix.diff);
  }
  return clone;
}

export function publicState(state) {
  if (!state) return state;
  return {
    ...state,
    ticketRuns: Object.fromEntries(Object.entries(state.ticketRuns || {}).map(([id, run]) => [
      id, id === state.selectedTicketId ? publicRun(run) : compactRun(run, state.revision)
    ])),
    retainedRuns: Object.fromEntries(Object.entries(state.retainedRuns || {}).map(([id, run]) => [id, compactRun(run, state.revision)]))
  };
}

export function publicPreviewState(state, ticketId) {
  const run = state?.ticketRuns?.[ticketId];
  return publicState({
    version: state?.version,
    revision: state?.revision,
    workspace: state?.workspace,
    settings: state?.settings,
    stageProfiles: state?.stageProfiles,
    selectedTicketId: ticketId,
    ticketRuns: run ? { [ticketId]: run } : {},
    retainedRuns: {},
    notice: state?.notice || null
  });
}

export function compactRun(run, revision = null) {
  return {
    id: run?.id || null,
    runId: run?.runId || null,
    ticket: run?.ticket ? {
      id: run.ticket.id,
      identifier: run.ticket.identifier,
      title: run.ticket.title,
      source: run.ticket.source || null,
      provider: run.ticket.provider || null,
      state: run.ticket.state ? { id: run.ticket.state.id, name: run.ticket.state.name, type: run.ticket.state.type } : null
    } : null,
    status: run?.status || null,
    checkpoint: run?.checkpoint || null,
    lastError: run?.lastError || null,
    workflow: run?.workflow || null,
    revision
  };
}
