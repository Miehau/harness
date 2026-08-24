import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { diffTrees, snapshotTree } from "../src/git.js";

const exec = promisify(execFile);

test("tree snapshots isolate one run without modifying the real index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-git-test-"));
  try {
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n");
    await exec("git", ["add", "tracked.txt"], { cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });

    await writeFile(join(cwd, "tracked.txt"), "pre-existing dirty state\n");
    const before = await snapshotTree(cwd);
    await writeFile(join(cwd, "tracked.txt"), "changed by this run\n");
    await writeFile(join(cwd, "artifact.md"), "run artifact\n");
    const after = await snapshotTree(cwd);
    const diff = await diffTrees(cwd, before, after);

    assert.deepEqual(diff.files.sort(), ["artifact.md", "tracked.txt"]);
    assert.match(diff.patch, /pre-existing dirty state/);
    assert.match(diff.patch, /changed by this run/);
    const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd });
    assert.equal(stdout, "");
  } finally {
    await rm(cwd, { recursive: true });
  }
});
