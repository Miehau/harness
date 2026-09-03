import test from "node:test";
import assert from "node:assert/strict";
import { blockingReasons, dependencyArtifacts, diffReviewBudget, findNode, groupStatus, normalizeEditedPlan, normalizePlan, planReviewViolations, reviewBudgetRequiresRollback } from "../src/plan.js";

function planFixture() {
  return normalizePlan({
    title: "Research then build",
    harness: "pi",
    nodes: [
      {
        id: "research",
        type: "group",
        title: "Research",
        children: [
          { id: "repo", title: "Map repo", prompt: "Inspect", expectedArtifacts: ["repo.md"], acceptanceCriteria: ["Map exists"] },
          { id: "risk", title: "Map risk", prompt: "Inspect risk", expectedArtifacts: ["risk.md"], acceptanceCriteria: ["Risks exist"] }
        ]
      },
      { id: "build", title: "Build", prompt: "Implement", permission: "write", dependsOn: ["research"], expectedArtifacts: ["result.md"], acceptanceCriteria: ["Tests pass"] }
    ]
  });
}

test("a group is a hard barrier until every required child is accepted", () => {
  const plan = planFixture();
  const research = findNode(plan, "research");
  const build = findNode(plan, "build");
  research.children[0].status = "accepted";
  research.children[0].artifacts = [{ name: "repo.md", content: "map" }];

  assert.equal(groupStatus(research), "blocked");
  assert.deepEqual(blockingReasons(plan, build), ["Map risk is ready"]);

  research.children[1].status = "accepted";
  research.children[1].artifacts = [{ name: "risk.md", content: "risks" }];
  assert.equal(groupStatus(research), "accepted");
  assert.deepEqual(blockingReasons(plan, build), []);
  research.children[0].artifacts.push({ name: "verification.json", kind: "step-verification", content: "large TAP audit" });
  assert.deepEqual(dependencyArtifacts(plan, build).map((artifact) => artifact.name), ["repo.md", "risk.md"]);
});

test("runaway review diffs require rollback while ordinary overruns remain reviewable", () => {
  assert.equal(reviewBudgetRequiresRollback({ files: 9, maxFiles: 8, changedLines: 450, maxChangedLines: 400 }), false);
  assert.equal(reviewBudgetRequiresRollback({ files: 6, maxFiles: 8, changedLines: 1800, maxChangedLines: 400 }), true);
});

test("nested groups are rejected in the MVP", () => {
  assert.throws(() => normalizePlan({
    title: "Too deep",
    nodes: [{ type: "group", title: "Outer", children: [{ type: "group", title: "Inner", children: [] }] }]
  }), /one nesting level/);
});

test("steps retain named worker agents and checkpoint statuses", () => {
  const plan = normalizePlan({
    title: "Agents",
    nodes: [{ id: "review", title: "Review", agentId: "worker:security", status: "awaiting_approval" }]
  });
  const step = findNode(plan, "review");
  assert.equal(step.agentId, "worker:security");
  assert.equal(step.status, "awaiting_approval");
});

test("review-ready is a valid persisted step state", () => {
  const vcsChange = { system: "jj", changeId: "change", commitId: "revision" };
  const plan = normalizePlan({ nodes: [{ title: "Review me", status: "review_ready", vcsChange }] });
  assert.equal(plan.nodes[0].status, "review_ready");
  assert.deepEqual(plan.nodes[0].vcsChange, vcsChange);
});

test("cancelled is a valid resumable persisted step state", () => {
  const plan = normalizePlan({ nodes: [{ title: "Stop me", status: "cancelled" }] });
  assert.equal(plan.nodes[0].status, "cancelled");
});

test("steps retain selective product context references", () => {
  const plan = normalizePlan({ nodes: [{ title: "Build slice", requirementIds: ["REQ-1"], capabilityIds: ["CAP-2"], deltaIds: ["DELTA-3"], productContext: "Only this behavior." }] });
  assert.deepEqual(plan.nodes[0].requirementIds, ["REQ-1"]);
  assert.deepEqual(plan.nodes[0].capabilityIds, ["CAP-2"]);
  assert.deepEqual(plan.nodes[0].deltaIds, ["DELTA-3"]);
  assert.equal(plan.nodes[0].productContext, "Only this behavior.");
});

