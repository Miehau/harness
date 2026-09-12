import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { boundedText } from "./redaction.js";
import { runMetrics } from "../public/ui-model.js";

export const projectIdentity = (cwd) => createHash("sha256").update(String(cwd)).digest("hex");
function canonicalCwd(cwd) {
  try { return realpathSync(cwd); } catch { return cwd; }
}
export const runProject = (run) => projectIdentity(canonicalCwd(run?.access?.primary?.path || run?.submission?.workspaceCwd || ""));
export function selectedProject(state) {
  return projectIdentity(canonicalCwd(state.workspace.cwd));
}
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Invalid supervisor configuration fields");
}

// Private configuration is operator-owned; never return its contents through inspection.
export async function loadSupervisorConfig(file, ownerToken, host = "127.0.0.1") {
  if (!file) return [];
  try {
    if (!isAbsolute(file) || (!ownerToken && !["127.0.0.1", "::1", "localhost"].includes(host))) throw new Error();
    const info = await stat(file);
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077)) throw new Error();
    const configPath = await realpath(file);
    const config = JSON.parse(await readFile(file, "utf8"));
    fields(config, ["projects", "webhook"]);
    if (config.projects === undefined) config.projects = [];
    if (!Array.isArray(config.projects) || config.projects.length > 32) throw new Error();
    const projects = [];
    for (const raw of [...config.projects, ...(config.webhook === undefined ? [] : [{ webhook: config.webhook }])]) {
      const global = !config.projects.includes(raw);
      fields(raw, ["cwd", "token", "webhook"]);
      if (!global && (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd))) throw new Error();
      if (raw.token !== undefined && (!ownerToken || typeof raw.token !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/.test(raw.token) || raw.token === ownerToken)) throw new Error();
      const cwd = global ? null : await realpath(raw.cwd);
      if (!global && (!(await stat(cwd)).isDirectory() || configPath.startsWith(cwd + sep))) throw new Error();
      const projectId = global ? null : projectIdentity(cwd);
      if (projects.some((item) => item.projectId === projectId || (raw.token !== undefined && item.token === raw.token))) throw new Error();
      let webhook = null;
      if (raw.webhook !== undefined) {
        fields(raw.webhook, ["url", "authorization", "deduplicates"]);
        const url = new URL(raw.webhook.url);
        if (url.protocol !== "https:" || url.username || url.password || url.hash || typeof raw.webhook.url !== "string" || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(raw.webhook.authorization || "") || (raw.webhook.deduplicates !== undefined && typeof raw.webhook.deduplicates !== "boolean")) throw new Error();
        webhook = { url: url.href, authorization: raw.webhook.authorization, deduplicates: raw.webhook.deduplicates === true };
      }
      // Bind pending sends to both destination and credential; changing either never reroutes old events.
      projects.push({ projectId, token: raw.token, webhook, destination: webhook ? projectIdentity(JSON.stringify(webhook)) : null });
    }
    return projects;
  } catch {
    throw new Error("Invalid supervisor config: use an absolute private JSON file (mode 600), unique project paths/tokens, HTTPS Bearer destinations, and an owner API token for bot access or non-loopback binding");
  }
}

const notificationConfig = (projects, projectId) => projects.find((item) => item.projectId === projectId && item.webhook) || projects.find((item) => item.projectId === null) || projects.find((item) => item.projectId === projectId);

const decisionKinds = new Set(["requirements_review", "technical_input", "needs_input", "awaiting_approval", "step_review", "evidence_review"]);
export function supervisorEventKind(run) {
  if (run.status === "completed") return "completed";
  if (["failed", "needs_attention", "interrupted"].includes(run.status)) return "attention";
  if (run.status === "cancelled") return null;
  if (run.status === "paused") return run.checkpoint?.kind === "provider_wait" && run.checkpoint.source === "execution" ? "attention" : null;
  return ["awaiting_requirements", "awaiting_input", "awaiting_approval", "awaiting_step_review", "awaiting_evidence_review"].includes(run.status) && decisionKinds.has(run.checkpoint?.kind) ? "decision" : null;
}
const signature = (run) => JSON.stringify([run.status, run.checkpoint?.id || null, run.checkpoint?.kind || null]);
const unresolved = (event) => ["pending", "attempting", "unknown", "failed"].includes(event.delivery);

