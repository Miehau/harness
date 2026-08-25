import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRepository, snapshotTree } from "../src/git.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, createZeroStateWorkspace, repairZeroStateWorkspace } from "../src/worktrees.js";

test("isolated sibling worktrees produce commits that integrate into the zero-state run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-parallel-"));
  const cwd = join(dataDir, "working-directory");
  const ticket = { id: "local-test", identifier: "LOCAL-test" };
  try {
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    assert.equal(workspace.cwd, cwd);
    assert.match(await readFile(join(workspace.cwd, ".gitignore"), "utf8"), /node_modules/);
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
    for (const cwd of [worktrees.feature.cwd, worktrees.ci.cwd]) await cherryPickCommit(workspace.cwd, await commitWorkspace(cwd, "feat: verified slice\n\nWhy: The ticket needs it.\nRequirement: REQ-test"));
    assert.equal(await readFile(join(workspace.cwd, "src", "app.js"), "utf8"), "export const ready = true;\n");
    assert.equal(await readFile(join(workspace.cwd, ".github", "workflows", "ci.yml"), "utf8"), "name: CI\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("commits accepted workspace changes and skips an empty follow-up commit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-commit-"));
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-test" }, runId: "run-1" });
    assert.equal(await commitWorkspace(cwd, "Baseline should already be clean"), null);
    await writeFile(join(cwd, "feature.txt"), "accepted\n");
    assert.match(await commitWorkspace(cwd, "Implement: feature"), /^[a-f0-9]{40}$/);
    assert.equal(await commitWorkspace(cwd, "Implement: feature again"), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
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

test("initializes a missing selected run directory as unrecovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-missing-"));
  const cwd = join(root, "working-directory");
  try {
    const { workspace, recovered } = await repairZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-test" }, runId: "run-1", previousCwd: cwd });
    assert.equal(recovered, false);
    assert.equal(await isGitRepository(workspace.cwd), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes an isolated repository when the run directory is nested in another repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-plan-parent-"));
  const cwd = join(parent, "working-directory");
  try {
    await createZeroStateWorkspace({ cwd: parent, ticket: { identifier: "LOCAL-parent" }, runId: "parent-run" });
    const parentHead = await readFile(join(parent, ".git", "HEAD"), "utf8");
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-child" }, runId: "child-run" });
    assert.equal((await readdir(cwd)).includes(".git"), true);
    assert.equal(await isGitRepository(cwd), true);
    assert.equal(await readFile(join(parent, ".git", "HEAD"), "utf8"), parentHead);
  } finally {
    await rm(parent, { recursive: true, force: true });
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
