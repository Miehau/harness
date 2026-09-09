import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTicketRunner } from "../src/ticket-runner.js";
import { proposePlanRevision, acceptPlanRevision } from "../src/coordination.js";
import { createZeroStateWorkspace } from "../src/worktrees.js";
import { initializeProofMap } from "../src/proof-map.js";
import { normalizePlan, findNode } from "../src/plan.js";
import { invoke, mockHarness, sampleTicket, seedRun, waitFor, withDaemon } from "./helpers.js";

const exec = promisify(execFile);
const report = (artifact) => ({ prompt: "mock prompt", rawOutput: artifact, output: artifact, sessionFile: null, reviewNotes: [], report: { status: "completed", summary: artifact, artifact } });

test("parallel workers pause selectively, reject late reports, and resume the accepted revision with durable decisions", { timeout: 20000 }, async () => {
  const inputs = new Map();
  let releaseFirst, releaseOther, releaseResumed;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const other = new Promise((resolve) => { releaseOther = resolve; });
  const resumed = new Promise((resolve) => { releaseResumed = resolve; });
  let oneCalls = 0;
  const verified = [];
  const harness = {
    ...mockHarness(),
    async runStep(input) {
      const { step, ticketId, runId, attemptId, onSessionActive, onSessionInactive } = input;
      const target = { ticketId, runId, stepId: step.id, attemptId };
      await onSessionActive(target);
      const name = step.id === "one" && ++oneCalls > 1 ? "resumed" : step.id;
      inputs.set(name, input);
      await (name === "one" ? first : name === "other" ? other : resumed);
      await onSessionInactive(target);
      const result = report(name === "one" ? "STALE REPORT MUST NOT ADVANCE" : `${name} complete`);
      if (name === "resumed") Object.assign(result.report, { status: "needs_input", request: "Confirm interface compatibility" });
      return result;
    },
    async runRepositoryChecks() { return { status: "passed", command: "mock verify", summary: "Passed", output: "Passed", evidence: [] }; },
    async verifyStep({ step, proofMap }) { verified.push(step.id); return { summary: "Verified", findings: [], criterionResults: (proofMap?.criteria || []).filter((item) => item.stepId === step.id).map((item) => ({ criterionId: item.id, status: "verified", explanation: { summary: "Mock check passed" }, evidence: [{ type: "check", scope: "step", stepId: step.id }] })), rawOutput: "Verified", sessionFile: null }; },
    async generateCommitMessage() { return "test: coordinate work\n\nWhy: preserve agreements\nRequirement: coordination"; },
    async evidenceImages() { return []; }
  };
  await withDaemon(async (daemon, { cwd }) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd });
    await writeFile(join(cwd, "README.md"), "Coordination fixture\n");
    await exec("git", ["add", "README.md"], { cwd });
    await exec("git", ["-c", "user.name=Coordination Test", "-c", "user.email=coordination@example.test", "commit", "-qm", "baseline"], { cwd });
    const plan = normalizePlan({ title: "Coordinate peers", nodes: [{ id: "parallel", type: "group", title: "Parallel work", children: [
      { id: "one", title: "Shared interface", permission: "write", writeScope: "one.txt", expectedFiles: ["one.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["Preserve the shared interface"] },
      { id: "other", title: "Independent analysis", permission: "write", writeScope: "other.txt", expectedFiles: ["other.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["Report independent analysis"] }
    ] }] });
    const id = await seedRun(daemon, { ticket: sampleTicket({ source: "local" }), status: "paused", plan, proofMap: initializeProofMap(plan), workspace: { cwd, vcs: "git", branch: "main" }, activeRuns: {} });
    const run = () => daemon.store.read().ticketRuns[id];
    const post = (path, body = {}) => invoke(daemon, "POST", `/api/tickets/${id}/${path}`, { body });
    try {
      let launchResponse;
      const launch = post("resume").then((value) => { launchResponse = value; return value; });
      await waitFor(() => { assert.ok(inputs.has("one") && inputs.has("other"), run().lastError || JSON.stringify({ launchResponse, status: run().status, checkpoint: run().checkpoint, started: [...inputs.keys()] })); }, { timeoutMs: 5000 });
      const original = inputs.get("one");
      assert.equal(findNode(run().plan, "one").activeAttempt.planRevision, 1);
      const conflict = await original.coordination.reportConflict({ summary: "The interface agreement needs a revised assignment", stepIds: ["one"], proposal: "Keep the existing signature and narrow the assignment" });
      assert.equal(original.signal.aborted, true);
      assert.equal(inputs.get("other").signal.aborted, false);
      releaseOther();
      await waitFor(() => assert.equal(findNode(run().plan, "other").status, "review_ready", run().lastError), { timeoutMs: 5000 });
      assert.ok(run().activeRuns.one, "affected worker remains bound until its late result settles");
      releaseFirst();
      await waitFor(() => assert.equal(run().activeRuns.one, undefined), { timeoutMs: 5000 });
      assert.equal((await launch).status, 202);
      assert.equal(findNode(run().plan, "one").status, "interrupted");
      assert.deepEqual(verified, ["other"]);
      assert.equal(run().artifacts.some((item) => item.stepId === "one" && item.kind === "agent-output"), false);
      const proposal = await post("coordination/revisions", { reason: "Keep existing signature; clarify interface ownership", changes: [{ stepId: "one", description: "Review the existing shared interface only" }], conflictIds: [conflict.id] });
      assert.equal(proposal.status, 200, proposal.text);
      const accepted = await post(`coordination/revisions/${proposal.json.id}/accept`);
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(run().planRevision, 2);
      assert.equal(findNode(run().plan, "other").status, "review_ready");
      let acceptanceResponse;
      const otherAccepted = post("steps/other/accept").then((value) => { acceptanceResponse = value; return value; });
      await waitFor(() => assert.ok(inputs.has("resumed"), run().lastError || JSON.stringify({ acceptanceResponse, status: run().status, checkpoint: run().checkpoint })), { timeoutMs: 5000 });
      const newInput = inputs.get("resumed");
      assert.notEqual(newInput.attemptId, original.attemptId);
      assert.equal(newInput.coordination.context.planRevision, 2);
      assert.match(newInput.coordination.context.decisions.at(-1).summary, /Keep existing signature/);
      assert.equal(newInput.step.description, "Review the existing shared interface only");
      assert.equal(findNode(run().plan, "one").activeAttempt.planRevision, 2);
      releaseResumed();
      assert.equal((await otherAccepted).status, 202);
      await waitFor(() => assert.equal(findNode(run().plan, "one").status, "needs_input", run().lastError), { timeoutMs: 5000 });
    } finally { releaseFirst(); releaseOther(); releaseResumed(); }
  }, { harness });
});

test("workspace adoption discards a batch prepared before an accepted plan revision", { timeout: 15000 }, async () => {
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    const ticket = sampleTicket({ source: "local" });
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const plan = normalizePlan({ nodes: [{ id: "pair", type: "group", title: "Parallel work", children: [
      { id: "one", title: "First", permission: "write", writeScope: "one.txt", expectedFiles: ["one.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["First outcome"] },
      { id: "two", title: "Second", permission: "write", writeScope: "two.txt", expectedFiles: ["two.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["Second outcome"] }
    ] }] });
    const id = await seedRun(daemon, { ticket, workspace, status: "running", plan, activeRuns: {} });
    let injected = false;
    const launched = [];
    const runner = createTicketRunner({
      state: {
        read: () => daemon.store.read(),
        update: (mutate) => daemon.store.update((state) => {
          if (!injected) {
            // The first update adopts worktrees after their asynchronous creation.
            // Commit a revision immediately before that old adoption callback runs.
            injected = true;
            const run = state.ticketRuns[id];
            const revision = proposePlanRevision(run, { reason: "Revise before launch", changes: [{ stepId: "one", description: "Use the revised assignment" }] });
            acceptPlanRevision(run, revision.id);
          }
          return mutate(state);
        })
      },
      runtime: {}, dataDir,
      lifecycle: { mirrorCheckpoint: async () => {} }, tracker: {},
      steps: { execute: async (_id, stepId) => {
        const run = daemon.store.read().ticketRuns[id];
        const step = findNode(run.plan, stepId);
        launched.push({ stepId, planRevision: run.planRevision, cwd: step.workspace.cwd });
      } },
      finalReview: {}, delivery: {}, artifacts: {}, proof: {}
    });
    await runner.advanceTicket(id, new AbortController().signal);
    assert.equal(injected, true);
    assert.equal(launched.length, 2);
    for (const entry of launched) {
      assert.equal(entry.planRevision, 2);
      assert.match(entry.cwd, /revision-2/, "no revised worker may adopt the old worktree");
    }
  });
});
