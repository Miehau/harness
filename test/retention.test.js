import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { cleanupRetainedRun, retentionInventory, runRoot } from "../src/retention.js";

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
  await mkdir(run.workspace.cwd, { recursive: true });
  try {
    await cleanupRetainedRun({
      run, dataDir,
      previewManager: { stopMatching(prefix) { previewPrefixes.push(prefix); } },
      execImpl: async (command, args, options) => calls.push({ command, args, options })
    });
    assert.deepEqual(previewPrefixes, ["ticket:"]);
    assert.deepEqual(calls.map((call) => call.args), [
      ["worktree", "remove", "--force", join(runRoot(dataDir, run), "parallel", "step")],
      ["worktree", "remove", "--force", run.workspace.cwd],
      ["branch", "-D", "codex/abc"]
    ]);
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(runRoot(dataDir, run)).then(() => true, () => false)), false);
  } finally { await rm(dataDir, { recursive: true }); }
});
