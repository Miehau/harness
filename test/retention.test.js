import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { cleanupMergedRun, cleanupRetainedRun, retentionInventory, runRoot } from "../src/retention.js";

test("retention inventory reports archived and active disk usage", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-retention-"));
  const active = { id: "a", runId: "run-a", ticket: { identifier: "A-1", title: "Active", team: { name: "Web" } }, artifacts: [{ id: "1" }], status: "completed" };
  const archived = { id: "b", runId: "run-b", ticket: { identifier: "B-1", title: "Archived" }, artifacts: [], status: "completed" };
  try {
    await mkdir(runRoot(dataDir, active), { recursive: true });
    await writeFile(join(runRoot(dataDir, active), "artifact.txt"), "12345");
    const inventory = await retentionInventory({ ticketRuns: { a: active }, retainedRuns: { b: archived } }, dataDir);
    assert.equal(inventory.items.length, 2);
    assert.equal(inventory.items.find((item) => item.ticketId === "a").bytes, 5);
    assert.equal(inventory.items.find((item) => item.ticketId === "b").archived, true);
    assert.equal(inventory.totalBytes, 5);
  } finally { await rm(dataDir, { recursive: true }); }
});

test("manual cleanup removes only run-owned worktrees, branch, previews, and files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-cleanup-"));
  const calls = [];
  const previewPrefixes = [];
  const run = {
    id: "ticket", runId: "run-1", ticket: { identifier: "ABC-1" },
    workspace: { sourceCwd: "/repo", cwd: "", branch: "codex/abc" },
    plan: { nodes: [{ id: "step", type: "step", workspace: { cwd: "" } }] }
  };
  run.workspace.cwd = join(runRoot(dataDir, run), "worktree");
  run.plan.nodes[0].workspace.cwd = join(runRoot(dataDir, run), "parallel", "step");
  const previousCwd = join(runRoot(dataDir, run), "parallel", "previous", "step");
  const snapshotRef = "refs/agent-plan/coordination/run-1/revision-1/0";
  run.coordination = { revisions: [{ id: "revision-1", beforeWork: [{ workspace: { cwd: previousCwd } }], workPreparation: { repositories: [{ cwd: previousCwd, ref: snapshotRef }, { cwd: "/unrelated-repo", ref: snapshotRef }] } }] };
  await mkdir(run.workspace.cwd, { recursive: true });
  try {
    await cleanupRetainedRun({
      run, dataDir,
      previewManager: { stopMatching(prefix) { previewPrefixes.push(prefix); } },
      execImpl: async (command, args, options) => calls.push({ command, args, options })
    });
    assert.deepEqual(previewPrefixes, ["ticket:"]);
    assert.deepEqual(calls.map((call) => call.args), [
      ["update-ref", "-d", snapshotRef],
      ["worktree", "remove", "--force", previousCwd],
      ["worktree", "remove", "--force", join(runRoot(dataDir, run), "parallel", "step")],
      ["worktree", "remove", "--force", run.workspace.cwd],
      ["branch", "-D", "codex/abc"]
    ]);
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(runRoot(dataDir, run)).then(() => true, () => false)), false);
  } finally { await rm(dataDir, { recursive: true }); }
});

test("cleanup removes extra-root worktrees and branches without touching user sources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-cleanup-extra-"));
  const extraSource = join(dataDir, "user-extra");
  const calls = [];
  const run = {
    id: "ticket", runId: "run-1", ticket: { identifier: "ABC-1" },
    workspace: { sourceCwd: "/repo", cwd: "", branch: "codex/abc" },
    repositories: [
      { id: "primary", sourceCwd: "/repo", cwd: "", branch: "codex/abc" },
      { id: "r-extra", sourceCwd: extraSource, cwd: "", branch: "codex/abc-r-extra" }
    ]
  };
  run.workspace.cwd = join(runRoot(dataDir, run), "worktree");
  run.repositories[0].cwd = run.workspace.cwd;
  run.repositories[1].cwd = join(runRoot(dataDir, run), "repos", "r-extra", "worktree");
  await mkdir(run.workspace.cwd, { recursive: true });
  await mkdir(run.repositories[1].cwd, { recursive: true });
  await mkdir(extraSource, { recursive: true });
  await writeFile(join(extraSource, "keep.txt"), "user-source\n");
  try {
    await cleanupRetainedRun({
      run, dataDir,
      execImpl: async (command, args, options) => calls.push({ command, args, options })
    });
    const extraRemoves = calls.filter((call) => call.options.cwd === extraSource && call.args[0] === "worktree");
    const extraBranches = calls.filter((call) => call.options.cwd === extraSource && call.args[0] === "branch");
    assert.equal(extraRemoves.some((call) => call.args.includes(run.repositories[1].cwd)), true);
    assert.deepEqual(extraBranches.map((call) => call.args), [["branch", "-D", "codex/abc-r-extra"]]);
    assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(extraSource, "keep.txt"), "utf8")), "user-source\n");
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(runRoot(dataDir, run)).then(() => true, () => false)), false);
  } finally { await rm(dataDir, { recursive: true }); }
});


test("post-merge cleanup is durable, retryable, and never wipes unmerged runs", async () => {
  const run = { id: "ticket", runId: "run", status: "awaiting_evidence_review", deliveries: [{ status: "integrated", change: { url: "https://forge/pr/1" } }] };
  const data = { ticketRuns: { ticket: run } };
  const state = { read: () => structuredClone(data), update: async (fn) => fn(data) };
  let attempts = 0;
  const cleanup = async () => {
    assert.equal(run.retentionCleanup.status, "pending");
    if (++attempts === 1) throw new Error("disk temporarily unavailable");
    return { root: "/run-owned", runId: "run" };
  };
  const input = { state, ticketId: "ticket", dataDir: "/unused", cleanup };
  assert.equal(await cleanupMergedRun(input), null);
  run.status = "completed";
  assert.equal((await cleanupMergedRun(input)).status, "failed");
  assert.equal(run.status, "completed");
  assert.equal((await cleanupMergedRun(input)).status, "completed");
  assert.equal((await cleanupMergedRun(input)).removed.root, "/run-owned");
  assert.equal(attempts, 2);
  delete run.retentionCleanup;
  run.deliveries.push({ status: "failed" });
  assert.equal(await cleanupMergedRun(input), null);
  assert.equal(attempts, 2);
  run.deliveries.pop();
  run.retentionCleanup = { status: "retained" };
  assert.equal((await cleanupMergedRun(input)).status, "retained");
  assert.equal(attempts, 2);
});

test("cleanup resumes after a prior pass removed a coordination worktree", async () => {
  const run = { id: "ticket", runId: "run-1", ticket: { identifier: "ABC-1" }, coordination: { revisions: [{ id: "revision-1", workPreparation: { repositories: [{ cwd: "/data/ticket-runs/abc-1/runs/run-1/previous", ref: "refs/agent-plan/coordination/run-1/revision-1/0" }] } }] } };
  const removed = [];
  let attempts = 0;
  await cleanupRetainedRun({ run, dataDir: "/data", execImpl: async () => { attempts++; throw Object.assign(new Error("missing cwd"), { code: "ENOENT" }); }, rmImpl: async (path) => removed.push(path) });
  assert.equal(attempts, 1);
  assert.ok(removed.includes(runRoot("/data", run)));
});
