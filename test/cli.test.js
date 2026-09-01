import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../src/plan.js";
import { runAgainstDaemon, seedRun, withDaemon } from "./helpers.js";

test("new text creates a queue item the UI would start", async () => {
  await withDaemon(async (daemon) => {
    const created = await runAgainstDaemon(daemon, ["new", "text", "Add an empty-state heading"]);
    assert.equal(created.code, 0);
    assert.equal(created.json.accepted, true);
    assert.match(created.json.identifier, /^TEXT-/);
    const backlog = await runAgainstDaemon(daemon, ["list", "backlog"]);
    assert.equal(backlog.code, 0);
    const row = backlog.json.tickets.find((ticket) => ticket.id === created.json.ticketId);
    assert.equal(row.title, "Add an empty-state heading");
    assert.equal(row.source, "local");
    assert.ok(row.status);
  });
});

test("select, timeline, resume, and queue clear talk to the same routes as the inspector", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "Seeded",
      nodes: [{
        id: "build",
        title: "Build",
        status: "running",
        permission: "write",
        writeScope: "src",
        expectedFiles: ["src/app.js"],
        estimatedChangedLines: 20,
        acceptanceCriteria: ["Works"],
        attempts: [{ events: [
          { type: "tool_start", tool: "edit", callId: "c1", args: "{\"path\":\"src/app.js\"}", at: "2026-09-01T12:00:00.000Z" },
          { type: "tool_end", tool: "edit", callId: "c1", result: "ok", at: "2026-09-01T12:00:01.000Z" }
        ] }]
      }]
    });
    const id = await seedRun(daemon, { status: "interrupted", plan });
    const selected = await runAgainstDaemon(daemon, ["select", id]);
    assert.equal(selected.json.selectedTicketId, id);
    const timeline = await runAgainstDaemon(daemon, ["list", "execution-timeline"]);
    assert.equal(timeline.json.ticketId, id);
    assert.equal(timeline.json.stepId, "build");
    assert.equal(timeline.json.events[0].tool, "edit");
    assert.equal(timeline.json.events[0].isError, false);
    const resumed = await runAgainstDaemon(daemon, ["select", id, "resume-run"]);
    assert.equal(resumed.json.accepted, true);
    const cleared = await runAgainstDaemon(daemon, ["queue", "clear"]);
    assert.equal(typeof cleared.json.cleared, "number");
  });
});

test("approve without an id uses the selected ticket (run manually)", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "Ready",
      nodes: [{
        id: "build", title: "Build", permission: "write", writeScope: "src",
        expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"]
      }]
    });
    const id = await seedRun(daemon, {
      status: "awaiting_approval",
      plan,
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve local execution plan" }
    });
    await runAgainstDaemon(daemon, ["select", id]);
    const approved = await runAgainstDaemon(daemon, ["approve"]);
    assert.equal(approved.code, 0);
    assert.equal(approved.json.accepted, true);
    assert.equal(approved.json.ticketId, id);
  });
});
