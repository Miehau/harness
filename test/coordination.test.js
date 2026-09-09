import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan, findNode } from "../src/plan.js";
import { acceptPlanRevision, coordinationBlockedStepIds, ensureCoordination, proposePlanRevision, recordCoordinationDecision, rejectPlanRevision, reportConflict, writeScopesOverlap } from "../src/coordination.js";

const run = () => ({ plan: normalizePlan({ nodes: [
  { type: "group", id: "parallel", children: [
    { id: "one", title: "One", permission: "write", writeScope: "src/one" },
    { id: "two", title: "Two", permission: "write", writeScope: "src/two" }
  ] },
  { id: "three", title: "Three", dependsOn: ["parallel"] }
] }), activeRuns: {} });

test("scope overlap reserves only intersecting roots and conservatively treats globs", () => {
  for (const [left, right, expected] of [
    ["src/one", "src/two", false], ["src", "src/one.js", true], ["src", "src-old", false],
    ["src/*.js", "src/nested/file.ts", true], ["**", "src/x", true], ["", "src", false],
    ["root:other:src", "src", false], ["root:primary:src", "src/x", true],
    ["root:other:**", "root:other:lib", true], ["lib, src/a", "src/a/b", true],
    ["/repo/src", "src", true], ["/repo/src", "/repo/test", false]
  ]) assert.equal(writeScopesOverlap(left, right), expected, `${left} / ${right}`);
});

test("conflicts block dependents, and decisions remain recoverable after JSON restart", () => {
  const current = run();
  const conflict = reportConflict(current, { summary: "Interface mismatch", stepIds: ["one"] });
  assert.deepEqual(coordinationBlockedStepIds(current), ["one", "three"]);
  const recovered = JSON.parse(JSON.stringify(current));
  const decision = recordCoordinationDecision(recovered, { summary: "Use existing interface", conflictIds: [conflict.id], stepIds: ["one", "two"] });
  assert.equal(recovered.coordination.conflicts[0].decisionId, decision.id);
  assert.deepEqual(coordinationBlockedStepIds(recovered), []);
  assert.equal(current.coordination.conflicts[0].status, "open");
});

test("revisions validate group cycles and missing dependencies without changing the plan", () => {
  const current = run();
  const original = structuredClone(current.plan);
  assert.throws(() => proposePlanRevision(current, { reason: "Cycle", changes: [{ stepId: "one", dependsOn: ["three"] }] }), /cycle/);
  assert.throws(() => proposePlanRevision(current, { reason: "Unknown", changes: [{ stepId: "one", dependsOn: ["missing"] }] }), /unknown dependency/);
  assert.throws(() => proposePlanRevision(current, { reason: "Permission", changes: [{ stepId: "one", permission: "write" }] }), /Unsupported/);
  assert.deepEqual(current.plan, original);
});

test("applying a revision requires operator approval and stopped workers, preserves work and invalidates proof", () => {
  const current = run();
  const step = findNode(current.plan, "one");
  Object.assign(step, { status: "interrupted", attempts: [{ attemptId: "old", status: "interrupted" }], artifacts: [{ id: "artifact" }], workspace: { cwd: "/old-worktree" }, sessionFile: "/old-session", pendingVerification: { stale: true }, activeAttempt: { id: "old", status: "interrupted" } });
  current.proofMap = { criteria: [{ id: "proof", stepId: "one", history: [], current: { status: "verified", evidenceValidity: "valid", evidence: [{ id: "evidence" }] } }] };
  const conflict = reportConflict(current, { summary: "Sequence conflict", stepIds: ["one", "two"] });
  const revision = proposePlanRevision(current, { reason: "Two must follow one", conflictIds: [conflict.id], changes: [{ stepId: "two", dependsOn: ["one"] }, { stepId: "one", description: "New agreed API" }] });
  const snapshot = structuredClone(revision.before);
  assert.throws(() => acceptPlanRevision(current, revision.id, { author: "worker" }), /operator approval/);
  current.activeRuns.one = { attemptId: "old" };
  assert.throws(() => acceptPlanRevision(current, revision.id), /Stop affected worker/);
  delete current.activeRuns.one;
  acceptPlanRevision(current, revision.id);
  assert.equal(current.planRevision, 2);
  assert.deepEqual(findNode(current.plan, "two").dependsOn, ["one"]);
  const updated = findNode(current.plan, "one");
  assert.equal(updated.status, "ready");
  assert.equal(updated.activeAttempt.status, "superseded");
  assert.equal(updated.coordinationRestart, true);
  assert.equal(updated.workspace, undefined);
  assert.equal(updated.sessionFile, null);
  assert.equal(updated.pendingVerification, undefined);
  assert.deepEqual(updated.attempts, step.attempts);
  assert.deepEqual(updated.artifacts, step.artifacts);
  assert.equal(revision.beforeWork.find((item) => item.id === "one").workspace.cwd, "/old-worktree");
  assert.deepEqual(revision.before, snapshot);
  assert.equal(current.proofMap.criteria[0].current.evidenceValidity, "stale");
  assert.equal(current.coordination.conflicts[0].status, "resolved");
  assert.equal(current.coordination.decisions[0].revisionId, revision.id);
  assert.throws(() => acceptPlanRevision(current, revision.id), /Pending revision/);
});

