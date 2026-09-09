import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { invoke, mockHarness, runAgainstDaemon, waitFor, withDaemon } from "./helpers.js";
import { normalizePlan } from "../src/plan.js";
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

test("conversation CLI follows a material ticket through revision, restart, execution and final proof", { timeout: 30000 }, async () => {
  let evidenceRoot, captures = 0, workers = 0;
  const results = (proofMap, artifacts) => proofMap.criteria.map((criterion) => ({
    criterionId: criterion.id, status: "verified", explanation: { summary: "Mock independent verification" },
    evidence: artifacts.filter((artifact) => artifact.kind === "visual-evidence" && artifact.criterionIds?.includes(criterion.id)).map(({ id }) => ({ type: "media", artifactId: id }))
  }));
  const harness = { ...mockHarness(),
    exploreTicket: async () => ({ artifact: "Reuse existing components", questions: [] }),
    lookAheadTickets: async () => ({ artifact: "No dependencies" }),
    designTicket: async () => ({ artifact: "Panel design", plan: normalizePlan({ uiImpact: { level: "material", reason: "New panel" }, nodes: [{ id: "panel", title: "Panel", permission: "write", writeScope: "panel.txt", expectedFiles: ["panel.txt"], estimatedChangedLines: 1, requiresVisualEvidence: true, acceptanceCriteria: ["The panel has an empty state"], criterionBindings: [{ index: 0, id: "ac-empty", evidence: "screenshot", journeyId: "panel-empty" }] }] }) }),
    proposeUi: async ({ feedback }) => ({ html: `<main><h1>${feedback ? "Compact" : "Activity"} panel</h1></main>`, summary: feedback || "Activity panel direction" }),
    runStep: async ({ cwd }) => { workers++; await writeFile(join(cwd, "panel.txt"), "Mock panel implementation\n"); return { report: { status: "completed", summary: "Mock worker completed", artifact: "Mock panel implementation" }, output: "Mock worker", rawOutput: "", sessionFile: null }; },
    evidenceImages: async () => [],
    generateCommitMessage: async () => "test: mock panel workflow",
    runRepositoryChecks: async ({ environment = {}, proofCriteria = [] }) => {
      const path = join(evidenceRoot, `mock-capture-${++captures}.png`);
      // This fixture tests evidence plumbing, not a real panel's appearance.
      await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64"));
      return { status: "passed", command: "mock-verify", summary: "Mock checks passed", output: "", evidence: [{ name: `mock-capture-${captures}.png`, path, mediaKind: "image", mediaType: "image/png", boundTicketId: environment.AGENT_PLAN_CAPTURE_TICKET_ID, boundRunId: environment.AGENT_PLAN_CAPTURE_RUN_ID,
        criterionIds: JSON.parse(environment.AGENT_PLAN_CAPTURE_CRITERIA || JSON.stringify(proofCriteria)).map(({ id }) => id), commands: [["panel", "empty"]], assertions: [{ selector: "#panel", text: "No activity" }] }] };
    },
    verifyStep: async ({ proofMap, artifacts }) => ({ summary: "Mock step review", findings: [], criterionResults: results(proofMap, artifacts), rawOutput: "", sessionFile: null }),
    reviewTicket: async ({ role, proofMap, artifacts }) => ({ role, summary: "Mock final review", findings: [], criterionResults: results(proofMap, artifacts) })
  };
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    evidenceRoot = dataDir;
    assert.equal((await runAgainstDaemon(daemon, ["init"])).code, 0);
    const receipt = (await runAgainstDaemon(daemon, ["orchestrator", "submit", JSON.stringify(submission("complete-conversation"))])).json;
    const brief = async (host) => (await runAgainstDaemon(host, ["orchestrator", "brief", receipt.ticketId, receipt.runId])).json;
    const act = async (host, action, input = {}) => {
      const view = await brief(host);
      return runAgainstDaemon(host, ["orchestrator", "act", receipt.ticketId, JSON.stringify(decision(view, action, input))]);
    };
    const until = async (host, predicate) => {
      let view;
      await waitFor(async () => { view = await brief(host); assert.ok(predicate(view), JSON.stringify({ status: view.status, checkpoint: view.checkpoint, proof: host.store.read().ticketRuns[receipt.ticketId].proofMap, checks: host.store.read().ticketRuns[receipt.ticketId].plan?.nodes[0].checks })); }, { timeoutMs: 12000 });
      return view;
    };
    assert.match((await brief(daemon)).message, /draft/);
    await act(daemon, "start");
    await until(daemon, (view) => view.actions.includes("answer"));
    await act(daemon, "answer", { answers: "" });
    const first = await until(daemon, (view) => view.actions.includes("approve"));
    assert.equal(workers, 0);
    assert.ok(first.artifacts.some((artifact) => artifact.preview));
    await act(daemon, "revise-proposal", { proposalRevision: first.uiProposal.revisionId, feedback: "Make the panel compact" });
    const revised = await until(daemon, (view) => view.uiProposal?.revisionId !== first.uiProposal.revisionId && view.actions.includes("approve"));
    await assert.rejects(act(daemon, "approve", { proposalRevision: first.uiProposal.revisionId }), /current UI proposal/);
    await daemon.close({ exit: false });
    await withDaemon(async (restored) => {
      assert.equal((await brief(restored)).uiProposal.revisionId, revised.uiProposal.revisionId);
      const duplicate = (await runAgainstDaemon(restored, ["orchestrator", "submit", JSON.stringify(submission("complete-conversation"))])).json;
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.runId, receipt.runId);
      await act(restored, "approve", { proposalRevision: revised.uiProposal.revisionId, auto: true });
      const final = await until(restored, (view) => view.actions.includes("approve-proof"));
      assert.equal(workers, 1);
      assert.ok(final.artifacts.some((artifact) => artifact.media));
      assert.equal(final.metrics.cost.state, "unavailable");
      await act(restored, "approve-proof");
      const completed = await until(restored, (view) => view.status === "completed");
      assert.deepEqual(completed.actions, []);
      assert.match(completed.message, /completed/);
      assert.equal((await invoke(restored, "GET", `/api/tickets/${receipt.ticketId}/run`)).json.status, "completed");
      assert.equal(await readFile(join(cwd, "panel.txt"), "utf8"), "Mock panel implementation\n");
      assert.equal(restored.store.read().ticketRuns[receipt.ticketId].runId, receipt.runId);
      assert.ok((await show(restored, receipt)).decisions.some((item) => item.action === "approve-proof" && item.authority.mode === "user"));
    }, { cwd, dataDir, harness, listen: true });
  }, { harness, listen: true });
});
