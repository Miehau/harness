import test from "node:test";
import assert from "node:assert/strict";
import { artifactsForStage, eventGroups, eventTimeline, executionGraph, finalReview, fleetLane, fleetTicketView, formatOutput, freeTextTicket, inspectionResourceLabel, inspectionSelection, inspectionSummary, inspectionTransitionAnnouncement, parseDiff, preferredStageId, preferredStepId, recentActivity, restartOptions, restoreInspectionSelection, reviewNotesForRows, runHeartbeat, runMetrics, stageDetailModel, stageMilestones, stepInspectorSummary } from "../public/ui-model.js";

test("resolves canonical attempt selection without replacing a retained choice", () => {
  const projection = {
    focus: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:two" },
    stages: [{ id: "stage:implement" }],
    workers: [{ id: "worker:build", stepId: "build", stageId: "stage:implement" }],
    attempts: [
      { id: "attempt:build:one", workerId: "worker:build", stageId: "stage:implement", status: "failed", latestAction: "Tests failed", evidence: { state: "incomplete" }, blocker: { type: "repository-check", summary: "Tests failed" } },
      { id: "attempt:build:two", workerId: "worker:build", stageId: "stage:implement", status: "verified", latestAction: "Checks passed", evidence: { state: "complete" } }
    ]
  };
  assert.deepEqual(inspectionSelection(projection, { attemptId: "attempt:build:one" }), { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:one" });
  assert.deepEqual(inspectionSelection(projection), { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:two" });
  assert.deepEqual(inspectionSummary({ attempt: projection.attempts[0] }), {
    status: "failed", latestAction: "Tests failed", blocker: { type: "repository-check", summary: "Tests failed" }, evidence: { state: "incomplete" }, nextAction: { kind: "none", label: "No action available" }
  });
  assert.equal(inspectionResourceLabel({ state: "not_retained" }), "Not retained");
  assert.equal(inspectionResourceLabel({ state: "truncated" }), "Truncated");
});

test("restores deliberate inspection selection and announces only meaningful attempt changes", () => {
  const previous = {
    focus: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:one", reason: "active" },
    stages: [{ id: "stage:implement" }], workers: [{ id: "worker:build", stageId: "stage:implement", attemptIds: ["attempt:build:one"] }],
    attempts: [{ id: "attempt:build:one", workerId: "worker:build", stageId: "stage:implement", lifecycle: "active" }]
  };
  const completed = {
    ...previous,
    attempts: [{ ...previous.attempts[0], lifecycle: "completed" }]
  };
  assert.deepEqual(restoreInspectionSelection(completed, { attemptId: "attempt:build:one" }), {
    selection: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:one" }, preserved: true, disappeared: false, reason: "preserved"
  });
  assert.match(inspectionTransitionAnnouncement(previous, completed, { attemptId: "attempt:build:one" }), /completed.*Retained history/i);

  const corrected = {
    ...completed,
    focus: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:two", reason: "active" },
    workers: [{ ...completed.workers[0], attemptIds: ["attempt:build:one", "attempt:build:two"] }],
    attempts: [...completed.attempts, { id: "attempt:build:two", workerId: "worker:build", stageId: "stage:implement", lifecycle: "active" }]
  };
  assert.match(inspectionTransitionAnnouncement(completed, corrected, { workerId: "worker:build" }), /correction attempt started/i);
  assert.deepEqual(restoreInspectionSelection(corrected, { workerId: "worker:build" }), {
    selection: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:two" }, preserved: true, disappeared: false, reason: "preserved"
  });
  assert.deepEqual(restoreInspectionSelection(corrected, { attemptId: "attempt:missing" }), {
    selection: { stageId: "stage:implement", workerId: "worker:build", attemptId: "attempt:build:two" }, preserved: false, disappeared: true, reason: "active"
  });
});

test("summarizes subscription usage without imposing a budget", () => {
  const run = {
    createdAt: "2026-08-24T18:00:00.000Z", completedAt: "2026-08-24T18:02:00.000Z", reviews: [{}, {}],
    plan: { nodes: [{ type: "step", attempts: [
      { events: [{ type: "usage", input: 100, output: 20, cacheRead: 50, cacheWrite: 5 }, { type: "tool_start" }] },
      { events: [{ type: "usage", input: 40, output: 10 }, { type: "tool_start" }] }
    ] }] }, stages: []
  };
  assert.deepEqual(runMetrics(run), { input: 140, output: 30, cacheRead: 50, cacheWrite: 5, calls: 2, correctionRounds: 2, durationSeconds: 120 });
});

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
  assert.equal(diff.files[0].hunks.length, 1);
  assert.equal(diff.files[0].hunks[0].context, "");
  assert.deepEqual(diff.files[0].rows.filter((row) => row.kind !== "hunk").map((row) => [row.kind, row.old, row.new]), [
    ["delete", 1, ""], ["add", "", 1], ["context", 2, 2]
  ]);
});

test("new-file metadata does not hide the first real diff hunk", () => {
  const diff = parseDiff("diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two");
  assert.equal(diff.files[0].hunks.length, 1);
  assert.equal(diff.files[0].hunks[0].header, "@@ -0,0 +1,2 @@");
  assert.deepEqual(diff.files[0].hunks[0].rows.map((row) => row.text), ["one", "two"]);
});

test("review notes attach only to their current old or new diff lines", () => {
  const rows = parseDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3 +3 @@\n-old\n+new").files[0].hunks[0].rows;
  const notes = [
    { id: "left", path: "a.ts", side: "LEFT", startLine: 3, endLine: 3, status: "current" },
    { id: "right", path: "a.ts", side: "RIGHT", startLine: 3, endLine: 3, status: "current" },
    { id: "stale", path: "a.ts", side: "RIGHT", startLine: 3, endLine: 3, status: "stale" },
    { id: "other", path: "b.ts", side: "RIGHT", startLine: 3, endLine: 3, status: "current" }
  ];
  assert.deepEqual(reviewNotesForRows(notes, "a.ts", rows).map((note) => note.id), ["left", "right"]);
});

test("live run heartbeat distinguishes active, stale, and permission-risk states", () => {
  const startedAt = "2026-08-24T18:00:00.000Z";
  const now = Date.parse("2026-08-24T18:01:00.000Z");
  assert.equal(runHeartbeat({ startedAt, lastEventAt: "2026-08-24T18:00:55.000Z", lastEvent: "Using bash" }, {}, now).state, "active");
  assert.equal(runHeartbeat({ startedAt, lastEvent: "Using bash" }, {}, now).state, "stale");
  assert.match(runHeartbeat({ startedAt, warning: true }, {}, now).note, /permission/);
  assert.equal(runHeartbeat({ startedAt, lastEvent: "Starting", activity: { lastEventAt: "2026-08-24T18:00:55.000Z", lastEvent: "Running repository checks" } }, {}, now).label, "Running repository checks");
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

test("cumulative tool updates replace earlier snapshots", () => {
  const [item] = eventTimeline([
    { type: "tool_start", callId: "1", tool: "read", at: "1" },
    { type: "tool_update", callId: "1", tool: "read", detail: "partial", replace: true, at: "2" },
    { type: "tool_update", callId: "1", tool: "read", detail: "complete", replace: true, at: "3" }
  ]);
  assert.equal(item.output, "complete");
});

test("recent activity puts the latest worker actions first", () => {
  const events = ["read", "edit", "test"].flatMap((tool, index) => [
    { type: "tool_start", callId: String(index), tool, at: String(index) },
    { type: "tool_end", callId: String(index), tool, result: "done", at: String(index) }
  ]);
  assert.deepEqual(recentActivity(events, 2).map((item) => item.tool), ["test", "edit"]);
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

test("workflow stage activity uses its recorded title and status", () => {
  const [item] = eventTimeline([
    { type: "tool_start", callId: "stage", tool: "workflow_stage", args: '{"id":"shape","title":"Execution plan shaping","status":"active"}', at: "1" },
    { type: "tool_end", callId: "stage", tool: "workflow_stage", result: "Workflow stage shape is active", at: "2" }
  ]);
  assert.equal(item.title, "Execution plan shaping");
  assert.equal(item.status, "active");
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

test("activity uses persisted group labels when an agent run is saved", () => {
  const groups = eventGroups([], [{
    key: "group:explore", title: "Explore repository", note: "Find the smallest relevant slice.",
    at: "2026-09-02T10:00:00.000Z", endedAt: "2026-09-02T10:00:02.000Z", status: "complete",
    events: [
      { type: "tool_start", tool: "read", callId: "read", args: '{"path":"src/app.js"}', at: "2026-09-02T10:00:00.000Z" },
      { type: "tool_end", tool: "read", callId: "read", result: "source", at: "2026-09-02T10:00:02.000Z" }
    ]
  }]);
  assert.deepEqual(groups.map((group) => [group.title, group.status, group.items[0].title]), [["Explore repository", "complete", "Read · src/app.js"]]);
});

test("activity hides empty generic lifecycle groups but keeps named phases", () => {
  const groups = eventGroups([], [{
    key: "lifecycle", title: "Agent activity", status: "complete", events: [
      { type: "agent_start", at: "2026-09-02T10:00:00.000Z" },
      { type: "usage", input: 20, output: 4, at: "2026-09-02T10:00:01.000Z" }
    ]
  }, {
    key: "checks", title: "Running repository checks", status: "running", events: [
      { type: "phase", label: "Running repository checks", at: "2026-09-02T10:00:02.000Z" }
    ]
  }]);
  assert.deepEqual(groups.map((group) => [group.title, group.status, group.items.length]), [["Running repository checks", "running", 0]]);
  assert.match(groups[0].note, /configured checks before review/);
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

test("handoff timeline lists captured visual evidence as proof without inventing shots", () => {
  const shots = [
    { kind: "visual-evidence", name: "desktop.png", stageId: "verify", createdAt: "2026-08-25T10:00:30.000Z" },
    { kind: "visual-evidence", name: "mobile.png", stageId: "verify", createdAt: "2026-08-25T10:00:31.000Z" }
  ];
  const withShots = stageMilestones({ artifacts: shots, integration: { sourceCwd: "/repo", commit: "abc", integratedAt: "2026-08-25T10:05:00.000Z" } }, { id: "handoff", status: "completed" });
  assert.equal(withShots[0].title, "Visual evidence attached as proof.");
  assert.equal(withShots[0].status, "2 shots");
  assert.match(withShots[0].detail, /desktop\.png/);
  assert.match(withShots[0].detail, /mobile\.png/);
  const withoutShots = stageMilestones({ artifacts: [{ kind: "handoff", name: "handoff.md" }], integration: { sourceCwd: "/repo", commit: "abc", integratedAt: "t" } }, { id: "handoff" });
  assert.equal(withoutShots.some((item) => /visual evidence/i.test(item.title)), false);
});

test("final review keeps supported visual proof and its final check summary", () => {
  const review = finalReview({
    artifacts: [{ kind: "visual-evidence", name: "desktop.png" }, { kind: "visual-evidence", name: "walkthrough.mp4" }, { kind: "visual-evidence", name: "notes.txt" }],
    reviews: [{ reviews: [
      { role: "deterministic", summary: "passed", checks: { status: "passed", summary: "node scripts/test.mjs" } },
      { role: "integration", summary: "No issues found" }
    ] }]
  });
  assert.deepEqual(review.proof.map((item) => item.media), ["image", "video"]);
  assert.deepEqual(review.checks, { status: "passed", summary: "node scripts/test.mjs", command: undefined });
  assert.deepEqual(review.reviews, [{ role: "integration", summary: "No issues found" }]);
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

test("handoff artifacts include verify visual-evidence without retagging them", () => {
  const artifacts = [
    { stageId: "handoff", kind: "handoff", name: "handoff.md" },
    { stageId: "verify", kind: "visual-evidence", name: "desktop.png" },
    { stageId: "verify", kind: "independent-review", name: "requirements.json" }
  ];
  assert.deepEqual(artifactsForStage(artifacts, "handoff").map((artifact) => artifact.name), ["handoff.md", "desktop.png"]);
  assert.deepEqual(artifactsForStage(artifacts, "verify").map((artifact) => artifact.name), ["desktop.png", "requirements.json"]);
});

test("keeps an explicit step selection when another step awaits review", () => {
  const plan = { nodes: [{ id: "review", status: "review_ready" }, { id: "other", status: "ready" }] };
  assert.equal(preferredStepId(plan, "other"), "other");
  assert.equal(preferredStepId(plan, null), "review");
});

test("defaults the inspector to the blocked or active workflow stage", () => {
  const stages = [{ id: "clarify", status: "completed" }, { id: "implement", status: "blocked" }, { id: "verify", status: "pending" }];
  assert.equal(preferredStageId(stages), "implement");
  assert.equal(preferredStageId(stages, "verify"), "verify");
});

test("stage details keep the implementation index ordered and split its dependency edges", () => {
  const run = {
    stages: [{ id: "implement", title: "Implement", status: "active" }, { id: "verify", title: "Verify", status: "pending" }],
    plan: { nodes: [
      { id: "foundation", type: "step", title: "Foundation", status: "accepted", dependsOn: [] },
      { id: "build", type: "step", title: "Build UI", status: "running", dependsOn: ["foundation"] },
      { id: "verify-ui", type: "step", stageId: "verify", title: "Verify UI", status: "ready", dependsOn: ["build"] }
    ] }
  };
  assert.deepEqual(stageDetailModel(run, "implement"), {
    stage: { id: "implement", title: "Implement", status: "active", position: 1, total: 2 },
    stepIndex: [{ id: "foundation", title: "Foundation", status: "accepted", position: 1 }, { id: "build", title: "Build UI", status: "running", position: 2 }],
    dependencies: { internal: [{ from: "foundation", to: "build", title: "Foundation", status: "accepted" }], external: [] }
  });
  assert.deepEqual(stageDetailModel(run, "verify").dependencies.external, [{ from: "build", to: "verify-ui", title: "Build UI", status: "running" }]);
});

test("step inspector surfaces real attention findings without inventing criterion progress", () => {
  const summary = stepInspectorSummary({
    status: "needs_attention",
    acceptanceCriteria: ["One", "Two"],
    artifacts: [{ id: "result" }],
    attempts: [{ verification: { findings: [{ severity: "high", claim: "Final-admin protection is unresolved" }] } }, { status: "interrupted" }]
  });
  assert.deepEqual(summary, {
    needsAttention: true,
    finding: "Final-admin protection is unresolved",
    findings: [{ severity: "high", claim: "Final-admin protection is unresolved" }],
    findingCount: 1,
    criteria: ["One", "Two"],
    artifactCount: 1,
    attemptCount: 2
  });
  assert.equal(stepInspectorSummary({ status: "accepted", lastError: "stale", attempts: [] }).needsAttention, false);
});

test("fleet rail groups tickets by operator urgency, not tracker buckets", () => {
  assert.equal(fleetLane(null), "idle");
  assert.equal(fleetLane({ status: "completed" }), "idle");
  assert.equal(fleetLane({ status: "running" }), "running");
  assert.equal(fleetLane({ status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" } }), "you");
  assert.equal(fleetLane({ status: "running", plan: { nodes: [{ id: "build", status: "review_ready" }] } }), "you");
  assert.equal(fleetLane({ status: "needs_attention" }), "you");
  assert.equal(fleetLane({ status: "interrupted" }), "you");
  assert.equal(fleetLane({ status: "paused" }), "you");
});

test("fleet ticket view omits findings and exposes stages plus selected agents", () => {
  const view = fleetTicketView(
    { id: "t", identifier: "TEXT-7F2", title: "Merge-queue rebase" },
    {
      status: "needs_attention",
      lastError: "duplicate preview-port bind in src/previews.js",
      createdAt: "2026-09-01T00:00:00.000Z",
      stages: [
        { id: "requirements", status: "completed" },
        { id: "explore", status: "completed" },
        { id: "design", status: "completed" },
        { id: "implement", status: "completed" },
        { id: "verify", status: "blocked" },
        { id: "handoff", status: "pending" }
      ],
      plan: { nodes: [
        { id: "rebase", title: "Rebase", agentId: "worker:rebase", status: "needs_attention", attempts: [{}, {}, {}] },
        { id: "tests", title: "Tests", agentId: "worker:tests", status: "ready" }
      ] }
    },
    { selected: true, now: Date.parse("2026-09-01T00:00:09.000Z") }
  );
  assert.equal(view.lane, "you");
  assert.equal(view.stateLabel, "needs you");
  assert.equal(view.stageLabel, "verify");
  assert.equal(view.agentCount, 2);
  assert.equal(view.idle, "9s idle");
  assert.equal(view.finding, undefined);
  assert.equal(JSON.stringify(view).includes("duplicate"), false);
  assert.deepEqual(view.stages.map((stage) => stage.kind), ["done", "done", "done", "done", "now", "pending"]);
  assert.deepEqual(view.agents.map((agent) => [agent.id, agent.name, agent.meta]), [["rebase", "rebase", "3 att"], ["tests", "tests", "queued"]]);
  assert.equal(fleetTicketView({ id: "t" }, { status: "needs_attention", plan: { nodes: [{ id: "rebase", status: "needs_attention" }] } }, { selected: false }).agents.length, 0);
  const planGate = fleetTicketView(
    { id: "p", identifier: "APP-1842", title: "Board" },
    { status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" }, plan: { nodes: [{ id: "a", status: "ready" }, { id: "b", status: "ready" }] } },
    { selected: true }
  );
  assert.equal(planGate.stateLabel, "plan gate");
  assert.equal(planGate.agentCount, 2);
  assert.equal(planGate.agents.length, 0);
});

test("offers only restart points backed by durable checkpoints", () => {
  const run = {
    baselineTree: "base", workspace: { cwd: "/worktree" },
    artifacts: ["requirements", "product-context-snapshot", "implementation-delta"].map((kind) => ({ kind })),
    plan: { nodes: [{ id: "one", title: "First", status: "accepted", baseTree: "base" }] }
  };
  assert.deepEqual(restartOptions(run).map((option) => option.value), ["stage:explore", "stage:design", "step:one", "stage:verify"]);
  assert.deepEqual(restartOptions({ ...run, merge: { status: "queued" } }), []);
});
