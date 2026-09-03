import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlan } from "../src/plan.js";
import { invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

function activePlan({ status = "running", attemptStatus = "active" } = {}) {
  const plan = normalizePlan({ nodes: [{
    id: "ledger", title: "Update steering ledger", permission: "write", writeScope: "src/steering.js",
    expectedFiles: ["src/steering.js"], estimatedChangedLines: 10,
    acceptanceCriteria: ["FIFO delivery and the claim guard keep steering durable"]
  }] });
  Object.assign(plan.nodes[0], { status, activeAttempt: { id: "attempt-1", status: attemptStatus, startedAt: "2025-01-01T00:00:00.000Z" } });
  return plan;
}

async function seedActiveRun(daemon, extras = {}) {
  const plan = extras.plan || activePlan();
  return seedRun(daemon, {
    status: "running", plan,
    activeRuns: { ledger: { runId: "worker-1", attemptId: "attempt-1", startedAt: "2025-01-01T00:00:00.000Z", piSessionState: "active" } },
    ...extras
  });
}

test("steering persists before Pi delivery and exposes the delivered lifecycle", async () => {
  let daemonRef;
  let persisted = false;
  const harness = {
    ...mockHarness(),
    async steer(message) {
      const record = daemonRef.store.read().ticketRuns[message.ticketId].steering.records.find((item) => item.id === message.steerId);
      persisted = record?.state === "claimed" && record.instruction === "Update src/steering.js with FIFO delivery.";
      return { session: "pi-session-1" };
    }
  };
  await withDaemon(async (daemon) => {
    daemonRef = daemon;
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.status, 200);
    assert.equal(result.json.state, "delivered");
    assert.equal(result.json.target.attemptId, "attempt-1");
    assert.equal(persisted, true);
    const listed = await invoke(daemon, "GET", `/api/tickets/${id}/steering`);
    assert.equal(listed.json.records[0].state, "delivered");
    assert.equal(listed.json.records[0].deliveryEvidence.session, "pi-session-1");
  }, { harness });
});

test("a request queued behind an active Pi claim drains in FIFO order", async () => {
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  const delivered = [];
  const harness = {
    ...mockHarness(),
    async steer(message) {
      delivered.push(message.steerId);
      if (delivered.length === 1) {
        firstStarted.then(() => {});
        releaseFirst();
        await new Promise((resolve) => { harness.release = resolve; });
      }
      return { session: "pi-session" };
    }
  };
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon);
    const first = invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    await firstStarted;
    const second = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with the claim guard." } });
    assert.equal(second.json.state, "queued");
    harness.release();
    await first;
    const records = daemon.store.read().ticketRuns[id].steering.records;
    assert.deepEqual(records.map((record) => record.state), ["delivered", "delivered"]);
    assert.deepEqual(delivered, records.map((record) => record.id));
  }, { harness });
});

test("invalid and unsafe steering produce auditable rejection or a visible checkpoint", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon);
    const empty = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "  " } });
    assert.equal(empty.json.state, "rejected");
    assert.match(empty.json.reason, /required/);

    const unsafe = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update lib/outside.js safely." } });
    assert.equal(unsafe.json.state, "withheld");
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.steeringRejections.length, 1);
    assert.equal(run.checkpoint.kind, "needs_input");
    assert.match(run.checkpoint.prompt, /Update lib\/outside\.js safely/);
    assert.equal(run.steering.records[0].reasonCode, "scope_expansion");
  });
});

test("ambiguous write steering is withheld without Pi delivery", async () => {
  for (const instruction of ["Remove it safely.", "Update src/steering.js safely.", "Delete it in src/steering.js.", "Update ledger safely."]) {
    let deliveries = 0;
    const harness = { ...mockHarness(), async steer() { deliveries++; } };
    await withDaemon(async (daemon) => {
      const id = await seedActiveRun(daemon);
      const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction } });
      assert.equal(result.json.state, "withheld");
      assert.equal(deliveries, 0);
      const run = daemon.store.read().ticketRuns[id];
      assert.equal(run.steering.records[0].reasonCode, "ambiguous_instruction");
      assert.equal(run.checkpoint.kind, "needs_input");
    }, { harness });
  }
});

