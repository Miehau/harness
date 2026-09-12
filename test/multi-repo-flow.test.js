import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { freezeRunAccess, normalizeProjectPolicy } from "../src/access-policy.js";
import { snapshotTree } from "../src/git.js";
import { scopedWorkerTools } from "../src/pi-harness.js";
import { normalizePlan } from "../src/plan.js";
import { createDaemon } from "../src/server.js";
import { commitWorkspace, createZeroStateWorkspace, ensureTicketWorktree } from "../src/worktrees.js";
import { invoke, mockHarness, runAgainstDaemon, seedRun } from "./helpers.js";

const exec = promisify(execFile);
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Multi-repo Flow",
  GIT_AUTHOR_EMAIL: "multi-repo@example.test",
  GIT_COMMITTER_NAME: "Multi-repo Flow",
  GIT_COMMITTER_EMAIL: "multi-repo@example.test"
};

async function waitForRun(daemon, ticketId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await invoke(daemon, "GET", `/api/tickets/${ticketId}/run`);
    if (last.status === 200 && predicate(last.json)) return last.json;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ticket ${ticketId}: ${last?.json?.status || last?.status} ${last?.json?.lastError || last?.text || ""}`);
}

async function initSourcedRepo(cwd) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await writeFile(join(cwd, "README.md"), "base\n");
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "-qm", "baseline"], { cwd, env: gitIdentity });
  const bare = await mkdtemp(join(tmpdir(), "agent-plan-origin-"));
  await exec("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare });
  await exec("git", ["remote", "add", "origin", bare], { cwd });
  await exec("git", ["push", "-q", "-u", "origin", "main"], { cwd });
  await exec("git", ["remote", "set-head", "origin", "main"], { cwd });
  return bare;
}

function fakeForge(label, { failCreate = () => false } = {}) {
  const creates = [];
  const merges = [];
  return {
    creates,
    merges,
    async create(input) {
      if (failCreate()) throw new Error(`${label} hosting failed`);
      creates.push(input);
      return {
        provider: "github",
        id: creates.length,
        url: `https://github.com/acme/${label}/pull/${creates.length}`,
        headSha: `head-${label}-${creates.length}`
      };
    },
    async status(change) {
      return {
        headSha: change.headSha || `head-${label}`,
        feedback: [],
        checks: "passed",
        mergeable: true,
        ready: true,
        mergeState: "clean",
        merged: false
      };
    },
    async merge(change) {
      merges.push(change);
      return { commit: `merged-${label}-${change.id}` };
    },
    comment: async () => ({})
  };
}

function criterionResults(proofMap, scope, stepId) {
  const criteria = proofMap?.criteria || [];
  const selected = stepId ? criteria.filter((criterion) => criterion.stepId === stepId) : criteria;
  return selected.map((criterion) => ({
    criterionId: criterion.id,
    status: "verified",
    explanation: { summary: "Canonical check passed." },
    evidence: [{ type: "check", scope, ...(stepId ? { stepId } : {}) }]
  }));
}

