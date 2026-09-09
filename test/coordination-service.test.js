import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCoordinationService, coordinationBlockedSteps } from "../src/coordination-service.js";
import { normalizePlan } from "../src/plan.js";
import { JsonStore } from "../src/store.js";
import { invoke, mockHarness, seedRun, withDaemon, waitFor } from "./helpers.js";

async function activeFixture(daemon, harness = {}, runtime = {}) {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "Shared interface", permission: "read" },
    { id: "two", title: "Dependent caller", permission: "read", dependsOn: ["one"] },
    { id: "other", title: "Independent work", permission: "read" }
  ] });
  const activeRuns = {};
  for (const step of plan.nodes) {
    step.status = "running";
    step.activeAttempt = { id: `${step.id}-attempt`, status: "active" };
    activeRuns[step.id] = { attemptId: step.activeAttempt.id, piSessionState: "active", runId: `${step.id}-worker` };
  }
  const id = await seedRun(daemon, { status: "running", plan, activeRuns });
  const service = createCoordinationService({ readState: () => daemon.store.read(), update: (fn) => daemon.store.update(fn), harness, runtime: { activeSteps: new Map(), stepControllers: new Map(), ...runtime } });
  const target = (stepId) => ({ ticketId: id, runId: "run-1", stepId, attemptId: `${stepId}-attempt` });
  return { service, id, target };
}

test("worker conflicts queue behind the existing supervisor without losing a resolution request", async () => {
  await withDaemon(async (daemon) => {
    let release, started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const firstTurn = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const harness = { async resolveCoordination({ conflicts }) {
      if (++calls === 1) { started(); await firstTurn; }
      return { reason: "Keep the agreed interface", changes: [], conflictIds: conflicts.map((item) => item.id) };
    } };
    const { service, target, id } = await activeFixture(daemon, harness);
    await service.forWorker(target("one")).reportConflict({ summary: "First interface question", stepIds: ["one"] });
    await firstStarted;
    await service.forWorker(target("other")).reportConflict({ summary: "Second interface question", stepIds: ["other"] });
    assert.equal(service.read(id).conflicts[1].resolutionState, "queued");
    release();
    await waitFor(() => assert.deepEqual(service.read(id).conflicts.map((item) => item.resolutionState), ["proposed", "proposed"]));
    assert.equal(calls, 2);
    assert.equal(service.read(id).decisions.length, 0);
  });
});

test("peer delivery persists the exact bound sender and target before invoking Pi", async () => {
  await withDaemon(async (daemon) => {
    let fixture;
    const harness = { async deliverPeerMessage({ message, ...target }) {
      const disk = JSON.parse(await readFile(daemon.store.file, "utf8"));
      const saved = disk.ticketRuns[fixture.id].coordination.messages[0];
      assert.equal(saved.state, "queued");
      assert.deepEqual(saved.from, fixture.target("one"));
      assert.deepEqual(saved.to, fixture.target("other"));
      assert.deepEqual(target, fixture.target("other"));
      assert.equal(saved.id, message.id);
      return { sessionId: "pi-other" };
    } };
    fixture = await activeFixture(daemon, harness);
    const worker = fixture.service.forWorker(fixture.target("one"));
    assert.equal(worker.listAgents().length, 3);
    const sent = await worker.sendMessage({ target: fixture.target("other"), text: "The interface is ready", from: fixture.target("two") });
    assert.equal(sent.state, "delivered");
    assert.equal(fixture.service.read(fixture.id).messages[0].deliveryEvidence.sessionId, "pi-other");
    await daemon.store.update((state) => { state.ticketRuns[fixture.id].activeRuns.one.attemptId = "replacement"; });
    await assert.rejects(worker.sendMessage({ target: fixture.target("other"), text: "Late input" }), /no longer active/);
    assert.throws(() => worker.listAgents(), /no longer active/);
    assert.equal(fixture.service.read(fixture.id).messages.length, 1);
  });
});

test("unavailable and uncertain delivery outcomes are durable and never replayed", async () => {
  await withDaemon(async (daemon) => {
    let calls = 0;
    const harness = { async deliverPeerMessage() {
      calls++;
      const error = new Error(calls === 1 ? "recipient stopped" : "transport result unknown");
      if (calls === 1) error.code = "peer_session_unavailable";
      throw error;
    } };
    const { service, target, id } = await activeFixture(daemon, harness);
    const worker = service.forWorker(target("one"));
    assert.equal((await worker.sendMessage({ target: target("other"), text: "First" })).state, "failed");
    assert.equal((await worker.sendMessage({ target: target("other"), text: "Second" })).state, "uncertain");
    const restarted = new JsonStore(daemon.store.file, daemon.store.cwd);
    await restarted.init();
    const recovered = createCoordinationService({ readState: () => restarted.read(), update: (fn) => restarted.update(fn), harness, runtime: {} });
    assert.deepEqual(recovered.read(id).messages.map((entry) => entry.state), ["failed", "uncertain"]);
    assert.equal(calls, 2);
  });
});

