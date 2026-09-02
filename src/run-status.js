export const inFlightRunStatuses = Object.freeze([
  "preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing",
  "queued_for_merge", "merging", "resolving_conflicts", "verifying_merge", "rebasing",
  "waiting_for_checks", "addressing_feedback", "waiting_for_merge"
]);

export const terminalRunStatuses = Object.freeze([
  "completed", "failed", "needs_attention", "cancelled", "interrupted", "paused"
]);

export const inFlightMergeStatuses = Object.freeze([
  "queued", "merging", "resolving_conflicts", "verifying", "rebasing",
  "waiting_for_checks", "addressing_feedback", "waiting_for_merge"
]);

export const inFlightStepStatuses = Object.freeze(["running", "fixing"]);
export const runnableStepStatuses = Object.freeze(["ready", "interrupted"]);
export const gateStepStatuses = Object.freeze(["review_ready", "needs_input", "awaiting_approval"]);
export const resumeRunStatuses = Object.freeze(["interrupted", "cancelled", "needs_attention", "failed", "paused"]);
export const replaceableRunStatuses = Object.freeze(["completed", "failed", "needs_attention"]);
export const earlyFailureStatuses = Object.freeze(["preparing", "clarifying"]);
export const restartableStepStatuses = Object.freeze(["cancelled", "needs_attention", "failed"]);

export const stepStatusList = Object.freeze([
  "draft", "ready", "running", "review_ready", "fixing", "needs_attention", "needs_input",
  "awaiting_approval", "accepted", "failed", "interrupted", "cancelled"
]);

export const inFlightRunStatusSet = new Set(inFlightRunStatuses);
export const terminalRunStatusSet = new Set(terminalRunStatuses);
export const inFlightMergeStatusSet = new Set(inFlightMergeStatuses);
export const inFlightStepStatusSet = new Set(inFlightStepStatuses);
export const runnableStepStatusSet = new Set(runnableStepStatuses);
export const gateStepStatusSet = new Set(gateStepStatuses);
export const resumeRunStatusSet = new Set(resumeRunStatuses);
export const replaceableRunStatusSet = new Set(replaceableRunStatuses);
export const earlyFailureStatusSet = new Set(earlyFailureStatuses);
export const restartableStepStatusSet = new Set(restartableStepStatuses);
export const stepStatuses = new Set(stepStatusList);
