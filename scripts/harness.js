import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/server.js";
import { createTicketRun } from "../src/execution.js";
import { sampleTicket } from "./seed-state.js";

export { sampleTicket };

export function mockHarness() {
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

export async function invoke(daemon, method, path, { body, token } = {}) {
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

export async function withDaemon(fn, opts = {}) {
  const dataDir = opts.dataDir || await mkdtemp(join(tmpdir(), "agent-plan-daemon-"));
  const cwd = opts.cwd || await mkdtemp(join(tmpdir(), "agent-plan-cwd-"));
  const daemon = await createDaemon({
    cwd, dataDir, listen: false, lock: false, harness: opts.harness || mockHarness(), apiToken: opts.apiToken || ""
  });
  try { return await fn(daemon, { dataDir, cwd }); }
  finally {
    await daemon.close({ exit: false });
    if (!opts.keep) {
      if (!opts.dataDir) await rm(dataDir, { recursive: true, force: true });
      if (!opts.cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
}

export async function seedRun(daemon, extras = {}) {
  const ticket = extras.ticket || sampleTicket();
  const { ticket: _ignored, ...rest } = extras;
  await daemon.store.update((state) => {
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
      runId: "run-1",
      status: "clarifying",
      workspace: { cwd: state.workspace.cwd },
      ...rest
    });
  });
  return ticket.id;
}