function lifecycleHarness({ writeFiles }) {
  return {
    ...mockHarness(),
    async runRepositoryChecks() {
      return { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed", output: "", evidence: [] };
    },
    async evidenceImages() { return []; },
    async updateProductContext() { return "# Product context\n\nBoth repositories.\n"; },
    async generateCommitMessage({ step }) {
      return `feat: ${step.title}\n\nWhy: multi-repo flow.\nRequirement: REQ-032`;
    },
    async verifyStep({ step, proofMap }) {
      return {
        summary: "ok",
        findings: [],
        criterionResults: criterionResults(proofMap, "step", step.id),
        rawOutput: "",
        sessionFile: null
      };
    },
    async reviewTicket({ role, proofMap }) {
      return {
        role,
        summary: `${role} passed`,
        findings: [],
        criterionResults: criterionResults(proofMap, "final")
      };
    },
    async runStep({ cwd, step, repositories, access }) {
      const write = scopedWorkerTools(cwd, step.writeScope, { ...access, repositories }).find((tool) => tool.name === "write");
      const files = writeFiles({ cwd, step, repositories, access }) || [];
      for (const [index, file] of files.entries()) {
        await write.execute(`write-${index}`, { path: file.path, content: file.content });
      }
      return {
        report: { status: "completed", summary: `${step.id} done`, artifact: "ok" },
        output: "ok",
        prompt: "p",
        rawOutput: "ok",
        sessionFile: null,
        reviewNotes: []
      };
    }
  };
}

test("one ticket changes A and B through mapped tools, proof, partial delivery, restart, and completion", { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-flow-ab-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-flow-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-flow-b-"));
  const bares = [];
  let daemon;
  let failB = true;
  try {
    bares.push(await initSourcedRepo(primary), await initSourcedRepo(extra));
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    const forgeA = fakeForge("repo-a");
    const mergeA = forgeA.merge;
    const inspectedHeads = [];
    let headChanged = false;
    forgeA.status = async () => {
      const headSha = headChanged ? "new-head" : "old-head";
      const checks = headChanged && inspectedHeads.at(-1) !== "new-head" ? "pending" : "passed";
      inspectedHeads.push(headSha);
      return { headSha, feedback: [], checks, mergeable: true, mergeState: "clean", merged: false };
    };
    forgeA.merge = async (change) => {
      if (!headChanged) {
        assert.equal(change.headSha, "old-head");
        headChanged = true;
        throw Object.assign(new Error("SHA does not match"), { status: 409 });
      }
      assert.equal(change.headSha, "new-head");
      assert.deepEqual(inspectedHeads, ["old-head", "new-head", "new-head"]);
      return mergeA(change);
    };
    const forgeB = fakeForge("repo-b", { failCreate: () => failB });
    const harness = lifecycleHarness({
      writeFiles({ repositories }) {
        const extraRepo = (repositories || []).find((repo) => repo.id === extraId);
        return [
          { path: "done-a.txt", content: "from-a\n" },
          extraRepo?.sourceCwd ? { path: join(extraRepo.sourceCwd, "done-b.txt"), content: "from-b\n" } : null
        ].filter(Boolean);
      }
    });
    let failTracker = true;
    let remoteLinkPosts = 0;
    const trackers = {
      async comment(_ticket, body) {
        if (body.startsWith("Remote review opened:")) {
          remoteLinkPosts++;
          if (failTracker) throw new Error("tracker outage after creation");
        }
        return { id: "c1" };
      },
      async transition() { return { type: "completed" }; }
    };
    const daemonOptions = {
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git", harness, trackers, deliveryPollMs: 5,
      deliveryForRemote(_remote, { repository } = {}) {
        return (repository?.id || "primary") === "primary" ? forgeA : forgeB;
      }
    };
    daemon = await createDaemon(daemonOptions);
    const ticket = {
      id: "flow-ab", identifier: "MEA-flow", title: "Ship A and B", description: "Two repos",
      source: "linear", provider: "linear", state: { name: "In Progress", type: "started" }
    };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    const plan = normalizePlan({
      title: "A and B",
      nodes: [{
        id: "one", title: "One", permission: "write",
        writeScope: `done-a.txt,root:${extraId}:done-b.txt`,
        expectedFiles: ["done-a.txt"], estimatedChangedLines: 4,
        acceptanceCriteria: ["A and B change through mapped tools"],
        requirementIds: ["REQ-032"]
      }]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });

    const selected = await runAgainstDaemon(daemon, ["select", id]);
    assert.equal(selected.code, 0, selected.stderr);
    const approved = await runAgainstDaemon(daemon, ["approve"]);
    assert.equal(approved.code, 0, approved.stderr);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "one");
    assert.equal(await readFile(join(workspace.cwd, "done-a.txt"), "utf8"), "from-a\n");
    assert.equal(await readFile(join(extraRepo.cwd, "done-b.txt"), "utf8"), "from-b\n");
    await assert.rejects(readFile(join(extra, "done-b.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(primary, "done-a.txt"), "utf8"), /ENOENT/);

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.code, 0, timeline.stderr);
    assert.match(JSON.stringify(timeline.json), /repo-b/);

    const accepted = await runAgainstDaemon(daemon, ["accept", "one", id]);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "evidence_review", 30_000);

    const packet = await invoke(daemon, "GET", `/api/tickets/${id}/review-packet`);
    assert.equal(packet.status, 200, packet.text);
    assert.equal((packet.json.repositories || []).length >= 2, true, JSON.stringify(packet.json.repositories));

    // Final proof binds the exact content reviewed in each delivery repository.
    // Restore the same bytes after each rejection so the existing partial-delivery
    // retry below still exercises its original A-success/B-failure journey.
    await writeFile(join(workspace.cwd, "done-a.txt"), "changed-after-proof-a\n");
    const stalePrimary = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(stalePrimary.status, 400, stalePrimary.text);
    assert.match(stalePrimary.json.error, /Final proof is stale: repository primary changed after review/);
    await writeFile(join(workspace.cwd, "done-a.txt"), "from-a\n");
    await writeFile(join(extraRepo.cwd, "done-b.txt"), "changed-after-proof-b\n");
    const staleExtra = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(staleExtra.status, 400, staleExtra.text);
    assert.match(staleExtra.json.error, new RegExp(`Final proof is stale: repository ${extraId} changed after review`));
    await writeFile(join(extraRepo.cwd, "done-b.txt"), "from-b\n");

    const proof = await runAgainstDaemon(daemon, ["approve-proof", id]);
    assert.equal(proof.code, 0, proof.stderr);
    await waitForRun(daemon, id, (run) => run.status === "needs_attention" || run.status === "completed", 20_000);
    let stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.status, "needs_attention", stored.lastError);
    assert.match(stored.lastError, /tracker outage after creation/);
    assert.equal(forgeA.creates.length, 1);
    assert.equal(forgeA.merges.length, 0);
    const savedChange = stored.deliveries.find((item) => item.repositoryId === "primary").change;
    assert.equal(savedChange.url, "https://github.com/acme/repo-a/pull/1");
    assert.equal(stored.deliveries[0].externalActionPending, null);
    await daemon.close({ exit: false });
    await daemon.store.queue;
    failTracker = false;
    daemon = await createDaemon(daemonOptions);
    assert.deepEqual(daemon.store.read().ticketRuns[id].deliveries[0].change, savedChange);
    const retryTracker = await runAgainstDaemon(daemon, ["resume", id]);
    assert.equal(retryTracker.code, 0, retryTracker.stderr);
    await waitForRun(daemon, id, (run) => run.status === "needs_attention" && /hosting failed/.test(run.lastError || "") && daemon.store.read().ticketRuns[id].deliveries.find((item) => item.repositoryId === "primary")?.status === "integrated", 20_000);
    stored = daemon.store.read().ticketRuns[id];
    assert.equal(remoteLinkPosts, 2);
    assert.ok(stored.trackerEvents["remote_change:primary"]);
    assert.equal(forgeA.creates.length, 1);
    assert.equal(forgeA.merges.length, 1);
    assert.equal(forgeB.creates.length, 0);
    assert.equal((stored.deliveries || []).find((item) => item.repositoryId === "primary")?.status, "integrated");
    assert.equal((stored.deliveries || []).find((item) => item.repositoryId === extraId)?.status, "failed");
    assert.match(stored.lastError || "", /repo-b|hosting failed/);

    await daemon.close({ exit: false });
    await daemon.store.queue;
    failB = false;
    daemon = await createDaemon(daemonOptions);
    const resumed = await runAgainstDaemon(daemon, ["resume", id]);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitForRun(daemon, id, (run) => run.status === "completed", 20_000);
    stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.status, "completed", stored.lastError);
    assert.equal(forgeA.creates.length, 1);
    assert.equal(forgeB.creates.length, 1);
    assert.equal(forgeB.merges.length, 1);
    assert.equal((stored.deliveries || []).find((item) => item.repositoryId === extraId)?.status, "integrated");
  } finally {
    try { await daemon?.close({ exit: false }); } catch {}
    try { await daemon?.store?.queue; } catch {}
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    await rm(primary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    await rm(extra, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    for (const bare of bares) await rm(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  }
});

test("Any-access writes outside configured roots are reviewable and never auto-delivered", { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-flow-any-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-flow-any-a-"));
  const external = await mkdtemp(join(tmpdir(), "agent-plan-flow-any-ext-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-any" }, runId: "base" });
    await writeFile(join(external, "outside.txt"), "before\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({ mode: "any", extraRoots: [] }, { primaryCwd: primary })
    });
    const harness = lifecycleHarness({
      writeFiles() {
        return [
          { path: "shipped.txt", content: "from-primary\n" },
          { path: join(external, "after-external.txt"), content: "after-external\n" }
        ];
      }
    });
    daemon = await createDaemon({
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git", harness
    });
    const ticket = {
      id: "flow-any", identifier: "LOCAL-any", title: "External write",
      source: "local", state: { name: "Local", type: "local" }
    };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const plan = normalizePlan({
      title: "External",
      nodes: [{
        id: "one", title: "One", permission: "write",
        writeScope: `shipped.txt,${external}`,
        expectedFiles: ["shipped.txt"], estimatedChangedLines: 4,
        acceptanceCriteria: ["External Any-access write is reviewable"],
        requirementIds: ["REQ-026"]
      }]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "one");
    assert.equal(await readFile(join(external, "after-external.txt"), "utf8"), "after-external\n");
    assert.equal(await readFile(join(external, "outside.txt"), "utf8"), "before\n");


    const accepted = await invoke(daemon, "POST", `/api/tickets/${id}/steps/one/accept`, { body: {} });
    assert.equal(accepted.status, 202, accepted.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "evidence_review", 30_000);
    const proof = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(proof.status, 200, proof.text);
    const completed = await waitForRun(daemon, id, (run) => run.status === "completed" || run.status === "needs_attention", 20_000);
    assert.equal(completed.status, "completed", completed.lastError);
    const stored = daemon.store.read().ticketRuns[id];
    const deliveryIds = (stored.deliveries || []).map((item) => item.repositoryId);
    const deliveryCwds = (stored.deliveries || []).map((item) => item.sourceCwd).filter(Boolean);
    assert.equal(deliveryIds.every((item) => item === "primary"), true, JSON.stringify(stored.deliveries));
    const externalReal = await realpath(external);
    assert.equal(deliveryCwds.some((cwd) => cwd === external || cwd === externalReal), false);
    assert.equal(stored.merge?.status, "integrated");
    assert.equal(await readFile(join(external, "after-external.txt"), "utf8"), "after-external\n");
  } finally {
    try { await daemon?.close({ exit: false }); } catch {}
    try { await daemon?.store?.queue; } catch {}
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    await rm(primary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    await rm(external, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  }
});
