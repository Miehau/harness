import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHarness } from "../src/pi-harness.js";
import { normalizePlan } from "../src/plan.js";
import { invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

test("Pi steering queues the stable instruction on the active worker session and preserves explicit acknowledgment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-steering-"));
  let releasePrompt;
  const promptReleased = new Promise((resolve) => { releasePrompt = resolve; });
  let activeTarget;
  let inactiveTarget;
  let workerReport;
  const queued = [];
  const session = {
    sessionId: "pi-session-1",
    sessionFile: join(root, "worker.jsonl"),
    state: { messages: [] },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    setSessionName() {},
    subscribe() { return () => {}; },
    async steer(instruction) { queued.push(instruction); },
    async prompt() {
      await promptReleased;
      await workerReport.execute("report", {
        status: "completed", summary: "Incorporated the correction", artifact: "# Result",
        incorporatedSteerIds: ["steer-1"]
      });
    },
    dispose() {}
  };
  const harness = new PiHarness({ dataDir: root, publish() {} });
  harness.sdk = async () => ({
    createAgentSession: async (options) => {
      workerReport = options.customTools.find((tool) => tool.name === "worker_report");
      return { session };
    },
    SessionManager: { create: () => ({}) }
  });
  const plan = normalizePlan({ title: "Steering", nodes: [{ id: "ledger", title: "Ledger", permission: "read", skills: [] }] });
  const target = { ticketId: "ticket-1", runId: "run-1", stepId: "ledger", attemptId: "attempt-1" };
  try {
    const running = harness.runStep({
      cwd: root, plan, step: plan.nodes[0], artifacts: [], images: [], ...target,
      onSessionActive(value) { activeTarget = value; },
      onSessionInactive(value) { inactiveTarget = value; }
    });
    while (!activeTarget) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(activeTarget, target);

    await harness.steer({ ...target, steerId: "steer-1", instruction: "[agent-plan-steer:steer-1]\nUpdate the ledger safely." });
    assert.deepEqual(queued, ["[agent-plan-steer:steer-1]\nUpdate the ledger safely."]);

    releasePrompt();
    const result = await running;
    assert.deepEqual(result.report.acknowledgedSteerIds, ["steer-1"]);
    assert.deepEqual(inactiveTarget, target);
    await assert.rejects(harness.steer({ ...target, steerId: "steer-1", instruction: "late" }), /not active yet or has already stopped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function activePlan() {
  const plan = normalizePlan({ nodes: [{
    id: "ledger", title: "Ledger", permission: "write", writeScope: "src/steering.js",
    expectedFiles: ["src/steering.js"], acceptanceCriteria: ["Steering is durable"]
  }] });
  Object.assign(plan.nodes[0], { status: "running", activeAttempt: { id: "attempt-1", status: "active" } });
  return plan;
}

test("an uncertain steering claim becomes an explained terminal failure when its worker ends", async () => {
  const plan = normalizePlan({ nodes: [{ id: "ledger", title: "Ledger", permission: "read", acceptanceCriteria: ["Steering is durable"] }] });
  Object.assign(plan.nodes[0], { status: "interrupted", activeAttempt: { id: "attempt-1", status: "interrupted" } });
  const harness = {
    ...mockHarness(),
    async steer() { throw new Error("Pi queue acceptance was interrupted"); },
    async runStep({ onSessionActive, onSessionInactive, ticketId, runId, attemptId }) {
      const target = { ticketId, runId, stepId: "ledger", attemptId };
      await onSessionActive(target);
      await onSessionInactive(target);
      return { prompt: "", rawOutput: "", output: "# Result", reviewNotes: [], sessionFile: null, report: { status: "completed", summary: "Done", artifact: "# Result" } };
    },
    async verifyStep() { return { summary: "Verified", findings: [], rawOutput: "", sessionFile: null }; },
    async generateCommitMessage() { return "test: verify steering\n\nWhy: test\nRequirement: REQ-test"; },
    async evidenceImages() { return []; }
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "paused", plan, workspace: { cwd: process.cwd() }, activeRuns: {} });
    const queued = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Preserve FIFO steering behavior for this worker." } });
    assert.equal(queued.json.state, "queued");
    await invoke(daemon, "POST", `/api/tickets/${id}/resume`, { body: {} });
    const deadline = Date.now() + 3000;
    let record;
    while (Date.now() < deadline) {
      record = daemon.store.read().ticketRuns[id].steering.records[0];
      if (record.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(record.state, "failed");
    assert.equal(record.reasonCode, "target_replaced");
    assert.match(record.reason, /worker session ended/);
  }, { harness, cwd: process.cwd() });
});

test("a pre-session steering claim is released and drains in FIFO order once delivery becomes available", async () => {
  let ready = false;
  const delivered = [];
  const harness = {
    ...mockHarness(),
    async steer(message) {
      if (!ready) {
        const error = new Error("The bound Pi worker session is not active yet or has already stopped.");
        error.code = "steering_session_unavailable";
        throw error;
      }
      delivered.push(message.steerId);
      return { sessionId: "pi-session-1" };
    }
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      status: "running", plan: activePlan(),
      activeRuns: { ledger: { runId: "worker-1", attemptId: "attempt-1", piSessionState: "starting" } }
    });
    const first = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(first.json.state, "queued");
    const pending = daemon.store.read().ticketRuns[id].steering.records[0];
    assert.equal(pending.claim.attempts, 0);
    assert.equal(pending.events.at(-1).type, "session_unavailable");

    ready = true;
    await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with the claim guard." } });
    const records = daemon.store.read().ticketRuns[id].steering.records;
    assert.deepEqual(records.map((record) => record.state), ["delivered", "delivered"]);
    assert.deepEqual(delivered, records.map((record) => record.id));
  }, { harness });
});
