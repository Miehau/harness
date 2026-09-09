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
    acceptanceCriteria: ["Matching tickets are returned"],
    requiresVisualEvidence: false,
    requiresVideoEvidence: false
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
    { kind: "agent-output", stepId: "removed", name: "removed.md", content: "no longer planned" },
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

test("progressive index stays bounded while preserving every current criterion and detail", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { writeReviewIndex } = await import("../src/review-packet.js");
  const root = await mkdtemp(join(tmpdir(), "progressive-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proofMap = { legacy: { reviews: "historical-sentinel".repeat(100000) }, criteria: Array.from({ length: 120 }, (_, n) => ({ id: `c-${n}`, stepId: `step-${n % 12}`, text: `Outcome ${n}`, current: { status: "verified", evidence: [] }, history: [{ summary: "historical-sentinel" }] })) };
  const input = { plan: { nodes: Array.from({ length: 12 }, (_, n) => ({ id: `step-${n}`, title: `Behavior ${n}`, status: "accepted", dependsOn: n ? [`step-${n - 1}`] : [] })) }, proofMap, diff: { before: "before", after: "after", files: ["src/app.js"], patch: "+current-change\n".repeat(50000) }, checks: { status: "passed", output: "check-detail-sentinel" }, operatorFeedback: "authoritative-constraint-sentinel", focusFindings: [{ claim: "Fix regression", suggestedFix: "finding-detail-sentinel" }] };
  const result = await writeReviewIndex(root, input);
  const initial = JSON.stringify(result.summary);
  assert.ok(initial.length < 12000, initial.length);
  assert.doesNotMatch(initial, /historical-sentinel|check-detail-sentinel|authoritative-constraint-sentinel|finding-detail-sentinel|current-change/);
  const index = JSON.parse(await readFile(result.summary.index, "utf8"));
  assert.equal(index.criteria.length, 120);
  assert.equal(index.groups.length, 12);
  assert.match(await readFile(join(result.root, index.criteria.at(-1).detail), "utf8"), /Outcome 119/);
  assert.doesNotMatch(await readFile(join(result.root, index.criteria[0].detail), "utf8"), /historical-sentinel/);
  assert.match(await readFile(join(result.root, "changes.patch"), "utf8"), /current-change/);
  assert.match(await readFile(join(result.root, index.constraints), "utf8"), /authoritative-constraint-sentinel/);
  const group = JSON.parse(await readFile(join(result.root, index.groups[1].detail), "utf8"));
  assert.deepEqual(group.dependsOn, ["step-0"]);
  assert.equal(group.criteria.length, 10);
  const updated = await writeReviewIndex(root, { ...input, operatorFeedback: "New scope" });
  assert.notEqual(updated.digest, result.digest);
  assert.match(await readFile(join(result.root, index.constraints), "utf8"), /authoritative-constraint-sentinel/, "old reviewer snapshots remain immutable");
});

test("indexed patches retain every repository and hunk without duplicating bodies in navigation", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { writeReviewIndex } = await import("../src/review-packet.js");
  const root = await mkdtemp(join(tmpdir(), "context-patches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = "diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+first-sentinel\n";
  const second = "diff --git a/src/b.js b/src/b.js\n@@ -1 +1 @@\n-old\n+second-sentinel\n";
  const result = await writeReviewIndex(root, { plan, currentStepId: "future", artifacts: [
    { kind: "agent-output", stepId: "future", content: "current-worker-sentinel" },
    { kind: "agent-output", stepId: "search", content: "accepted-worker-sentinel" },
    { kind: "agent-output", stepId: "removed-step", content: "orphaned-worker-sentinel" }
  ], diff: { files: ["src/a.js", "src/b.js"], patch: first + second, repositories: [
    { repositoryId: "primary", patch: first + second },
    { repositoryId: "secondary", patch: second, truncated: true }
  ] } });
  const changes = JSON.parse(await readFile(join(result.root, "changes.json"), "utf8"));
  assert.equal(changes.truncated, true);
  assert.doesNotMatch(JSON.stringify(changes), /first-sentinel|second-sentinel/);
  assert.deepEqual(changes.repositories[0].patches.map((item) => [item.file, item.hunks.length]), [["src/a.js", 1], ["src/b.js", 1]]);
  const restored = await Promise.all(changes.repositories[0].patches.map((item) => readFile(join(result.root, item.detail), "utf8")));
  assert.equal(restored.join(""), first + second);
  assert.equal(await readFile(join(result.root, changes.repositories[1].patches[0].detail), "utf8"), second);
  const index = JSON.parse(await readFile(result.summary.index, "utf8"));
  assert.equal(index.evidence.length, 2, "the current unaccepted worker report and accepted handoffs remain accessible");
});
