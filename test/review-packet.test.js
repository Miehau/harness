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

test("keeps every visual-evidence artifact ID available to reviewers", () => {
  const packet = compactReviewPacket({
    plan,
    artifacts: [
      { id: "screen-a", kind: "visual-evidence", stepId: "search", name: "desktop.png", path: "/proof/desktop.png" },
      { id: "screen-b", kind: "visual-evidence", stepId: "search", name: "mobile.png", path: "/proof/mobile.png" },
      { id: "video-a", kind: "visual-evidence", stepId: "search", name: "walkthrough.webm", path: "/proof/walkthrough.webm" }
    ]
  });

  assert.deepEqual(packet.artifacts.map((artifact) => artifact.id), ["screen-a", "screen-b", "video-a"]);
  assert.deepEqual(packet.media.map((artifact) => artifact.id), ["screen-a", "screen-b", "video-a"]);
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

test("keeps the ordered proof projection, locators, and retained history in the packet", () => {
  const proofMap = {
    version: 1, approvedAt: "2026-09-10T10:00:00.000Z", compatibility: false,
    eligibility: { eligible: false, blockingReasons: [{ criterionId: "criterion-2", message: "Criterion evidence is not currently valid." }] },
    criteria: [
      { id: "criterion-1", stepId: "search", stepTitle: "Implement search", stepRequired: true, index: 0, text: "Matching tickets are returned", current: { status: "verified", evidenceValidity: "valid", evidence: [{ type: "check", scope: "step", stepId: "search", validity: "valid" }] }, history: [] },
      { id: "criterion-2", stepId: "search", stepTitle: "Implement search", stepRequired: true, index: 1, text: "Invalid input is rejected", current: { status: "verified", evidenceValidity: "stale", evidence: [{ type: "diff", scope: "step", stepId: "search", validity: "valid" }] }, history: [{ status: "verified", evidenceValidity: "valid", evidence: [] }] }
    ]
  };
  const packet = compactReviewPacket({ plan, proofMap });

  assert.deepEqual(packet.proofMap.criteria.map((criterion) => [criterion.id, criterion.text, criterion.current.evidence[0]?.type, criterion.history.length]), [
    ["criterion-1", "Matching tickets are returned", "check", 0],
    ["criterion-2", "Invalid input is rejected", "diff", 1]
  ]);
  assert.equal(packet.proofMap.eligibility.blockingReasons[0].criterionId, "criterion-2");
  proofMap.criteria[0].current.status = "failed";
  assert.equal(packet.proofMap.criteria[0].current.status, "verified");
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
