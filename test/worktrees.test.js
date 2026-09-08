import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { freezeRunAccess, normalizeProjectPolicy } from "../src/access-policy.js";
import { isGitRepository, snapshotTree } from "../src/git.js";
import { scopedWorkerTools } from "../src/pi-harness.js";
import { cherryPickCommit, commitWorkspace, createParallelWorktrees, createZeroStateWorkspace, ensureTicketWorktree, gitRepositoriesForStep, integrateBranch, mapConfiguredPath, needsLocalWorkspaceRepair, repairZeroStateWorkspace } from "../src/worktrees.js";

const exec = promisify(execFile);

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
    await createParallelWorktrees({ sourceCwd: workspace.cwd, dataDir, ticket, runId: "run-1", tree: base, steps: [{ id: "feature" }, { id: "ci" }] });
    await assert.rejects(readFile(join(worktrees.feature.cwd, "src", "app.js"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(worktrees.ci.cwd, ".github", "workflows", "ci.yml"), "utf8"), /ENOENT/);
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

test("ticket worktrees reuse installed dependencies without committing them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-dependencies-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    await mkdir(join(cwd, "backend-ts"));
    await writeFile(join(cwd, "backend-ts", "package.json"), "{}\n");
    await commitWorkspace(cwd, "feat: add backend package");
    await mkdir(join(cwd, "node_modules", "eslint"), { recursive: true });
    await mkdir(join(cwd, "backend-ts", "node_modules", "hono"), { recursive: true });

    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-change" }, runId: "run-1" });

    assert.equal(await readlink(join(workspace.cwd, "node_modules", "eslint")), join(cwd, "node_modules", "eslint"));
    assert.equal(await readlink(join(workspace.cwd, "backend-ts", "node_modules", "hono")), join(cwd, "backend-ts", "node_modules", "hono"));
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: workspace.cwd })).stdout, "");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("integrates a completed ticket branch into the opened working directory", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-integrate-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-change" }, runId: "run-1" });
    await writeFile(join(workspace.cwd, "integrated.txt"), "ready\n");
    await commitWorkspace(workspace.cwd, "feat: integrate ticket\n\nWhy: The result belongs in the opened repository.\nRequirement: REQ-integrate");
    let verified = false;
    const result = await integrateBranch({
      sourceCwd: cwd, branch: workspace.branch, integrationCwd: join(dataDir, "integration"),
      verify: async ({ cwd: integrationCwd }) => { verified = (await readFile(join(integrationCwd, "integrated.txt"), "utf8")) === "ready\n"; }
    });
    assert.match(result.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(result.diff.files, ["integrated.txt"]);
    assert.equal(verified, true);
    assert.equal(await readFile(join(cwd, "integrated.txt"), "utf8"), "ready\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("seeds a ticket worktree from uncommitted source files without touching the source index", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-dirty-source-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    await writeFile(join(cwd, "tracked.txt"), "committed\n");
    await commitWorkspace(cwd, "feat: tracked baseline");
    await writeFile(join(cwd, "tracked.txt"), "dirty tracked\n");
    await writeFile(join(cwd, "dirty.txt"), "not committed\n");
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-change" }, runId: "run-1" });
    assert.equal(await readFile(join(workspace.cwd, "tracked.txt"), "utf8"), "dirty tracked\n");
    assert.equal(await readFile(join(workspace.cwd, "dirty.txt"), "utf8"), "not committed\n");
    assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "dirty tracked\n");
    assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd })).stdout, "");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("initializes a ticket worktree from an existing project before its first commit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-unborn-source-"));
  const cwd = join(dataDir, "repository");
  try {
    await mkdir(cwd);
    await exec("git", ["init", "-q", "-b", "main"], { cwd });
    await writeFile(join(cwd, "app.js"), "export const ready = true;\n");
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-first" }, runId: "run-1" });
    assert.equal(await readFile(join(workspace.cwd, "app.js"), "utf8"), "export const ready = true;\n");
    await assert.rejects(exec("git", ["rev-parse", "HEAD"], { cwd }));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("uses a resolver only when an isolated merge has conflicts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-conflict-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    await writeFile(join(cwd, "shared.txt"), "base\n");
    await commitWorkspace(cwd, "feat: shared base");
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-change" }, runId: "run-1" });
    await writeFile(join(workspace.cwd, "shared.txt"), "ticket\n");
    await commitWorkspace(workspace.cwd, "feat: ticket change");
    await writeFile(join(cwd, "shared.txt"), "target\n");
    await commitWorkspace(cwd, "feat: target change");
    let resolverCalls = 0;
    const result = await integrateBranch({
      sourceCwd: cwd, branch: workspace.branch, integrationCwd: join(dataDir, "integration"),
      resolveConflicts: async ({ cwd: integrationCwd, conflicts }) => {
        resolverCalls++;
        assert.deepEqual(conflicts, ["shared.txt"]);
        await writeFile(join(integrationCwd, "shared.txt"), "target + ticket\n");
      },
      verify: async ({ cwd: integrationCwd }) => assert.equal(await readFile(join(integrationCwd, "shared.txt"), "utf8"), "target + ticket\n")
    });
    assert.equal(resolverCalls, 1);
    assert.deepEqual(result.conflicts, ["shared.txt"]);
    assert.equal(await readFile(join(cwd, "shared.txt"), "utf8"), "target + ticket\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("does not touch the opened repository when merged verification fails", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-rejected-merge-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    const sourceTree = await snapshotTree(cwd);
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-change" }, runId: "run-1" });
    await writeFile(join(workspace.cwd, "unverified.txt"), "not ready\n");
    await commitWorkspace(workspace.cwd, "feat: unverified change");
    await assert.rejects(
      integrateBranch({
        sourceCwd: cwd, branch: workspace.branch, integrationCwd: join(dataDir, "integration"),
        verify: async () => { throw new Error("checks failed"); }
      }),
      /checks failed/
    );
    assert.equal(await snapshotTree(cwd), sourceTree);
    await assert.rejects(readFile(join(cwd, "unverified.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reuses an initialized non-empty zero-state repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-existing-"));
  try {
    const input = { cwd, ticket: { identifier: "LOCAL-test" }, runId: "run-1" };
    await createZeroStateWorkspace(input);
    await writeFile(join(cwd, "existing.txt"), "keep\n");
    assert.equal((await createZeroStateWorkspace(input)).cwd, cwd);
    assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "keep\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("does not repair a local run that already owns an initialized worktree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-owned-"));
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-test" }, runId: "run-1" });
    assert.equal(await needsLocalWorkspaceRepair({ source: "local" }, { cwd }), false);
    assert.equal(await needsLocalWorkspaceRepair({ source: "local" }, null), true);
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

test("a free-text task initializes a new folder and delivers back to main", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-new-folder-"));
  const cwd = join(dataDir, "repository");
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, "existing.txt"), "preserved\n");
    await writeFile(join(cwd, ".env"), "SECRET=local\n");
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-new" }, runId: "run-1" });
    assert.equal(await isGitRepository(cwd), true);
    assert.equal((await exec("git", ["branch", "--show-current"], { cwd })).stdout.trim(), "main");
    assert.equal(await readFile(join(workspace.cwd, "existing.txt"), "utf8"), "preserved\n");
    await assert.rejects(readFile(join(workspace.cwd, ".env")), /ENOENT/);
    await writeFile(join(workspace.cwd, "result.txt"), "delivered\n");
    await commitWorkspace(workspace.cwd, "feat: new project\n\nWhy: verify first-ticket delivery.");
    await integrateBranch({ sourceCwd: cwd, branch: workspace.branch, integrationCwd: join(dataDir, "integration") });
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "delivered\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function toolNamed(tools, name) {
  return tools.find((tool) => tool.name === name);
}

test("primary-only projects still create a single ticket worktree and branch", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-primary-only-"));
  const cwd = join(dataDir, "repository");
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket: { identifier: "TEXT-one" }, runId: "run-1" });
    assert.equal(workspace.repositories.length, 1);
    assert.equal(workspace.repositories[0].id, "primary");
    assert.equal(workspace.repositories[0].cwd, workspace.cwd);
    assert.equal(workspace.branch, workspace.repositories[0].branch);
    assert.match(workspace.cwd, /worktree$/);
    assert.notEqual(workspace.cwd, cwd);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a ticket touching two RW Git repos writes only inside worktrees and accepts both", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-two-repos-"));
  const primary = join(dataDir, "repo-a");
  const extra = join(dataDir, "repo-b");
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    await writeFile(join(primary, "dirty-a.txt"), "seeded-a\n");
    await writeFile(join(extra, "dirty-b.txt"), "seeded-b\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const workspace = await ensureTicketWorktree({
      sourceCwd: primary, dataDir, ticket: { identifier: "TEXT-multi" }, runId: "run-1", access
    });
    const extraRepo = workspace.repositories.find((repo) => repo.id === access.extraRoots[0].id);
    assert.ok(extraRepo);
    assert.notEqual(extraRepo.cwd, extra);
    assert.equal(await readFile(join(workspace.cwd, "dirty-a.txt"), "utf8"), "seeded-a\n");
    assert.equal(await readFile(join(extraRepo.cwd, "dirty-b.txt"), "utf8"), "seeded-b\n");
    const policy = { ...access, repositories: workspace.repositories };
    const write = toolNamed(scopedWorkerTools(workspace.cwd, `root:primary:from-a.txt,root:${extraRepo.id}:from-b.txt`, policy), "write");
    await write.execute("a", { path: "from-a.txt", content: "worktree-a" });
    await write.execute("b", { path: join(extra, "from-b.txt"), content: "worktree-b" });
    assert.equal(await readFile(join(workspace.cwd, "from-a.txt"), "utf8"), "worktree-a");
    assert.equal(await readFile(join(extraRepo.cwd, "from-b.txt"), "utf8"), "worktree-b");
    await assert.rejects(readFile(join(primary, "from-a.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(extra, "from-b.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(primary, "dirty-a.txt"), "utf8"), "seeded-a\n");
    assert.equal(await readFile(join(extra, "dirty-b.txt"), "utf8"), "seeded-b\n");
    const mapped = await mapConfiguredPath(workspace.repositories, join(extra, "from-b.txt"), workspace.cwd);
    assert.equal(mapped, join(await realpath(extraRepo.cwd), "from-b.txt"));
    const primaryCommit = await commitWorkspace(workspace.cwd, "feat: change A");
    const extraCommit = await commitWorkspace(extraRepo.cwd, "feat: change B");
    assert.match(primaryCommit, /^[a-f0-9]{40}$/);
    assert.match(extraCommit, /^[a-f0-9]{40}$/);
    assert.match((await exec("git", ["status", "--porcelain"], { cwd: primary })).stdout, /dirty-a\.txt/);
    assert.doesNotMatch((await exec("git", ["status", "--porcelain"], { cwd: primary })).stdout, /from-a/);
    assert.match((await exec("git", ["status", "--porcelain"], { cwd: extra })).stdout, /dirty-b\.txt/);
    assert.doesNotMatch((await exec("git", ["status", "--porcelain"], { cwd: extra })).stdout, /from-b/);
    const run = { workspace, repositories: workspace.repositories };
    assert.equal(gitRepositoriesForStep(run).length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("parallel extra-root worktrees stay distinct from the run worktrees", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-parallel-extra-"));
  const primary = join(dataDir, "repo-a");
  const extra = join(dataDir, "repo-b");
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const workspace = await ensureTicketWorktree({
      sourceCwd: primary, dataDir, ticket: { identifier: "TEXT-par" }, runId: "run-1", access
    });
    const tree = await snapshotTree(workspace.cwd);
    const pairs = await createParallelWorktrees({
      sourceCwd: workspace.cwd, dataDir, ticket: { identifier: "TEXT-par" }, runId: "run-1",
      tree, steps: [{ id: "one" }, { id: "two" }], repositories: workspace.repositories
    });
    const workspaces = Object.fromEntries(pairs);
    assert.notEqual(workspaces.one.cwd, workspaces.two.cwd);
    const extraOne = workspaces.one.repositories.find((repo) => repo.id !== "primary");
    const extraTwo = workspaces.two.repositories.find((repo) => repo.id !== "primary");
    assert.ok(extraOne && extraTwo);
    assert.notEqual(extraOne.cwd, extraTwo.cwd);
    assert.notEqual(extraOne.cwd, extra);
    await writeFile(join(extraOne.cwd, "slice.txt"), "one\n");
    await assert.rejects(readFile(join(extraTwo.cwd, "slice.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(extra, "slice.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing frozen RW Git extra fails closed with its identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-missing-extra-"));
  const primary = join(dataDir, "repo-a");
  const extra = join(dataDir, "repo-b");
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    await rm(extra, { recursive: true, force: true });
    await assert.rejects(
      ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket: { identifier: "TEXT-missing" }, runId: "run-1", access }),
      new RegExp(`${access.extraRoots[0].id}.*repo-b`)
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