test("accepted work is immutable and corrective additions retain its evidence", () => {
  const current = run();
  const step = findNode(current.plan, "one");
  step.status = "accepted";
  step.artifacts = [{ id: "retained" }];
  assert.throws(() => proposePlanRevision(current, { reason: "Rewrite", changes: [{ stepId: "one", title: "New" }] }), /immutable/);
  assert.throws(() => proposePlanRevision(current, { reason: "Correction", correctiveStepIds: ["one"], addSteps: [{ id: "correct", title: "Correct" }] }), /depending on one/);
  const revision = proposePlanRevision(current, { reason: "Correct interface", correctiveStepIds: ["one"], addSteps: [{ id: "correct", title: "Correct", dependsOn: ["one"], permission: "write", writeScope: "src/one", expectedFiles: ["src/one"], estimatedChangedLines: 20, acceptanceCriteria: ["Interface matches"] }], changes: [{ stepId: "three", dependsOn: ["parallel", "correct"] }] });
  acceptPlanRevision(current, revision.id);
  assert.deepEqual(findNode(current.plan, "one"), step);
  assert.equal(findNode(current.plan, "correct").status, "ready");
  assert.equal(current.proofMap.criteria.find((item) => item.stepId === "correct").text, "Interface matches");
});

test("stale proposals cannot replace newer accepted plans; rejection preserves proposal history", () => {
  const current = run();
  ensureCoordination(current);
  const first = proposePlanRevision(current, { reason: "First", changes: [{ stepId: "one", title: "First" }] });
  const second = proposePlanRevision(current, { reason: "Second", changes: [{ stepId: "two", title: "Second" }] });
  acceptPlanRevision(current, first.id);
  assert.throws(() => acceptPlanRevision(current, second.id), /Pending revision/);
  assert.equal(second.status, "superseded");
  const third = proposePlanRevision(current, { reason: "Third", changes: [{ stepId: "two", title: "Third" }] });
  rejectPlanRevision(current, third.id, { reason: "Keep original" });
  assert.equal(third.reason, "Third");
  assert.equal(third.status, "rejected");
  assert.equal(findNode(current.plan, "two").title, "Two");
});

test("scope revisions respect frozen read-only roots and require reviewable new work", () => {
  const current = run();
  current.access = { mode: "scoped", primary: { id: "primary", path: "/repo" }, extraRoots: [{ id: "docs", path: "/docs", mode: "read-only" }] };
  for (const writeScope of ["../outside", "root:docs:guide", "root:missing:src", "/outside"]) {
    assert.throws(() => proposePlanRevision(current, { reason: "Scope", changes: [{ stepId: "one", writeScope }] }), /scope/i);
  }
  assert.throws(() => proposePlanRevision(current, { reason: "Missing review surface", addSteps: [{ id: "new", title: "New", permission: "write", writeScope: "src/new" }] }), /expectedFiles/);
  const revision = proposePlanRevision(current, { reason: "Approved scope change", changes: [{ stepId: "one", writeScope: "src/new" }] });
  assert.equal(findNode(current.plan, "one").writeScope, "src/one");
  acceptPlanRevision(current, revision.id);
  assert.equal(findNode(current.plan, "one").writeScope, "src/new");
});
