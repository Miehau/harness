import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePlan } from "../src/plan.js";
import { createDaemon } from "../src/server.js";
import { seedScenario } from "../scripts/seed-state.js";
import { mockHarness, runAgainstDaemon, seedRun, withDaemon } from "./helpers.js";

test("plan approval selects and approves without a live model", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "E2E plan",
      nodes: [{
        id: "build", title: "Build", permission: "write", writeScope: "src",
        expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"]
      }]
    });
    const id = await seedRun(daemon, {
      status: "awaiting_approval",
      plan,
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve local execution plan" }
    });
    const backlog = await runAgainstDaemon(daemon, ["list", "backlog"]);
    assert.ok(backlog.json.tickets.some((ticket) => ticket.id === id));
    const selected = await runAgainstDaemon(daemon, ["select", id]);
    assert.equal(selected.json.selectedTicketId, id);
    const approved = await runAgainstDaemon(daemon, ["approve"]);
    assert.equal(approved.json.accepted, true);
    const status = await runAgainstDaemon(daemon, ["status", id]);
    assert.ok(status.json.status);
    assert.notEqual(status.json.status, "awaiting_approval");
  });
});

test("observable seed exposes active parallel resources and immutable correction history across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-e2e-observable-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-e2e-observable-cwd-"));
  let daemon;
  try {
    daemon = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness() });
    const seeded = await seedScenario(daemon.store, { dataDir, cwd, scenario: "observability" });
    const active = await runAgainstDaemon(daemon, ["list", "timeline", seeded.ticketId]);
    assert.equal(active.code, 0);
    assert.deepEqual(active.json.workers.filter((worker) => ["worker:api", "worker:ui"].includes(worker.id)).map((worker) => worker.lifecycle), ["active", "active"]);
    assert.deepEqual(active.json.attempts.filter((attempt) => ["worker:api", "worker:ui"].includes(attempt.workerId)).map((attempt) => attempt.resources.output.state), ["not_yet_available", "not_yet_available"]);
    const foundationBeforeRestart = daemon.store.read().ticketRuns[seeded.ticketId].plan.nodes[0];
    assert.equal(foundationBeforeRestart.attempts[0].rawOutput.length, 100000);
    await daemon.close({ exit: false });
    daemon = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness() });
    const stored = daemon.store.read().ticketRuns[seeded.ticketId];
    const foundation = stored.plan.nodes[0];
    assert.equal(stored.status, "interrupted");
    assert.deepEqual(foundation.attempts.map((attempt) => [attempt.attemptId, attempt.status]), [
      ["foundation-original", "failed"], ["foundation-correction", "verified"]
    ]);
    assert.deepEqual(stored.plan.nodes[1].children.map((step) => step.status), ["interrupted", "interrupted"]);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("needs-attention wait exits 1 and in-flight runs recover as interrupted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-e2e-recover-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-e2e-recover-cwd-"));
  try {
    await writeFile(join(dataDir, "state-v3.json"), `${JSON.stringify({
      version: 6,
      workspace: { cwd },
      ticketRuns: {
        "ticket-1": {
          id: "ticket-1",
          status: "running",
          ticket: { id: "ticket-1", identifier: "T-1", title: "In flight" },
          plan: { nodes: [{ id: "build", type: "step", status: "running" }] }
        }
      }
    })}\n`);
    const daemon = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness() });
    try {
      const recovered = daemon.store.read().ticketRuns["ticket-1"];
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.plan.nodes[0].status, "interrupted");
      assert.equal(recovered.recovery.kind, "execution");
      await daemon.store.update((state) => {
        const run = state.ticketRuns["ticket-1"];
        run.status = "needs_attention";
        run.checkpoint = { kind: "needs_attention", title: "Correction stalled" };
        state.selectedTicketId = "ticket-1";
      });
      const waited = await runAgainstDaemon(daemon, ["wait"]);
      assert.equal(waited.code, 1);
      assert.match(waited.stdout, /needs_attention/);
    } finally {
      await daemon.close({ exit: false });
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
