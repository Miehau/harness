import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProofReports, criterionId, initializeProofMap, invalidateProof, normalizeProofResult, projectProofMap, proofEligibility, resolveEvidence } from "../src/proof-map.js";
import { normalizePlan } from "../src/plan.js";

const approvedAt = "2026-09-10T10:00:00.000Z";
const reportedAt = "2026-09-10T11:00:00.000Z";

function fixture() {
  const plan = normalizePlan({ nodes: [
    { id: "api", title: "Build API", acceptanceCriteria: ["Returns matches", "Rejects invalid input"] },
    { id: "ui", title: "Build UI", acceptanceCriteria: ["Shows results"] }
  ] });
  const run = {
    plan,
    artifacts: [
      { id: "result", kind: "agent-output", name: "result.md", path: "/data/result.md", createdAt: approvedAt },
      { id: "screen", kind: "visual-evidence", name: "screen.png", path: "/data/screen.png", createdAt: approvedAt }
    ],
    checkpoint: { finalChecks: { status: "passed", command: "node verify.mjs", summary: "Passed" } },
    deliveredDiff: { available: true, reference: "base..head", files: ["src/api.js"] }
  };
  plan.nodes[0].attempts = [{ attemptId: "attempt-1", verification: { checks: { status: "passed", command: "node test" } }, diff: { available: true, files: ["src/api.js"] } }];
  plan.nodes[0].diff = { available: true, reference: "base..api", files: ["src/api.js"] };
  return { plan, run, map: initializeProofMap(plan, { approvedAt }) };
}

function verified(criterionIdValue, evidence = [{ type: "artifact", artifactId: "result" }]) {
  return { criterionId: criterionIdValue, status: "verified", evidence };
}

test("initializes one ordered stable identity and immutable snapshot per approved criterion", () => {
  const { plan, map } = fixture();
  assert.deepEqual(map.criteria.map(({ stepId, index, text }) => [stepId, index, text]), [
    ["api", 0, "Returns matches"], ["api", 1, "Rejects invalid input"], ["ui", 0, "Shows results"]
  ]);
  assert.equal(new Set(map.criteria.map((item) => item.id)).size, 3);
  assert.equal(map.criteria[0].id, criterionId("api", 0, "Returns matches"));
  plan.nodes[0].acceptanceCriteria[0] = "Edited later";
  assert.equal(map.criteria[0].text, "Returns matches");
  assert.equal(map.criteria[0].current.status, "not_yet_verified");
});

test("resolves only typed canonical run-owned evidence", () => {
  const { run } = fixture();
  assert.equal(resolveEvidence(run, { type: "artifact", artifactId: "result" }).valid, true);
  assert.equal(resolveEvidence(run, { type: "media", artifactId: "screen" }).valid, false, "media needs a readable canonical proof-storage path");
  assert.equal(resolveEvidence(run, { type: "media", artifactId: "result" }).valid, false);
  assert.equal(resolveEvidence(run, { type: "check", stepId: "api", attemptId: "attempt-1" }).valid, true);
  assert.equal(resolveEvidence(run, { type: "check", scope: "final" }).valid, true);
  // A legacy display round is not an immutable final-check record, so the locator
  // remains unversioned and continues to resolve the checkpoint output.
  run.reviews = [{ round: 1, diff: { available: true, files: ["legacy.js"] } }];
  assert.deepEqual(resolveEvidence(run, { type: "check", scope: "final" }).locator, { type: "check", scope: "final" });
  assert.equal(resolveEvidence(run, { type: "check", scope: "final" }).valid, true);
  assert.equal(resolveEvidence(run, { type: "diff", stepId: "api" }).valid, true);
  assert.equal(resolveEvidence(run, { type: "artifact", artifactId: "other-run" }).valid, false);
  assert.equal(resolveEvidence(run, { type: "url", href: "https://example.test" }).valid, false);

  const invalidScope = resolveEvidence(run, { type: "check", scope: "invalid", stepId: "api" });
  assert.equal(invalidScope.valid, false);
  assert.equal(invalidScope.reason, "malformed_locator");
  assert.deepEqual(invalidScope.locator, { type: "check" });
  assert.equal(normalizeProofResult({ status: "verified", evidence: [{ type: "check", scope: "invalid", stepId: "api" }] }, run, { reportedAt }).status, "not_yet_verified");
  assert.equal(resolveEvidence(run, { type: "diff", scope: "attempt", stepId: "api" }).valid, false);
});

