import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { invoke, mockHarness, runAgainstDaemon, waitFor, withDaemon } from "./helpers.js";
import { JsonStore } from "../src/store.js";
import { createOrchestratorService, guardOrchestratorUpdate } from "../src/orchestration.js";

const submission = (idempotencyKey = "conversation:panel") => ({ idempotencyKey, title: "Add activity panel", requirements: ["Show current activity"], acceptanceCriteria: ["The panel has an empty state"], exclusions: ["No notifications"], dependencies: [], uiImpact: { level: "material", reason: "New panel" }, origin: "conversation-test" });
const decision = (view, action, input = {}) => ({ action, expected: view.expected, authority: { mode: "user", actor: "conversation-test" }, input });
const base = "/api/orchestrator/tickets";

async function show(daemon, receipt) {
  const result = await invoke(daemon, "GET", `${base}/${receipt.ticketId}/runs/${receipt.runId}`);
  assert.equal(result.status, 200, result.text);
  return result.json;
}

test("concurrent submissions persist one draft and preserve idempotency through restart", async () => {
  let modelCalls = 0;
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const results = await Promise.all([invoke(daemon, "POST", base, { body: submission() }), invoke(daemon, "POST", base, { body: submission() })]);
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(results[0].json.ticketId, results[1].json.ticketId);
    assert.equal(results.filter((result) => result.json.created).length, 1);
    const receipt = results[0].json;
    assert.equal((await show(daemon, receipt)).status, "draft");
    assert.equal(modelCalls, 0);
    assert.equal(daemon.store.read().selectedTicketId, null);
    const conflict = await invoke(daemon, "POST", base, { body: { ...submission(), title: "Other panel" } });
    assert.equal(conflict.status, 400);
    assert.match(conflict.text, /different ticket content/);
    await daemon.close({ exit: false });
    const restored = new JsonStore(join(dataDir, "state-v3.json"), cwd);
    await restored.init();
    const api = createOrchestratorService({ state: { read: restored.read.bind(restored), update: restored.update.bind(restored) }, tickets: {}, dataDir });
    assert.deepEqual(await api.submit(submission()), { version: 1, created: false, ticketId: receipt.ticketId, runId: receipt.runId });
  }, { harness: { ...mockHarness(), clarifyRequirements: async () => { modelCalls++; return { artifact: "Requirements", questions: [] }; } } });
});

test("CLI decisions target exact runs, audit authority and reject stale checkpoints even inside queued writes", async () => {
  await withDaemon(async (daemon) => {
    const created = await runAgainstDaemon(daemon, ["orchestrator", "submit", JSON.stringify(submission())]);
    const other = (await invoke(daemon, "POST", base, { body: submission("other") })).json;
    await invoke(daemon, "POST", `/api/tickets/${other.ticketId}/select`);
    const view = await show(daemon, created.json);
    const started = await runAgainstDaemon(daemon, ["orchestrator", "act", view.ticketId, JSON.stringify(decision(view, "start"))]);
    assert.equal(started.code, 0);
    await waitFor(async () => assert.equal((await show(daemon, created.json)).status, "awaiting_requirements"), { timeoutMs: 5000 });
    assert.equal((await show(daemon, other)).status, "draft");
    const current = await show(daemon, created.json);
    assert.equal(current.decisions[0].action, "start");
    assert.equal(current.decisions[0].authority.mode, "user");
    assert.equal(current.uiImpact.level, "material");
    const stale = await invoke(daemon, "POST", `${base}/${view.ticketId}/actions`, { body: decision(view, "answer", { answers: "" }) });
    assert.equal(stale.status, 400);
    assert.match(stale.text, /Stale run or checkpoint/);
    const missing = await invoke(daemon, "POST", `${base}/${view.ticketId}/actions`, { body: { action: "answer", expected: current.expected, input: { answers: "" } } });
    assert.equal(missing.status, 400);

    // Simulate another decision winning after the HTTP read but before its write.
    const snapshot = daemon.store.read();
    const run = snapshot.ticketRuns[view.ticketId];
    const service = createOrchestratorService({ dataDir: "/unused", state: { read: () => structuredClone(snapshot) }, tickets: { clarify: async () => {
      run.checkpoint.id = "new-checkpoint";
      await guardOrchestratorUpdate(snapshot, (draft) => { draft.ticketRuns[view.ticketId].status = "wrongly-mutated"; });
    } } });
    await assert.rejects(service.act(view.ticketId, decision(current, "answer", { answers: "" })), /Stale run or checkpoint/);
    assert.notEqual(run.status, "wrongly-mutated");
  }, { harness: { ...mockHarness(), clarifyRequirements: async () => ({ artifact: "Requirements", questions: [], uiImpact: { level: "none", reason: "Fixture attempts downgrade" } }) } });
});

test("draft dependencies and file-based CLI submissions use the ordinary workflow boundary", async () => {
  await withDaemon(async (daemon, { dataDir }) => {
    const file = join(dataDir, "submission.json");
    await writeFile(file, JSON.stringify({ ...submission(), dependencies: ["missing-ticket"] }));
    const result = await runAgainstDaemon(daemon, ["orchestrator", "submit", `@${file}`]);
    const view = await show(daemon, result.json);
    assert.equal((await invoke(daemon, "POST", `${base}/${view.ticketId}/actions`, { body: decision(view, "start") })).status, 400);
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${view.ticketId}/start`)).status, 400);
    assert.equal((await show(daemon, result.json)).status, "draft");
    assert.equal((await show(daemon, result.json)).decisions.length, 0);
    assert.equal((await invoke(daemon, "POST", base, { body: { ...submission("bad"), auto: true } })).status, 400);
  });
});
