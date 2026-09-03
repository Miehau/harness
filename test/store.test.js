import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactPersistedState, JsonStore } from "../src/store.js";

test("persisted audit detail stays bounded without losing prompts and event summaries", () => {
  const huge = "x".repeat(300000);
  const activity = { events: [{ type: "tool_end", tool: "test", result: huge }], prompts: [{ actor: "reviewer", content: huge }], rawOutput: huge, groups: [{ events: [] }] };
  const attempt = { events: [{ type: "tool_end", result: huge }], rawOutput: huge, activityGroups: [{ events: [] }], verification: { rawOutput: huge }, diff: { stat: "1 file", patch: huge }, checkDiff: { patch: huge }, aggregateDiff: { patch: huge } };
  const state = { ticketRuns: { one: { stages: [{ activity, diff: { patch: huge } }], activeRuns: { step: { activity: structuredClone(activity) } }, plan: { nodes: [{ id: "step", diff: { patch: huge }, attempts: [attempt] }] }, reviews: [{ diff: { patch: huge }, fix: { diff: { patch: huge } } }] } }, retainedRuns: {} };
  compactPersistedState(state);
  assert.match(activity.prompts[0].content, /state detail truncated/);
  assert.ok(activity.prompts[0].content.length < 51_000);
  assert.equal(activity.events[0].tool, "test");
  assert.match(activity.events[0].result, /state detail truncated/);
  assert.ok(activity.events[0].result.length < 5_000);
  assert.equal("groups" in activity, false);
  assert.match(attempt.rawOutput, /state detail truncated/);
  assert.ok(attempt.rawOutput.length < 51_000);
  assert.equal("activityGroups" in attempt, false);
  assert.match(attempt.verification.rawOutput, /state detail truncated/);
  assert.equal(attempt.diff.patch, undefined);
  assert.equal(attempt.diff.stat, "1 file");
  assert.equal(attempt.checkDiff.patch, undefined);
  assert.equal(attempt.aggregateDiff.patch, undefined);
  assert.equal(state.ticketRuns.one.stages[0].diff.patch, undefined);
  assert.equal(state.ticketRuns.one.plan.nodes[0].diff.patch, undefined);
  assert.equal(state.ticketRuns.one.reviews[0].diff.patch, undefined);
  assert.equal(state.ticketRuns.one.reviews[0].fix.diff.patch, undefined);
});

test("persisted activity keeps the newest bounded audit window", () => {
  const activity = {
    events: Array.from({ length: 150 }, (_, index) => ({ label: `event-${index}` })),
    prompts: Array.from({ length: 15 }, (_, index) => ({ content: `prompt-${index}` }))
  };
  const attempt = { events: Array.from({ length: 150 }, (_, index) => ({ label: `attempt-${index}` })) };
  compactPersistedState({ ticketRuns: { one: { stages: [{ activity }], plan: { nodes: [{ id: "step", attempts: [attempt] }] } } } });
  assert.equal(activity.events.length, 100);
  assert.equal(activity.events[0].label, "event-50");
  assert.equal(activity.events.at(-1).label, "event-149");
  assert.equal(activity.prompts.length, 10);
  assert.equal(activity.prompts[0].content, "prompt-5");
  assert.equal(attempt.events.length, 100);
  assert.equal(attempt.events[0].label, "attempt-50");
});

test("keeps file-backed artifact bodies out of memory and persisted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-artifact-state-"));
  const file = join(root, "state.json");
  const artifactPath = join(root, "ticket-runs", "one", "result.md");
  await mkdir(join(root, "ticket-runs", "one"), { recursive: true });
  await writeFile(artifactPath, "x".repeat(10_000));
  try {
    const store = new JsonStore(file, root);
    await store.init();
    await store.update((state) => {
      const artifact = { id: "result", name: "result.md", kind: "agent-output", path: artifactPath, content: "x".repeat(10_000) };
      state.ticketRuns.one = {
        status: "paused", stages: [], activeRuns: {}, artifacts: [{ ...artifact }],
        plan: { nodes: [{ id: "step", type: "step", artifacts: [{ ...artifact }], attempts: [{ artifacts: [{ ...artifact }] }] }] },
        reviews: [{ fix: { artifact: { ...artifact } } }]
      };
      state.ticketRuns.two = {
        status: "paused", stages: [], activeRuns: {}, artifacts: [
          { id: "external", name: "external.md", kind: "agent-output", path: join(tmpdir(), "external.md"), content: "inline fallback" },
          { id: "missing", name: "missing.md", kind: "agent-output", path: join(root, "ticket-runs", "missing.md"), content: "only surviving copy" }
        ]
      };
    });
    const memory = store.read();
    assert.equal(memory.ticketRuns.one.artifacts[0].content, undefined);
    assert.equal(memory.ticketRuns.one.artifacts[0].bodyStored, true);
    assert.match(memory.ticketRuns.one.artifacts[0].bodySummary, /state detail truncated/);
    assert.equal(memory.ticketRuns.one.plan.nodes[0].artifacts[0].content, undefined);
    assert.equal(memory.ticketRuns.one.plan.nodes[0].attempts[0].artifacts[0].content, undefined);
    assert.equal(memory.ticketRuns.one.reviews[0].fix.artifact.content, undefined);
    assert.equal(memory.ticketRuns.two.artifacts[0].content, "inline fallback");
    assert.equal(memory.ticketRuns.two.artifacts[1].content, "only surviving copy");
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.ticketRuns.one.artifacts[0].content, undefined);
    assert.equal(persisted.ticketRuns.one.artifacts[0].bodyStored, true);
    assert.equal(persisted.ticketRuns.two.artifacts[0].content, "inline fallback");
    assert.equal(persisted.ticketRuns.two.artifacts[1].content, "only surviving copy");
    const reloaded = await new JsonStore(file, root).init();
    assert.equal(reloaded.ticketRuns.one.artifacts[0].content, undefined);
  } finally {
    await rm(root, { recursive: true });
  }
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
    assert.equal(state.ticketRuns["run-1"].cleanup.outcome, "incomplete");
    assert.match(state.ticketRuns["run-1"].cleanup.executions[0].diagnostics[0], /predates durable containment/);
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

test("normalizes active and retained cleanup evidence without erasing diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-cleanup-store-"));
  try {
    const file = join(root, "state.json");
    await writeFile(file, JSON.stringify({
      version: 6, workspace: { cwd: root }, ticketRuns: {
        active: { status: "paused", plan: { nodes: [] }, cleanup: { executions: [{ executionId: "active-worker", outcome: "unknown", diagnostics: ["adapter lost"], unresolved: [{ pid: 9, reason: "unknown" }] }] } }
      },
      retainedRuns: {
        "old:run": { status: "completed", cleanup: { executions: [{ executionId: "old-worker", outcome: "unsupported", platform: { name: "darwin", supported: false }, diagnostics: ["no adapter"] }] } }
      }
    }));
    const state = await new JsonStore(file, root).init();
    assert.equal(state.ticketRuns.active.cleanup.outcome, "incomplete");
    assert.deepEqual(state.ticketRuns.active.cleanup.executions[0].diagnostics, ["adapter lost"]);
    assert.equal(state.retainedRuns["old:run"].cleanup.outcome, "unsupported");
    assert.deepEqual(state.retainedRuns["old:run"].cleanup.executions[0].platform, { name: "darwin", supported: false });
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