test("resolves archived attempts and review-round checks without following mutable current output", () => {
  const { run } = fixture();
  const original = run.plan.nodes[0].attempts[0];
  run.archivedAttempts = [{ stepId: "api", ...structuredClone(original) }];
  run.plan.nodes[0].attempts = [];
  run.finalCheckHistory = {
    "final-review-1": { status: "passed", command: "node old", summary: "original final output" },
    "final-review-2": { status: "passed", command: "node new", summary: "replacement final output" }
  };
  run.finalChecks = run.finalCheckHistory["final-review-2"];

  assert.equal(resolveEvidence(run, { type: "check", scope: "attempt", stepId: "api", attemptId: "attempt-1" }).target.command, "node test");
  assert.equal(resolveEvidence(run, { type: "diff", scope: "attempt", stepId: "api", attemptId: "attempt-1" }).valid, true);
  assert.equal(resolveEvidence(run, { type: "check", scope: "final", reviewId: "final-review-1" }).target.summary, "original final output");
  assert.equal(resolveEvidence(run, { type: "check", scope: "final", reviewId: "final-review-2" }).target.summary, "replacement final output");
});

test("requires media evidence to have a readable canonical proof-storage path", async () => {
  const root = await mkdtemp(join(tmpdir(), "proof-map-"));
  try {
    const { run } = fixture();
    const screen = run.artifacts.find((artifact) => artifact.id === "screen");
    run.proofStorageRoot = root;
    screen.path = join(root, "screen.png");
    await writeFile(screen.path, "image");
    assert.equal(resolveEvidence(run, { type: "media", artifactId: "screen" }).valid, true);

    delete screen.path;
    screen.content = "inline image";
    const result = normalizeProofResult({ status: "verified", evidence: [{ type: "media", artifactId: "screen" }] }, run, { reportedAt });
    assert.equal(result.status, "not_yet_verified");
    assert.equal(result.evidence[0].reason, "missing_evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores strict locators without worker-supplied evidence content", () => {
  const { run } = fixture();
  const result = normalizeProofResult({
    status: "verified",
    evidence: [{ type: "artifact", artifactId: "result", content: "copied output", prose: "trust me", path: "/tmp/unowned" }]
  }, run, { reportedAt });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.evidence, [{ type: "artifact", artifactId: "result", validity: "valid", producedAt: approvedAt }]);
});

test("malformed, prose-only, exit-only, and omitted reports remain unresolved", () => {
  const { run, map } = fixture();
  const [one, two, three] = map.criteria;
  const next = applyProofReports(map, [
    { criterionId: one.id, status: "verified", summary: "trust me", exitCode: 0 },
    { criterionId: two.id, status: "passed", evidence: [{ type: "artifact", artifactId: "result" }] },
    { summary: "all criteria pass", exitCode: 0 }
  ], run, { reportedAt });
  assert.deepEqual(next.criteria.map((item) => item.current.status), ["not_yet_verified", "not_yet_verified", "not_yet_verified"]);
  assert.match(next.criteria[0].current.explanation.summary, /resolvable run evidence/);
  assert.match(next.criteria[1].current.explanation.summary, /malformed/);
  assert.equal(next.criteria[2].id, three.id);
  assert.deepEqual(map.criteria.map((item) => item.history), [[], [], []], "input map is not mutated");
});

test("duplicate reports for one criterion fail closed instead of using array order", () => {
  const { run, map } = fixture();
  const id = map.criteria[0].id;
  const next = applyProofReports(map, [verified(id), verified(id)], run, { criterionIds: [id], reportedAt });
  assert.equal(next.criteria[0].current.status, "not_yet_verified");
  assert.match(next.criteria[0].current.explanation.summary, /Conflicting/);
});

test("verified claims require at least one resolvable reference while sharing is allowed", () => {
  const { run, map } = fixture();
  const [one, two] = map.criteria;
  const next = applyProofReports(map, [
    verified(one.id, [{ type: "artifact", artifactId: "missing" }]),
    verified(two.id, [{ type: "artifact", artifactId: "missing" }, { type: "artifact", artifactId: "result" }])
  ], run, { criterionIds: [one.id, two.id], reportedAt });
  assert.equal(next.criteria[0].current.status, "not_yet_verified");
  assert.equal(next.criteria[0].current.evidenceValidity, "missing");
  assert.equal(next.criteria[1].current.status, "verified");
  assert.equal(next.criteria[1].current.evidenceValidity, "valid");

  const shared = applyProofReports(map, [verified(one.id), verified(two.id)], run, { criterionIds: [one.id, two.id], reportedAt });
  assert.deepEqual(shared.criteria.slice(0, 2).map((item) => item.current.evidence[0].artifactId), ["result", "result"]);
});

test("failed and blocked results require structured explanations", () => {
  const { run } = fixture();
  assert.equal(normalizeProofResult({ status: "failed", explanation: "broken" }, run, { reportedAt }).status, "not_yet_verified");
  const result = normalizeProofResult({ status: "blocked", explanation: { summary: "Service unavailable", details: "Retry after maintenance" } }, run, { reportedAt });
  assert.equal(result.status, "blocked");
  assert.equal(result.explanation.details, "Retry after maintenance");
});

test("selective invalidation separates stale evidence from result status", () => {
  const { run, map } = fixture();
  const ids = map.criteria.map((item) => item.id);
  const verifiedMap = applyProofReports(map, ids.map((id) => verified(id)), run, { reportedAt });
  const stale = invalidateProof(verifiedMap, [ids[1]], { invalidatedAt: "2026-09-10T12:00:00.000Z", reason: "API correction" });
  assert.deepEqual(stale.criteria.map((item) => [item.current.status, item.current.evidenceValidity]), [
    ["verified", "valid"], ["verified", "stale"], ["verified", "valid"]
  ]);
  assert.equal(stale.criteria[1].history.length, 2);
  assert.equal(stale.criteria[0].history.length, 1);
  assert.equal(proofEligibility(stale).eligible, false);
  assert.equal(proofEligibility(stale).blockingReasons[0].code, "evidence_stale");
});

test("re-verification replaces stale media proof and retains the earlier capture in history", async () => {
  const root = await mkdtemp(join(tmpdir(), "proof-map-"));
  try {
    const { run, map } = fixture();
    run.proofStorageRoot = root;
    run.artifacts.find((artifact) => artifact.id === "screen").path = join(root, "screen.png");
    await writeFile(run.artifacts.find((artifact) => artifact.id === "screen").path, "original image");
    const id = map.criteria[0].id;
    const first = applyProofReports(map, [verified(id, [{ type: "media", artifactId: "screen" }])], run, { criterionIds: [id], reportedAt });
    const stale = invalidateProof(first, [id], { invalidatedAt: "2026-09-10T12:00:00.000Z" });
    const reverifiedPath = join(root, "captures", "reverified", "screen.png");
    await mkdir(join(root, "captures", "reverified"), { recursive: true });
    await writeFile(reverifiedPath, "reverified image");
    run.artifacts.push({
      id: "screen-reverified", kind: "visual-evidence", name: "screen.png", path: reverifiedPath,
      createdAt: "2026-09-10T13:00:00.000Z"
    });
    const second = applyProofReports(stale, [verified(id, [{ type: "media", artifactId: "screen-reverified" }])], run, { criterionIds: [id], reportedAt: "2026-09-10T13:00:00.000Z" });
    assert.equal(second.criteria[0].current.evidence[0].artifactId, "screen-reverified");
    assert.equal(second.criteria[0].current.evidenceValidity, "valid");
    assert.equal(second.criteria[0].history.length, 3);
    assert.equal(second.criteria[0].history.at(-1).evidenceValidity, "stale");
    assert.equal(second.criteria[0].history.at(-1).evidence[0].artifactId, "screen");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projection rechecks current, stale, and historical locators after reload", () => {
  const { run, map } = fixture();
  const complete = applyProofReports(map, map.criteria.map((item) => verified(item.id)), run, { reportedAt });
  run.proofMap = complete;
  assert.equal(projectProofMap(run).eligibility.eligible, true);
  run.proofMap = invalidateProof(run.proofMap, [run.proofMap.criteria[0].id], { invalidatedAt: "2026-09-10T12:00:00.000Z" });
  run.artifacts = [];
  const projection = projectProofMap(run);
  assert.equal(projection.criteria[0].current.status, "verified");
  assert.equal(projection.criteria[0].current.evidenceValidity, "stale");
  assert.equal(projection.criteria[0].current.evidence[0].validity, "missing");
  assert.equal(projection.criteria[0].history.at(-1).evidence[0].validity, "missing");
  assert.equal(projection.criteria[1].current.evidenceValidity, "missing");
  assert.equal(projection.eligibility.eligible, false);
});

test("re-verification rejects invalidated evidence repeatedly and requires a dated fresh locator", () => {
  const { run, map } = fixture();
  const id = map.criteria[0].id;
  const first = applyProofReports(map, [verified(id)], run, { criterionIds: [id], reportedAt });
  const stale = invalidateProof(first, [id], { invalidatedAt: "2026-09-10T12:00:00.000Z" });
  const reused = applyProofReports(stale, [verified(id)], run, { criterionIds: [id], reportedAt: "2026-09-10T13:00:00.000Z" });
  assert.equal(reused.criteria[0].current.status, "not_yet_verified");
  assert.equal(reused.criteria[0].current.evidence[0].reason, "stale_evidence");

  const retried = applyProofReports(reused, [verified(id)], run, { criterionIds: [id], reportedAt: "2026-09-10T13:01:00.000Z" });
  assert.equal(retried.criteria[0].current.status, "not_yet_verified");
  assert.equal(retried.criteria[0].current.evidence[0].reason, "stale_evidence");

  const undated = applyProofReports(retried, [verified(id, [{ type: "check", scope: "final" }])], run, { criterionIds: [id], reportedAt: "2026-09-10T13:02:00.000Z" });
  assert.equal(undated.criteria[0].current.status, "not_yet_verified");
  assert.equal(undated.criteria[0].current.evidence[0].reason, "stale_evidence");

  run.finalCheckHistory = { "final-review-2": { status: "passed", createdAt: "2026-09-10T13:03:00.000Z" } };
  run.finalReviewHistory = { "final-review-2": { createdAt: "2026-09-10T13:03:00.000Z" } };
  const fresh = applyProofReports(undated, [verified(id, [{ type: "check", scope: "final" }])], run, { criterionIds: [id], reportedAt: "2026-09-10T13:03:00.000Z" });
  assert.equal(fresh.criteria[0].current.status, "verified");
});

test("legacy runs project discoverable criteria unresolved without changing aggregate history", () => {
  const { run } = fixture();
  run.status = "completed";
  run.reviews = [{ summary: "Legacy aggregate pass" }];
  run.finalChecks = { status: "passed", summary: "Legacy checks passed" };
  const before = structuredClone(run);
  const projection = projectProofMap(run);
  assert.equal(projection.compatibility, true);
  assert.deepEqual(projection.criteria.map((item) => item.current.status), ["not_yet_verified", "not_yet_verified", "not_yet_verified"]);
  assert.equal(projection.legacy.status, "completed");
  assert.equal(projection.legacy.reviews[0].summary, "Legacy aggregate pass");
  assert.equal(projection.legacy.finalChecks.summary, "Legacy checks passed");
  assert.deepEqual(run, before);
});

test("empty approved and legacy plans remain empty and are vacuously eligible", () => {
  const map = initializeProofMap({ nodes: [] }, { approvedAt });
  assert.deepEqual(map.criteria, []);
  const projection = projectProofMap({ plan: { nodes: [] }, status: "completed" });
  assert.deepEqual(projection.criteria, []);
  assert.equal(projection.eligibility.eligible, true);
});
