#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseModelRef } from "./profiles.js";
import { freeTextTicket } from "../public/ui-model.js";

const DEFAULT_URL = "http://127.0.0.1:4317";
export const usage = `agent-plan <command>
Talks to 127.0.0.1:4317. AGENT_PLAN_URL / AGENT_PLAN_API_TOKEN supported.

  new text <prompt>                 Start a free-text ticket (New task dialog)
  list backlog                      Queue and tracker tickets
  list runs [ticketId]              Active and archived run identities for a ticket
  list timeline [ticketId] [runId]  Inspector output for an active or archived run
  select <ticketId> [action]        Select; action: resume|approve|pause|cancel
  resume [ticketId]                 Resume paused, interrupted, or failed work
  restart <ticketId> [target] --confirm Restart fresh or from stage:<id>/step:<id>
  approve [ticketId] [--auto]       Run manually, or auto-run the graph
  approve-proof [ticketId]          Approve final proof and continue delivery
  revise-proof <ticketId> <feedback> [--criterion <id>] Request final-proof corrections (repeat flag for multiple criteria)
  restart-fixer <ticketId> <reason> Abandon a contaminated final-review fixer session
  accept <stepId> [ticketId] [--auto] Accept a step; --auto runs later slices automatically
  revise <stepId> <ticketId> <feedback> [--criterion <id>] Request focused changes (repeat flag for multiple criteria)
  steer <instruction> [ticketId] [--step <stepId>] Queue one focused instruction for an active worker
  waive <stepId> <ticketId> <reason> Reject a false verifier finding and return to review
  scope-add <stepId> <ticketId> <path> <reason> [--max-files N --max-lines N] Approve audited scope/budget
  coordination show [ticketId]      Peer messages, conflicts, decisions and revisions
  coordination conflict <ticketId> <json> Record {summary, stepIds, proposal}
  coordination decide <ticketId> <json> Save {summary, reason, conflictIds, stepIds}
  coordination propose <ticketId> <json> Propose {reason, changes, conflictIds}
  coordination resolve <ticketId> <conflictId> Ask supervisor for a resolution
  coordination accept <ticketId> <revisionId> Accept a proposed revision
  coordination reject <ticketId> <revisionId> <reason> Reject a proposed revision
  cancel [ticketId]
  pause [ticketId]                  Pause and persist the active checkpoint
  profile <stage> <model> <thinking> [ticketId] Override one stopped run stage profile
  preview start|stop [ticketId]     Start or stop the ticket live preview
  answer <ticketId> <text|--approve> Approve or answer an open question
  start <ticketId>                  Start a tracker ticket already in the queue
  wait [ticketId]                   Block until checkpoint; exit 1 on needs_attention
  status [ticketId]
  queue clear                       Remove non-running queue items
  access show                       Current project access policy (JSON)
  access set <json>                 Set extra roots / any access (same JSON as the API)
`;

export async function runCli(argv, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const [command, ...rest] = argv.filter((arg) => arg !== "--");
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(usage);
    return 0;
  }
  const ctx = { env, fetchImpl, stdout, stderr, sleep };
  if (command === "status") return statusCommand(rest, ctx);
  return handleCommand(command, rest, ctx);
}

function revisionInput(words) {
  const feedback = [];
  const criterionIds = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "--criterion") { feedback.push(words[i]); continue; }
    const id = words[++i];
    if (!id?.trim() || id.startsWith("--")) throw new Error("--criterion requires a criterion ID");
    criterionIds.push(id);
  }
  return { feedback: feedback.join(" ").trim(), ...(criterionIds.length ? { criterionIds } : {}) };
}

