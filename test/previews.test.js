import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewManager } from "../src/previews.js";

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
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
    const spawns = [];
    const captures = [];
    const manager = new PreviewManager({ dataDir, portImpl: async () => 47821,
      spawnImpl: (file, args, options) => { spawns.push({ file, args, options }); return child; },
      fetchImpl: async () => ({ ok: true }),
      execImpl: async (file, args) => { captures.push({ file, args }); return { stdout: "", stderr: "" }; }
    });
    const preview = await manager.ensure({ id: "ticket-1", cwd: root, seedState: { selectedTicketId: "ticket-1", ticketRuns: { "ticket-1": { status: "verifying" } } } });
    assert.equal(preview.url, "http://127.0.0.1:47821");
    assert.equal(spawns[0].options.env.APP_PORT, "47821");
    assert.equal(spawns[0].options.env.AGENT_PLAN_DATA_DIR, join(dataDir, "preview-state", "ticket-1"));
    assert.deepEqual(JSON.parse(await readFile(join(spawns[0].options.env.AGENT_PLAN_DATA_DIR, "state-v3.json"), "utf8")), {
      selectedTicketId: "ticket-1", ticketRuns: { "ticket-1": { status: "verifying" } }
    });
    const evidence = await manager.capture("ticket-1", { source: { CHROMIUM_PATH: process.execPath } });
    assert.deepEqual(evidence.map(({ viewport }) => viewport), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
    assert.deepEqual(evidence.map(({ mediaType, mediaKind }) => ({ mediaType, mediaKind })), [{ mediaType: "image/png", mediaKind: "image" }, { mediaType: "image/png", mediaKind: "image" }]);
    assert.equal(captures.length, 2);
    const profiles = captures.map(({ args }) => args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length));
    assert.equal(captures.every(({ args }) => !args.some((arg) => arg.startsWith("--virtual-time-budget=")) && args.includes("--run-all-compositor-stages-before-draw")), true);
    assert.notEqual(profiles[0], profiles[1]);
    await Promise.all(profiles.map((profile) => assert.rejects(readFile(profile), /ENOENT|EISDIR/)));
    assert.equal(manager.stop("ticket-1"), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
});

test("starts a conventional package preview when a legacy contract omits one", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { verify: ["node", "verify.mjs"] } }));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js", dev: "node --watch server.js" } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => {};
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

test("a timed-out Chromium capture is usable when its screenshot was written", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "preview-timeout-"));
  try {
    const manager = new PreviewManager({ dataDir, captureTimeoutMs: 10, execImpl: async (_file, args) => {
      const output = args.find((arg) => arg.startsWith("--screenshot=")).slice("--screenshot=".length);
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
    await assert.rejects(readFile(join(directory, "desktop.png")), /ENOENT/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a hanging preview probe cannot bypass the readiness deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-manager-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    let killed = false;
    child.kill = () => { killed = true; child.exitCode = 0; child.emit("exit", 0); };
    const manager = new PreviewManager({
      portImpl: async () => 47821,
      spawnImpl: () => child,
      readyTimeoutMs: 30,
      probeTimeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    });
    await assert.rejects(manager.ensure({ id: "hanging-preview", cwd: root }), /Preview did not become ready/);
    assert.equal(killed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stopAll terminates every preview process", () => {
  const manager = new PreviewManager({});
  const killed = [];
  const child = (id) => {
    const process = new EventEmitter();
    process.exitCode = null;
    process.kill = (signal) => { killed.push(id + ":" + signal); process.exitCode = 0; process.emit("exit", 0); };
    return process;
  };
  manager.active.set("a", { child: child("a"), public: { port: 1 } });
  manager.active.set("b", { child: child("b"), public: { port: 2 } });
  manager.ports.add(1);
  manager.ports.add(2);
  assert.equal(manager.stopAll(), 2);
  assert.deepEqual(killed, ["a:SIGTERM", "b:SIGTERM"]);
  assert.equal(manager.list().length, 0);
});
