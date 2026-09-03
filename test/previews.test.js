import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewManager } from "../src/previews.js";
import { PROCESS_OWNERSHIP_ENV } from "../src/process-containment.js";

test("does not reuse a port held by another ticket preview", async () => {
  const ports = [47821, 47821, 47822];
  const manager = new PreviewManager({ portImpl: async () => ports.shift() });
  manager.ports.add(47821);
  assert.equal(await manager.reservePort(), 47822);
});

test("starts a named preview with isolated port variables and captures desktop and mobile", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  const dataDir = await mkdtemp(join(tmpdir(), "preview-evidence-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { preview: ["npm", "run", "preview"] }, ports: { variables: ["APP_PORT"] } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => assert.fail("preview teardown must use containment rather than child.kill");
    const spawns = [];
    const captures = [];
    const cleanupTriggers = [];
    const containment = {
      executionId: "preview-execution", ownership: { token: "preview-owner" },
      environment: (environment) => ({ ...environment, [PROCESS_OWNERSHIP_ENV]: "preview-owner" }),
      cleanup: async (trigger) => { cleanupTriggers.push(trigger); return { outcome: "complete" }; }
    };
    const manager = new PreviewManager({ dataDir, portImpl: async () => 47821,
      spawnImpl: (file, args, options) => { spawns.push({ file, args, options }); return child; },
      fetchImpl: async () => ({ ok: true }),
      execImpl: async (file, args, options) => { captures.push({ file, args, options }); return { stdout: "", stderr: "" }; }
    });
    const preview = await manager.ensure({ id: "ticket-1", cwd: root, seedState: { selectedTicketId: "ticket-1", ticketRuns: { "ticket-1": { status: "verifying" } } }, containment });
    assert.equal(preview.url, "http://127.0.0.1:47821");
    assert.equal(spawns[0].options.env.APP_PORT, "47821");
    assert.equal(spawns[0].options.env.AGENT_PLAN_DATA_DIR, join(dataDir, "preview-state", "ticket-1"));
    assert.equal(spawns[0].options.env[PROCESS_OWNERSHIP_ENV], "preview-owner");
    assert.deepEqual(JSON.parse(await readFile(join(spawns[0].options.env.AGENT_PLAN_DATA_DIR, "state-v3.json"), "utf8")), {
      selectedTicketId: "ticket-1", ticketRuns: { "ticket-1": { status: "verifying" } }
    });
    const evidence = await manager.capture("ticket-1", { source: { CHROMIUM_PATH: process.execPath } });
    const recaptured = await manager.capture("ticket-1", { source: { CHROMIUM_PATH: process.execPath } });
    assert.deepEqual(evidence.map(({ viewport }) => viewport), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
    assert.deepEqual(evidence.map(({ mediaType, mediaKind }) => ({ mediaType, mediaKind })), [{ mediaType: "image/png", mediaKind: "image" }, { mediaType: "image/png", mediaKind: "image" }]);
    assert.equal(new Set([...evidence, ...recaptured].map(({ path }) => path)).size, 4);
    assert.equal(captures.length, 4);
    assert.equal(captures.every(({ file, args }) => file === process.execPath && args[0].endsWith("/scripts/screenshot.mjs")), true);
    assert.deepEqual(captures.map(({ args }) => [args[args.indexOf("--width") + 1], args[args.indexOf("--height") + 1]]), [["1440", "900"], ["390", "844"], ["1440", "900"], ["390", "844"]]);
    assert.equal(captures.every(({ args }) => args.includes("--click") && args[args.indexOf("--click") + 1].includes("status-running")), true);
    assert.ok(captures.every(({ options }) => options.env[PROCESS_OWNERSHIP_ENV] === "preview-owner"));
    assert.equal(manager.stop("ticket-1"), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleanupTriggers, [{ trigger: "preview-stop", previewId: "ticket-1" }]);
    assert.equal(preview.status, "stopped");
  } finally { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
});

test("starts a conventional package preview when a legacy contract omits one", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { verify: ["node", "verify.mjs"] } }));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js", dev: "node --watch server.js" } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => assert.fail("preview teardown must use containment rather than child.kill");
    const spawns = [];
    const manager = new PreviewManager({
      portImpl: async () => 47821,
      spawnImpl: (file, args, options) => { spawns.push({ file, args, options }); return child; },
      fetchImpl: async () => ({ ok: true })
    });
    const preview = await manager.ensure({ id: "legacy-ticket", cwd: root });
    assert.equal(preview.command, "start");
    assert.deepEqual([spawns[0].file, spawns[0].args], ["npm", ["run", "start"]]);
    assert.equal(spawns[0].options.env.PORT, "47821");
    manager.stop("legacy-ticket");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restarts a seeded preview so recurring gates cannot reuse stale run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  const dataDir = await mkdtemp(join(tmpdir(), "preview-evidence-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { preview: ["npm", "run", "preview"] } }));
    const children = [];
    const manager = new PreviewManager({
      dataDir,
      portImpl: async () => 47821 + children.length,
      fetchImpl: async () => ({ ok: true }),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => assert.fail("preview teardown must use containment rather than child.kill");
        children.push(child);
        return child;
      }
    });

    await manager.ensure({ id: "ticket", cwd: root, seedState: { revision: 1 } });
    const refreshed = await manager.ensure({ id: "ticket", cwd: root, seedState: { revision: 2 } });
    await new Promise((resolveWait) => setImmediate(resolveWait));

    assert.equal(children.length, 2);
    assert.equal(refreshed.port, 47822);
    assert.deepEqual(manager.list().map(({ port }) => port), [47822]);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "preview-state", "ticket", "state-v3.json"), "utf8")), { revision: 2 });
    manager.stop("ticket");
  } finally { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
});

