import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock } from "../src/daemon-lock.js";

test("single-daemon lock rejects a live owner and replaces a stale owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-lock-"));
  const path = join(root, "daemon.lock");
  try {
    await writeFile(path, JSON.stringify({ pid: 42 }));
    await assert.rejects(acquireDaemonLock(path, { pid: 7, processKill: (pid) => { if (pid === 42) return; } }), /PID 42/);
    const lock = await acquireDaemonLock(path, { pid: 7, processKill: () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; } });
    assert.equal((await stat(path)).isFile(), true);
    await lock.release();
    assert.equal(await stat(path).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true }); }
});
