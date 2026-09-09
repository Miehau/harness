import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlan } from "../src/plan.js";
import { assertUiProposal, buildUiProposal, uiPlanHash } from "../src/ui-proposal.js";
import { invoke, mockHarness, seedRun, withDaemon, waitFor } from "./helpers.js";
import { join } from "node:path";
import { createZeroStateWorkspace } from "../src/worktrees.js";
import { planApprovalCheckpoint } from "../src/planning.js";
import { JsonStore } from "../src/store.js";

const plan = () => normalizePlan({ uiImpact: { level: "material", reason: "Add a panel" }, nodes: [{ id: "panel", title: "Panel", permission: "read", requiresVisualEvidence: true, acceptanceCriteria: ["Panel is visible"], criterionBindings: [{ index: 0, id: "ac-panel", evidence: "screenshot", journeyId: "panel-open" }] }] });

test("proposal approval binds to direction and revision while runtime statuses do not invalidate it", () => {
  const run = { plan: plan() };
  assert.throws(() => assertUiProposal(run), /current UI proposal/);
  run.uiProposal = { revisionId: "v1", planHash: uiPlanHash(run.plan), approvedAt: "now" };
  assert.doesNotThrow(() => assertUiProposal(run));
  run.plan.nodes[0].status = "accepted";
  assert.doesNotThrow(() => assertUiProposal(run));
  assert.throws(() => assertUiProposal(run, "v0", { approving: true }), /current UI proposal/);
  run.plan.nodes[0].acceptanceCriteria[0] = "Different panel";
  assert.throws(() => assertUiProposal(run), /current UI proposal/);
  assert.doesNotThrow(() => assertUiProposal({ plan: normalizePlan({ nodes: [{ id: "legacy" }] }) }));
});

test("UI revision gates auto execution, retains history, and persists approval across restart", async () => {
  let worked = false;
  const harness = { ...mockHarness(), proposeUi: async () => ({ html: '<main><h1>New panel</h1><button>Expand</button></main>', summary: "Review the new panel" }),
    runStep: async () => { worked = true; return { report: { status: "needs_input", summary: "Stopped fixture", artifact: "Stopped fixture" }, output: "Stopped fixture" }; } };
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const ticket = { id: "ui-test", identifier: "UI-test", source: "local", title: "Panel", state: { type: "unstarted", name: "Todo" } };
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const id = await seedRun(daemon, { ticket, workspace, plan: plan(), status: "awaiting_approval", checkpoint: planApprovalCheckpoint("Panel") });
    const run = daemon.store.read().ticketRuns[id];
    const proposal = await buildUiProposal({ dataDir, run, plan: run.plan, design: "Panel design", harness });
    await daemon.store.update((draft) => {
      const current = draft.ticketRuns[id];
      const { artifact, ...metadata } = proposal;
      current.uiProposal = metadata;
      current.uiReviewRequired = true;
      current.artifacts.push(artifact);
    });
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: true } })).status, 400);
    assert.equal(worked, false);
    const changed = await invoke(daemon, "POST", `/api/tickets/${id}/ui-proposal/changes`, { body: { proposalRevision: proposal.revisionId, feedback: "Make the panel compact" } });
    assert.equal(changed.status, 202, changed.text);
    const revised = daemon.store.read().ticketRuns[id].uiProposal;
    assert.notEqual(revised.revisionId, proposal.revisionId);
    assert.equal(daemon.store.read().ticketRuns[id].uiProposalHistory.length, 1);
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: true, proposalRevision: proposal.revisionId } })).status, 400);
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { proposalRevision: revised.revisionId } })).status, 202);
    await waitFor(() => assert.equal(worked, true), { timeoutMs: 5000 });
    assert.ok(daemon.store.read().ticketRuns[id].uiProposal.approvedAt);
    await daemon.close({ exit: false });
    const restored = new JsonStore(join(dataDir, "state-v3.json"), cwd);
    await restored.init();
    assert.equal(restored.read().ticketRuns[id].uiProposal.revisionId, revised.revisionId);
    assert.ok(restored.read().ticketRuns[id].uiProposal.approvedAt);
  }, { harness });
});

test("normal requirements and design generate a proposal before any implementation", async () => {
  const { runAgainstDaemon } = await import("./helpers.js");
  const harness = { ...mockHarness(),
    exploreTicket: async () => ({ artifact: "Reuse existing components", questions: [] }),
    lookAheadTickets: async () => ({ artifact: "No dependencies" }),
    designTicket: async () => ({ plan: plan(), artifact: "New panel design" }),
    proposeUi: async () => ({ html: "<main><h1>Panel proposal</h1></main>", summary: "Panel direction" }) };
  await withDaemon(async (daemon) => {
    const created = await runAgainstDaemon(daemon, ["new", "text", "Add a panel"]);
    const id = created.json.ticketId;
    await waitFor(() => assert.equal(daemon.store.read().ticketRuns[id].status, "awaiting_requirements"), { timeoutMs: 5000 });
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/clarify`, { body: { answers: "" } })).status, 202);
    await waitFor(() => assert.equal(daemon.store.read().ticketRuns[id].status, "awaiting_approval"), { timeoutMs: 5000 });
    const run = daemon.store.read().ticketRuns[id];
    assert.ok(run.uiProposal?.artifactId);
    assert.equal(run.uiProposal.approvedAt, null);
    assert.equal(run.plan.nodes[0].attempts.length, 0);
    const shown = await runAgainstDaemon(daemon, ["proposal", "show", id]);
    assert.match(shown.json.artifact.content, /Panel proposal/);
    const preview = await invoke(daemon, "GET", `/api/tickets/${id}/runs/${run.runId}/artifacts/${run.uiProposal.artifactId}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers["content-security-policy"], /sandbox allow-scripts; default-src 'none'/);
    assert.match(preview.text, /Panel proposal/);
    assert.equal((await invoke(daemon, "GET", `/api/tickets/${id}/runs/${run.runId}/artifacts/${run.uiProposal.artifactId}/media`)).status, 400);
  }, { harness });
});

test("restart releases interrupted UI revision and replay controls", async () => {
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const id = await seedRun(daemon, { status: "awaiting_approval", uiProposalGenerating: true,
      uiProposal: { revisionId: "old-direction" }, uiReplay: { status: "running" } });
    await daemon.close({ exit: false });
    const restored = new JsonStore(join(dataDir, "state-v3.json"), cwd);
    await restored.init();
    const run = restored.read().ticketRuns[id];
    assert.equal(run.uiProposalGenerating, false);
    assert.ok(run.uiProposal.invalidatedAt);
    assert.equal(run.uiReplay.status, "interrupted");
  });
});
