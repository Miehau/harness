import { boundedText, redactRecord, redactText, safeReasoningSummary } from "./redaction.js";

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

export function retainedUsage(activity = {}) {
  if (activity.usage) return {
    ...Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "calls", "records"].map((key) => [key, Number(activity.usage[key]) || 0])),
    ...(activity.usage.costRecords > 0 ? { costUsd: activity.usage.costUsd, costRecords: activity.usage.costRecords } : {}),
    complete: activity.usage.complete === true
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, records: 0, complete: !activity.startedAt && !activity.attemptId && !(activity.events || []).length };
  for (const event of activity.events || []) addUsage(usage, event);
  return usage;
}

function addUsage(usage, event) {
  if (event.type === "tool_start") usage.calls++;
  const record = event.type === "usage" ? event : event.usage;
  if (!record) return;
  usage.records++;
  if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd >= 0) {
    usage.costUsd = (usage.costUsd || 0) + record.costUsd;
    usage.costRecords = (usage.costRecords || 0) + 1;
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value >= 0) usage[key] += value;
  }
}

export function createActivityCapture({ existing = {}, persist, emit, now = Date.now, outputLimit = 100000, eventLimit = 200 }) {
  const usage = retainedUsage(existing);
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
    startedAt, lastEventAt, lastEvent, warning, rawOutput, usage: { ...usage }, events: events.slice(), prompts: prompts.slice(), groups: groupActivityEvents(events),
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
      addUsage(usage, item);
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
        save();
      } else {
        pushBounded(events, item, eventLimit);
        lastEventAt = item.at;
        lastEvent = item.label || lastEvent;
        warning = item.type === "agent_error" || (item.type === "tool_end" && item.isError);
        save();
      }
      emit?.(["usage", "tool_start"].includes(item.type) || item.usage ? { ...item, usageTotals: { ...usage } } : item);
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

/** Durable activity snapshots use an explicit persistence and event boundary. */
export function stageActivity({ store, update, emit, ticketId, stageId, runId }) {
  return createActivityCapture({
    existing: store.read().ticketRuns[ticketId]?.stages?.find((stage) => stage.id === stageId)?.activity,
    persist: (activity) => update((state) => {
      if (state.ticketRuns[ticketId]?.runId !== runId) return;
      const stage = state.ticketRuns[ticketId]?.stages?.find((candidate) => candidate.id === stageId);
      if (stage) stage.activity = activity;
    }, { publish: false }),
    emit: (event) => {
      if (store.read().ticketRuns[ticketId]?.runId === runId) emit({ channel: "stage", ticketId, stageId, runId, ...event });
    }
  });
}

export function stepActivity({ store, update, emit, ticketId, stepId, runId }) {
  return createActivityCapture({
    existing: store.read().ticketRuns[ticketId]?.activeRuns?.[stepId]?.activity,
    persist: (activity) => update((state) => {
      const active = state.ticketRuns[ticketId]?.activeRuns?.[stepId];
      if (active?.runId === runId) active.activity = activity;
    }, { publish: false }),
    emit: (event) => {
      if (store.read().ticketRuns[ticketId]?.activeRuns?.[stepId]?.runId === runId) emit(event);
    }
  });
}
