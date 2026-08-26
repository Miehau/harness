import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const preview = await manager.ensure({ id: "ticket-1", cwd: root });
    assert.equal(preview.url, "http://127.0.0.1:47821");
    assert.equal(spawns[0].options.env.APP_PORT, "47821");
    const evidence = await manager.capture("ticket-1", { source: { CHROMIUM_PATH: process.execPath } });
    assert.deepEqual(evidence.map(({ viewport }) => viewport), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
    assert.equal(captures.length, 2);
    assert.equal(manager.stop("ticket-1"), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
});
