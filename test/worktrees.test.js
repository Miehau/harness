import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, diffTrees, snapshotTree } from "../src/git.js";
import { createParallelWorktrees, createZeroStateWorkspace } from "../src/worktrees.js";

test("isolated sibling worktrees produce patches that integrate into the zero-state run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-parallel-"));
  const ticket = { id: "local-test", identifier: "LOCAL-test" };
  try {
    const workspace = await createZeroStateWorkspace({ dataDir, ticket, runId: "run-1" });
    await writeFile(join(workspace.cwd, "package.json"), "{}\n");
    const base = await snapshotTree(workspace.cwd);
    const pairs = await createParallelWorktrees({
      sourceCwd: workspace.cwd, dataDir, ticket, runId: "run-1", tree: base,
      steps: [{ id: "feature" }, { id: "ci" }]
    });
    const worktrees = Object.fromEntries(pairs);
    await mkdir(join(worktrees.feature.cwd, "src"));
    await writeFile(join(worktrees.feature.cwd, "src", "app.js"), "export const ready = true;\n");
    await mkdir(join(worktrees.ci.cwd, ".github", "workflows"), { recursive: true });
    await writeFile(join(worktrees.ci.cwd, ".github", "workflows", "ci.yml"), "name: CI\n");
    for (const cwd of [worktrees.feature.cwd, worktrees.ci.cwd]) {
      const after = await snapshotTree(cwd);
      await applyPatch(workspace.cwd, (await diffTrees(cwd, base, after)).patch);
    }
    assert.equal(await readFile(join(workspace.cwd, "src", "app.js"), "utf8"), "export const ready = true;\n");
    assert.equal(await readFile(join(workspace.cwd, ".github", "workflows", "ci.yml"), "utf8"), "name: CI\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
