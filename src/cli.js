#!/usr/bin/env node
const DEFAULT_URL = "http://127.0.0.1:4317";
export const usage = "agent-plan status|wait|answer|approve|start\nTalks to 127.0.0.1:4317. AGENT_PLAN_URL / AGENT_PLAN_API_TOKEN supported.\nHeadless workspace: POST /api/workspace {cwd}. wait exits 1 on needs_attention.\n";
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
  if (command === "status") {
    const id = rest[0];
    if (id) {
      const run = await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl });
      stdout.write(JSON.stringify(run, null, 2) + "\n");
    } else {
      const state = await request("GET", "/api/state", { env, fetchImpl });
      const runs = Object.values(state.ticketRuns || {}).map((run) => ({
        id: run.id, status: run.status, checkpoint: run.checkpoint, lastError: run.lastError, workflow: run.workflow
      }));
      stdout.write(JSON.stringify({ selectedTicketId: state.selectedTicketId, revision: state.revision, runs }, null, 2) + "\n");
    }
    return 0;
  }
  return handleCommand(command, rest, { env, fetchImpl, stdout, stderr, sleep });
}

async function handleCommand(command, rest, ctx) {
  const { env, fetchImpl, stdout, stderr, sleep } = ctx;
  if (command === "wait") {
    let id = rest[0];
    if (!id) {
      const state = await request("GET", "/api/state", { env, fetchImpl });
      id = state.selectedTicketId || Object.keys(state.ticketRuns || {})[0];
      if (!id) throw new Error("Pass a ticket id (no selected run)");
    }
    const deadline = Date.now() + Number(env.AGENT_PLAN_WAIT_MS || 30 * 60 * 1000);
    while (Date.now() < deadline) {
      const run = await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl });
      const result = terminal(run);
      if (result.done) {
        stdout.write(JSON.stringify(run, null, 2) + "\n");
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
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (command === "approve") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan approve <ticketId> [--auto]");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/approve", { body: { auto: rest.includes("--auto") }, env, fetchImpl });
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (command === "start") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan start <ticketId>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/start", { body: {}, env, fetchImpl });
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  throw new Error("Unknown command: " + command + "\n" + usage);
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
