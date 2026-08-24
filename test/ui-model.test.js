import test from "node:test";
import assert from "node:assert/strict";
import { eventTimeline, executionGraph, formatOutput, parseDiff, runHeartbeat } from "../public/ui-model.js";

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
  assert.match(timeline[0].title, /npm test/);
  assert.equal(timeline[0].key, "1");
  assert.equal(timeline[0].result, "32 tests pass");
  assert.equal(eventTimeline([{ type: "tool_start", tool: "edit", at: "1" }, { type: "tool_end", tool: "edit", at: "2" }])[0].hasDetails, false);
});

test("formats JSON output including nested serialized JSON", () => {
  assert.equal(formatOutput('{"summary":"ok","rawOutput":"{\\"findings\\":[]}"}'), '{\n  "summary": "ok",\n  "rawOutput": {\n    "findings": []\n  }\n}');
});
