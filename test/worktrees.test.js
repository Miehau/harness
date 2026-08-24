import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, diffTrees, snapshotTree } from "../src/git.js";
import { createParallelWorktrees, createZeroStateWorkspace, repairZeroStateWorkspace } from "../src/worktrees.js";

test("isolated sibling worktrees produce patches that integrate into the zero-state run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-parallel-"));
  const cwd = join(dataDir, "working-directory");
  const ticket = { id: "local-test", identifier: "LOCAL-test" };
  try {
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    assert.equal(workspace.cwd, cwd);
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

test("repairs a missing local Git workspace without losing surviving files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-repair-"));
  const previousCwd = join(dataDir, "old-run");
  const cwd = join(dataDir, "working-directory");
  const ticket = { id: "local-test", identifier: "LOCAL-test" };
  try {
    await mkdir(previousCwd);
    await writeFile(join(previousCwd, "survived.txt"), "kept\n");
    const { workspace, recovered } = await repairZeroStateWorkspace({ cwd, ticket, runId: "run-1", previousCwd });
    assert.equal(recovered, true);
    assert.equal(await readFile(join(workspace.cwd, "survived.txt"), "utf8"), "kept\n");
    assert.equal(await snapshotTree(workspace.cwd) !== null, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("refuses to initialize a zero-state run over existing files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-nonempty-"));
  try {
    await writeFile(join(cwd, "keep.txt"), "do not overwrite\n");
    await assert.rejects(
      createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-test" }, runId: "run-1" }),
      /working directory must be empty/
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