test("self-preview launches worktree server code with an immutable live-state restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  const dataDir = await mkdtemp(join(tmpdir(), "preview-evidence-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-plan-workspace", scripts: { start: "node src/server.js" } }));
    await writeFile(join(root, "src", "server.js"), "export async function createDaemon() {}\n");
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { preview: ["npm", "run", "start"] } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => assert.fail("preview teardown must use containment rather than child.kill");
    let spawned;
    const manager = new PreviewManager({
      dataDir, portImpl: async () => 47821, fetchImpl: async () => ({ ok: true }),
      spawnImpl: (file, args, options) => { spawned = { file, args, options }; return child; }
    });

    const snapshot = { version: 6, revision: 42, ticketRuns: { ticket: { status: "reviewing" } } };
    await manager.ensure({ id: "ticket", cwd: root, seedState: snapshot });

    assert.equal(spawned.file, process.execPath);
    assert.match(spawned.args[0], /preview-snapshot-server\.mjs$/);
    assert.equal(spawned.args[1], join(root, "src/server.js"));
    assert.deepEqual(JSON.parse(await readFile(spawned.args.at(-1), "utf8")), snapshot);
    manager.stop("ticket");
  } finally { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
});

test("a timed-out Chromium capture is usable when its screenshot was written", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "preview-timeout-"));
  try {
    const manager = new PreviewManager({ dataDir, captureTimeoutMs: 10, execImpl: async (_file, args) => {
      const output = args[args.indexOf("--out") + 1];
      await writeFile(output, "png");
      throw new Error("Chromium timed out after 10ms");
    } });
    manager.active.set("ticket", { public: { url: "http://127.0.0.1:4317" } });
    const evidence = await manager.capture("ticket", { source: { CHROMIUM_PATH: process.execPath } });
    assert.equal(evidence.length, 2);
    assert.equal(evidence.every((item) => item.mediaType === "image/png"), true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a timed-out Chromium capture cannot reuse stale screenshot evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "preview-stale-"));
  try {
    const directory = join(dataDir, "visual-evidence", "ticket");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "desktop.png"), "stale");
    const manager = new PreviewManager({ dataDir, captureTimeoutMs: 10, execImpl: async () => { throw new Error("Chromium timed out after 10ms"); } });
    manager.active.set("ticket", { public: { url: "http://127.0.0.1:4317" } });
    await assert.rejects(manager.capture("ticket", { source: { CHROMIUM_PATH: process.execPath } }), /timed out/);
    assert.equal(await readFile(join(directory, "desktop.png"), "utf8"), "stale");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a hanging preview probe cannot bypass the readiness deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => assert.fail("preview teardown must use containment rather than child.kill");
    const cleanupTriggers = [];
    const containment = {
      executionId: "hanging-preview", environment: (environment) => environment,
      cleanup: async (trigger) => { cleanupTriggers.push(trigger); return { outcome: "complete" }; }
    };
    const manager = new PreviewManager({
      portImpl: async () => 47821,
      spawnImpl: () => child,
      readyTimeoutMs: 30,
      probeTimeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    });
    await assert.rejects(manager.ensure({ id: "hanging-preview", cwd: root, containment }), /Preview did not become ready/);
    assert.deepEqual(cleanupTriggers, [{ trigger: "preview-launch-failed", previewId: "hanging-preview", error: "Preview did not become ready within 0 seconds" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("records launch failures through containment without claiming a preview PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-launch-failure-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { preview: ["npm", "run", "preview"] } }));
    let trigger;
    const containment = {
      executionId: "failed-preview", environment: (environment) => environment,
      cleanup: async (value) => { trigger = value; return { outcome: "incomplete" }; }
    };
    const manager = new PreviewManager({ portImpl: async () => 47821, spawnImpl: () => { throw new Error("spawn unavailable"); } });
    await assert.rejects(manager.ensure({ id: "ticket-failed", cwd: root, containment }), /spawn unavailable[\s\S]*Preview cleanup: incomplete/);
    assert.equal(trigger.trigger, "preview-launch-failed");
    assert.match(trigger.error, /spawn unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("redacts ownership tokens from failed preview output", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-redaction-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { preview: ["npm", "run", "preview"] } }));
    const token = "89f609e7-128e-40b7-a21a-59a09768b6dd";
    const child = new EventEmitter();
    child.exitCode = 1;
    child.stdout = new EventEmitter();
    const on = child.stdout.on.bind(child.stdout);
    child.stdout.on = (event, listener) => {
      on(event, listener);
      if (event === "data") listener(Buffer.from(`owner=${token}`));
      return child.stdout;
    };
    const containment = {
      executionId: "redacted-preview", environment: (environment) => ({ ...environment, [PROCESS_OWNERSHIP_ENV]: token }),
      cleanup: async () => ({ outcome: "not-required" })
    };
    const manager = new PreviewManager({ portImpl: async () => 47821, spawnImpl: () => child });
    await assert.rejects(manager.ensure({ id: "ticket-redacted", cwd: root, containment }), (error) => {
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /owner=\[REDACTED\]/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stopAll delegates every preview process to containment", async () => {
  const manager = new PreviewManager({});
  const cleanup = [];
  const preview = (id) => ({
    child: { exitCode: null }, public: { port: id, status: "running", cleanup: null },
    containment: { executionId: `preview-${id}`, cleanup: async (trigger) => { cleanup.push(trigger); return { outcome: "complete" }; } }, cleanup: null
  });
  manager.active.set("a", preview("a"));
  manager.active.set("b", preview("b"));
  manager.ports.add("a");
  manager.ports.add("b");
  assert.equal(manager.stopAll(), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleanup, [{ trigger: "preview-stop", previewId: "a" }, { trigger: "preview-stop", previewId: "b" }]);
  assert.equal(manager.list().length, 0);
});