test("a conflict aborts affected workers and dependent work while independent work continues", async () => {
  await withDaemon(async (daemon) => {
    const controllers = new Map();
    const { service, target, id } = await activeFixture(daemon, {}, { stepControllers: controllers });
    for (const name of ["one", "two", "other"]) controllers.set(`${id}:${name}`, new AbortController());
    const conflict = await service.forWorker(target("one")).reportConflict({ summary: "Shared interface needs revision", stepIds: ["one"], proposal: "Keep the existing signature" });
    assert.deepEqual([...coordinationBlockedSteps(daemon.store.read().ticketRuns[id])], ["one", "two"]);
    assert.equal(controllers.get(`${id}:one`).signal.aborted, true);
    assert.equal(controllers.get(`${id}:two`).signal.aborted, true);
    assert.equal(controllers.get(`${id}:other`).signal.aborted, false);
    assert.equal(service.read(id).conflicts[0].id, conflict.id);
    assert.deepEqual(conflict.author, target("one"));
  });
});

test("restart preserves decisions and conflicts and marks in-flight peer delivery uncertain", async () => {
  await withDaemon(async (daemon) => {
    const { service, id, target } = await activeFixture(daemon);
    const resolved = await service.conflict(id, { summary: "Choose the shared interface", stepIds: ["one"] });
    await daemon.store.update((state) => {
      const run = state.ticketRuns[id];
      run.activeRuns = {};
      for (const step of run.plan.nodes) { step.status = "interrupted"; step.activeAttempt.status = "interrupted"; }
    });
    await service.decide(id, { summary: "Keep the existing signature", reason: "Preserve current callers", conflictIds: [resolved.id], stepIds: ["one"] });
    const open = await service.conflict(id, { summary: "Sequence remaining work", stepIds: ["two"] });
    await daemon.store.update((state) => {
      state.ticketRuns[id].coordination.messages.push({ id: "pending-delivery", from: target("one"), to: target("other"), text: "May have reached Pi", state: "queued" });
    });
    const restarted = new JsonStore(daemon.store.file, daemon.store.cwd);
    await restarted.init();
    const run = restarted.read().ticketRuns[id];
    assert.equal(run.coordination.decisions[0].reason, "Preserve current callers");
    assert.equal(run.coordination.conflicts.find((entry) => entry.id === open.id).status, "open");
    assert.equal(run.coordination.conflicts.find((entry) => entry.id === resolved.id).status, "resolved");
    assert.equal(run.coordination.messages[0].state, "uncertain");
    assert.deepEqual(run.activeRuns, {});
    assert.deepEqual([...coordinationBlockedSteps(run)], ["two"]);
  }, { harness: mockHarness() });
});

test("revision acceptance waits for affected workers and preserves independent execution", async () => {
  await withDaemon(async (daemon) => {
    let release;
    const stopped = new Promise((resolve) => { release = resolve; });
    const activeSteps = new Map();
    const controllers = new Map();
    const { service, id } = await activeFixture(daemon, {}, {
      activeSteps, stepControllers: controllers, waitForWorkerAbort: (pending) => pending
    });
    const key = `${id}:one`;
    controllers.set(key, new AbortController());
    const pending = stopped.then(async () => {
      await daemon.store.update((state) => {
        const run = state.ticketRuns[id];
        for (const stepId of ["one", "two"]) {
          const step = run.plan.nodes.find((item) => item.id === stepId);
          step.status = "interrupted";
          step.activeAttempt.status = "interrupted";
          delete run.activeRuns[stepId];
        }
      });
      activeSteps.delete(key);
    });
    activeSteps.set(key, pending);
    const revision = await service.propose(id, { reason: "Clarify interface ownership", changes: [{ stepId: "one", description: "Own the shared interface" }] });
    assert.equal(controllers.get(key).signal.aborted, true);
    let accepted = false;
    const applying = service.accept(id, revision.id).then((value) => { accepted = true; return value; });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(accepted, false);
      assert.equal(service.read(id).planRevision, 1);
      release();
      const result = await applying;
      assert.equal(result.status, "accepted");
      const run = daemon.store.read().ticketRuns[id];
      assert.equal(run.planRevision, 2);
      assert.equal(run.plan.nodes.find((item) => item.id === "one").description, "Own the shared interface");
      assert.equal(run.plan.nodes.find((item) => item.id === "other").status, "running");
      assert.equal(run.activeRuns.other.attemptId, "other-attempt");
    } finally { release(); await pending; }
  });
});

