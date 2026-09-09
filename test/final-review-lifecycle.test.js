import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { recoverableCleanReview } from "../src/execution.js";
import { createFinalReviewRunner } from "../src/final-review.js";

const runFile = promisify(execFile);

function stages() {
  return ["implement", "verify", "handoff"].map((id) => ({ id, status: "pending", summary: "" }));
}

function setStage(run, id, status, summary) {
  return Object.assign(run.stages.find((stage) => stage.id === id), { status, summary });
}

test("recoverable clean reviews retain their covered proof revision", () => {
  const proofRevision = { version: 1, repositories: { primary: "a".repeat(40) }, roots: {} };
  assert.deepEqual(recoverableCleanReview({
    reviews: [{ round: 2, actionableFindings: [], diff: { files: [] }, proofRevision, reviews: [{ role: "deterministic", checks: { status: "passed" } }] }]
  }), { round: 2, checks: { status: "passed" }, diff: { files: [] }, proofRevision });
});

test("late fixer callbacks cannot adopt a result after the same review restarts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-final-review-"));
  const finding = { severity: "high", category: "tests", claim: "The final regression is missing", suggestedFix: "Add the regression", evidence: [{ file: "src/app.js", line: 1 }] };
  const run = {
    id: "ticket-1", runId: "run-1", ticket: { id: "ticket-1", identifier: "LOCAL-1", source: "local" },
    workspace: { cwd: dataDir }, repositories: [], plan: { nodes: [] }, artifacts: [], stages: stages(),
    stageProfiles: { implementation: {}, verification: {} }, reviews: [{
      round: 1, reviewId: "final-review-1", actionableFindings: [finding],
      finalChecks: { status: "passed", evidence: [] }, reviews: []
    }]
  };
  const state = { ticketRuns: { "ticket-1": run } };
  let onSessionFile;
  let settleWorker;
  const workerDone = new Promise((resolve) => { settleWorker = resolve; });
  const runner = createFinalReviewRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    checks: { runChanged: async () => ({ status: "passed", evidence: [] }), repositoryCheckReview: () => ({}) },
    worker: {
      run: async (input) => { onSessionFile = input.onSessionFile; return workerDone; },
      updateProductContext: async () => "", evidenceImages: async () => [], reviewTicket: async () => ({})
    },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    artifacts: { dataDir, hydrate: async (items) => items },
    proof: { gate: () => ({ eligible: false }), gateError: () => "", snapshot: async () => {} },
    repositories: { snapshotRoots: async () => ({}), labelRootDiffs: () => [], baselines: () => ({}) },
    reviews: { retain: (value) => value, sequence: (value) => value.finalReviewSequence || 0 },
    lifecycle: { setStage }
  });
  const loop = runner.finalReviewLoop("ticket-1", new AbortController().signal);
  while (!onSessionFile) await new Promise((resolve) => setImmediate(resolve));

  run.reviews[0].fix = { fixerId: "replacement-fixer", sessionFile: "/replacement.jsonl" };
  run.status = "interrupted";
  await onSessionFile("/stale.jsonl");
  settleWorker({ report: { status: "completed", summary: "stale success" }, output: "stale output", sessionFile: "/stale.jsonl" });
  assert.deepEqual(await loop, { kind: "blocked" });

  assert.deepEqual(run.reviews[0].fix, { fixerId: "replacement-fixer", sessionFile: "/replacement.jsonl" });
  assert.equal(run.status, "interrupted");
  assert.equal(run.artifacts.some((artifact) => artifact.kind === "review-fix"), false);
});

test("a mutation while independent reviewers await cannot create an approval checkpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-final-proof-"));
  await runFile("git", ["init", "-q"], { cwd: dataDir });
  await writeFile(join(dataDir, "app.txt"), "before\n");
  const run = {
    id: "ticket-1", runId: "run-1", ticket: { id: "ticket-1", identifier: "LOCAL-1", source: "local" },
    workspace: { cwd: dataDir }, repositories: [{ id: "primary", kind: "primary", cwd: dataDir }],
    access: { mode: "restricted", extraRoots: [] }, plan: { nodes: [] }, artifacts: [], stages: stages(),
    stageProfiles: { implementation: {}, verification: {} }, reviews: []
  };
  const state = { ticketRuns: { "ticket-1": run } };
  const reviewers = [];
  const runner = createFinalReviewRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    checks: {
      runChanged: async () => ({ status: "passed", command: "test", summary: "passed", evidence: [] }),
      repositoryCheckReview: () => ({ role: "deterministic", findings: [] })
    },
    worker: {
      run: async () => { throw new Error("fixer should not run"); }, updateProductContext: async () => "", evidenceImages: async () => [],
      reviewTicket: async ({ role }) => new Promise((resolve) => reviewers.push(() => resolve({ role, findings: [], criterionResults: [] })))
    },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    artifacts: { dataDir, hydrate: async (items) => items },
    proof: { gate: () => ({ eligible: true }), gateError: () => "", snapshot: async () => {} },
    repositories: { snapshotRoots: async () => ({}), labelRootDiffs: () => [], baselines: () => ({}) },
    reviews: { retain: (value) => value, sequence: (value) => value.finalReviewSequence || 0 },
    lifecycle: { setStage }
  });
  const loop = runner.finalReviewLoop("ticket-1", new AbortController().signal);
  while (reviewers.length < 3) await new Promise((resolve) => setImmediate(resolve));
  await writeFile(join(dataDir, "app.txt"), "after\n");
  for (const resolve of reviewers) resolve();

  await assert.rejects(loop, /Final proof is stale: repository primary changed after review/);
  assert.equal(run.checkpoint, null);
  assert.notEqual(run.status, "awaiting_evidence_review");
});