test("steps retain an explicit visual-evidence gate", () => {
  const plan = normalizePlan({ nodes: [{ title: "Polish board", requiresVisualEvidence: true }] });
  assert.equal(plan.nodes[0].requiresVisualEvidence, true);
});

test("video evidence also enables the visual-evidence gate", () => {
  const plan = normalizePlan({ nodes: [{ title: "Exercise checkout", requiresVideoEvidence: true }] });
  assert.equal(plan.nodes[0].requiresVisualEvidence, true);
  assert.equal(plan.nodes[0].requiresVideoEvidence, true);
});

test("flags broad or predicted oversized review steps unless explicitly justified", () => {
  const broad = normalizePlan({ nodes: [{ title: "Build everything", permission: "write", writeScope: "**", expectedFiles: Array.from({ length: 9 }, (_, index) => `src/${index}.js`), estimatedChangedLines: 200 }] });
  assert.equal(planReviewViolations(broad).length, 2);
  broad.nodes[0].reviewBudget.justification = "One generated protocol surface must change atomically.";
  assert.deepEqual(planReviewViolations(broad), []);
});

test("keeps verification bootstrap separate from architecture and product changes", () => {
  const mixed = normalizePlan({ nodes: [{
    title: "Bootstrap and document",
    permission: "write",
    writeScope: ".agent-plan,docs/architecture.md",
    expectedFiles: [".agent-plan/verify.mjs", "docs/architecture.md"],
    estimatedChangedLines: 20
  }] });
  assert.match(planReviewViolations(mixed)[0], /verification bootstrap write scope must contain only \.agent-plan/);
});

test("measures actual review size while excluding lockfiles", () => {
  const step = normalizePlan({ nodes: [{ title: "Focused change", permission: "write", writeScope: "src", reviewBudget: { maxFiles: 1, maxChangedLines: 5 } }] }).nodes[0];
  const result = diffReviewBudget(step, { files: ["src/app.js", "package-lock.json"], fileStats: [
    { path: "src/app.js", additions: 4, deletions: 2 }, { path: "package-lock.json", additions: 200, deletions: 100 }
  ] });
  assert.equal(result.files, 1);
  assert.equal(result.changedLines, 6);
  assert.equal(result.exceeded, true);
  assert.equal(result.excludedFiles, 1);
});

test("visual proof plumbing does not consume the ticket review-file budget", () => {
  const step = normalizePlan({ nodes: [{ title: "Visual change", permission: "write", writeScope: "public,.agent-plan", reviewBudget: { maxFiles: 2, maxChangedLines: 100 } }] }).nodes[0];
  const result = diffReviewBudget(step, { files: [
    "public/app.js", ".agent-plan/capture-dashboard.mjs", ".agent-plan/project.json", ".agent-plan/verify.mjs", ".agent-plan/evidence/desktop.png"
  ], fileStats: [
    { path: "public/app.js", additions: 20 }, { path: ".agent-plan/capture-dashboard.mjs", additions: 30 },
    { path: ".agent-plan/project.json", additions: 3 }, { path: ".agent-plan/verify.mjs", additions: 10 },
    { path: ".agent-plan/evidence/desktop.png", additions: 0 }
  ] });
  assert.equal(result.files, 2);
  assert.equal(result.changedLines, 50);
  assert.equal(result.excludedFiles, 3);
  assert.equal(result.exceeded, false);
});

test("edited plans reject unknown dependencies, duplicate ids, and cycles", () => {
  assert.throws(() => normalizeEditedPlan({ nodes: [{ id: "a", title: "A", dependsOn: ["missing"] }] }), /unknown dependency/);
  assert.throws(() => normalizeEditedPlan({ nodes: [{ id: "a", title: "A" }, { id: "a", title: "Again" }] }), /duplicate id/);
  assert.throws(() => normalizeEditedPlan({ nodes: [
    { id: "a", title: "A", dependsOn: ["b"] },
    { id: "b", title: "B", dependsOn: ["a"] }
  ] }), /dependency cycle/);
});
