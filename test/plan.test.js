import test from "node:test";
import assert from "node:assert/strict";
import { blockingReasons, dependencyArtifacts, findNode, groupStatus, normalizePlan } from "../src/plan.js";

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
  assert.deepEqual(dependencyArtifacts(plan, build).map((artifact) => artifact.name), ["repo.md", "risk.md"]);
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
  const plan = normalizePlan({ nodes: [{ title: "Review me", status: "review_ready" }] });
  assert.equal(plan.nodes[0].status, "review_ready");
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
