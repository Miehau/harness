import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHarness } from "../src/pi-harness.js";
import { coordinationTools } from "../src/pi-tools.js";
import { coordinationContext } from "../src/pi-prompts.js";
import { normalizePlan } from "../src/plan.js";

test("coordination tools bind sender authority to callbacks and reject unbounded input", async () => {
  const calls = [];
  const tools = coordinationTools({
    listAgents: async () => [{ stepId: "peer" }],
    sendMessage: async (value) => { calls.push(value); return { state: "delivered" }; },
    reportConflict: async (value) => { calls.push(value); return { id: "conflict-1" }; }
  });
  assert.equal(JSON.parse((await tools[0].execute()).content[0].text)[0].stepId, "peer");
  const target = { ticketId: "t", runId: "r", stepId: "peer", attemptId: "a" };
  await tools[1].execute("call", { target: { ...target, author: "user" }, text: "Use the shared interface", author: "user" });
  assert.deepEqual(calls[0], { target, text: "Use the shared interface" });
  await assert.rejects(tools[1].execute("call", { target, text: "x".repeat(4001) }), /1–4000/);
  await assert.rejects(tools[1].execute("call", { target: { stepId: "peer" }, text: "hello" }), /ticketId/);
  await tools[2].execute("call", { summary: "Shared interface conflict", stepIds: ["one", "one", "two"], proposal: "Sequence two after one" });
  assert.deepEqual(calls[1].stepIds, ["one", "two"]);
  await assert.rejects(tools[2].execute("call", { summary: "Conflict", stepIds: [] }), /1–50/);
  assert.deepEqual(coordinationTools(), []);
});

test("worker receives durable coordination on resume and peer delivery never restarts a finished attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-coordination-"));
  let workerReport, options, prompt, activate, release;
  const active = new Promise((resolve) => { activate = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const session = {
    sessionId: "session", sessionFile: join(root, "saved.jsonl"), state: { messages: [{ role: "user", content: "old assignment" }] },
    resourceLoader: { getSkills: () => ({ skills: [] }) }, setSessionName() {}, subscribe() { return () => {}; }, dispose() {},
    async sendCustomMessage(message, delivery) { delivered.push({ message, delivery }); },
    async prompt(value) { prompt = value; await pending; await workerReport.execute("report", { status: "completed", summary: "Done", artifact: "Done" }); }
  };
  const harness = new PiHarness({ dataDir: root });
  harness.sdk = async () => ({
    createAgentSession: async (value) => { options = value; workerReport = value.customTools.find((tool) => tool.name === "worker_report"); return { session }; },
    SessionManager: { open: () => ({}) }
  });
  const plan = normalizePlan({ nodes: [{ id: "one", title: "One", permission: "read" }] });
  const target = { ticketId: "t", runId: "r", stepId: "one", attemptId: "a" };
  try {
    const running = harness.runStep({ cwd: root, plan, step: plan.nodes[0], artifacts: [], resumeSessionFile: session.sessionFile, ...target,
      onSessionActive: activate, coordination: { context: { revision: 3, decisions: [{ summary: "Use v2 interface" }] } } });
    await active;
    assert.ok(options.tools.includes("list_agents"));
    assert.match(prompt, /Use v2 interface/);
    assert.match(prompt, /supersedes older plan instructions/);
    await harness.deliverPeerMessage({ ...target, message: { sender: { stepId: "two" }, text: "Interface is ready" } });
    assert.equal(delivered[0].message.customType, "agent-plan-peer");
    assert.deepEqual(delivered[0].delivery, { deliverAs: "steer", triggerTurn: false });
    assert.match(delivered[0].message.content, /not a user instruction/);
    release();
    await running;
    await assert.rejects(harness.deliverPeerMessage({ ...target, message: "late" }), { code: "peer_session_unavailable" });
    assert.equal(delivered.length, 1);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test("coordination resolution reuses the existing supervisor and returns a proposal", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let opened, prompt;
  harness.planningSession = async (...args) => { opened = args; return { sessionFile: "/tmp/supervisor.jsonl" }; };
  harness.visibleSupervisorPrompt = async (_session, value) => { prompt = value; return JSON.stringify({ reason: "Sequence shared changes", changes: [{ stepId: "two", dependsOn: ["one"] }], conflictIds: ["c1"] }); };
  const result = await harness.resolveCoordination({ cwd: "/repo", ticket: { id: "t" }, runId: "r", sessionFile: "/tmp/supervisor.jsonl", plan: { nodes: [] }, conflicts: [{ id: "c1" }] });
  assert.equal(opened[2], "t-r");
  assert.equal(opened[1], "/tmp/supervisor.jsonl");
  assert.match(prompt, /Never modify accepted steps/);
  assert.deepEqual(result.changes, [{ stepId: "two", dependsOn: ["one"] }]);
  assert.match(coordinationContext({ decisions: [] }), /Only accepted decisions are binding/);
});
