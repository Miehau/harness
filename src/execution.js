import { blockingReasons, flattenSteps, parentGroup } from "./plan.js";

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

export function createActivityCapture({ existing = {}, persist, emit, now = Date.now, outputLimit = 100000, eventLimit = 200 }) {
  const startedAt = existing.startedAt || new Date(now()).toISOString();
  const events = (existing.events || []).slice(-eventLimit);
  let rawOutput = appendBounded("", existing.rawOutput, outputLimit);
  let lastEventAt = existing.lastEventAt || startedAt;
  let lastEvent = existing.lastEvent || "";
  let warning = Boolean(existing.warning);
  let completedAt = existing.completedAt;
  let persistence;
  let dirty = false;
  const lastThinkingAt = new Map();
  const current = () => ({
    startedAt, lastEventAt, lastEvent, warning, rawOutput, events: events.slice(),
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
      if (item.type === "text_delta") rawOutput = appendBounded(rawOutput, item.delta, outputLimit);
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
  for (const step of flattenSteps(run.plan)) if (["running", "fixing"].includes(step.status)) step.status = "cancelled";
  const stage = run.stages.find((item) => item.status === "active");
  if (stage) Object.assign(stage, { status: "blocked", summary: "Run cancelled" });
}

export function clearInactiveRuns(state, activeTicketIds) {
  const running = new Set(["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing", "queued_for_merge", "merging", "resolving_conflicts", "verifying_merge"]);
  let cleared = 0;
  for (const id of Object.keys(state.ticketRuns)) {
    if (activeTicketIds.has(id) && running.has(state.ticketRuns[id].status)) continue;
    delete state.ticketRuns[id];
    cleared++;
  }
  if (state.selectedTicketId && !state.ticketRuns[state.selectedTicketId]) state.selectedTicketId = null;
  return cleared;
}

export function planApprovalPending(run) {
  return Boolean(run?.plan && run.checkpoint?.kind === "awaiting_approval");
}

export function resumeStage(run) {
  if (!["interrupted", "cancelled", "needs_attention"].includes(run?.status)) return null;
  return run.plan ? "run" : run.stages?.find((stage) => stage.status === "active")?.id || null;
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

export function actionableFindings(reviews) {
  const seen = new Set();
  return reviews.flatMap((review) => review.findings || [])
    .filter((finding) => {
      const evidence = finding.evidence?.[0] || {};
      const key = `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