test("removing approved behavior is withheld without Pi delivery", async () => {
  let deliveries = 0;
  const harness = { ...mockHarness(), async steer() { deliveries++; } };
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, {
      body: { instruction: "Remove FIFO delivery from src/steering.js." }
    });
    assert.equal(result.json.state, "withheld");
    assert.equal(deliveries, 0);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.steering.records[0].reasonCode, "conflicting_instruction");
    assert.equal(run.checkpoint.kind, "needs_input");
  }, { harness });
});

test("an in-scope path cannot authorize an unapproved feature expansion", async () => {
  let deliveries = 0;
  const harness = { ...mockHarness(), async steer() { deliveries++; } };
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, {
      body: { instruction: "Allow users to download report data in src/steering.js." }
    });
    assert.equal(result.json.state, "withheld");
    assert.equal(deliveries, 0);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.steering.records[0].reasonCode, "requirement_expansion");
    assert.equal(run.checkpoint.kind, "needs_input");
  }, { harness });
});

test("multi-action steering is withheld instead of being delivered", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js safely, then add a test." } });
    assert.equal(result.json.state, "withheld");
    assert.equal(daemon.store.read().ticketRuns[id].steering.records[0].reasonCode, "multiple_actions");
  });
});

test("a paused attempt accepts a queued steer without resuming or delivering it", async () => {
  let calls = 0;
  const harness = { ...mockHarness(), async steer() { calls++; } };
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon, {
      status: "paused", plan: activePlan({ status: "interrupted", attemptStatus: "interrupted" }), activeRuns: {}
    });
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.json.state, "queued");
    assert.match(result.json.nextCondition, /Resume this paused run manually/);
    assert.equal(daemon.store.read().ticketRuns[id].status, "paused");
    assert.equal(calls, 0);
  }, { harness });
});

test("terminal steering is actionable without adding attempt lifecycle history", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon, { status: "completed", activeRuns: {} });
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.json.state, "rejected");
    assert.match(result.json.nextCondition, /Start a new run/);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.steering.records.length, 0);
    assert.equal(run.plan.nodes[0].attempts.length, 0);
    assert.equal(run.steeringRejections[0].code, "target_not_active");
  });
});

test("a session that has already ended rejects steering without creating a delivery claim", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedActiveRun(daemon, {
      activeRuns: { ledger: { runId: "worker-1", attemptId: "attempt-1", piSessionState: "unavailable" } }
    });
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.json.state, "rejected");
    assert.match(result.json.reason, /no longer available/);
    assert.match(result.json.nextCondition, /Wait for the worker outcome/);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.steering.records.length, 0);
    assert.equal(run.steeringRejections.at(-1).code, "worker_unavailable");
  });
});

test("a target changed during Pi delivery cannot be recorded as delivered", async () => {
  let daemonRef;
  const harness = {
    ...mockHarness(),
    async steer() {
      await daemonRef.store.update((state) => {
        const run = state.ticketRuns["ticket-1"];
        run.activeRuns = {};
        run.plan.nodes[0].status = "interrupted";
      });
      return { session: "pi-session-1" };
    }
  };
  await withDaemon(async (daemon) => {
    daemonRef = daemon;
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.json.state, "failed");
    assert.equal(result.json.reason, "The bound worker attempt changed before Pi accepted this correction.");
  }, { harness });
});

test("Pi teardown during a steering call cannot be recorded as delivery", async () => {
  let daemonRef;
  const harness = {
    ...mockHarness(),
    async steer() {
      await daemonRef.store.update((state) => {
        state.ticketRuns["ticket-1"].activeRuns.ledger.piSessionState = "unavailable";
      });
      return { session: "pi-session-1" };
    }
  };
  await withDaemon(async (daemon) => {
    daemonRef = daemon;
    const id = await seedActiveRun(daemon);
    const result = await invoke(daemon, "POST", `/api/tickets/${id}/steering`, { body: { instruction: "Update src/steering.js with FIFO delivery." } });
    assert.equal(result.json.state, "failed");
    const record = daemon.store.read().ticketRuns[id].steering.records[0];
    assert.equal(record.reasonCode, "target_replaced");
    assert.match(record.reason, /session ended/);
  }, { harness });
});