test("late reviewer results cannot replace a newer run checkpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-final-replacement-"));
  await runFile("git", ["init", "-q"], { cwd: dataDir });
  await writeFile(join(dataDir, "app.txt"), "baseline\n");
  const run = {
    id: "ticket-1", runId: "run-1", ticket: { id: "ticket-1", identifier: "LOCAL-1", source: "local" },
    workspace: { cwd: dataDir }, repositories: [{ id: "primary", kind: "primary", cwd: dataDir }],
    access: { mode: "restricted", extraRoots: [] }, plan: { nodes: [] }, artifacts: [], stages: stages(),
    stageProfiles: { implementation: {}, verification: {} }, reviews: []
  };
  const state = { ticketRuns: { "ticket-1": run } };
  const reviewers = [];
  const runner = createFinalReviewRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    checks: { runChanged: async () => ({ status: "passed", evidence: [] }), repositoryCheckReview: () => ({ role: "deterministic", findings: [] }) },
    worker: {
      run: async () => { throw new Error("fixer should not run"); }, updateProductContext: async () => "", evidenceImages: async () => [],
      reviewTicket: async ({ role }) => new Promise((resolve) => reviewers.push(() => resolve({ role, findings: [], criterionResults: [] })))
    },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    artifacts: { dataDir, hydrate: async (items) => items },
    proof: { gate: () => ({ eligible: true }), gateError: () => "", snapshot: async () => {} },
    repositories: { snapshotRoots: async () => ({}), labelRootDiffs: () => [], baselines: () => ({}) },
    reviews: { retain: (value) => value, sequence: (value) => value.finalReviewSequence || 0 }, lifecycle: { setStage }
  });
  const loop = runner.finalReviewLoop("ticket-1", new AbortController().signal);
  while (reviewers.length < 3) await new Promise((resolve) => setImmediate(resolve));
  const replacement = { ...run, runId: "run-2", status: "awaiting_approval", checkpoint: { kind: "awaiting_approval", title: "New plan" }, artifacts: [], reviews: [] };
  state.ticketRuns["ticket-1"] = replacement;
  for (const resolve of reviewers) resolve();

  assert.deepEqual(await loop, { kind: "superseded", ticketId: "ticket-1" });
  assert.deepEqual(replacement.checkpoint, { kind: "awaiting_approval", title: "New plan" });
  assert.equal(replacement.reviews.length, 0);
});

test("cancelled review results cannot overwrite the cancellation checkpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-final-cancel-"));
  await runFile("git", ["init", "-q"], { cwd: dataDir });
  await writeFile(join(dataDir, "app.txt"), "baseline\n");
  const run = {
    id: "ticket-1", runId: "run-1", ticket: { id: "ticket-1", identifier: "LOCAL-1", source: "local" },
    workspace: { cwd: dataDir }, repositories: [{ id: "primary", kind: "primary", cwd: dataDir }],
    access: { mode: "restricted", extraRoots: [] }, plan: { nodes: [] }, artifacts: [], stages: stages(),
    stageProfiles: { implementation: {}, verification: {} }, reviews: []
  };
  const state = { ticketRuns: { "ticket-1": run } };
  const reviewers = [];
  const runner = createFinalReviewRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    checks: { runChanged: async () => ({ status: "passed", evidence: [] }), repositoryCheckReview: () => ({ role: "deterministic", findings: [] }) },
    worker: {
      run: async () => { throw new Error("fixer should not run"); }, updateProductContext: async () => "", evidenceImages: async () => [],
      reviewTicket: async ({ role }) => new Promise((resolve) => reviewers.push(() => resolve({ role, findings: [], criterionResults: [] })))
    },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    artifacts: { dataDir, hydrate: async (items) => items },
    proof: { gate: () => ({ eligible: true }), gateError: () => "", snapshot: async () => {} },
    repositories: { snapshotRoots: async () => ({}), labelRootDiffs: () => [], baselines: () => ({}) },
    reviews: { retain: (value) => value, sequence: (value) => value.finalReviewSequence || 0 }, lifecycle: { setStage }
  });
  const controller = new AbortController();
  const loop = runner.finalReviewLoop("ticket-1", controller.signal);
  while (reviewers.length < 3) await new Promise((resolve) => setImmediate(resolve));
  run.status = "interrupted";
  run.checkpoint = { kind: "cancelled", title: "Cancelled" };
  controller.abort();
  for (const resolve of reviewers) resolve();

  assert.deepEqual(await loop, { kind: "aborted", ticketId: "ticket-1" });
  assert.deepEqual(run.checkpoint, { kind: "cancelled", title: "Cancelled" });
  assert.equal(run.reviews.length, 0);
});
