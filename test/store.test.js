import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactPersistedState, JsonStore } from "../src/store.js";

test("persisted audit detail stays bounded without losing prompts and event summaries", () => {
  const huge = "x".repeat(300000);
  const activity = { events: [{ type: "tool_end", tool: "test", result: huge }], prompts: [{ actor: "reviewer", content: huge }], rawOutput: huge, groups: [{ events: [] }] };
  const attempt = { events: [{ type: "tool_end", result: huge }], rawOutput: huge, activityGroups: [{ events: [] }], verification: { rawOutput: huge } };
  const state = { ticketRuns: { one: { stages: [{ activity }], activeRuns: { step: { activity: structuredClone(activity) } }, plan: { nodes: [{ id: "step", attempts: [attempt] }] } } }, retainedRuns: {} };
  compactPersistedState(state);
  assert.match(activity.prompts[0].content, /state detail truncated/);
  assert.equal(activity.events[0].tool, "test");
  assert.match(activity.events[0].result, /state detail truncated/);
  assert.equal("groups" in activity, false);
  assert.match(attempt.rawOutput, /state detail truncated/);
  assert.equal("activityGroups" in attempt, false);
  assert.match(attempt.verification.rawOutput, /state detail truncated/);
});

test("server restart marks active work as interrupted and clears dead runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-store-"));
  const file = join(root, "state.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 3, workspace: { cwd: root }, stageProfiles: {}, selectedTicketId: "run-1",
      ticketRuns: {
        "run-1": { status: "fixing", activeRuns: { step: { runId: "dead" } }, plan: { nodes: [{ id: "step", type: "step", status: "fixing" }] } },
        "run-2": { status: "merging", merge: { status: "merging" }, plan: { nodes: [] } },
        "run-3": { status: "waiting_for_merge", merge: { status: "waiting_for_merge", externalActionPending: "squash_merge" }, plan: { nodes: [] } }
      }
    }));
    const state = await new JsonStore(file, root).init();
    assert.equal(state.version, 6);
    assert.deepEqual(state.settings, { projectMode: "manual", pollIntervalSeconds: 60 });
    assert.equal(state.ticketRuns["run-1"].status, "interrupted");
    assert.equal(state.ticketRuns["run-1"].plan.nodes[0].status, "interrupted");
    assert.deepEqual(state.ticketRuns["run-1"].activeRuns, {});
    assert.equal(state.ticketRuns["run-2"].status, "interrupted");
    assert.equal(state.ticketRuns["run-2"].merge.status, "interrupted");
    assert.equal(state.ticketRuns["run-2"].recovery.kind, "delivery");
    assert.equal(state.ticketRuns["run-2"].recovery.uncertainExternalActions, false);
    assert.equal(state.ticketRuns["run-3"].recovery.uncertainExternalActions, true);
    assert.match(state.ticketRuns["run-3"].recovery.message, /inspect the forge/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("preserves daemon settings and ignores retired ticket capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-settings-"));
  try {
    const file = join(root, "state.json");
    await writeFile(file, JSON.stringify({ version: 4, workspace: { cwd: root }, settings: { maxConcurrentTickets: 6, projectMode: "automatic", pollIntervalSeconds: 30 }, ticketRuns: {} }));
    assert.deepEqual((await new JsonStore(file, root).init()).settings, { projectMode: "automatic", pollIntervalSeconds: 30 });
    await writeFile(file, JSON.stringify({ version: 4, workspace: { cwd: root }, settings: { maxConcurrentTickets: 0 }, ticketRuns: {} }));
    assert.deepEqual((await new JsonStore(file, root).init()).settings, { projectMode: "manual", pollIntervalSeconds: 60 });
  } finally {
    await rm(root, { recursive: true });
  }
});