test("daemon API retains supervisor agreements as proposals and resolves only explicitly selected conflicts", async () => {
  const harness = { ...mockHarness(), async resolveCoordination({ conflicts }) {
    return { reason: "Keep the existing interface", changes: [], conflictIds: [conflicts[0].id] };
  } };
  await withDaemon(async (daemon) => {
    const { id } = await activeFixture(daemon);
    await daemon.store.update((state) => {
      const run = state.ticketRuns[id];
      run.activeRuns = {};
      for (const step of run.plan.nodes) { step.status = "interrupted"; step.activeAttempt.status = "interrupted"; }
    });
    const first = await invoke(daemon, "POST", `/api/tickets/${id}/coordination/conflicts`, { body: { summary: "Agree on signature", stepIds: ["one"] } });
    const second = await invoke(daemon, "POST", `/api/tickets/${id}/coordination/conflicts`, { body: { summary: "Choose sequencing", stepIds: ["two"] } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const proposal = await invoke(daemon, "POST", `/api/tickets/${id}/coordination/resolve`, { body: {} });
    assert.equal(proposal.status, 200);
    let ledger = (await invoke(daemon, "GET", `/api/tickets/${id}/coordination`)).json;
    assert.equal(ledger.decisions.length, 0, "a supervisor proposal does not grant approval");
    assert.equal(ledger.conflicts[0].status, "open");
    assert.equal(ledger.conflicts[0].resolutionProposal.reason, "Keep the existing interface");
    assert.equal(ledger.conflicts[1].resolutionProposal, undefined);
    const decision = await invoke(daemon, "POST", `/api/tickets/${id}/coordination/decisions`, { body: { summary: proposal.json.reason, reason: "Preserve caller compatibility", conflictIds: proposal.json.conflictIds, stepIds: ["one"] } });
    assert.equal(decision.status, 200);
    ledger = (await invoke(daemon, "GET", `/api/tickets/${id}/coordination`)).json;
    assert.equal(ledger.conflicts[0].status, "resolved");
    assert.equal(ledger.conflicts[1].status, "open");
  }, { harness });
});

test("revision preparation fences new mutations and waits for an existing step acceptance", async () => {
  await withDaemon(async (daemon) => {
    let release, waiting;
    const finished = new Promise((resolve) => { release = resolve; });
    const startedWaiting = new Promise((resolve) => { waiting = resolve; });
    const stepAcceptances = new Map();
    const { service, id } = await activeFixture(daemon, {}, {
      stepAcceptances,
      async waitForWorkerAbort(pending) { waiting(); await pending; }
    });
    await daemon.store.update((state) => {
      const run = state.ticketRuns[id];
      run.activeRuns = {};
      for (const step of run.plan.nodes) { step.status = "interrupted"; step.activeAttempt.status = "interrupted"; }
    });
    const revision = await service.propose(id, { reason: "Revise interface assignment", changes: [{ stepId: "one", description: "Use the existing interface" }] });
    const acceptance = finished.then(async () => {
      await daemon.store.update((state) => { state.ticketRuns[id].plan.nodes.find((step) => step.id === "other").status = "accepted"; });
      stepAcceptances.delete(`${id}:other`);
    });
    stepAcceptances.set(`${id}:other`, acceptance);
    const applying = service.accept(id, revision.id);
    try {
      await startedWaiting;
      const pendingRun = daemon.store.read().ticketRuns[id];
      assert.equal(pendingRun.coordination.applyingRevisionId, revision.id);
      assert.equal(pendingRun.planRevision, 1);
      assert.equal(pendingRun.coordination.revisions[0].workPreparation, undefined, "workspace preparation must wait for acceptance");
      await assert.rejects(service.propose(id, { reason: "Competing mutation", changes: [{ stepId: "two", description: "Different assignment" }] }), /Finish applying/);
      release();
      assert.equal((await applying).status, "accepted");
      const acceptedRun = daemon.store.read().ticketRuns[id];
      assert.equal(acceptedRun.coordination.applyingRevisionId, undefined);
      assert.equal(acceptedRun.planRevision, 2);
      assert.equal(acceptedRun.plan.nodes.find((step) => step.id === "other").status, "accepted");
    } finally { release(); await acceptance; }
  });
});
