import assert from "node:assert/strict";
import test from "node:test";
import { compactReviewPacket } from "../src/review-packet.js";

const plan = {
  title: "Ship search",
  summary: "Add a search slice.",
  nodes: [
    {
      id: "search",
      title: "Implement search",
      description: "Return matching tickets.",
      status: "accepted",
      requirementIds: ["REQ-1"],
      capabilityIds: ["CAP-search"],
      deltaIds: ["DELTA-1"],
      acceptanceCriteria: ["Matching tickets are returned"],
      prompt: "A very long implementation conversation",
      attempts: [{ output: "historical output" }],
      diff: { patch: "duplicate diff" }
    },
    { id: "future", title: "Future work", description: "Not accepted.", status: "ready", acceptanceCriteria: [] }
  ]
};

test("compacts the plan to outcomes and acceptance mappings", () => {
  const packet = compactReviewPacket({ ticket: { identifier: "APP-1", title: "Search" }, plan });

  assert.deepEqual(packet.plan.outcomes[0], {
    id: "search",
    title: "Implement search",
    description: "Return matching tickets.",
    status: "accepted",
    requirementIds: ["REQ-1"],
    capabilityIds: ["CAP-search"],
    deltaIds: ["DELTA-1"],
    acceptanceCriteria: ["Matching tickets are returned"]
  });
  assert.equal("prompt" in packet.plan.outcomes[0], false);
  assert.equal("attempts" in packet.plan.outcomes[0], false);
  assert.equal("diff" in packet.plan.outcomes[0], false);
});

test("keeps only the latest relevant artifact for each accepted step", () => {
  const artifacts = [
    { kind: "agent-output", stepId: "search", name: "old.md", content: "old result" },
    { kind: "agent-prompt", stepId: "search", name: "prompt.md", content: "prompt" },
    { kind: "git-diff", stepId: "search", name: "diff.patch", content: "duplicate diff" },
    { kind: "agent-output", stepId: "search", name: "new.md", content: "new result" },
    { kind: "agent-output", stepId: "future", name: "future.md", content: "not accepted" },
    { kind: "requirements", name: "requirements.md", content: "approved requirements" }
  ];

  const packet = compactReviewPacket({ plan, artifacts });

  assert.deepEqual(packet.artifacts.map(({ name }) => name), ["requirements.md", "new.md"]);
  assert.equal(packet.artifacts[1].content, "new result");
});

test("preserves every planned outcome and prioritizes essential artifacts", () => {
  const manySteps = { nodes: Array.from({ length: 30 }, (_, index) => ({ id: `step-${index}`, title: `Step ${index}`, acceptanceCriteria: [`Criterion ${index}`] })) };
  const artifacts = [
    { kind: "requirements", name: "requirements.md", content: "approved requirements" },
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "agent-output", name: `output-${index}.md`, content: `output ${index}` }))
  ];

  const packet = compactReviewPacket({ plan: manySteps, artifacts });

  assert.equal(packet.plan.outcomes.length, 30);
  assert.equal(packet.plan.outcomes[29].acceptanceCriteria[0], "Criterion 29");
  assert.equal(packet.artifacts[0].name, "requirements.md");
});

test("bounds canonical diff and deterministic check output", () => {
  const longText = "x".repeat(80_000);
  const packet = compactReviewPacket({
    plan,
    artifacts: [{ kind: "architecture", name: "architecture.md", content: longText }],
    diff: { reference: "baseline..head", files: Array.from({ length: 120 }, (_, index) => `src/${index}.js`), stat: "2 files", patch: longText },
    checks: { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed", output: longText, durationMs: 42 }
  });

  assert.equal(packet.canonicalDiff.reference, "baseline..head");
  assert.equal(packet.canonicalDiff.files.length, 100);
  assert.equal(packet.canonicalDiff.omittedFiles, 20);
  assert.match(packet.canonicalDiff.patch, /characters omitted/);
  assert.match(packet.checks.output, /characters omitted/);
  assert.match(packet.artifacts[0].content, /characters omitted/);
  assert.equal(packet.checks.durationMs, 42);
});
