import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanningRunner } from "../src/planning.js";

function stages() {
  return ["requirements", "explore", "design"].map((id) => ({ id, status: "pending", summary: "" }));
}

function setStage(run, id, status, summary) {
  return Object.assign(run.stages.find((stage) => stage.id === id), { status, summary });
}

test("planning runner persists a redacted plan and retains the approval boundary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-planning-"));
  const run = {
    id: "ticket-1", runId: "run-1", status: "exploring", ticket: { id: "ticket-1", identifier: "LOCAL-1" },
    workspace: { cwd: dataDir }, access: { mode: "restricted" }, repositories: [], sessionFile: null,
    stageProfiles: { architecture: { model: "test" } }, stages: stages(), plan: { nodes: [] },
    artifacts: [
      { kind: "requirements", content: "Requirements" },
      { kind: "product-context-snapshot", content: "Product context" },
      { kind: "implementation-delta", content: "Existing implementation" },
      { kind: "ticket-lookahead", content: "Nearby ticket" }
    ]
  };
  const state = { workspace: { cwd: dataDir }, ticketRuns: { "ticket-1": run } };
  let input;
  const runner = createPlanningRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    runtime: { start: (_ticketId, work) => work(new AbortController().signal) },
    harness: { designTicket: async (value) => {
      input = value;
      return { artifact: "Design api_key=secret_abcdefgh", plan: { title: "Plan", nodes: [] }, sessionFile: "/private/session.jsonl" };
    } },
    artifacts: { dataDir, artifactText: async (artifact) => artifact?.content || "" },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    lifecycle: { setStage, mirrorCheckpoint: async () => {}, pauseIfWorkflowBlocked: () => false, saveSession: () => async () => {} }
  });
  const result = await runner.designTicket("ticket-1", "Proceed", new AbortController().signal);
  assert.deepEqual(result, { ticketId: "ticket-1", outcome: "planned", next: "awaiting-approval" });
  assert.equal(input.ticketLookAhead, "Nearby ticket");
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.plan.title, "Plan");
  assert.equal(run.artifacts.at(-1).kind, "architecture");
  assert.equal(run.checkpoint.kind, "awaiting_approval");
  assert.match(run.checkpoint.prompt, /not a filesystem sandbox/);
  assert.equal(JSON.stringify(run).includes("secret_abcdefgh"), false);
});

test("late requirement results cannot publish into a replacement run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-planning-late-"));
  const original = {
    id: "ticket-1", runId: "run-1", status: "queued", ticket: { id: "ticket-1", identifier: "LOCAL-1" },
    stageProfiles: { requirements: {} }, stages: stages(), artifacts: [], workspace: null
  };
  const replacement = {
    ...original, runId: "run-2", status: "awaiting_approval", artifacts: [], stages: stages(), checkpoint: { kind: "awaiting_approval" }
  };
  const state = { workspace: { cwd: dataDir }, ticketRuns: { "ticket-1": original } };
  let resolveRequirements;
  const requirements = new Promise((resolve) => { resolveRequirements = resolve; });
  let mirrored = 0;
  const runner = createPlanningRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    runtime: { start: (_ticketId, work) => work(new AbortController().signal) },
    harness: { clarifyRequirements: async () => requirements },
    artifacts: { dataDir, artifactText: async () => "" },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    lifecycle: { setStage, mirrorCheckpoint: async () => { mirrored++; }, pauseIfWorkflowBlocked: () => false, saveSession: () => async () => {} }
  });
  const pending = runner.prepareTicket("ticket-1");
  await new Promise((resolve) => setImmediate(resolve));
  state.ticketRuns["ticket-1"] = replacement;
  resolveRequirements({ artifact: "Late requirements", questions: [], sessionFile: "/old-session.jsonl" });
  assert.deepEqual(await pending, { ticketId: "ticket-1", outcome: "superseded" });
  assert.equal(replacement.status, "awaiting_approval");
  assert.deepEqual(replacement.artifacts, []);
  assert.equal(mirrored, 0);
});

test("late planning session callbacks do not persist after cancellation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-planning-session-cancel-"));
  const run = {
    id: "ticket-1", runId: "run-1", status: "exploring", ticket: { id: "ticket-1", identifier: "LOCAL-1" },
    workspace: { cwd: dataDir }, access: { mode: "restricted" }, repositories: [], sessionFile: null,
    stageProfiles: { architecture: {} }, stages: stages(), plan: { nodes: [] }, artifacts: [
      { kind: "requirements", content: "Requirements" }, { kind: "product-context-snapshot", content: "Context" },
      { kind: "implementation-delta", content: "Delta" }
    ]
  };
  const state = { workspace: { cwd: dataDir }, ticketRuns: { "ticket-1": run } };
  const controller = new AbortController();
  let onSessionFile;
  let resolveDesign;
  let saved = 0;
  const runner = createPlanningRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    runtime: { start: (_ticketId, work) => work(controller.signal) },
    harness: { designTicket: async (input) => {
      onSessionFile = input.onSessionFile;
      return new Promise((resolve) => { resolveDesign = resolve; });
    } },
    artifacts: { dataDir, artifactText: async (artifact) => artifact?.content || "" },
    activity: { capture: () => ({ onEvent() {}, snapshot: () => ({ events: [] }) }) },
    lifecycle: { setStage, mirrorCheckpoint: async () => {}, pauseIfWorkflowBlocked: () => false, saveSession: () => async () => { saved++; } }
  });
  const pending = runner.designTicket("ticket-1", "Proceed", controller.signal);
  while (!onSessionFile) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await onSessionFile("/late.jsonl");
  resolveDesign({ artifact: "Design", plan: { title: "Plan", nodes: [] }, sessionFile: "/late.jsonl" });

  assert.deepEqual(await pending, { ticketId: "ticket-1", outcome: "aborted" });
  assert.equal(saved, 0);
  assert.equal(run.sessionFile, null);
});
