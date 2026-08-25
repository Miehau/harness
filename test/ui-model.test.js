import test from "node:test";
import assert from "node:assert/strict";
import { artifactsForStage, eventGroups, eventTimeline, executionGraph, formatOutput, freeTextTicket, parseDiff, preferredStepId, runHeartbeat, stageMilestones } from "../public/ui-model.js";

test("builds graph levels and readable diff rows", () => {
  const graph = executionGraph({ nodes: [
    { id: "research", type: "group", children: [{ id: "a", dependsOn: [] }, { id: "b", dependsOn: [] }] },
    { id: "build", type: "step", dependsOn: ["research"] },
    { id: "verify", type: "step", dependsOn: ["build"] }
  ] });
  assert.deepEqual(graph.columns.map((column) => column.map((unit) => unit.id)), [["research"], ["build"], ["verify"]]);
  assert.deepEqual(graph.edges, [{ from: "research", to: "build" }, { from: "build", to: "verify" }]);

  const diff = parseDiff("diff --git a/a.ts b/a.ts\nindex 123..456 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same");
  assert.equal(diff.files[0].name, "a.ts");
  assert.deepEqual([diff.additions, diff.deletions], [1, 1]);
  assert.deepEqual(diff.files[0].rows.filter((row) => row.kind !== "hunk").map((row) => [row.kind, row.old, row.new]), [
    ["delete", 1, ""], ["add", "", 1], ["context", 2, 2]
  ]);
});

test("live run heartbeat distinguishes active, stale, and permission-risk states", () => {
  const startedAt = "2026-08-24T18:00:00.000Z";
  const now = Date.parse("2026-08-24T18:01:00.000Z");
  assert.equal(runHeartbeat({ startedAt, lastEventAt: "2026-08-24T18:00:55.000Z", lastEvent: "Using bash" }, {}, now).state, "active");
  assert.equal(runHeartbeat({ startedAt, lastEvent: "Using bash" }, {}, now).state, "stale");
  assert.match(runHeartbeat({ startedAt, warning: true }, {}, now).note, /permission/);
});

test("tool activity preserves event order and pairs details", () => {
  const timeline = eventTimeline([
    { type: "tool_start", callId: "1", tool: "bash", args: "{\"command\":\"npm test\"}", at: "1" },
    { type: "tool_end", callId: "1", tool: "bash", result: "32 tests pass", at: "2" },
    { type: "tool_start", callId: "2", tool: "read", args: "{\"path\":\"src/app.js\"}", at: "3" },
    { type: "tool_end", callId: "2", tool: "read", result: "source", at: "4" }
  ]);
  assert.deepEqual(timeline.map((item) => item.tool), ["bash", "read"]);
  assert.equal(timeline[0].title, "Command · npm test");
  assert.equal(timeline[0].key, "1");
  assert.equal(timeline[0].result, "32 tests pass");
  assert.equal(eventTimeline([{ type: "tool_start", tool: "edit", at: "1" }, { type: "tool_end", tool: "edit", at: "2" }])[0].hasDetails, false);
});

test("activity gives persisted reasoning and worker reports meaningful titles and details", () => {
  const timeline = eventTimeline([
    { type: "reasoning_summary", detail: "**Mapped** task lifecycle invariants", at: "1" },
    { type: "reasoning_summary", detail: "Checked automation ownership", at: "2" },
    { type: "tool_start", callId: "report", tool: "worker_report", args: '{"status":"completed","summary":"Derived domain architecture","artifact":"# Architecture"}', at: "3" },
    { type: "tool_end", callId: "report", tool: "worker_report", result: "Reported completed", at: "4" }
  ]);
  assert.deepEqual(timeline.map((item) => item.title), [
    "Reasoning · Mapped task lifecycle invariants",
    "Reasoning · Checked automation ownership",
    "Worker report · completed — Derived domain architecture"
  ]);
  assert.equal(timeline[2].hasDetails, true);
});

test("activity groups tool calls under the latest reasoning focus", () => {
  const groups = eventGroups([
    { type: "reasoning_summary", detail: "Inspect the current UI", at: "2026-08-25T10:00:00.000Z" },
    { type: "tool_start", callId: "read", tool: "read", args: '{"path":"public/app.js"}', at: "2026-08-25T10:00:01.000Z" },
    { type: "tool_end", callId: "read", tool: "read", result: "source", at: "2026-08-25T10:00:03.000Z" },
    { type: "reasoning_summary", detail: "Verify the focused redesign", at: "2026-08-25T10:00:04.000Z" },
    { type: "tool_start", callId: "test", tool: "bash", args: '{"command":"npm test"}', at: "2026-08-25T10:00:05.000Z" }
  ]);
  assert.deepEqual(groups.map((group) => [group.title, group.items.map((item) => item.key)]), [
    ["Inspect the current UI", ["read"]],
    ["Verify the focused redesign", ["test"]]
  ]);
  assert.equal(groups[1].items[0].status, "running");
});

