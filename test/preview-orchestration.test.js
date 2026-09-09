import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewOrchestrator } from "../src/preview-orchestration.js";

function stateForPreview() {
  return {
    selectedTicketId: "ticket",
    workspace: { cwd: "/workspace" },
    ticketRuns: {
      ticket: {
        runId: "run-1",
        ticket: { id: "ticket" },
        plan: { nodes: [] },
        proofMap: { criteria: [] },
        previews: {},
        artifacts: []
      }
    },
    retainedRuns: {}
  };
}

test("preview orchestration keeps checks and operator previews bound to their owning run", async () => {
  const source = stateForPreview();
  const calls = { checks: [], stopped: [] };
  const preview = {
    id: "ticket:verify",
    url: "http://127.0.0.1:4777",
    status: "running"
  };
  const previews = {
    async ensure(input) {
      assert.equal(input.seedState.selectedTicketId, "ticket");
      return input.id.endsWith(":operator")
        ? { ...preview, id: input.id }
        : preview;
    },
    async capture() { return []; },
    stop(id, trigger) { calls.stopped.push({ id, trigger }); return true; },
    async settleMatching() {},
    previewState(id) {
      return {
        id,
        status: "stopped",
        cleanup: { outcome: "complete", executionId: "preview-execution" }
      };
    },
    stopMatching(prefix, trigger) { calls.stopped.push({ prefix, trigger }); return 1; }
  };
  const runtime = {
    cleanupTimeoutMs: 10,
    containmentForExecution(executionId) { return { executionId, ownership: { executionId } }; },
    async registerContainment(ticketId) {
      assert.equal(ticketId, "ticket");
      return "run-1";
    },
    async settleContainment() {},
    finish() {},
    async persistPreviewCleanup() {},
    async runContainedRepositoryChecks(input) {
      calls.checks.push(input);
      return {
        status: "passed",
        command: "node verify.mjs",
        summary: "passed",
        output: "",
        evidence: [{
          name: "proof.png",
          path: "/tmp/proof.png",
          mediaKind: "image",
          mediaType: "image/png",
          boundTicketId: "ticket",
          boundRunId: "run-1"
        }]
      };
    }
  };
  const service = createPreviewOrchestrator({
    state: {
      read: () => source,
      update: async (change) => change(source)
    },
    runtime,
    previews,
    address: () => ({ port: 4317 })
  });

  const checks = await service.runChecksWithPreview({
    ticketId: "ticket",
    previewId: "ticket:verify",
    cwd: process.cwd(),
    required: true
  });
  assert.equal(checks.status, "passed");
  assert.equal(calls.checks[0].environment.AGENT_PLAN_CAPTURE_TICKET_ID, "ticket");
  assert.equal(calls.checks[0].environment.AGENT_PLAN_CAPTURE_RUN_ID, "run-1");
  assert.equal(source.ticketRuns.ticket.previews["ticket:verify"].url, preview.url);

  const combined = await service.runChangedRepositoryChecks({
    ticketId: "ticket",
    previewId: "ticket:changed",
    repositories: [
      { id: "primary", cwd: process.cwd(), displayPath: "main" },
      { id: "docs", cwd: "/workspace/docs", displayPath: "docs" }
    ],
    diffs: { docs: { files: ["guide.md"] } }
  });
  assert.equal(combined.status, "passed");
  assert.deepEqual(combined.repositories.map((item) => item.repositoryId), ["primary", "docs"]);
  assert.equal(calls.checks.at(-1).cwd, "/workspace/docs");

  await service.startOperatorPreview("ticket");
  await service.stopOperatorPreview("ticket");
  assert.equal(source.ticketRuns.ticket.previews["ticket:operator"].status, "stopped");
  assert.deepEqual(calls.stopped[0], {
    id: "ticket:operator",
    trigger: { trigger: "preview-stop", reason: "operator-stop" }
  });
});

