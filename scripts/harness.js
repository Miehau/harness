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

async function removeTemporaryDirectory(path) {
  // Daemon shutdown can settle a final queued state write after its worker
  // promise has completed. Retry transient ENOTEMPTY while removing test-only
  // directories so that write cannot make an otherwise successful fixture fail.
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export async function withDaemon(fn, opts = {}) {
  const dataDir = opts.dataDir || await mkdtemp(join(tmpdir(), "agent-plan-daemon-"));
  const cwd = opts.cwd || await mkdtemp(join(tmpdir(), "agent-plan-cwd-"));
  const daemon = await createDaemon({
    cwd, dataDir, listen: opts.listen || false, port: opts.listen ? 0 : undefined, lock: false,
    harness: opts.harness || mockHarness(), apiToken: opts.apiToken || "", trackers: opts.trackers
  });
  try { return await fn(daemon, { dataDir, cwd }); }
  finally {
    await daemon.close({ exit: false });
    // Wait for state persistence already queued by the bounded shutdown before
    // deleting its backing directory; the retry below covers a last write that
    // was scheduled concurrently by a detached activity callback.
    await daemon.store.queue;
    if (!opts.keep) {
      if (!opts.dataDir) await removeTemporaryDirectory(dataDir);
      if (!opts.cwd) await removeTemporaryDirectory(cwd);
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
