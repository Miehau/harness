import test from "node:test";
import assert from "node:assert/strict";
import { executionGraph, parseDiff, runHeartbeat, summarizeRun } from "../public/ui-model.js";

test("builds graph levels, human run summaries, and readable diff rows", () => {
  const graph = executionGraph({ nodes: [
    { id: "research", type: "group", children: [{ id: "a", dependsOn: [] }, { id: "b", dependsOn: [] }] },
    { id: "build", type: "step", dependsOn: ["research"] },
    { id: "verify", type: "step", dependsOn: ["build"] }
  ] });
  assert.deepEqual(graph.columns.map((column) => column.map((unit) => unit.id)), [["research"], ["build"], ["verify"]]);
  assert.deepEqual(graph.edges, [{ from: "research", to: "build" }, { from: "build", to: "verify" }]);

  assert.deepEqual(summarizeRun([
    { type: "tool_start", tool: "read", at: "1" },
    { type: "tool_start", tool: "edit", at: "2" },
    { type: "tool_end", tool: "bash", isError: true, at: "3" }
  ]).map((item) => item.title), ["Explored the repository", "Changed the implementation", "Some commands needed correction"]);

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