test("a preview that settles after restart cannot launch checks or adopt evidence", async () => {
  const source = stateForPreview();
  let releasePreview;
  let previewStarted;
  const started = new Promise((resolve) => { previewStarted = resolve; });
  let checks = 0;
  let settled = 0;
  const service = createPreviewOrchestrator({
    state: {
      read: () => source,
      update: async (change) => change(source)
    },
    runtime: {
      cleanupTimeoutMs: 10,
      containmentForExecution(executionId) { return { executionId, ownership: { executionId } }; },
      async registerContainment() { return "run-1"; },
      async settleContainment() { settled++; },
      finish() {},
      async persistPreviewCleanup() {},
      async runContainedRepositoryChecks() { checks++; return { status: "passed", evidence: [] }; }
    },
    previews: {
      ensure() {
        previewStarted();
        return new Promise((resolve) => { releasePreview = resolve; });
      },
      async capture() { assert.fail("stale preview must not capture evidence"); }
    }
  });

  const pending = service.runChecksWithPreview({
    ticketId: "ticket",
    previewId: "ticket:verify",
    cwd: process.cwd(),
    required: true
  });
  await started;
  source.ticketRuns.ticket = {
    ...source.ticketRuns.ticket,
    runId: "run-2",
    previews: {},
    artifacts: []
  };
  releasePreview({ id: "ticket:verify", status: "running" });

  await assert.rejects(pending, (error) => error.code === "run_superseded");
  assert.equal(checks, 0);
  assert.equal(settled, 1);
  assert.deepEqual(source.ticketRuns.ticket.artifacts, []);
});

test("preview stop settlement cannot mark a replacement run stopped", async () => {
  const source = stateForPreview();
  source.ticketRuns.ticket.previews["ticket:operator"] = { status: "running" };
  let releaseSettle;
  const waiting = new Promise((resolve) => { releaseSettle = resolve; });
  const service = createPreviewOrchestrator({
    state: { read: () => source, update: async (change) => change(source) },
    runtime: { cleanupTimeoutMs: 10 },
    previews: {
      stop() { return true; },
      settleMatching() { return waiting; },
      previewState() { return { status: "stopped", cleanup: { outcome: "complete" } }; }
    }
  });

  const pending = service.stopOperatorPreview("ticket");
  source.ticketRuns.ticket = {
    ...source.ticketRuns.ticket,
    runId: "run-2",
    previews: { "ticket:operator": { status: "running" } }
  };
  releaseSettle();
  await pending;

  assert.equal(source.ticketRuns.ticket.previews["ticket:operator"].status, "running");
});

test("replay rejects stale runs and source checkout, retains diagnostic results without changing approval", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "replay-"));
  const source = stateForPreview();
  const run = source.ticketRuns.ticket;
  source.workspace.cwd = root;
  run.status = "awaiting_evidence_review";
  run.checkpoint = { id: "proof-1", kind: "evidence_review" };
  run.workspace = { cwd: root };
  const runtime = { activeTickets: new Map(), activeMerges: new Map(), start: (_id, work) => work(new AbortController().signal),
    containmentForExecution: () => ({}), registerContainment: async () => "run-1", settleContainment: async () => {}, finish() {},
    runContainedRepositoryChecks: async () => ({ status: "failed", summary: "Fixture assertion failed", output: "", evidence: [], previewEvidence: [] }) };
  const previews = { ensure: async ({ id }) => ({ id, url: "http://127.0.0.1:4777", status: "running" }), capture: async () => [], stop() {}, settleMatching: async () => {} };
  const service = createPreviewOrchestrator({ state: { read: () => source, update: async (change) => change(source) }, runtime, previews });
  try {
    await assert.rejects(service.replayJourneys("ticket", { runId: "old" }), /current run ID/);
    await assert.rejects(service.replayJourneys("ticket", { runId: "run-1" }), /isolated ticket workspace/);
    const cwd = join(root, "ticket");
    await mkdir(join(cwd, ".agent-plan"), { recursive: true });
    await writeFile(join(cwd, ".agent-plan/project.json"), JSON.stringify({ commands: { "capture-proof": ["node", "capture.mjs"] } }));
    run.workspace.cwd = cwd;
    const result = await service.replayJourneys("ticket", { runId: "run-1" });
    assert.equal(result.status, "failed");
    assert.equal(run.uiReplay.status, "failed");
    assert.equal(run.status, "awaiting_evidence_review");
    assert.equal(run.checkpoint.id, "proof-1");
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "visual-evidence"), false);
    runtime.activeTickets.set("ticket", {});
    await assert.rejects(service.replayJourneys("ticket", { runId: "run-1" }), /Pause active work/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
