import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store.js";

test("server restart marks active work as interrupted and clears dead runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-store-"));
  const file = join(root, "state.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 3, workspace: { cwd: root }, stageProfiles: {}, selectedTicketId: "run-1",
      ticketRuns: {
        "run-1": { status: "fixing", activeRuns: { step: {
          runId: "dead", attemptId: "attempt-4", startedAt: "2026-09-02T10:00:00.000Z",
          lastEvent: "Editing", lastEventAt: "2026-09-02T10:01:00.000Z", prompt: "Resume with api_key=0123456789abcdef",
          activity: { rawOutput: "partial output", prompts: [{ content: "Resume with api_key=0123456789abcdef" }], events: [{ type: "phase", label: "Editing" }] }
        } }, plan: { nodes: [{ id: "step", type: "step", status: "fixing", attempts: [{ attemptId: "attempt-3", status: "verified" }] }] } },
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
    assert.deepEqual(state.ticketRuns["run-1"].plan.nodes[0].attempts.map((attempt) => attempt.attemptId), ["attempt-3", "attempt-4"]);
    assert.equal(state.ticketRuns["run-1"].plan.nodes[0].attempts[1].status, "interrupted");
    assert.equal(state.ticketRuns["run-1"].plan.nodes[0].attempts[1].terminationReason, "daemon_restart");
    assert.equal(state.ticketRuns["run-1"].plan.nodes[0].attempts[1].rawOutput, "partial output");
    assert.equal(state.ticketRuns["run-1"].plan.nodes[0].attempts[1].prompt.includes("0123456789abcdef"), false);
    const reloaded = await new JsonStore(file, root).init();
    assert.equal(reloaded.ticketRuns["run-1"].plan.nodes[0].attempts.length, 2);
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

test("store upgrade migrates legacy artifact bodies into authorized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-artifact-upgrade-"));
  const file = join(root, "state-v3.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 5, workspace: { cwd: root }, ticketRuns: {
        "run-1": {
          id: "run-1", runId: "legacy-run", status: "completed", ticket: { id: "run-1", identifier: "LEG-1" },
          artifacts: [{ id: "legacy-output", name: "output.md", kind: "agent-output", stageId: "implement", content: "legacy api_key=0123456789abcdef" }]
        }
      }
    }));
    const state = await new JsonStore(file, root).init();
    const artifact = state.ticketRuns["run-1"].artifacts[0];
    assert.equal(artifact.content, undefined);
    assert.match(artifact.path, /ticket-runs\/leg-1\/runs\/legacy-run\/artifacts\/implement\/agent-output-[a-f0-9]{10}-output\.md$/);
    assert.equal((await readFile(artifact.path, "utf8")).includes("0123456789abcdef"), false);
    assert.equal((await readFile(file, "utf8")).includes("0123456789abcdef"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store migration preserves duplicate legacy artifact bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-artifact-collision-"));
  const file = join(root, "state-v3.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 5, workspace: { cwd: root }, ticketRuns: {
        "run-1": {
          id: "run-1", runId: "legacy-run", status: "completed", ticket: { id: "run-1", identifier: "LEG-1" },
          checkpoint: { evidenceArtifactIds: ["legacy-output", "legacy-output"], media: [{ id: "legacy-output" }, { id: "legacy-output" }] },
          artifacts: [
            { id: "legacy-output", name: "output.md", kind: "agent-output", stageId: "implement", stepId: "build", attemptId: "attempt-1", content: "first body" },
            { id: "legacy-output", name: "output.md", kind: "agent-output", stageId: "implement", stepId: "build", attemptId: "attempt-1", content: "second body" }
          ]
        }
      }
    }));
    const state = await new JsonStore(file, root).init();
    const artifacts = state.ticketRuns["run-1"].artifacts;
    assert.notEqual(artifacts[0].id, artifacts[1].id);
    assert.notEqual(artifacts[0].path, artifacts[1].path);
    assert.match(artifacts[0].path, /agent-output-[a-f0-9]{10}-output\.md$/);
    assert.match(artifacts[1].path, /agent-output-[a-f0-9]{10}-output\.md$/);
    assert.equal(await readFile(artifacts[0].path, "utf8"), "first body");
    assert.equal(await readFile(artifacts[1].path, "utf8"), "second body");
    assert.equal(artifacts.every((artifact) => artifact.content === undefined), true);
    assert.deepEqual(state.ticketRuns["run-1"].checkpoint.evidenceArtifactIds, artifacts.map((artifact) => artifact.id));
    assert.deepEqual(state.ticketRuns["run-1"].checkpoint.media.map((artifact) => artifact.id), artifacts.map((artifact) => artifact.id));
  } finally {
    await rm(root, { recursive: true, force: true });
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
