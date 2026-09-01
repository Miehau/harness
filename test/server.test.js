import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/server.js";
import { runCli } from "../src/cli.js";

function mockHarness() {
  return {
    models: async () => [{ id: "gpt-test", name: "Test", provider: "pi-test" }],
    listSkills: async () => [{ name: "shape-feature", description: "Shape" }],
    validateProfiles: async () => {},
    reset() {},
    activateWorkflow: async () => ({
      reply: "Loaded shape-feature",
      stages: [{ id: "brief", title: "Shape brief", status: "active" }],
      checkpoints: [{ kind: "awaiting_approval", title: "Approve the brief", prompt: "Continue?" }],
      sessionFile: null
    }),
    continueWorkflow: async () => ({ reply: "Continued", stages: [], checkpoints: [], sessionFile: null }),
    clarifyRequirements: async () => ({ artifact: "# Requirements", questions: [], sessionFile: null }),
    refineRequirements: async () => ({ artifact: "# Requirements", questions: [], sessionFile: null })
  };
}

async function invoke(daemon, method, path, { body, token } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from([Buffer.from(payload, "utf8")]);
  request.method = method;
  request.url = path;
  request.headers = {
    host: "127.0.0.1:4317",
    "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {})
  };
  let status = 200;
  let headers = {};
  const chunks = [];
  const response = {
    headersSent: false,
    destroyed: false,
    writableNeedDrain: false,
    writeHead(code, hdrs) { status = code; headers = hdrs || {}; this.headersSent = true; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.ended = true; },
    destroy() { this.destroyed = true; },
    on() { return this; }
  };
  await daemon.handleRequest(request, response);
  const text = Buffer.concat(chunks).toString();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status, headers, text, json };
}

async function withDaemon(fn, opts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-daemon-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-cwd-"));
  const daemon = await createDaemon({
    cwd, dataDir, listen: false, lock: false, harness: opts.harness || mockHarness(), apiToken: opts.apiToken || ""
  });
  try { return await fn(daemon, { dataDir, cwd }); }
  finally {
    await daemon.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function seedRun(daemon, extras = {}) {
  const ticket = { id: "ticket-1", identifier: "T-1", title: "Ticket", description: "Desc", state: { name: "Ready" }, source: "linear" };
  await daemon.store.update((state) => {
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = {
      id: ticket.id, runId: "run-1", ticket, status: extras.status || "clarifying",
      workspace: { cwd: daemon.store.read().workspace.cwd },
      stageProfiles: state.stageProfiles, stages: [
        { id: "requirements", title: "Clarify requirements", status: "active", summary: "" },
        { id: "explore", title: "Explore", status: "pending", summary: "" },
        { id: "design", title: "Design", status: "pending", summary: "" },
        { id: "implement", title: "Implement", status: "pending", summary: "" },
        { id: "verify", title: "Verify", status: "pending", summary: "" },
        { id: "handoff", title: "Handoff", status: "pending", summary: "" }
      ],
      checkpoint: extras.checkpoint || null, plan: extras.plan || null, artifacts: extras.artifacts || [],
      activeRuns: {}, sessionFile: null, auto: false, lastError: extras.lastError || null,
      workflow: extras.workflow || { skillName: null, status: "idle", stages: [], checkpoints: [], lastReview: null },
      createdAt: new Date().toISOString(),
      ...extras
    };
  });
  return ticket.id;
}

test("GET /api/health and compact run omit artifact content", async () => {
  await withDaemon(async (daemon) => {
    const health = await invoke(daemon, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const id = await seedRun(daemon, {
      artifacts: [{ id: "a1", name: "design.md", path: "/tmp/design.md", kind: "architecture", content: "# secret" }]
    });
    const compact = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(compact.status, 200);
    assert.equal(compact.json.status, "clarifying");
    assert.equal(compact.json.revision > 0, true);
    assert.equal("artifacts" in compact.json, false);
    assert.equal(JSON.stringify(compact.json).includes("# secret"), false);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.json.ticketRuns[id].artifacts[0].name, "design.md");
    assert.equal(state.json.ticketRuns[id].artifacts[0].content, undefined);
  });
});

test("API token rejects unauthenticated /api calls", async () => {
  await withDaemon(async (daemon) => {
    const denied = await invoke(daemon, "GET", "/api/health");
    assert.equal(denied.status, 401);
    const allowed = await invoke(daemon, "GET", "/api/health", { token: "secret" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.ok, true);
  }, { apiToken: "secret" });
});

test("GET /api/models reports the real provider instead of a hardcoded Codex label", async () => {
  await withDaemon(async (daemon) => {
    const result = await invoke(daemon, "GET", "/api/models");
    assert.equal(result.status, 200);
    assert.equal(result.json.provider, "pi-test");
    assert.equal(result.json.models[0].provider, "pi-test");
    assert.notEqual(result.json.provider, "openai-codex");
  });
});

test("binding a skill creates run.checkpoint and continue resumes the ticket", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon);
    const bound = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/workflow", { body: { skillName: "shape-feature" } });
    assert.equal(bound.status, 200);
    const afterBind = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(afterBind.json.checkpoint.title, "Approve the brief");
    assert.equal(afterBind.json.workflow.skillName, "shape-feature");
    assert.equal(afterBind.json.status, "awaiting_approval");
    const continued = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/workflow/continue", {
      body: { checkpointId: afterBind.json.checkpoint.id, response: "Approved" }
    });
    assert.equal(continued.status, 202);
    const deadline = Date.now() + 3000;
    let latest;
    while (Date.now() < deadline) {
      latest = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
      if (latest.json.checkpoint && latest.json.checkpoint.kind === "requirements_review") break;
      if (latest.json.lastError) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(latest.json.lastError, null);
    assert.equal(latest.json.checkpoint.kind, "requirements_review");
  });
});

test("agent-plan CLI wait is non-zero on needs_attention", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "needs_attention", lastError: "stalled", checkpoint: { kind: "needs_attention", title: "Correction stalled" } });
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push(url);
      const parsed = new URL(url);
      const result = await invoke(daemon, options.method || "GET", parsed.pathname + parsed.search, {});
      return {
        ok: result.status < 400,
        status: result.status,
        async text() { return result.text; }
      };
    };
    const chunks = [];
    const code = await runCli(["wait", id], {
      env: { AGENT_PLAN_URL: "http://127.0.0.1:4317", AGENT_PLAN_POLL_MS: "10" },
      fetchImpl,
      stdout: { write(value) { chunks.push(value); } },
      stderr: { write() {} }
    });
    assert.equal(code, 1);
    assert.match(chunks.join(""), /needs_attention/);
  });
});