async function handleCommand(command, rest, ctx) {
  const { env, fetchImpl, stdout, stderr, sleep } = ctx;
  if (command === "coordination") {
    const [action = "show", explicitId, input, ...extra] = rest;
    if (!["show", "conflict", "propose", "decide", "resolve", "accept", "reject"].includes(action) || (action !== "reject" && extra.length)) throw new Error("Usage: agent-plan coordination show|conflict|propose|resolve|accept|reject [ticketId] [input]");
    const id = await resolveTicketId(explicitId, ctx);
    const base = `/api/tickets/${encodeURIComponent(id)}/coordination`;
    if (action === "show") {
      if (input) throw new Error("Usage: agent-plan coordination show [ticketId]");
      print(stdout, await request("GET", base, { env, fetchImpl }));
      return 0;
    }
    if (!input) throw new Error(`coordination ${action} requires an input`);
    let body = {};
    let suffix;
    if (["conflict", "propose", "decide"].includes(action)) {
      try { body = JSON.parse(input); } catch { throw new Error("Coordination input must be valid JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Coordination input must be an object");
      suffix = action === "conflict" ? "conflicts" : action === "decide" ? "decisions" : "revisions";
    } else if (action === "resolve") { suffix = "resolve"; body = { conflictId: input }; }
    else {
      suffix = `revisions/${encodeURIComponent(input)}/${action}`;
      if (action === "reject") {
        body = { reason: extra.join(" ").trim() };
        if (!body.reason) throw new Error("coordination reject requires a reason");
      }
    }
    print(stdout, await request("POST", `${base}/${suffix}`, { body, env, fetchImpl }));
    return 0;
  }
  if (command === "new") {
    if (rest[0] !== "text") throw new Error("Usage: agent-plan new text <prompt>\n" + usage);
    const prompt = rest.slice(1).join(" ").trim();
    if (!prompt) throw new Error("Usage: agent-plan new text <prompt>");
    const ticket = freeTextTicket(prompt, randomUUID());
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(ticket.id) + "/start", { body: { ticket }, env, fetchImpl });
    print(stdout, { ticketId: ticket.id, identifier: ticket.identifier, title: ticket.title, ...result });
    return 0;
  }
  if (command === "list" || command === "backlog" || command === "timeline") {
    const what = command === "list" ? rest[0] : command;
    const args = command === "list" ? rest.slice(1) : rest;
    if (what === "backlog") {
      print(stdout, await backlog(ctx));
      return 0;
    }
    if (what === "runs") {
      print(stdout, await runHistories(args[0], ctx));
      return 0;
    }
    if (what === "timeline" || what === "execution-timeline") {
      print(stdout, sanitizeTimeline(await timeline(args[0], args[1], ctx)));
      return 0;
    }
    throw new Error("Usage: agent-plan list backlog|runs [ticketId]|timeline [ticketId] [runId]\n" + usage);
  }
  if (command === "select") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan select <ticketId> [resume|approve|pause|cancel]");
    await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/select", { body: {}, env, fetchImpl });
    const action = aliasAction(rest[1]);
    if (!action) {
      print(stdout, { selectedTicketId: id });
      return 0;
    }
    return handleCommand(action, [id, ...rest.slice(2)], ctx);
  }
  if (command === "resume") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/resume", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "restart") {
    const id = rest[0];
    const target = rest.find((arg, index) => index > 0 && arg !== "--confirm") || "fresh";
    if (!id || !rest.includes("--confirm")) throw new Error("Usage: agent-plan restart <ticketId> [fresh|stage:<id>|step:<id>] --confirm");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/restart", { body: { target, confirmed: true }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "cancel") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/cancel", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "pause") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/pause", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "profile") {
    const [profileId, model, thinking, explicitId] = rest;
    if (!profileId || !model || !thinking) throw new Error("Usage: agent-plan profile <stage> <model> <thinking> [ticketId]");
    const id = await resolveTicketId(explicitId, ctx);
    const parsed = parseModelRef(model);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/stage-profiles/" + encodeURIComponent(profileId), {
      body: { model: parsed.model, thinking, ...(parsed.provider ? { provider: parsed.provider } : {}) },
      env, fetchImpl
    });
    print(stdout, result);
    return 0;
  }
  if (command === "preview") {
    const action = rest[0];
    if (!["start", "stop"].includes(action)) throw new Error("Usage: agent-plan preview start|stop [ticketId]");
    const id = await resolveTicketId(rest[1], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/preview", { body: { action }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "accept") {
    const stepId = rest[0];
    if (!stepId) throw new Error("Usage: agent-plan accept <stepId> [ticketId] [--auto]");
    const auto = rest.includes("--auto");
    const id = await resolveTicketId(rest.slice(1).find((arg) => arg !== "--auto"), ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/accept", { body: { auto }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "revise") {
    const [stepId, id, ...words] = rest;
    const input = revisionInput(words);
    if (!stepId || !id || !input.feedback) throw new Error("Usage: agent-plan revise <stepId> <ticketId> <feedback> [--criterion <id>]");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/changes", { body: input, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "steer") {
    const flag = rest.indexOf("--step");
    const stepId = flag >= 0 ? String(rest[flag + 1] || "").trim() : null;
    const args = flag < 0 ? rest : rest.filter((_, index) => index !== flag && index !== flag + 1);
    const [instruction, explicitId, ...extra] = args;
    if (!instruction || extra.length || (flag >= 0 && !stepId)) throw new Error("Usage: agent-plan steer <instruction> [ticketId] [--step <stepId>]");
    const id = await resolveTicketId(explicitId, ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steering", { body: { instruction, author: "cli", ...(stepId ? { stepId } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "scope-add") {
    const [stepId, id, path, ...words] = rest;
    const reasonWords = [];
    const reviewBudget = {};
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "--max-files" || words[i] === "--max-lines") {
        const key = words[i] === "--max-files" ? "maxFiles" : "maxChangedLines";
        const value = Number(words[++i]);
        if (!Number.isInteger(value) || value <= 0) throw new Error("Review budget limits must be positive integers");
        reviewBudget[key] = value;
      } else reasonWords.push(words[i]);
    }
    const hasBudget = Object.keys(reviewBudget).length > 0;
    if (hasBudget && (!reviewBudget.maxFiles || !reviewBudget.maxChangedLines)) throw new Error("Provide both --max-files and --max-lines");
    const reason = reasonWords.join(" ").trim();
    if (!stepId || !id || !path || !reason) throw new Error("Usage: agent-plan scope-add <stepId> <ticketId> <path> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/scope", { body: { paths: [path], reason, ...(hasBudget ? { reviewBudget } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "waive") {
    const [stepId, id, ...words] = rest;
    const reason = words.join(" ").trim();
    if (!stepId || !id || !reason) throw new Error("Usage: agent-plan waive <stepId> <ticketId> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/waive", { body: { reason }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "queue") {
    if (rest[0] !== "clear") throw new Error("Usage: agent-plan queue clear\n" + usage);
    const result = await request("POST", "/api/queue/clear", { body: {}, env, fetchImpl });
    print(stdout, { cleared: result.cleared });
    return 0;
  }
  if (command === "wait") {
    const id = await resolveTicketId(rest[0], ctx);
    const deadline = Date.now() + Number(env.AGENT_PLAN_WAIT_MS || 30 * 60 * 1000);
    while (Date.now() < deadline) {
      const run = await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl });
      const result = terminal(run);
      if (result.done) {
        print(stdout, run);
        return result.code;
      }
      await sleep(Number(env.AGENT_PLAN_POLL_MS || 1000));
    }
    stderr.write("Timed out waiting for a checkpoint\n");
    return 1;
  }
  if (command === "answer") {
    const id = rest[0];
    const approve = rest.length === 2 && rest[1] === "--approve";
    const answers = approve ? "" : rest.slice(1).join(" ").trim();
    if (!id || (!approve && !answers)) throw new Error("Usage: agent-plan answer <ticketId> <text|--approve>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/clarify", { body: { answers }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "approve") {
    const auto = rest.includes("--auto");
    const id = await resolveTicketId(rest.find((arg) => arg !== "--auto"), ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/approve", { body: { auto }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "approve-proof") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/evidence/approve", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "revise-proof") {
    const [id, ...words] = rest;
    const input = revisionInput(words);
    if (!id || !input.feedback) throw new Error("Usage: agent-plan revise-proof <ticketId> <feedback> [--criterion <id>]");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/evidence/changes", { body: input, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "restart-fixer") {
    const [id, ...words] = rest;
    const reason = words.join(" ").trim();
    if (!id || !reason) throw new Error("Usage: agent-plan restart-fixer <ticketId> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/review-fix/restart", { body: { reason }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "start") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan start <ticketId>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/start", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "access") {
    const action = rest[0] || "show";
    if (action === "show" && rest.length <= 1) {
      print(stdout, await request("GET", "/api/workspace/access-policy", { env, fetchImpl }));
      return 0;
    }
    if (action === "set") {
      const raw = rest.slice(1).join(" ").trim();
      if (!raw) throw new Error("Usage: agent-plan access set <json>\n" + usage);
      let body;
      try { body = JSON.parse(raw); }
      catch { throw new Error("Access policy JSON is invalid"); }
      print(stdout, await request("POST", "/api/workspace/access-policy", { body, env, fetchImpl }));
      return 0;
    }
    throw new Error("Usage: agent-plan access show|set <json>\n" + usage);
  }
  throw new Error("Unknown command: " + command + "\n" + usage);
}

async function statusCommand(rest, ctx) {
  const { env, fetchImpl, stdout } = ctx;
  const id = rest[0];
  if (id) {
    print(stdout, await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl }));
    return 0;
  }
  const state = await request("GET", "/api/state", { env, fetchImpl });
  const runs = Object.values(state.ticketRuns || {}).map((run) => ({
    id: run.id, status: run.status, checkpoint: run.checkpoint, lastError: run.lastError, workflow: run.workflow
  }));
  print(stdout, { selectedTicketId: state.selectedTicketId, revision: state.revision, runs });
  return 0;
}

async function backlog(ctx) {
  const { env, fetchImpl } = ctx;
  const [sources, state] = await Promise.all([
    request("GET", "/api/tickets", { env, fetchImpl }).catch(() => ({ tickets: [] })),
    request("GET", "/api/state", { env, fetchImpl })
  ]);
  const runs = state.ticketRuns || {};
  const seen = new Set();
  const tickets = [];
  for (const ticket of sources.tickets || []) {
    const run = runs[ticket.id];
    tickets.push(backlogRow(ticket, run, state.selectedTicketId));
    seen.add(ticket.id);
  }
  for (const run of Object.values(runs)) {
    if (seen.has(run.id)) continue;
    tickets.push(backlogRow(run.ticket || { id: run.id }, run, state.selectedTicketId));
  }
  return { selectedTicketId: state.selectedTicketId, tickets };
}

function backlogRow(ticket, run, selectedTicketId) {
  return {
    id: ticket.id,
    identifier: ticket.identifier || run?.ticket?.identifier || ticket.id,
    title: ticket.title || run?.ticket?.title || "",
    source: ticket.source || ticket.provider || run?.ticket?.source || null,
    status: run?.status || ticket.state?.name || null,
    checkpoint: run?.checkpoint?.kind || null,
    selected: selectedTicketId === ticket.id
  };
}

async function timeline(explicitId, runId, ctx) {
  const { env, fetchImpl } = ctx;
  const state = explicitId ? null : await request("GET", "/api/state", { env, fetchImpl });
  const id = explicitId || state.selectedTicketId;
  if (!id) throw new Error("Pass a ticket id (no selected run)");
  // The inspector owns focus, lifecycle, redaction, and retention semantics. Keep
  // this command a transport-only view so its JSON cannot drift from the dashboard.
  const path = runId
    ? "/api/tickets/" + encodeURIComponent(id) + "/runs/" + encodeURIComponent(runId) + "/inspection"
    : "/api/tickets/" + encodeURIComponent(id) + "/inspection";
  return request("GET", path, { env, fetchImpl });
}

async function runHistories(explicitId, ctx) {
  const id = await resolveTicketId(explicitId, ctx);
  return request("GET", "/api/tickets/" + encodeURIComponent(id) + "/runs", { env: ctx.env, fetchImpl: ctx.fetchImpl });
}

function aliasAction(value) {
  if (!value) return null;
  if (value === "resume-run") return "resume";
  if (["resume", "approve", "pause", "cancel", "start"].includes(value)) return value;
  throw new Error("Unknown action: " + value + " (resume|approve|pause|cancel)");
}

async function resolveTicketId(explicit, ctx) {
  if (explicit) return explicit;
  const state = await request("GET", "/api/state", { env: ctx.env, fetchImpl: ctx.fetchImpl });
  const id = state.selectedTicketId || Object.keys(state.ticketRuns || {})[0];
  if (!id) throw new Error("Pass a ticket id (no selected run)");
  return id;
}

const timelineSecretKey = /(?:api[_-]?key|authorization|credential|password|secret|token|cookie|private[_-]?key)/i;
const timelineAuthorization = /\b(?:authorization|proxy-authorization)\s*[=:]\s*[^\r\n]+/gi;
const timelineSecret = /\b(?:api[_-]?key|authorization|credential|password|secret|token|cookie|private[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const timelinePath = /(^|[^A-Za-z0-9_.@-])(?:~\/|\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*|[A-Za-z]:\\[^\s"'`),;]+)/g;

function sanitizeTimeline(value) {
  if (typeof value === "string") return value
    .replace(timelineAuthorization, "[redacted]")
    .replace(timelineSecret, (match) => match.replace(/(?:"[^"]*"|'[^']*'|[^\s,;]+)$/, "[redacted]"))
    .replace(timelinePath, (_, prefix) => `${prefix}[path]`);
  if (Array.isArray(value)) return value.map(sanitizeTimeline);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, timelineSecretKey.test(key) ? "[redacted]" : sanitizeTimeline(item)]));
}

function print(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function baseUrl(env) {
  env = env || process.env;
  return String(env.AGENT_PLAN_URL || DEFAULT_URL).replace(/\/$/, "");
}

function headers(env) {
  env = env || process.env;
  const token = env.AGENT_PLAN_API_TOKEN;
  const result = { "content-type": "application/json" };
  if (token) result.authorization = "Bearer " + token;
  return result;
}

async function request(method, path, opts) {
  opts = opts || {};
  const env = opts.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const response = await fetchImpl(baseUrl(env) + path, {
    method,
    headers: { ...headers(env), ...(method === "POST" ? { prefer: "respond-async" } : {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok) throw new Error((payload && payload.error) || ("Request failed: " + response.status));
  return payload;
}

function terminal(run) {
  if (!run) return { done: true, code: 1, reason: "missing" };
  if (run.status === "needs_attention" || (run.checkpoint && run.checkpoint.kind === "needs_attention")) return { done: true, code: 1, reason: "needs_attention" };
  if (run.status === "failed") return { done: true, code: 1, reason: "failed" };
  if (run.status === "completed") return { done: true, code: 0, reason: "completed" };
  if (run.status === "paused") return { done: true, code: 0, reason: "paused" };
  if (run.checkpoint) return { done: true, code: 0, reason: "checkpoint" };
  return { done: false, code: 0, reason: run.status };
}

if (process.argv[1] && import.meta.url === ("file://" + process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(error.message + String.fromCharCode(10));
    process.exitCode = 1;
  });
}
