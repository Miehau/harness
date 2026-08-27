import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acceptJjChange, beginJjChange, initializeJjWorkspace, prepareJjForGit, snapshotJjChange } from "../src/jj.js";
import { createZeroStateWorkspace, ensureTicketWorktree } from "../src/worktrees.js";

const exec = promisify(execFile);
const hasJj = await exec("jj", ["--version"]).then(() => true, () => false);

test("keeps a stable jj change id while revisions evolve and exports the accepted Git branch", { skip: !hasJj }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-jj-"));
  try {
    const sourceCwd = join(root, "source");
    await createZeroStateWorkspace({ cwd: sourceCwd, ticket: { identifier: "LOCAL-base" }, runId: "base" });
    const workspace = await ensureTicketWorktree({ sourceCwd, dataDir: root, ticket: { identifier: "JJ-change" }, runId: "run-1" });
    await initializeJjWorkspace(workspace.cwd);
    const started = await beginJjChange(workspace.cwd, { title: "Editable change" });
    await writeFile(join(workspace.cwd, "feature.txt"), "first\n");
    const first = await snapshotJjChange(workspace.cwd);
    await writeFile(join(workspace.cwd, "feature.txt"), "second\n");
    const second = await snapshotJjChange(workspace.cwd);
    assert.equal(first.changeId, started.changeId);
    assert.equal(second.changeId, started.changeId);
    assert.notEqual(first.commitId, second.commitId);

    const accepted = await acceptJjChange(workspace.cwd, {
      changeId: started.changeId,
      message: "feat: editable change\n\nWhy: Review should follow one stable change.",
      bookmark: workspace.branch
    });
    await prepareJjForGit(workspace.cwd, workspace.branch);
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    const status = (await exec("git", ["status", "--porcelain"], { cwd: workspace.cwd })).stdout;
    assert.equal(head, accepted.commitId);
    assert.equal(status, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
