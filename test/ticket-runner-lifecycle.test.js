import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketRunner } from "../src/ticket-runner.js";

function stages() {
  return ["requirements", "explore", "design", "implement", "verify", "handoff"].map((id) => ({ id, status: "pending", summary: "" }));
}

test("deferred execution startup cannot advance a replacement run", async () => {
  const original = {
    id: "ticket-1", runId: "run-1", ticket: { id: "ticket-1", source: "local" }, workspace: { cwd: "/unused" },
    stages: stages(), plan: { nodes: [] }, artifacts: [], activeRuns: {}, status: "awaiting_approval"
  };
  const replacement = { ...original, runId: "run-2", status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" }, stages: stages() };
  const state = { workspace: { cwd: "/unused" }, ticketRuns: { "ticket-1": original } };
  let resolveStart;
  const started = new Promise((resolve) => { resolveStart = resolve; });
  const runner = createTicketRunner({
    state: { read: () => state, update: async (mutate) => mutate(state) },
    runtime: { start: (_ticketId, work) => work(new AbortController().signal), activeTickets: new Map(), activeMerges: new Set() },
    dataDir: "/unused",
    lifecycle: { setStage: () => {}, mirrorCheckpoint: async () => {}, stopPreviews: async () => {} },
    workflow: { pauseIfBlocked: () => false },
    tracker: { ensureExecutionStarted: async () => started, mirrorBlocker: async () => {} },
    steps: { execute: async () => {}, accept: async () => {} },
    finalReview: { run: async () => {} }, delivery: { schedule: async () => ({}) },
    artifacts: { artifactText: async () => "" }, proof: { gate: () => ({ eligible: true }), gateError: () => "", persistSnapshot: async () => {} }
  });
  const pending = runner.runTicket("ticket-1");
  await new Promise((resolve) => setImmediate(resolve));
  state.ticketRuns["ticket-1"] = replacement;
  resolveStart();

  assert.deepEqual(await pending, { kind: "superseded", ticketId: "ticket-1" });
  assert.equal(replacement.status, "awaiting_approval");
  assert.deepEqual(replacement.checkpoint, { kind: "awaiting_approval" });
});

function commandRunner(state, {
  schedule = async () => ({ promise: Promise.resolve() }),
  harness = {},
  tracker = { ensureExecutionStarted: async () => {}, mirrorBlocker: async () => {} }
} = {}) {
  let starts = 0;
  const runner = createTicketRunner({
    state: {
      read: () => state,
      update: async (mutate) => {
        mutate(state);
        return state;
      }
    },
    runtime: {
      start: () => {
        starts += 1;
        return new Promise(() => {});
      },
      activeTickets: new Map(),
      activeMerges: new Set()
    },
    dataDir: state.dataDir,
    lifecycle: { setStage: () => {}, mirrorCheckpoint: async () => {}, stopPreviews: async () => {} },
    workflow: { pauseIfBlocked: () => false },
    tracker,
    steps: { execute: async () => {}, accept: async () => {} },
    finalReview: { run: async () => {} },
    delivery: { schedule },
    artifacts: { artifactText: async (artifact) => artifact?.content || "" },
    proof: { gate: () => ({ eligible: true }), gateError: () => "", persistSnapshot: async () => {} },
    harness,
    config: { isAsyncResponse: () => true }
  });
  return { runner, starts: () => starts };
}

test("plan approval initializes and persists the proof map before starting execution", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ticket-runner-"));
  const run = {
    id: "ticket-1",
    runId: "run-1",
    ticket: { id: "ticket-1", title: "Proof-bound plan", updatedAt: "tracker-r2" },
    status: "awaiting_approval",
    checkpoint: { kind: "awaiting_approval" },
    plan: { title: "Plan", nodes: [] },
    stages: stages(),
    artifacts: [],
    activeRuns: {},
    automaticAdmission: false
  };
  const state = { dataDir, workspace: { cwd: dataDir }, ticketRuns: { "ticket-1": run } };

  const service = commandRunner(state);
  const result = await service.runner.approvePlan("ticket-1", { auto: true });

  assert.deepEqual(result, { accepted: true, ticketId: "ticket-1" });
  assert.equal(run.auto, true);
  assert.equal(run.ticketSnapshot.title, "Proof-bound plan");
  assert.equal(run.trackerRevision, "tracker-r2");
  assert.equal(run.proofMap.version, 1);
  assert.equal(run.artifacts.at(-1).kind, "proof-map");
  assert.equal(run.planApprovedAt, run.proofMap.approvedAt);
  assert.equal(service.starts(), 1);
});

