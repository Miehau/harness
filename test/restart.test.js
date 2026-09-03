import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/server.js";
import { mockHarness, invoke, seedRun, withDaemon } from "./helpers.js";

test("startup recovery records interrupted ownership as incomplete rather than successful", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-cleanup-restart-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-cleanup-restart-cwd-"));
  let first;
  let restarted;
  try {
    first = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness() });
    const id = await seedRun(first, {
      cleanup: {
        outcome: "running",
        executions: [{ executionId: "interrupted-worker", outcome: "running", ownership: { tokenPresent: true }, triggers: [] }]
      }
    });
    await first.close({ exit: false });
    restarted = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness() });
    const cleanup = restarted.store.read().ticketRuns[id].cleanup;
    assert.equal(cleanup.outcome, "incomplete");
    assert.equal(cleanup.executions[0].outcome, "incomplete");
    assert.ok(cleanup.executions[0].triggers.some(({ trigger }) => trigger === "daemon-restart-recovery"));
    assert.ok(cleanup.executions[0].unresolved.some(({ reason }) => reason === "restart-ownership-token-unavailable"));
  } finally {
    await restarted?.close({ exit: false });
    await first?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fresh restart settles preview cleanup before archiving its owning run", async () => {
  await withDaemon(async (daemon) => {
    const ticket = {
      id: "restart-preview-owner", identifier: "PREVIEW-1", title: "Retain preview cleanup",
      description: "Keep cleanup on the archived run.", source: "local",
      state: { name: "Free text", type: "local" }, team: { name: "Local" }
    };
    const id = await seedRun(daemon, { ticket, status: "awaiting_requirements" });
    const previewId = `${id}:verification`;
    daemon.previews.active.set(previewId, {
      child: { exitCode: null }, cleanup: null,
      public: { id: previewId, port: 47821, status: "running", cleanup: null },
      containment: { cleanup: async () => assert.fail("the run-bound observer must own persistence") },
      onCleanup: async () => {
        await daemon.store.update((state) => {
          state.ticketRuns[id].cleanup = {
            outcome: "incomplete",
            executions: [{ executionId: "preview-owner", outcome: "incomplete", diagnostics: ["preview cleanup observed before archive"], unresolved: [{ pid: 71, reason: "still-running-after-force" }] }]
          };
        });
        return { executionId: "preview-owner", outcome: "incomplete" };
      }
    });
    daemon.previews.ports.add(47821);

    const response = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { target: "fresh", confirmed: true } });
    assert.equal(response.status, 202);
    const state = daemon.store.read();
    const archived = state.retainedRuns[`${id}:run-1`];
    assert.equal(archived.cleanup.outcome, "incomplete");
    assert.deepEqual(archived.cleanup.executions[0].unresolved, [{ pid: 71, reason: "still-running-after-force" }]);
    assert.notEqual(state.ticketRuns[id].cleanup.executions[0]?.executionId, "preview-owner");
  });
});

test("fresh restart preserves a timed-out preview cleanup as pending", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-pending-preview-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-pending-preview-cwd-"));
  let resolveCleanup = () => {};
  const daemon = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness(), lifecycleCleanupTimeoutMs: 5 });
  try {
    const ticket = {
      id: "restart-preview-pending", identifier: "PREVIEW-2", title: "Keep pending preview cleanup",
      description: "Do not claim an unsettled cleanup stopped.", source: "local",
      state: { name: "Free text", type: "local" }, team: { name: "Local" }
    };
    const id = await seedRun(daemon, { ticket, status: "awaiting_requirements" });
    const previewId = `${id}:verification`;
    const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });
    const publicPreview = { id: previewId, port: 47821, status: "running", cleanup: null };
    await daemon.store.update((state) => { state.ticketRuns[id].previews = { [previewId]: publicPreview }; });
    daemon.previews.active.set(previewId, {
      child: { exitCode: null }, cleanup: null, public: publicPreview,
      containment: { cleanup: async () => assert.fail("the preview observer owns cleanup") },
      onCleanup: async () => cleanup
    });
    daemon.previews.ports.add(47821);

    const response = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { target: "fresh", confirmed: true } });
    assert.equal(response.status, 202);
    const preview = daemon.store.read().retainedRuns[`${id}:run-1`].previews[previewId];
    assert.equal(preview.status, "stopping");
    assert.equal(preview.cleanup.outcome, "running");
    assert.match(preview.cleanup.diagnostics[0], /containment remains pending/);

    resolveCleanup({ outcome: "incomplete", diagnostics: ["Process remained after force termination"] });
    await daemon.previews.settleMatching(previewId, 50);
  } finally {
    resolveCleanup({ outcome: "complete" });
    await daemon.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fresh restart keeps a free-text local ticket out of the fixture path", async () => {
  await withDaemon(async (daemon) => {
    const ticket = {
      id: "local-text-1", identifier: "TEXT-1", title: "Add verification",
      description: "Reuse existing checks.", source: "local",
      state: { name: "Free text", type: "local" }, team: { name: "Local" }
    };
    const id = await seedRun(daemon, { ticket, status: "awaiting_requirements" });
    const response = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, {
      body: { target: "fresh", confirmed: true }
    });

    assert.equal(response.status, 202);
    const deadline = Date.now() + 3000;
    let restarted;
    while (Date.now() < deadline) {
      restarted = daemon.store.read().ticketRuns[id];
      if (restarted.checkpoint?.kind === "requirements_review") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(restarted.ticket.description, "Reuse existing checks.");
    assert.equal(restarted.checkpoint.kind, "requirements_review");
    assert.equal(restarted.checkpoint.title, "Approve ticket requirements");
  });
});
