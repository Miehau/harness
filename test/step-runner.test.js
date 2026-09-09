import assert from "node:assert/strict";
import test from "node:test";
import { createStepRunner } from "../src/step-runner.js";

test("deferred artifact hydration cannot launch a worker for a replacement run", async () => {
  const step = {
    id: "step-1", type: "step", title: "Implement", status: "ready",
    permission: "write", writeScope: "src", attempts: [], expectedFiles: [], workspace: { cwd: "/nonexistent-step-runner-worktree" }
  };
  const source = {
    ticketRuns: {
      ticket: {
        runId: "run-1", status: "running", ticket: { id: "ticket" },
        workspace: { cwd: "/nonexistent-step-runner-worktree", vcs: "git" }, plan: { nodes: [step] },
        artifacts: [], activeRuns: {}, stages: [{ id: "implement", status: "pending" }], proofMap: { criteria: [] }, stageProfiles: { implementation: {} }
      }
    }
  };
  let releaseHydration;
  let hydrationStarted;
  const waiting = new Promise((resolve) => { releaseHydration = resolve; });
  const started = new Promise((resolve) => { hydrationStarted = resolve; });
  let launches = 0;
  const runner = createStepRunner({
    state: { read: () => source, update: async (change) => change(source) },
    runtime: { activeSteps: new Map() },
    worker: { async run() { launches++; }, async verifyStep() {}, async reviewWorkerReport() {}, async generateCommitMessage() {}, async evidenceImages() {} },
    checks: { async runChanged() {}, repositoryCheckReview() {} },
    proof: { async snapshot() {}, applyStep() {}, gate() { return { eligible: true }; }, gateError() {} },
    artifacts: { hydrate: async () => { hydrationStarted(); return waiting; }, async persist() {}, async text() {}, dataDir: "/tmp" },
    activity: { capture: () => ({ onEvent() {}, finish() {} }) },
    steering: { async drain() {}, clear() {} },
    repositories: { async snapshotRoots() { return {}; }, labelRootDiffs() { return []; } },
    lifecycle: { setStage() {}, async mirrorCheckpoint() {} },
    reviews: { retain: (value) => value }, attempts: { nextId: () => "attempt-1" }
  });

  const pending = runner.executeStep("ticket", "step-1");
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Hydration did not start: ${source.ticketRuns.ticket.lastError || "no error"}`)), 500))
  ]);
  source.ticketRuns.ticket = {
    ...source.ticketRuns.ticket,
    runId: "run-2",
    status: "waiting",
    activeRuns: {},
    plan: { nodes: [{ ...step, status: "ready", activeAttempt: null }] }
  };
  releaseHydration([]);
  await pending;

  assert.equal(launches, 0);
  assert.equal(source.ticketRuns.ticket.status, "waiting");
  assert.equal(source.ticketRuns.ticket.activeRuns["step-1"], undefined);
  assert.equal(source.ticketRuns.ticket.plan.nodes[0].activeAttempt, null);
});