test("delivery recovery reschedules the saved evidence context without rerunning the pipeline", async () => {
  const run = {
    id: "ticket-1",
    runId: "run-1",
    ticket: { id: "ticket-1", title: "Delivery recovery" },
    status: "needs_attention",
    recovery: { kind: "delivery", uncertainExternalActions: false },
    artifacts: [{ kind: "product-context-update", content: "context proposal" }],
    reviews: [{ diff: { files: ["src/app.js"], patch: "patch" } }],
    plan: { nodes: [] },
    stages: stages(),
    activeRuns: {}
  };
  const state = { workspace: { cwd: "/unused" }, ticketRuns: { "ticket-1": run } };
  let scheduled;
  const { runner } = commandRunner(state, {
    schedule: async (ticketId, options) => {
      scheduled = { ticketId, options };
      return { promise: Promise.resolve() };
    }
  });

  assert.deepEqual(await runner.resume("ticket-1"), {
    accepted: true,
    ticketId: "ticket-1",
    recovery: "delivery"
  });
  assert.deepEqual(scheduled, {
    ticketId: "ticket-1",
    options: { diff: run.reviews[0].diff, contextContent: "context proposal" }
  });
});

test("late workflow continuation cannot update a replacement run", async () => {
  const checkpoint = {
    id: "gate-1",
    kind: "awaiting_approval",
    source: "supervisor",
    title: "Supervisor review",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const original = {
    id: "ticket-1",
    runId: "run-1",
    ticket: { id: "ticket-1", title: "Workflow" },
    status: "awaiting_approval",
    checkpoint,
    workflow: { checkpoints: [{ ...checkpoint, status: "pending" }] },
    plan: { nodes: [] },
    stages: stages(),
    artifacts: [],
    activeRuns: {}
  };
  const replacement = {
    ...original,
    runId: "run-2",
    checkpoint: { id: "replacement", kind: "awaiting_approval" },
    workflow: { checkpoints: [] },
    clarificationHistory: []
  };
  const state = { workspace: { cwd: "/unused" }, ticketRuns: { "ticket-1": original } };
  let resolveContinuation;
  const pendingContinuation = new Promise((resolve) => { resolveContinuation = resolve; });
  const { runner } = commandRunner(state, {
    harness: { continueWorkflow: async () => pendingContinuation }
  });

  const pending = runner.acceptCheckpointAnswer("ticket-1", "Proceed", "dashboard");
  await new Promise((resolve) => setImmediate(resolve));
  state.ticketRuns["ticket-1"] = replacement;
  resolveContinuation({ reply: "late response", sessionFile: "/private/session" });

  assert.equal(await pending, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replacement.clarificationHistory, []);
  assert.equal(replacement.workflow.lastReview, undefined);
  assert.equal(replacement.status, "awaiting_approval");
});

test("stalled graphs surface attention while active work and input gates remain waiting", async () => {
  for (const status of ['draft', 'running', 'verifying', 'needs_input', 'awaiting_approval', 'review_ready']) {
    const run = {
      id: 'ticket-1', runId: 'run-1', ticket: { id: 'ticket-1', source: 'linear' },
      workspace: { cwd: '/unused', vcs: 'git' }, status: 'running', stages: stages(),
      plan: { nodes: [{ id: 'a', type: 'step', status, dependsOn: [] }] }, activeRuns: {}
    };
    const state = { ticketRuns: { 'ticket-1': run } };
    const { runner } = commandRunner(state);
    await runner.advanceTicket('ticket-1', new AbortController().signal);
    assert.equal(run.status, status === 'draft' ? 'needs_attention' : 'running');
    if (status === 'draft') assert.match(run.checkpoint.prompt, /a \(draft/);
  }
});