export function captureSupervisorEvents(draft, projects, at = new Date().toISOString()) {
  // ponytail: scan current runs in the existing serialized write; index only if measured queue latency warrants it.
  for (const run of Object.values(draft.ticketRuns || {})) {
    const current = signature(run);
    const previous = run.supervisorObservation;
    const projectId = runProject(run);
    const config = notificationConfig(projects, projectId);
    const destination = config?.destination || null;
    if (previous?.signature === current && previous.destination === destination) continue;
    run.supervisorObservation = { signature: current, destination, at: previous?.signature === current ? previous.at : !previous && ["completed", "failed", "cancelled"].includes(run.status) ? run.completedAt || run.createdAt || at : at, sequence: (previous?.sequence || 0) + 1 };
    const kind = supervisorEventKind(run);
    if (!config?.webhook || !kind) continue;
    // Do not announce historical completions on first enabling the integration.
    if ((!previous || previous.signature === current) && kind === "completed") continue;
    (draft.supervisorEvents ||= []).push({
      version: 1, eventId: randomUUID(), projectId, ticketId: run.id, runId: run.runId,
      checkpointId: run.checkpoint?.id || null, status: run.status, kind, occurredAt: at,
      signature: current, destination: config.destination, delivery: "pending", attempts: 0, nextAttemptAt: at
    });
  }
  for (const event of draft.supervisorEvents || []) {
    if (!unresolved(event)) continue;
    const config = notificationConfig(projects, event.projectId);
    const run = draft.ticketRuns[event.ticketId];
    if (config?.destination !== event.destination) Object.assign(event, { delivery: "discarded", reason: "destination_changed", settledAt: at });
    else if (event.kind !== "completed" && (!run || run.runId !== event.runId || signature(run) !== event.signature)) Object.assign(event, { delivery: "superseded", settledAt: at });
  }
  const settled = (draft.supervisorEvents || []).filter((event) => !unresolved(event));
  const remove = new Set(settled.slice(0, Math.max(0, settled.length - 200)).map((event) => event.eventId));
  if (remove.size) {
    draft.supervisorEvents = draft.supervisorEvents.filter((event) => !remove.has(event.eventId));
    draft.supervisorHistoryPrunedAt = at;
  }
}

export function supervisorPolicy(state, projectId) {
  return state.supervisorPolicies?.[projectId] || { revision: "0", maxProviderResumes: 0 };
}
export function delegatedResumeAllowed(state, run, projectId, now = Date.now()) {
  const policy = supervisorPolicy(state, projectId);
  const used = (run.orchestratorDecisions || []).filter((item) => item.supervisorProject === projectId && item.action === "resume").length;
  const checkpoint = run.checkpoint;
  const createdAt = Date.parse(checkpoint?.createdAt || "");
  const retryAt = checkpoint?.retryAt ? Date.parse(checkpoint.retryAt) : 0;
  // A per-run ceiling is intentionally stricter than a failure-episode heuristic.
  return runProject(run) === projectId && run.status === "paused" && checkpoint?.kind === "provider_wait"
    && checkpoint.source === "execution" && Boolean(checkpoint.id) && !run.recovery?.uncertainExternalActions
    && Number.isFinite(retryAt) && now >= retryAt && Number.isFinite(createdAt) && now >= createdAt + 60_000 && used < policy.maxProviderResumes;
}
export function assertSupervisorDecision(state, run, action) {
  if (!action.supervisorProject) return;
  if (action.authority.mode !== "delegated" || action.action !== "resume" || !delegatedResumeAllowed(state, run, action.supervisorProject)) throw new Error("Supervisor decision is not delegated; owner action required");
  action.policyRevision = supervisorPolicy(state, action.supervisorProject).revision;
}

