import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileTree } from "../src/process-tree.js";

test("timeouts terminate the whole spawned process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-tree-"));
  const pidFile = join(root, "child.pid");
  try {
    await writeFile(join(root, "parent.mjs"), `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    await assert.rejects(execFileTree(process.execPath, [join(root, "parent.mjs")], { timeout: 100 }), /timed out/);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
