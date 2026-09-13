import assert from "node:assert/strict";
import test from "node:test";
import { finalReviewRoles, normalizePlan } from "../src/plan.js";
import { applyIndependentProofReports, initializeProofMap, proofEligibility } from "../src/proof-map.js";

test("temporary criteria remain step gates without contradicting final requirements", () => {
  const plan = normalizePlan({ nodes: [{ id: "bootstrap", title: "Bootstrap", acceptanceCriteria: ["No package yet", "Runnable page"], criterionBindings: [
    { index: 0, id: "temporary", evidence: "check", scope: "step" },
    { index: 1, id: "final", evidence: "check", scope: "final" }
  ] }] });
  const map = initializeProofMap(plan);
  assert.equal(map.criteria[0].scope, "step");
  assert.equal(proofEligibility(map, { stepId: "bootstrap" }).blockingReasons.length, 2);
  const run = { plan, finalChecks: { status: "passed" } };
  const reviewed = applyIndependentProofReports(map, [{ criterionId: "final", status: "verified", explanation: { summary: "Runnable" }, evidence: [{ type: "check", scope: "final" }] }], run);
  assert.equal(reviewed.criteria[0].current.status, "not_yet_verified", "final review does not invent historical success");
  assert.equal(proofEligibility(reviewed).eligible, true);
  assert.equal(proofEligibility(reviewed, { stepId: "bootstrap" }).eligible, false);
  const legacy = initializeProofMap(normalizePlan({ nodes: [{ id: "old", acceptanceCriteria: ["Required"] }] }));
  assert.equal(legacy.criteria[0].scope, "final");
});

test("only explicitly approved low-risk small diffs use a comprehensive reviewer", () => {
  const raw = { reviewPolicy: { mode: "small", reason: "One local heading", risks: [] }, nodes: [{ id: "page" }] };
  const plan = normalizePlan(raw);
  const diff = { available: true, files: ["page.html"], changedLines: 20 };
  assert.deepEqual(finalReviewRoles(plan, diff), ["requirements"]);
  assert.equal(finalReviewRoles({}, diff).length, 3);
  assert.equal(finalReviewRoles(plan, { ...diff, changedLines: 401 }).length, 3);
  assert.equal(finalReviewRoles(plan, { ...diff, repositories: [{}, {}] }).length, 3);
  assert.throws(() => normalizePlan({ ...raw, reviewPolicy: { ...raw.reviewPolicy, risks: ["authentication"] } }), /empty risk list/);
});