export function createSupervisor({ store, projects = [], fetchImpl = fetch, timeoutMs = 5000 }) {
  let timer;
  let running;
  let controller;
  let closed = false;
  let deliveryError = false;
  function projectFor(request) { return request.supervisorProject || selectedProject(store.read()); }
  function authorize(request, url) {
    const header = request.headers.authorization || request.headers["x-agent-plan-token"] || "";
    const token = String(header).replace(/^Bearer /, "");
    const config = projects.find((item) => item.token === token);
    if (!config) return false;
    const denied = () => { const error = new Error("Supervisor credential cannot access this route or project"); error.status = 403; throw error; };
    const read = request.method === "GET";
    const globalRead = read && ["/api/orchestrator/overview", "/api/orchestrator/notifications", "/api/orchestrator/policy"].includes(url.pathname);
    const runRead = read && url.pathname.match(/^\/api\/orchestrator\/tickets\/([^/]+)\/runs\/([^/]+)$/);
    const artifactRead = read && url.pathname.match(/^\/api\/tickets\/([^/]+)\/runs\/([^/]+)\/artifacts\/[^/]+\/(?:content|media|preview)$/);
    const action = request.method === "POST" && url.pathname.match(/^\/api\/orchestrator\/tickets\/([^/]+)\/actions$/);
    if (!globalRead && !runRead && !artifactRead && !action) denied();
    const identity = runRead || artifactRead || action;
    if (identity) {
      const state = store.read();
      const id = decodeURIComponent(identity[1]);
      const runId = identity[2] ? decodeURIComponent(identity[2]) : null;
      const run = [state.ticketRuns[id], ...Object.values(state.retainedRuns || {})].find((item) => item?.id === id && (!runId || item.runId === runId));
      if (!run || runProject(run) !== config.projectId) denied();
    }
    request.supervisorProject = config.projectId;
    return true;
  }
  function overview(projectId, params) {
    const state = store.read();
    const until = params.get("until") || new Date().toISOString();
    const since = params.get("since") || new Date(Date.parse(until) - 86400000).toISOString();
    const offset = Number(params.get("offset") || 0);
    const limit = Number(params.get("limit") || 50);
    if (![since, until].every((item) => /^\d{4}-\d\d-\d\dT/.test(item) && Number.isFinite(Date.parse(item))) || Date.parse(since) > Date.parse(until) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use ISO since/until, nonnegative offset, and limit 1–100");
    const seen = new Set();
    const runs = [...Object.values(state.ticketRuns || {}), ...Object.values(state.retainedRuns || {})].filter((run) => {
      const key = `${run.id}:${run.runId}`;
      if (seen.has(key) || runProject(run) !== projectId) return false;
      seen.add(key);
      const at = run.supervisorObservation?.at || run.completedAt || run.createdAt;
      const active = state.ticketRuns[run.id]?.runId === run.runId;
      return (active && !["completed", "cancelled"].includes(run.status)) || (Date.parse(at) >= Date.parse(since) && Date.parse(at) <= Date.parse(until));
    }).sort((a, b) => `${a.id}:${a.runId}`.localeCompare(`${b.id}:${b.runId}`));
    return { version: 1, projectId, since, until, total: runs.length, nextOffset: offset + limit < runs.length ? offset + limit : null,
      history: "retained_runs_only", historyComplete: false, runs: runs.slice(offset, offset + limit).map((run) => ({
        ticketId: run.id, runId: run.runId, archived: state.ticketRuns[run.id]?.runId !== run.runId, title: boundedText(run.ticket?.title, 240).value, status: run.status,
        checkpointId: run.checkpoint?.id || null, requiredAction: boundedText(run.checkpoint?.title || run.lastError, 240).value || null,
        changedAt: run.supervisorObservation?.at || run.completedAt || run.createdAt, metrics: runMetrics(run),
        delegatedActions: state.ticketRuns[run.id]?.runId === run.runId && delegatedResumeAllowed(state, run, projectId) ? ["resume"] : []
      })) };
  }
  function notifications(projectId, params = new URLSearchParams()) {
    const state = store.read();
    const offset = Number(params.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Use a nonnegative notification offset");
    const events = (state.supervisorEvents || []).filter((item) => item.projectId === projectId).sort((a, b) => Number(unresolved(b)) - Number(unresolved(a)));
    return { configured: Boolean(notificationConfig(projects, projectId)?.webhook), deliveryError,
      unresolved: events.filter(unresolved).length, total: events.length, truncated: events.length > 100, nextOffset: offset + 100 < events.length ? offset + 100 : null,
      historyPrunedAt: state.supervisorHistoryPrunedAt || null,
      events: events.slice(offset, offset + 100).map(({ signature: _s, destination: _d, ...event }) => event) };
  }
  async function setPolicy(projectId, input) {
    fields(input, ["expectedRevision", "maxProviderResumes"]);
    if (typeof input.expectedRevision !== "string" || !Number.isInteger(input.maxProviderResumes) || input.maxProviderResumes < 0 || input.maxProviderResumes > 3) throw new Error("Provide expectedRevision and maxProviderResumes (0–3)");
    await store.update((draft) => {
      if (supervisorPolicy(draft, projectId).revision !== input.expectedRevision) throw new Error("Stale supervisor policy");
      (draft.supervisorPolicies ||= {})[projectId] = { revision: randomUUID(), maxProviderResumes: input.maxProviderResumes, updatedAt: new Date().toISOString() };
    });
    return supervisorPolicy(store.read(), projectId);
  }
  async function retry(projectId, input) {
    fields(input, ["eventId", "discard"]);
    if (typeof input.eventId !== "string" || typeof input.discard !== "boolean") throw new Error("Provide eventId and discard boolean; retry may duplicate a received event");
    await store.update((draft) => {
      const event = draft.supervisorEvents?.find((item) => item.eventId === input.eventId && item.projectId === projectId);
      if (!event || !["failed", "unknown", "pending"].includes(event.delivery)) throw new Error("Event is not retryable/discardable");
      Object.assign(event, input.discard ? { delivery: "discarded", settledAt: new Date().toISOString() } : { delivery: "pending", nextAttemptAt: new Date().toISOString() });
    });
    return notifications(projectId);
  }
  async function drain() {
    for (const candidate of (store.read().supervisorEvents || []).filter((event) => event.delivery === "pending" && Date.parse(event.nextAttemptAt) <= Date.now())) {
      if (closed) break;
      let claimed;
      await store.update((draft) => {
        const event = draft.supervisorEvents?.find((item) => item.eventId === candidate.eventId);
        const config = notificationConfig(projects, event?.projectId);
        if (!event || !config?.webhook || config.destination !== event.destination || event.delivery !== "pending" || Date.parse(event.nextAttemptAt) > Date.now()) return;
        event.delivery = "attempting";
        event.attempts++;
        event.lastAttemptAt = new Date().toISOString();
        claimed = { event: structuredClone(event), config };
      });
      if (!claimed) continue;
      const { event, config } = claimed;
      controller = new AbortController();
      let timeout;
      let delivery = "unknown";
      let httpStatus = null;
      try {
        const { version, eventId, projectId, ticketId, runId, checkpointId, status, kind, occurredAt } = event;
        const response = await Promise.race([
          fetchImpl(config.webhook.url, { method: "POST", redirect: "manual", signal: controller.signal,
            headers: { Authorization: config.webhook.authorization, "Content-Type": "application/json", "Idempotency-Key": eventId },
            body: JSON.stringify({ version, eventId, projectId, ticketId, runId, checkpointId, status, kind, occurredAt }) }),
          new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); })
        ]);
        httpStatus = response.status;
        delivery = httpStatus >= 200 && httpStatus < 300 ? "accepted" : "failed";
        void response.body?.cancel().catch(() => {});
      } catch { /* Network errors and aborts cannot prove non-delivery. */ }
      finally { clearTimeout(timeout); controller.abort(); controller = null; }
      await store.update((draft) => {
        const current = draft.supervisorEvents?.find((item) => item.eventId === event.eventId);
        if (!current) return;
        Object.assign(current, { transportResult: delivery, httpStatus, receivedAt: new Date().toISOString() });
        if (current.delivery !== "attempting") return;
        const retryable = config.webhook.deduplicates && event.attempts < 3 && (delivery === "unknown" || httpStatus === 429 || httpStatus >= 500);
        Object.assign(current, { delivery: retryable ? "pending" : delivery, httpStatus, settledAt: new Date().toISOString(),
          nextAttemptAt: retryable ? new Date(Date.now() + event.attempts * 60_000).toISOString() : null });
      });
    }
  }
  function flush() {
    if (closed) return Promise.resolve();
    if (!running) running = drain().then(() => { deliveryError = false; }).catch(() => { deliveryError = true; }).finally(() => { running = null; });
    return running;
  }
  async function start() {
    await store.update((draft) => {
      for (const event of draft.supervisorEvents || []) if (event.delivery === "attempting") {
        const config = notificationConfig(projects, event.projectId);
        Object.assign(event, { delivery: config?.destination === event.destination && config?.webhook?.deduplicates && event.attempts < 3 ? "pending" : "unknown", nextAttemptAt: new Date().toISOString() });
      }
    });
    if (projects.some((item) => item.webhook)) { timer = setInterval(flush, 1000); timer.unref(); }
  }
  async function close() { closed = true; clearInterval(timer); controller?.abort(); await running; }
  return { authorize, projectFor, overview, notifications, setPolicy, retry, start, close, flush,
    policy: (projectId) => supervisorPolicy(store.read(), projectId) };
}
