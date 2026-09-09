import { randomUUID } from "node:crypto";
import { cloneRunAccess } from "./access-policy.js";
import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";
import { cleanupOutcomes, gateStepStatusSet, inFlightRunStatusSet, inFlightStepStatusSet, normalizeRunCleanup, restartableStepStatusSet, resumeRunStatusSet, runnableStepStatusSet } from "./run-status.js";
import { initialWorkflow, workflowBlockers } from "./workflow.js";
import { createSteeringLedger } from "./steering.js";
import { publicPreviewState, publicRun, publicState, compactRun } from "./inspection.js";
import { appendBounded, createActivityCapture, groupActivityEvents, pushBounded, retainedUsage } from "./activity.js";
import { actionableFindings, executionFailure, findingsFingerprint, findingsRequireVisualEvidence, humanProofFindings, recurringReviewClusters, refreshedReviewFindings, reviewFindingLedger, reviewFixImages, reviewScopeExpanded, storedFindingsFingerprint, unaddressedReviewClusters, unresolvedReviewFindings } from "./review-findings.js";
import { boundedText, redactRecord, redactText, safeArtifactMetadata } from "./redaction.js";

export const visualEvidencePolicy = "contract-only-v1";
export { actionableFindings, appendBounded, compactRun, createActivityCapture, executionFailure, findingsFingerprint, findingsRequireVisualEvidence, groupActivityEvents, humanProofFindings, publicPreviewState, publicRun, publicState, pushBounded, recurringReviewClusters, refreshedReviewFindings, reviewFindingLedger, reviewFixImages, reviewScopeExpanded, storedFindingsFingerprint, unaddressedReviewClusters, unresolvedReviewFindings };
export const finalReviewRepositoryBoundary = "Harness boundary: review-fixes-round-*.md files are external audit records, not product artifacts. The harness removes its legacy copies; do not create or restore them in the repository.";

export function nextAttemptId(step) {
  const current = Math.max(
    Number(step.attemptSequence) || 0,
    ...(step.attempts || []).map((attempt) =>
      Number(String(attempt.attemptId || "").match(/^attempt-(\d+)$/)?.[1]) || 0)
  );
  return `attempt-${current + 1}`;
}

export function finalReviewFixFeedback(findings) {
  return `${finalReviewRepositoryBoundary}\n\nCanonical current findings (this list supersedes any earlier duplicated or stale finding list in the session):\n${JSON.stringify(findings, null, 2)}\n\nRe-evaluate these findings against the current harness runtime before editing. If a harness or environment correction made a finding pass without a repository change, preserve the repository and report it completed for fresh verification; do not add a synthetic fallback.`;
}

export function finalReviewSequence(run) {
  const sequence = (value) =>
    Number(String(value || "").match(/^final-review-(\d+)$/)?.[1]) || 0;
  return Math.max(
    Number(run.finalReviewSequence) || 0,
    ...(run.reviews || []).flatMap((review) => [Number(review.round) || 0, sequence(review.reviewId)]),
    ...Object.keys(run.finalCheckHistory || {}).map(sequence),
    ...Object.keys(run.finalDiffHistory || {}).map(sequence),
    0
  );
}

