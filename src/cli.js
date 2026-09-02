#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { eventTimeline, freeTextTicket, preferredStepId } from "../public/ui-model.js";

const DEFAULT_URL = "http://127.0.0.1:4317";
export const usage = `agent-plan <command>
Talks to 127.0.0.1:4317. AGENT_PLAN_URL / AGENT_PLAN_API_TOKEN supported.

  new text <prompt>                 Start a free-text ticket (New task dialog)
  list backlog                      Queue and tracker tickets
  list timeline [ticketId]          Inspector output for the active step
  select <ticketId> [action]        Select; action: resume|approve|pause|cancel
  resume [ticketId]                 Resume paused, interrupted, or failed work
  approve [ticketId] [--auto]       Run manually, or auto-run the graph
  accept <stepId> [ticketId]        Accept a review-ready step
  cancel [ticketId]
  pause [ticketId]                  Pause and persist the active checkpoint
  answer <ticketId> <text>
  start <ticketId>                  Start a tracker ticket already in the queue
  wait [ticketId]                   Block until checkpoint; exit 1 on needs_attention
  status [ticketId]
  queue clear                       Remove non-running queue items
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

async function handleCommand(command, rest, ctx) {
  const { env, fetchImpl, stdout, stderr, sleep } = ctx;
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
    if (what === "timeline" || what === "execution-timeline") {
      print(stdout, await timeline(args[0], ctx));
      return 0;
    }
    throw new Error("Usage: agent-plan list backlog|timeline [ticketId]\n" + usage);
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
  if (command === "accept") {
    const stepId = rest[0];
    if (!stepId) throw new Error("Usage: agent-plan accept <stepId> [ticketId]");
    const id = await resolveTicketId(rest[1], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/accept", { body: {}, env, fetchImpl });
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
    const answers = rest.slice(1).join(" ").trim();
    if (!id || !answers) throw new Error("Usage: agent-plan answer <ticketId> <text>");
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
  if (command === "start") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan start <ticketId>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/start", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
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

async function timeline(explicitId, ctx) {
  const { env, fetchImpl } = ctx;
  const state = await request("GET", "/api/state", { env, fetchImpl });
  const id = explicitId || state.selectedTicketId;
  if (!id) throw new Error("Pass a ticket id (no selected run)");
  const run = state.ticketRuns?.[id];
  if (!run) throw new Error("Ticket run not found");
  const steps = (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  const step = steps.find((item) => ["running", "fixing"].includes(item.status))
    || steps.find((item) => item.id === preferredStepId(run.plan))
    || null;
  const stage = (run.stages || []).find((item) => item.status === "active");
  const events = step
    ? (step.attempts || []).flatMap((attempt) => attempt.events || [])
    : stage?.activity?.events || [];
  return {
    ticketId: id,
    stepId: step?.id || null,
    stepStatus: step?.status || null,
    stageId: stage?.id || null,
    events: eventTimeline(events).map((item) => ({
      at: item.at || null,
      title: item.title,
      tool: item.tool || null,
      status: item.status,
      isError: Boolean(item.isError)
    }))
  };
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
    headers: headers(env),
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
  if (run.checkpoint) return { done: true, code: 0, reason: "checkpoint" };
  return { done: false, code: 0, reason: run.status };
}

if (process.argv[1] && import.meta.url === ("file://" + process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(error.message + String.fromCharCode(10));
    process.exit(1);
  });
}