test("stage activity identifies concurrent reviewers", () => {
  const timeline = eventTimeline([
    { type: "thinking", actor: "requirements", label: "Model is reasoning", at: "1" },
    { type: "tool_start", actor: "verification", callId: "read", tool: "read", args: '{"path":"test/app.test.js"}', at: "2" }
  ]);
  assert.deepEqual(timeline.map((item) => item.title), ["Reasoning · requirements · Model is reasoning", "verification · Read · test/app.test.js"]);
});

test("review stage becomes a findings-and-fixes timeline", () => {
  const milestones = stageMilestones({ reviews: [{
    round: 1, createdAt: "2026-08-25T10:01:00.000Z",
    actionableFindings: [{ severity: "blocking", claim: "Completion is not persisted", suggestedFix: "Save the state" }],
    fix: { report: { summary: "Persisted completion" }, diff: { stat: "1 file changed" }, artifact: { createdAt: "2026-08-25T10:02:00.000Z" } }
  }] }, { id: "verify", status: "active", updatedAt: "2026-08-25T10:03:00.000Z", activity: { startedAt: "2026-08-25T10:00:00.000Z" } });
  assert.deepEqual(milestones.map((item) => item.title), ["Agent review started.", "Review round 1 found issues.", "Focused fixes completed.", "Review round 2 started."]);
  assert.match(milestones[1].detail, /Completion is not persisted/);
  assert.match(milestones[2].detail, /Persisted completion/);
});

test("handoff timeline exposes merge queue, conflict resolution, verification, and integration", () => {
  const milestones = stageMilestones({
    merge: {
      status: "integrated", queuedAt: "2026-08-25T10:00:00.000Z", startedAt: "2026-08-25T10:01:00.000Z",
      sourceCwd: "/repo", branch: "codex/ticket", conflicts: ["src/app.js"], resolverStartedAt: "2026-08-25T10:02:00.000Z",
      resolverCompletedAt: "2026-08-25T10:03:00.000Z", resolutionArtifact: { content: "Combined both state transitions." },
      verifiedAt: "2026-08-25T10:04:00.000Z", checks: { status: "passed", summary: "npm test passed." }
    },
    integration: { sourceCwd: "/repo", commit: "abc123", integratedAt: "2026-08-25T10:05:00.000Z" }, artifacts: []
  }, { id: "handoff", status: "completed" });
  assert.deepEqual(milestones.map((item) => item.title), [
    "Added to merge queue.", "Automated merge started.", "Merge conflicts found.",
    "Conflict-resolution agent completed.", "Merged result verified.", "Changes integrated into the working directory."
  ]);
});

test("free text becomes a local ticket without losing the original request", () => {
  const ticket = freeTextTicket("# Improve search\n\nAdd keyboard navigation.", "A1B2-C3D4");
  assert.deepEqual([ticket.id, ticket.identifier, ticket.title, ticket.source], ["local-text-a1b2-c3d4", "TEXT-A1B2C3D4", "Improve search", "local"]);
  assert.match(ticket.description, /keyboard navigation/);
  assert.throws(() => freeTextTicket("", "id"), /Describe the task/);
});

test("formats JSON output including nested serialized JSON", () => {
  assert.equal(formatOutput('{"summary":"ok","rawOutput":"{\\"findings\\":[]}"}'), '{\n  "summary": "ok",\n  "rawOutput": {\n    "findings": []\n  }\n}');
});

test("filters artifacts for a workflow stage and includes review rounds in verification", () => {
  const artifacts = [{ stageId: "design" }, { stageId: "verify" }, { stageId: "review-round-1" }, { stageId: "implement" }];
  assert.equal(artifactsForStage(artifacts, "design").length, 1);
  assert.equal(artifactsForStage(artifacts, "verify").length, 2);
});

test("keeps an explicit step selection when another step awaits review", () => {
  const plan = { nodes: [{ id: "review", status: "review_ready" }, { id: "other", status: "ready" }] };
  assert.equal(preferredStepId(plan, "other"), "other");
  assert.equal(preferredStepId(plan, null), "review");
});