export function migrateFinalProofLocators(run) {
  const reviews = run.reviews || [];
  let nextSequence = finalReviewSequence(run);
  const knownIds = new Set([
    ...Object.keys(run.finalCheckHistory || {}),
    ...Object.keys(run.finalDiffHistory || {}),
    ...reviews.map((review) => review.reviewId).filter(Boolean)
  ]);
  for (const review of reviews) {
    const checks = review.finalChecks || review.reviews?.find((item) => item.role === "deterministic")?.checks;
    if (!checks) continue;
    const roundId = Number(review.round) ? `final-review-${Number(review.round)}` : null;
    let reviewId = review.reviewId || (roundId && !knownIds.has(roundId) ? roundId : null);
    while (!reviewId) reviewId = `final-review-${++nextSequence}`;
    knownIds.add(reviewId);
    review.reviewId = reviewId;
    review.finalChecks ||= structuredClone(checks);
    run.finalCheckHistory ||= {};
    run.finalCheckHistory[reviewId] ||= structuredClone(review.finalChecks);
    if (review.diff) {
      run.finalDiffHistory ||= {};
      run.finalDiffHistory[reviewId] ||= structuredClone(review.diff);
    }
    run.finalReviewHistory ||= {};
    run.finalReviewHistory[reviewId] ||= { createdAt: review.createdAt || null };
  }
  run.finalReviewSequence = Math.max(nextSequence, finalReviewSequence(run));
  if (!reviews.length || !run.proofMap?.criteria) return;
  const reviewFor = (reportedAt) => reviews.filter((review) => review.reviewId && (!reportedAt || !review.createdAt || review.createdAt <= reportedAt)).at(-1) || reviews.find((review) => review.reviewId) || null;
  const migrateResult = (result) => {
    if (!result?.evidence) return;
    const reviewId = reviewFor(result.reportedAt)?.reviewId;
    if (reviewId) result.evidence = result.evidence.map((locator) => locator?.scope === "final" && !locator.reviewId ? { ...locator, reviewId } : locator);
  };
  for (const criterion of run.proofMap.criteria) {
    migrateResult(criterion.current);
    for (const result of criterion.history || []) migrateResult(result);
  }
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

export { cleanupOutcomes, normalizeRunCleanup };

function cleanupOutcome(executions) {
  const outcomes = executions.map((execution) => execution.outcome);
  if (outcomes.includes("running")) return "running";
  if (outcomes.includes("incomplete")) return "incomplete";
  if (outcomes.includes("unsupported")) return "unsupported";
  if (outcomes.includes("complete")) return "complete";
  return "not-required";
}

export function initializeRunCleanup(run, { legacy = false } = {}) {
  if (legacy && !Object.hasOwn(run, "cleanup")) {
    run.cleanup = {
      executions: [{
        executionId: "legacy-unrecorded",
        outcome: "incomplete",
        ownership: { executionId: "legacy-unrecorded", establishedAt: null },
        startedAt: null,
        completedAt: null,
        triggers: [],
        discovered: [],
        actions: [],
        unresolved: [],
        diagnostics: ["Cleanup evidence predates durable containment records"]
      }],
      outcome: "incomplete",
      updatedAt: null
    };
  } else run.cleanup = normalizeRunCleanup(run.cleanup);
  return run.cleanup;
}

function persistedOwnership(ownership, executionId, at) {
  return {
    executionId: String(ownership?.executionId || executionId),
    establishedAt: ownership?.createdAt || at,
    tokenPresent: Boolean(ownership?.token)
  };
}

// A cleanup result may be delivered again after a bounded persistence wait.
// Deduplicate that exact durable record, but retain timestamp-distinct lifecycle
// requests even when their trigger payload is otherwise identical.
function triggerIdentity(entry) {
  return stableCleanupValueKey(entry || {});
}

function mergeCleanupTriggers(...groups) {
  const seen = new Set();
  return groups.flat().filter((entry) => {
    const key = triggerIdentity(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanupTriggerEntry(trigger, at) {
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const entry = structuredClone(trigger);
    return { ...entry, at: entry.at ?? at };
  }
  return { trigger: typeof trigger === "string" ? trigger : "unspecified", at };
}

function stableCleanupValueKey(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableCleanupValueKey).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableCleanupValueKey(item)}`).join(",")}}`;
  return `${typeof value}:${String(value)}`;
}

function cleanupProcessKey(process) {
  if (Number.isInteger(process?.pid) && Number.isInteger(process?.ppid) && typeof process?.startTime === "string") return `process:${process.pid}:${process.ppid}:${process.startTime}`;
  return stableCleanupValueKey(process);
}

function mergeCleanupEvidence(prior, reported, key) {
  const seen = new Set();
  return [...prior, ...reported].filter((entry) => {
    const identity = key(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Persist a running execution before its worker gets an opportunity to launch a controlled process. */
export function beginRunCleanup(run, { executionId, ownership = null, stepId = null, attemptId = null, trigger = "worker-launch", at = new Date().toISOString() } = {}) {
  if (!executionId) throw new TypeError("cleanup executionId is required");
  const cleanup = initializeRunCleanup(run);
  let execution = cleanup.executions.find((item) => item.executionId === executionId);
  if (!execution) {
    execution = {
      executionId,
      stepId,
      attemptId,
      ownership: persistedOwnership(ownership, executionId, at),
      outcome: "running",
      startedAt: at,
      completedAt: null,
      triggers: [],
      discovered: [],
      actions: [],
      unresolved: [],
      diagnostics: []
    };
    cleanup.executions.push(execution);
  }
  execution.triggers.push(cleanupTriggerEntry(trigger, at));
  cleanup.outcome = cleanupOutcome(cleanup.executions);
  cleanup.updatedAt = at;
  return execution;
}

/** Merge containment evidence into its pre-existing execution record; unknown evidence is uncertainty, never success. */
export function completeRunCleanup(run, executionId, evidence, triggerOptions = {}) {
  const options = triggerOptions && typeof triggerOptions === "object" && !Array.isArray(triggerOptions)
    ? triggerOptions : { trigger: triggerOptions };
  const at = options.at ?? new Date().toISOString();
  const trigger = { ...options };
  delete trigger.at;
  if (!Object.hasOwn(trigger, "trigger")) trigger.trigger = "worker-exit";
  const execution = beginRunCleanup(run, { executionId, trigger, at });
  const reported = evidence && typeof evidence === "object" ? structuredClone(evidence) : null;
  if (reported) {
    const priorTriggers = execution.triggers;
    const priorOutcome = execution.outcome;
    const priorEvidence = {
      discovered: execution.discovered || [],
      actions: execution.actions || [],
      unresolved: execution.unresolved || [],
      diagnostics: execution.diagnostics || []
    };
    const reportedOutcome = cleanupOutcomes.includes(reported.outcome) && reported.outcome !== "running" ? reported.outcome : "incomplete";
    const preserveUncertainty = priorOutcome === "incomplete";
    Object.assign(execution, reported, {
      executionId,
      ...(reported.executionId && reported.executionId !== executionId ? { containmentExecutionId: reported.executionId } : {}),
      ownership: execution.ownership,
      startedAt: execution.startedAt,
      triggers: mergeCleanupTriggers(priorTriggers, Array.isArray(reported.triggers) ? reported.triggers : []),
      // A bounded wait is an unresolved safety condition, not a provisional
      // success. Late observations may add evidence but cannot erase it.
      outcome: preserveUncertainty ? "incomplete" : reportedOutcome,
      // A shared containment promise can be durably settled by a timed-out
      // command and then again when its worker exits. Keep genuinely late
      // observations, but collapse the same process, action, uncertainty, or
      // diagnostic instead of turning one cleanup sequence into duplicate audit evidence.
      discovered: preserveUncertainty ? mergeCleanupEvidence(priorEvidence.discovered, Array.isArray(reported.discovered) ? reported.discovered : [], cleanupProcessKey) : reported.discovered || [],
      actions: preserveUncertainty ? mergeCleanupEvidence(priorEvidence.actions, Array.isArray(reported.actions) ? reported.actions : [], stableCleanupValueKey) : reported.actions || [],
      unresolved: preserveUncertainty ? mergeCleanupEvidence(priorEvidence.unresolved, Array.isArray(reported.unresolved) ? reported.unresolved : [], stableCleanupValueKey) : reported.unresolved || [],
      diagnostics: preserveUncertainty ? mergeCleanupEvidence(priorEvidence.diagnostics, Array.isArray(reported.diagnostics) ? reported.diagnostics : [], stableCleanupValueKey) : reported.diagnostics || [],
      completedAt: reported.completedAt || at
    });
  } else {
    execution.outcome = "incomplete";
    execution.completedAt = at;
    execution.diagnostics = [...(execution.diagnostics || []), "Worker exited without process-cleanup evidence"];
  }
  const cleanup = initializeRunCleanup(run);
  cleanup.outcome = cleanupOutcome(cleanup.executions);
  cleanup.updatedAt = at;
  return execution;
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
    steering = createSteeringLedger(),
    trackerEvents = {},
    sessionFile = null,
    auto = false,
    lastError = null,
    workflow,
    harnessEvidencePolicy = visualEvidencePolicy,
    createdAt = new Date().toISOString(),
    cleanup,
    access = null,
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
    steering: createSteeringLedger(steering),
    trackerEvents,
    sessionFile,
    auto,
    lastError,
    workflow: workflow || initialWorkflow(),
    harnessEvidencePolicy,
    createdAt,
    cleanup: normalizeRunCleanup(cleanup),
    access: cloneRunAccess(access, { workspace, createdAt }),
    ...rest
  };
}

export function finalReviewFixStep(round, findings, rootCauseClusters = [], restartFeedback = "") {
  const rootCauseInstruction = rootCauseClusters.length ? `\n\nThese findings recur across at least three review rounds on the same code surface (${rootCauseClusters.join(", ")}). Fix the general invariant, not only the reported examples or additional deny-list words. Prefer a positive decision tied to approved requirements, capabilities, or architecture, with data-driven counterexamples. If that general correction is impossible within the approved scope, report needs_input with the exact boundary.` : "";
  const restartInstruction = restartFeedback ? `\n\nOperator restart directive: ${restartFeedback}\n\nThis fresh conversation inherits the existing worktree. Before editing, inspect its complete current diff. Account for every inherited changed file, revert carried work that the directive does not justify, and name every file remaining in the final diff in the worker report.` : "";
  const visualInstruction = findingsRequireVisualEvidence(findings) ? " The harness captures required visual proof after your report; do not modify the repository verification contract solely to produce review images." : "";
  return {
    id: `review-fix-${round}`,
    title: `Fix final review findings — round ${round}`,
    prompt: `Correct these independently verified actionable findings:\n\n${JSON.stringify(findings, null, 2)}\n\n${finalReviewRepositoryBoundary}\n\nKeep the fix focused. Add or update regression coverage where practical and run the relevant deterministic checks.${visualInstruction}${rootCauseInstruction}${restartInstruction}`,
    contextPolicy: "seeded", harness: "pi", agentId: `review-fixer:round-${round}`,
    permission: "write", writeScope: "**", skills: [], references: [],
    // Review prose belongs in the harness audit store, never in the product repository.
    expectedArtifacts: [],
    acceptanceCriteria: findings.map((finding) => finding.claim), dependsOn: [], required: true,
    requiresVisualEvidence: false,
    status: "ready", attempts: [], artifacts: [], attachments: [], diff: null, sessionFile: null, lastError: null
  };
}
const attemptEventLimit = 200;
const attemptOutputLimit = 100000;

function boundedAttemptActivity(activity = {}, rawOutput = "") {
  return {
    usage: retainedUsage(activity),
    events: redactRecord(structuredClone((activity.events || []).slice(-attemptEventLimit))),
    activityGroups: redactRecord(structuredClone((activity.groups || []).slice(-attemptEventLimit))),
    prompts: (activity.prompts || []).slice(-20).map((item) => {
      const { prompt: legacyPrompt, ...saved } = item;
      const bounded = boundedText(saved.content || legacyPrompt, 4000);
      return redactRecord({ ...saved, content: bounded.value, truncated: Boolean(saved.truncated) || bounded.truncated, total: Math.max(bounded.total, Number(saved.total) || 0) });
    }),
    rawOutput: appendBounded("", redactText(activity.rawOutput || rawOutput), attemptOutputLimit)
  };
}

export function failureDetails(error, { status, reason, phase = "execution" } = {}) {
  const message = String(error || reason || "");
  if (!["failed", "needs_attention", "verification_failed", "cancelled", "paused", "interrupted"].includes(status)) return { kind: null, phase: null, message: null };
  const kind = status === "cancelled" ? "cancellation"
    : status === "paused" || status === "interrupted" ? "interruption"
    : /provider|model request|rate limit|quota|authentication|api key|timeout/i.test(message) ? "provider"
    : /check|test|verification/i.test(message) ? "verification" : "execution";
  return { kind, phase, message: redactText(message) || null };
}

// This is the sole conversion from mutable active state into durable history. Callers
// may add new attempts, but must never mutate an attempt returned by this helper.
export function snapshotActiveAttempt(step, active = {}, {
  status, completedAt = new Date().toISOString(), reason = null, error = null, phase = "execution",
  activity = active.activity || {}, rawOutput = "", report, checks, verification, diff, checkDiff, aggregateDiff, vcsChange,
  feedback, violations, reviewNotes, reviewBudgetResult, artifactRefs = []
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
    ...(checks === undefined ? {} : { checks: redactRecord(structuredClone(checks)) }),
    ...(verification === undefined ? {} : { verification: redactRecord(structuredClone(verification)) }),
    ...(diff === undefined ? {} : { diff: redactRecord(structuredClone(diff)) }),
    ...(checkDiff === undefined ? {} : { checkDiff: redactRecord(structuredClone(checkDiff)) }),
    ...(aggregateDiff === undefined ? {} : { aggregateDiff: redactRecord(structuredClone(aggregateDiff)) }),
    ...(vcsChange === undefined ? {} : { vcsChange: redactRecord(structuredClone(vcsChange)) }),
    ...(feedback === undefined ? {} : { feedback: redactText(feedback) }),
    ...(violations === undefined ? {} : { violations: redactRecord(structuredClone(violations)) }),
    ...(reviewNotes === undefined ? {} : { reviewNotes: redactRecord(structuredClone(reviewNotes)) }),
    ...(reviewBudgetResult === undefined ? {} : { reviewBudgetResult: redactRecord(structuredClone(reviewBudgetResult)) }),
    ...(artifactRefs.length ? { artifacts: redactRecord(structuredClone(artifactRefs)), artifactRefs: redactRecord(structuredClone(artifactRefs)) } : {}),
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
      attemptId: active.attemptId || steps.find((step) => step.id === stepId)?.activeAttempt?.id || null,
      sessionFile: active.sessionFile || steps.find((step) => step.id === stepId)?.sessionFile || null,
      startedAt: active.startedAt || null,
      lastEventAt: active.activity?.lastEventAt || active.lastEventAt || null,
      lastEvent: active.activity?.lastEvent || active.lastEvent || ""
    }))
  };
  for (const step of steps) {
    if (!inFlightStepStatusSet.has(step.status)) continue;
    const active = activeRuns[step.id] || {};
    const attempt = materializeActiveAttempt(step, active, { status: "paused", completedAt: at, reason: "run_paused" });
    step.activeAttempt = {
      ...(step.activeAttempt || {}), id: attempt.attemptId, status: "interrupted", workerRunId: null,
      startedAt: step.activeAttempt?.startedAt || active.startedAt || at, interruptedAt: at
    };
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

function staleProof(run, stepIds, at, reason) {
  const selected = new Set(stepIds);
  if (!run.proofMap?.criteria) return;
  for (const criterion of run.proofMap.criteria) {
    if (!selected.has(criterion.stepId)) continue;
    criterion.history ||= [];
    criterion.history.push(structuredClone(criterion.current));
    criterion.invalidation = { at, evidence: structuredClone(criterion.current?.evidence || []) };
    criterion.current = { ...criterion.current, evidenceValidity: "stale", invalidatedAt: at, invalidationReason: reason };
  }
}

function resetStep(run, step, { archiveAttempts = false } = {}) {
  const attempts = structuredClone(step.attempts || []);
  // A restart changes live worker state, never durable evidence. Proof-aware
  // rewinds move superseded attempt evidence to the run archive so its locator
  // remains resolvable without letting the new worker reuse its attempt ID.
  if (archiveAttempts && attempts.length) {
    run.archivedAttempts ||= [];
    run.archivedAttempts.push(...attempts.map((attempt) => ({ ...attempt, stepId: step.id })));
    step.attempts = [];
    step.attemptSequence = Math.max(Number(step.attemptSequence) || 0, ...attempts.map((attempt) => Number(String(attempt.attemptId || "").match(/^attempt-(\d+)$/)?.[1]) || 0));
  }
  Object.assign(step, { status: "ready", artifacts: [], diff: null, vcsChange: null, sessionFile: null, supervisorReview: null, lastError: null });
  for (const key of ["acceptedAt", "commit", "commitMessage", "workspace", "workspaceCommit", "workspaceCommits", "baseTree", "baseTrees", "reviewMap", "reviewNotes", "reviewNotesArtifact", "reviewBudgetResult", "repositoryVcs", "repositoryDiffs", "acceptedRepositories"]) delete step[key];
  return { archived: archiveAttempts ? attempts.length : 0, retained: archiveAttempts ? 0 : attempts.length };
}

export function rewindRun(run, target, at = new Date().toISOString()) {
  if (!run?.plan && !["stage:explore", "stage:design"].includes(target)) throw new Error("This run has no plan to restart");
  const previousStages = (run.stages || []).map(({ id, status }) => ({ id, status }));
  const previousSteps = flattenSteps(run.plan).map((step) => ({
    id: step.id, title: step.title, status: step.status, baseTree: step.baseTree || null,
    baseTrees: step.baseTrees ? structuredClone(step.baseTrees) : null,
    commit: step.commit || null, vcsChange: step.vcsChange || null,
    repositoryVcs: step.repositoryVcs ? structuredClone(step.repositoryVcs) : null,
    attempts: step.attempts?.length || 0,
    attemptHistory: structuredClone(step.attempts || [])
  }));
  const previousStatus = run.status;
  const previousCheckpoint = run.checkpoint?.kind || null;
  let stageId;
  let restoredTree = null;
  let restoredTrees = null;
  let resetStepIds = [];
  let discardedAttempts = 0;
  let retainedAttempts = 0;

  if (target === "stage:explore" || target === "stage:design") {
    stageId = target.slice(6);
    restoredTree = run.baselineTree;
    if (!restoredTree) throw new Error("This stage has no recorded repository baseline");
    run.plan = null;
    run.sessionFile = null;
    if (run.proofMap) {
      run.proofMapHistory ||= [];
      run.proofMapHistory.push({ archivedAt: at, reason: "Plan redesign restart", proofMap: structuredClone(run.proofMap) });
      delete run.proofMap;
    }
    delete run.planApprovedAt;
  } else if (target === "stage:verify") {
    if (!flattenSteps(run.plan).length || flattenSteps(run.plan).some((step) => step.status !== "accepted")) throw new Error("Verification can restart only after every implementation step is accepted");
    stageId = "verify";
    // Review records are immutable evidence: retaining them preserves historical
    // final-check and final-diff locators while the new review gets a new sequence.
    run.reviews ||= [];
    staleProof(run, flattenSteps(run.plan).map((step) => step.id), at, "Verification restart requires fresh final proof.");
  } else {
    const stepId = String(target || "").replace(/^step:/, "");
    const steps = flattenSteps(run.plan);
    const selectedIndex = steps.findIndex((step) => step.id === stepId);
    if (selectedIndex < 0) throw new Error("Restart step not found");
    const selected = steps[selectedIndex];
    restoredTree = selected.baseTree || run.baselineTree;
    restoredTrees = selected.baseTrees ? structuredClone(selected.baseTrees) : null;
    if (!restoredTree) throw new Error("This step has no recorded code checkpoint");
    const firstIndex = selected.baseTree ? steps.findIndex((step) => step.baseTree === selected.baseTree) : selectedIndex;
    const reset = steps.slice(Math.max(0, firstIndex));
    resetStepIds = reset.map((step) => step.id);
    // Attempts without proof remain attached to their step for legacy inspection.
    // Proof-bound evidence moves to the run archive, preserving its immutable
    // locator while reserving the old attempt ID for the restarted worker.
    const archiveAttempts = Boolean(run.proofMap?.criteria?.length);
    const resetCounts = reset.map((step) => resetStep(run, step, { archiveAttempts }));
    retainedAttempts = resetCounts.reduce((total, count) => total + count.retained, 0);
    discardedAttempts = resetCounts.reduce((total, count) => total + count.archived, 0);
    staleProof(run, resetStepIds, at, "Step restart restored an earlier implementation checkpoint.");
    stageId = "implement";
  }

  resetStagesFrom(run, stageId);
  run.status = "interrupted";
  run.checkpoint = null;
  run.activeRuns = {};
  run.lastError = null;
  run.recovery = null;
  for (const key of ["completedAt", "merge", "integration", "deliveredDiff", "productContextPath", "finalEvidenceArtifactIds"]) delete run[key];
  const audit = {
    id: `restart-${(run.restartHistory?.length || 0) + 1}`,
    at,
    target,
    fromStatus: previousStatus,
    fromCheckpoint: previousCheckpoint,
    previousStages,
    previousSteps,
    restoredTree,
    restoredTrees,
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

export const MAX_CORRECTION_ROUNDS = 12;

export function pendingReviewAttempt(run, round) {
  const attempt = run?.pendingReviewAttempt;
  return Number(attempt?.round) === Number(round) && attempt?.checks && attempt?.diff ? attempt : null;
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
  if (!["paused", "interrupted", "needs_attention", "failed"].includes(run?.status)) throw new Error("Pause or stop the run before restarting its fixer session");
  const review = run.reviews?.at(-1);
  const findings = actionableFindings([{ findings: review?.actionableFindings || [] }]);
  if (!review || !findings.length || !review.fix?.sessionFile) throw new Error("No active final-review fixer session is available to restart");
  const previousSessionFile = review.fix.sessionFile;
  const files = [...new Set((inheritedFiles || []).map(String).filter(Boolean))].sort();
  const restartFeedback = `${feedback}${files.length ? `\n\nInherited changed files at restart:\n${files.map((file) => `- ${file}`).join("\n")}` : ""}`;
  (run.reviewFixSessionRestarts ||= []).push({ round: review.round, previousSessionFile, reason: feedback, inheritedFiles: files, at: new Date().toISOString() });
  review.fix = { ...review.fix, sessionFile: null, restartFeedback };
  delete review.fix.report;
  // A fresh fixer supersedes any gate captured after the abandoned session.
  // Reusing it would review evidence from before the audited restart boundary.
  delete run.pendingReviewAttempt;
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
  return {
    round: Number(review.round) || run.reviews.length,
    checks,
    diff: review.diff,
    ...(review.proofRevision ? { proofRevision: review.proofRevision } : {})
  };
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
  return feedback ? (findings.length ? findings : humanProofFindings(feedback)) : [];
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
  return safeArtifactMetadata(artifact);
}
