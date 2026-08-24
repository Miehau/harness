import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";

export const MAX_REVIEW_ROUNDS = 3;

export function markRunCancelled(run, at = new Date().toISOString()) {
  run.status = "cancelled";
  run.cancelledAt = at;
  run.checkpoint = null;
  run.activeRuns = {};
  for (const step of flattenSteps(run.plan)) if (["running", "fixing"].includes(step.status)) step.status = "cancelled";
  const stage = run.stages.find((item) => item.status === "active");
  if (stage) Object.assign(stage, { status: "blocked", summary: "Run cancelled" });
}

export function clearInactiveRuns(state, activeTicketIds) {
  let cleared = 0;
  for (const id of Object.keys(state.ticketRuns)) {
    if (activeTicketIds.has(id)) continue;
    delete state.ticketRuns[id];
    cleared++;
  }
  if (state.selectedTicketId && !state.ticketRuns[state.selectedTicketId]) state.selectedTicketId = null;
  return cleared;
}

export function nextRunnableStep(plan) {
  return flattenSteps(plan).find((step) =>
    ["ready", "interrupted"].includes(step.status) && blockingReasons(plan, step).length === 0
  ) || null;
}

export function nextRunnableBatch(plan) {
  if (flattenSteps(plan).some((step) => step.status === "review_ready")) return [];
  const first = nextRunnableStep(plan);
  if (!first) return [];
  const group = parentGroup(plan, first.id);
  return group ? group.children.filter((step) =>
    ["ready", "interrupted"].includes(step.status) && blockingReasons(plan, step).length === 0
  ) : [first];
}

export function blockingFindings(reviews) {
  const seen = new Set();
  return reviews.flatMap((review) => review.findings || [])
    .filter((finding) => finding.severity === "blocking")
    .filter((finding) => {
      const evidence = finding.evidence?.[0] || {};
      const key = `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
