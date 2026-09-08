import test from "node:test";
import assert from "node:assert/strict";
import { initialStages, rewindRun } from "../src/execution.js";
import { normalizePlan } from "../src/plan.js";
import { initializeProofMap } from "../src/proof-map.js";

function run() {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "One", acceptanceCriteria: ["One works"], status: "accepted", baseTree: "base" },
    { id: "two", title: "Two", acceptanceCriteria: ["Two works"], status: "accepted", baseTree: "base" }
  ] });
  for (const step of plan.nodes) Object.assign(step, { status: "accepted", baseTree: "base" });
  const proofMap = initializeProofMap(plan);
  for (const criterion of proofMap.criteria) Object.assign(criterion.current, { status: "verified", evidenceValidity: "valid" });
  return { plan, proofMap, stages: initialStages(), baselineTree: "base", status: "awaiting_evidence_review", reviews: [] };
}

test("rewinds stale restored proof and archives proof before a redesign", () => {
  const restarted = run();
  rewindRun(restarted, "step:one", "2026-09-10T12:00:00.000Z");
  assert.deepEqual(restarted.proofMap.criteria.map((item) => item.current.evidenceValidity), ["stale", "stale"]);
  assert.ok(restarted.proofMap.criteria.every((item) => item.history.at(-1).evidenceValidity === "valid"));

  const redesigned = run();
  rewindRun(redesigned, "stage:design", "2026-09-10T12:00:00.000Z");
  assert.equal(redesigned.proofMap, undefined);
  assert.equal(redesigned.proofMapHistory[0].proofMap.criteria.length, 2);
});

test("archives rewound attempt evidence and reserves its attempt ID", () => {
  const restarted = run();
  const step = restarted.plan.nodes[0];
  step.attempts = [{ attemptId: "attempt-1", verification: { checks: { status: "passed", output: "original" } }, diff: { available: true, patch: "original delta", files: ["one.js"] } }];
  restarted.proofMap.criteria[0].current.evidence = [{ type: "check", scope: "attempt", stepId: "one", attemptId: "attempt-1", validity: "valid" }];

  rewindRun(restarted, "step:one", "2026-09-10T12:00:00.000Z");

  assert.equal(step.attempts.length, 0);
  assert.equal(step.attemptSequence, 1);
  assert.equal(restarted.archivedAttempts[0].verification.checks.output, "original");
  assert.equal(restarted.proofMap.criteria[0].history.at(-1).evidence[0].attemptId, "attempt-1");
});

test("verification restart stales every accepted criterion", () => {
  const restarted = run();
  rewindRun(restarted, "stage:verify", "2026-09-10T12:00:00.000Z");
  assert.ok(restarted.proofMap.criteria.every((item) => item.current.evidenceValidity === "stale"));
});
