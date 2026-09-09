import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { snapshotTree } from "../src/git.js";
import { normalizePlan } from "../src/plan.js";
import { createParallelWorktrees, createZeroStateWorkspace } from "../src/worktrees.js";
import { prepareRevisionWork } from "../src/coordination-workspaces.js";

const exec = promisify(execFile);
async function fixture(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-revision-work-"));
  try {
    const ticket = { id: "local-revision", identifier: "LOCAL-revision" };
    const workspace = await createZeroStateWorkspace({ cwd: join(dataDir, "repo"), ticket, runId: "test" });
    await writeFile(join(workspace.cwd, "work.txt"), "baseline\n");
    const baseTree = await snapshotTree(workspace.cwd);
    const run = { id: ticket.id, runId: "test", ticket, workspace, planRevision: 1, plan: normalizePlan({ nodes: [{ id: "work", title: "Work", permission: "write", writeScope: "work.txt,new.bin" }] }) };
    Object.assign(run.plan.nodes[0], { baseTree, baseTrees: { primary: baseTree }, status: "interrupted" });
    const revision = { id: "revision-test", status: "proposed", baseRevision: 1, affectedStepIds: ["work"] };
    await fn({ dataDir, run, revision, cwd: workspace.cwd });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("revision preservation saves unfinished binary work before restoring scoped shared changes", async () => fixture(async ({ dataDir, run, revision, cwd }) => {
  run.plan.nodes[0].writeScope += ",.agent-plan";
  await writeFile(join(cwd, "work.txt"), "unfinished\n");
  await writeFile(join(cwd, "new.bin"), Buffer.from([0, 255, 1, 254]));
  await writeFile(join(cwd, "accepted.txt"), "unrelated accepted work\n");
  await mkdir(join(cwd, ".agent-plan"));
  await writeFile(join(cwd, ".agent-plan", "verify.mjs"), "unfinished verification contract\n");
  const states = [];
  const prepared = await prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => {
    states.push(journal.status);
    if (journal.status === "captured") assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "unfinished\n");
    revision.workPreparation = journal;
  } });
  assert.deepEqual(states, ["captured", "prepared"]);
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "baseline\n");
  assert.equal(await readFile(join(cwd, "accepted.txt"), "utf8"), "unrelated accepted work\n");
  await assert.rejects(readFile(join(cwd, "new.bin")), /ENOENT/);
  await assert.rejects(readFile(join(cwd, ".agent-plan", "verify.mjs")), /ENOENT/);
  const saved = prepared.repositories[0];
  assert.match(await readFile(saved.artifact.path, "utf8"), /GIT binary patch/);
  const recovered = await exec("git", ["show", `${saved.ref}:new.bin`], { cwd, encoding: "buffer" });
  assert.deepEqual(recovered.stdout, Buffer.from([0, 255, 1, 254]));
  await prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => { revision.workPreparation = journal; } });
  assert.equal(await readFile(join(cwd, "accepted.txt"), "utf8"), "unrelated accepted work\n");
}));

test("capture persistence failure never restores work and interrupted completion retries safely", async () => fixture(async ({ dataDir, run, revision, cwd }) => {
  await writeFile(join(cwd, "work.txt"), "unfinished\n");
  await assert.rejects(prepareRevisionWork({ run, revision, dataDir, persist: async () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "unfinished\n");
  await assert.rejects(prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => {
    if (journal.status === "prepared") throw new Error("interrupted write");
    revision.workPreparation = journal;
  } }), /interrupted write/);
  assert.equal(revision.workPreparation.status, "captured");
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "baseline\n");
  await prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => { revision.workPreparation = journal; } });
  assert.equal(revision.workPreparation.status, "prepared");
}));

test("parked isolated work remains inspectable and retry refuses unexpected new shared edits", async () => fixture(async ({ dataDir, run, revision, cwd }) => {
  const workspaces = await createParallelWorktrees({ sourceCwd: cwd, dataDir, ticket: run.ticket, runId: run.runId, tree: run.plan.nodes[0].baseTree, steps: [run.plan.nodes[0]] });
  run.plan.nodes[0].workspace = Object.fromEntries(workspaces).work;
  const isolated = run.plan.nodes[0].workspace.cwd;
  await writeFile(join(isolated, "work.txt"), "isolated unfinished\n");
  const prepared = await prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => { revision.workPreparation = journal; } });
  assert.equal(prepared.repositories[0].isolated, true);
  assert.equal(await readFile(join(isolated, "work.txt"), "utf8"), "isolated unfinished\n");
  delete revision.workPreparation;
  delete run.plan.nodes[0].workspace;
  await assert.rejects(prepareRevisionWork({ run, revision, dataDir, persist: async (journal) => {
    revision.workPreparation = journal;
    if (journal.status === "captured") await writeFile(join(cwd, "work.txt"), "new external work\n");
  } }), /Workspace changed/);
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "new external work\n");
}));


test("revision preservation refuses active independent workers sharing a Git workspace", async () => fixture(async ({ dataDir, run, revision, cwd }) => {
  run.plan.nodes.push({ id: "independent", permission: "write", writeScope: "elsewhere", status: "running" });
  await assert.rejects(prepareRevisionWork({ run, revision, dataDir, persist: async () => assert.fail("must not persist") }), /Stop worker sharing revision workspace/);
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "baseline\n");
}));
