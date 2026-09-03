import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePlan } from "../src/plan.js";
import { applyProofReports, initializeProofMap } from "../src/proof-map.js";
import { runRoot } from "../src/retention.js";
import { createZeroStateWorkspace } from "../src/worktrees.js";
import { auditHarnessWriteScopes, closeSseClients, createDaemon, deliveryFeedbackReferences, reconcileVisualChecks, repositoryCheckReview, settleScheduledDelivery } from "../src/server.js";
import { persistArtifact } from "../src/artifacts.js";
import { runAgainstDaemon, invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

test("reports missing visual evidence instead of mislabeling passing checks", () => {
  const review = repositoryCheckReview({
    status: "failed",
    failureKind: "visual-evidence",
    command: "node .agent-plan/verify.mjs",
    summary: "Visual verification produced no desktop or mobile evidence.",
    output: "238 tests passed\nVerification passed"
  });
  assert.equal(review.findings[0].category, "evidence");
  assert.equal(review.findings[0].claim, "Visual verification produced no desktop or mobile evidence.");
  assert.doesNotMatch(review.findings[0].suggestedFix, /Make .* pass|238 tests passed/);
});

test("daemon shutdown ends open event streams before closing the server", () => {
  let ended = 0;
  const clients = new Set([
    { response: { end() { ended += 1; } } },
    { response: { end() { ended += 1; } } }
  ]);
  closeSseClients(clients);
  assert.equal(ended, 2);
  assert.equal(clients.size, 0);
});

test("delivery observers consume failures from the scheduled inner promise", async () => {
  assert.equal(await settleScheduledDelivery(Promise.resolve({ promise: Promise.reject(new Error("delivery failed")) })), undefined);
});

test("delivery fixers receive repository paths named by failing checks", () => {
  assert.deepEqual(deliveryFeedbackReferences([{ body: "location: '/tmp/worktree/test/e2e-proof.test.js:109:1'\ninspect src/server.js" }]), [
    "test/e2e-proof.test.js", "src/server.js"
  ]);
});

test("preview diagnostics cannot satisfy missing verification-contract evidence", () => {
  const checks = reconcileVisualChecks({
    status: "failed",
    failureKind: "visual-evidence",
    command: "node .agent-plan/verify.mjs",
    summary: "node .agent-plan/verify.mjs passed but produced no screenshot evidence.",
    output: "Verification passed",
    evidence: []
  }, [
    { name: "desktop.png", path: "/proof/desktop.png", mediaKind: "image" },
    { name: "mobile.png", path: "/proof/mobile.png", mediaKind: "image" }
  ], { required: true });
  assert.equal(checks.status, "failed");
  assert.equal(checks.failureKind, "visual-evidence");
  assert.deepEqual(checks.evidence, []);
  assert.equal(checks.previewEvidence.length, 2);
  assert.equal(repositoryCheckReview(checks).findings[0].category, "evidence");
});

test("missing screenshots do not hide a repository failure", () => {
  const checks = reconcileVisualChecks({
    status: "failed", command: "node .agent-plan/verify.mjs",
    summary: "node .agent-plan/verify.mjs failed.", failureHighlights: "not ok 216 - contract composition",
    evidence: []
  }, [], { required: true });
  assert.equal(checks.failureKind, undefined);
  assert.equal(checks.summary, "node .agent-plan/verify.mjs failed.");
  const finding = repositoryCheckReview(checks).findings[0];
  assert.equal(finding.category, "tests");
  assert.match(finding.suggestedFix, /not ok 216/);
});

test("resuming a persisted visual step audits the newly available contract scope", () => {
  const run = { plan: normalizePlan({ nodes: [{
    id: "visual", title: "Prove the dashboard", permission: "write", writeScope: "public,test",
    expectedFiles: ["public/app.js"], requiresVisualEvidence: true,
    attempts: [{ completedAt: "2026-09-03T10:00:00.000Z", verification: { findings: [{ severity: "high", claim: "Missing proof" }] } }]
  }] }) };
  assert.deepEqual(auditHarnessWriteScopes(run, "2026-09-03T10:15:00.000Z"), [{ stepId: "visual", paths: [".agent-plan"] }]);
  assert.equal(run.plan.nodes[0].writeScope, "public,test,.agent-plan");
  assert.deepEqual(run.plan.nodes[0].expectedFiles, ["public/app.js", ".agent-plan"]);
  assert.deepEqual(run.plan.nodes[0].scopeChanges[0], {
    at: "2026-09-03T10:15:00.000Z", paths: [".agent-plan"], source: "harness",
    reason: "Visual verification must be able to correct its repository-owned evidence contract."
  });
  assert.deepEqual(auditHarnessWriteScopes(run, "2026-09-03T10:20:00.000Z"), []);
});

test("repository failures send correction workers only focused highlights", () => {
  const review = repositoryCheckReview({
    status: "failed",
    command: "node .agent-plan/verify.mjs",
    summary: "node .agent-plan/verify.mjs failed.",
    output: "thousands of passing TAP lines",
    failureHighlights: "not ok 17 - retains the steering claim\nexpected: queued\nactual: withheld"
  });
  assert.match(review.findings[0].suggestedFix, /not ok 17/);
  assert.match(review.findings[0].claim, /not ok 17 - retains the steering claim/);
  assert.doesNotMatch(review.findings[0].suggestedFix, /thousands of passing/);
});

test("GET /api/health and compact run omit artifact content", async () => {
  await withDaemon(async (daemon) => {
    const health = await invoke(daemon, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const id = await seedRun(daemon, {
      artifacts: [{ id: "a1", name: "design.md", path: "/tmp/design.md", kind: "architecture", content: "# secret" }]
    });
    const compact = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(compact.status, 200);
    assert.equal(compact.json.status, "clarifying");
    assert.equal(compact.json.revision > 0, true);
    assert.equal("artifacts" in compact.json, false);
    assert.equal(JSON.stringify(compact.json).includes("# secret"), false);
    const detailed = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run?detail=1");
    assert.equal(detailed.status, 200);
    assert.equal(detailed.json.artifacts[0].name, "design.md");
    assert.equal(detailed.json.artifacts[0].content, undefined);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.json.ticketRuns[id].artifacts[0].name, "design.md");
    assert.equal(state.json.ticketRuns[id].artifacts[0].content, undefined);
  });
});

test("daemon shutdown bounds an unresponsive preview cleanup", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-shutdown-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-shutdown-cwd-"));
  const daemon = await createDaemon({ cwd, dataDir, listen: false, lock: false, harness: mockHarness(), lifecycleCleanupTimeoutMs: 20, shutdownTimeoutMs: 20 });
  try {
    daemon.previews.active.set("shutdown-preview", {
      child: { exitCode: null },
      public: { port: 47821, status: "running", cleanup: null },
      containment: { cleanup: async () => new Promise(() => {}) },
      cleanup: null
    });
    daemon.previews.ports.add(47821);
    const started = Date.now();
    await daemon.close({ exit: false });
    assert.ok(Date.now() - started < 1_000, "shutdown must not await an unresponsive preview cleanup");
  } finally {
    await daemon.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("public run state preserves actionable process cleanup evidence", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      cleanup: {
        outcome: "incomplete",
        updatedAt: "2026-09-03T10:00:01.000Z",
        executions: [{
          executionId: "worker-1", outcome: "incomplete", stepId: "build",
          unresolved: [{ pid: 81, reason: "force-identity-mismatch" }],
          diagnostics: ["Identity changed before force termination"], triggers: [{ trigger: "worker-aborted", at: "2026-09-03T10:00:01.000Z" }]
        }]
      }
    });
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(state.json.ticketRuns[id].cleanup.outcome, "incomplete");
    assert.deepEqual(state.json.ticketRuns[id].cleanup.executions[0].unresolved, [{ pid: 81, reason: "force-identity-mismatch" }]);
  });
});

test("ticket selection returns the selected public run without artifact bodies", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { artifacts: [{ id: "a", name: "proof.md", content: "private body" }] });
    const selected = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/select`, { body: {} });
    assert.deepEqual(Object.keys(selected.json).sort(), ["revision", "run", "selectedTicketId"]);
    assert.equal(selected.json.selectedTicketId, id);
    assert.equal(selected.json.revision > 0, true);
    assert.equal(selected.json.run.id, id);
    assert.equal(selected.json.run.artifacts[0].content, undefined);
  });
});

test("artifact endpoint hydrates a compact body from its persisted file", async () => {
  await withDaemon(async (daemon, { dataDir }) => {
    const artifact = await persistArtifact(dataDir, { identifier: "MEA-1" }, {
      name: "proof.md", content: "full persisted proof", runId: "run-1", stageId: "verify"
    });
    const id = await seedRun(daemon, { artifacts: [artifact] });
    assert.equal(daemon.store.read().ticketRuns[id].artifacts[0].content, undefined);
    const response = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact.id)}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.content, "full persisted proof");
  });
});

test("workflow stage prompts expose persisted agent input with its stage context", async () => {
  const harness = {
    ...mockHarness(),
    sessionTrace: async (sessionFile, bounds) => ({
      prompt: `Prompt from ${sessionFile}`,
      prompts: [{ prompt: `Prompt from ${sessionFile}`, at: "2026-09-02T10:00:01.000Z" }],
      bounds
    })
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      sessionFile: "/tmp/planning.jsonl",
      stages: [{
        id: "design", title: "Design & plan", status: "completed",
        activity: { startedAt: "2026-09-02T10:00:00.000Z", completedAt: "2026-09-02T10:00:02.000Z" }
      }]
    });
    const result = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/stages/design/prompts`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.prompts, [{
      prompt: "Prompt from /tmp/planning.jsonl",
      at: "2026-09-02T10:00:01.000Z",
      title: "Design & plan",
      status: "completed"
    }]);
  }, { harness });
});

test("accepting a step can enable auto mode at an existing review checkpoint", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "accepted", acceptanceCriteria: ["Works"] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", auto: false, plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const result = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/accept`, { body: { auto: true } });
    assert.equal(result.status, 200);
    assert.equal(result.json.auto, true);
    assert.equal(daemon.store.read().ticketRuns[id].auto, true);
  });
});

test("pausing persists a checkpoint artifact and resumes the saved requirements session", async () => {
  let releaseStarted;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  let releaseResume;
  const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
  let calls = 0;
  const harness = {
    ...mockHarness(),
    async clarifyRequirements({ signal, onEvent, onSessionFile }) {
      calls++;
      await onSessionFile?.("/tmp/requirements-session.jsonl");
      onEvent?.({ type: "phase", label: calls === 1 ? "Shaping requirements" : "Continuing requirements" });
      if (calls === 1) {
        releaseStarted();
        await new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } else await resumeGate;
      return { artifact: "# Requirements", questions: [], sessionFile: "/tmp/requirements-session.jsonl" };
    }
  };
  await withDaemon(async (daemon) => {
    const ticket = {
      id: "pause-ticket", identifier: "PAUSE-1", title: "Pause this run", description: "Keep its work",
      source: "local", state: { name: "Local", type: "local" }, team: { name: "Local" }
    };
    const starting = invoke(daemon, "POST", `/api/tickets/${ticket.id}/start`, { body: { ticket } });
    await started;
    const paused = await invoke(daemon, "POST", `/api/tickets/${ticket.id}/pause`, { body: {} });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.paused, true);
    assert.match(paused.json.auditId, /^pause-/);
    await starting;

    const saved = daemon.store.read().ticketRuns[ticket.id];
    assert.equal(saved.status, "paused");
    assert.equal(saved.requirementsSessionFile, "/tmp/requirements-session.jsonl");
    assert.equal(saved.pauseHistory[0].stageId, "requirements");
    assert.equal(saved.pauseHistory[0].sessionFile, "/tmp/requirements-session.jsonl");
    assert.equal(saved.artifacts.find((artifact) => artifact.kind === "pause-checkpoint").id, paused.json.artifactId);

    const resumed = await Promise.race([
      invoke(daemon, "POST", `/api/tickets/${ticket.id}/resume`, { body: {} }),
      new Promise((resolve) => setTimeout(() => resolve({ status: 599, text: "Resume waited for the background model run" }), 500))
    ]);
    assert.equal(resumed.status, 202);
    releaseResume();
    const deadline = Date.now() + 3000;
    let after;
    while (Date.now() < deadline) {
      after = daemon.store.read().ticketRuns[ticket.id];
      if (after.status === "awaiting_requirements") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(after.status, "awaiting_requirements");
    assert.equal(calls, 2);
    assert.ok(after.pauseHistory[0].resumedAt);
  }, { harness });
});

test("cancelling an active run stops it through the run endpoint", async () => {
  let releaseStarted;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  const harness = {
    ...mockHarness(),
    async clarifyRequirements({ signal }) {
      releaseStarted();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  };
  await withDaemon(async (daemon) => {
    const ticket = {
      id: "cancel-ticket", identifier: "CANCEL-1", title: "Cancel this run", description: "Stop it",
      source: "local", state: { name: "Local", type: "local" }, team: { name: "Local" }
    };
    const starting = invoke(daemon, "POST", `/api/tickets/${ticket.id}/start`, { body: { ticket } });
    await started;
    const cancelled = await invoke(daemon, "POST", `/api/tickets/${ticket.id}/cancel`, { body: {} });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.json, { cancelled: true, ticketId: ticket.id });
    await starting;
    assert.equal(daemon.store.read().ticketRuns[ticket.id].status, "cancelled");
  }, { harness });
});

test("forgetting a run deletes its state and owned files", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "cancelled", runId: "forget-run" });
    const run = daemon.store.read().ticketRuns[id];
    const root = runRoot(daemon.dataDir, run);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "artifact.txt"), "remove me");

    const unconfirmed = await invoke(daemon, "POST", `/api/tickets/${id}/forget`, { body: {} });
    assert.equal(unconfirmed.status, 400);
    const forgotten = await invoke(daemon, "POST", `/api/tickets/${id}/forget`, { body: { confirmed: true } });
    assert.deepEqual(forgotten.json.forgotten, true);
    assert.equal(daemon.store.read().ticketRuns[id], undefined);
    await assert.rejects(stat(root));
  });
});

test("requirements answers remain in chat history when the agent replies", async () => {
  const harness = {
    ...mockHarness(),
    refineRequirements: async () => ({ artifact: "# Revised requirements", questions: ["Should completed tickets stay visible?"], sessionFile: null })
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      status: "awaiting_requirements",
      checkpoint: { id: "requirements-1", kind: "requirements_review", title: "Approve ticket requirements", questions: ["Who uses this view?"], createdAt: "2026-09-02T10:00:00.000Z" }
    });
    const response = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/clarify`, { body: { answers: "1. Operators" } });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 3000;
    let state;
    while (Date.now() < deadline) {
      state = await invoke(daemon, "GET", "/api/state");
      if (state.json.ticketRuns[id].checkpoint?.questions?.[0] === "Should completed tickets stay visible?") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(state.json.ticketRuns[id].clarificationHistory, [{
      checkpointId: "requirements-1",
      kind: "requirements_review",
      title: "Approve ticket requirements",
      questions: ["Who uses this view?"],
      answer: "1. Operators",
      askedAt: "2026-09-02T10:00:00.000Z",
      answeredAt: state.json.ticketRuns[id].clarificationHistory[0].answeredAt,
      answerSource: "dashboard"
    }]);
    assert.deepEqual(state.json.ticketRuns[id].checkpoint.questions, ["Should completed tickets stay visible?"]);
  }, { harness });
});

test("API token rejects unauthenticated /api calls", async () => {
  await withDaemon(async (daemon) => {
    const denied = await invoke(daemon, "GET", "/api/health");
    assert.equal(denied.status, 401);
    const allowed = await invoke(daemon, "GET", "/api/health", { token: "secret" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.ok, true);
  }, { apiToken: "secret" });
});

test("GET /api/models lists OpenAI subscription models", async () => {
  const harness = {
    ...mockHarness(),
    async models(provider) {
      assert.equal(provider, "openai-codex");
      return [{ id: "gpt-test", name: "Test", provider }];
    }
  };
  await withDaemon(async (daemon) => {
    const result = await invoke(daemon, "GET", "/api/models");
    assert.equal(result.status, 200);
    assert.equal(result.json.provider, "openai-codex");
    assert.equal(result.json.models[0].provider, "openai-codex");
  }, { harness });
});

test("binding a skill creates run.checkpoint and continue resumes the ticket", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon);
    const bound = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/workflow", { body: { skillName: "shape-feature" } });
    assert.equal(bound.status, 200);
    const afterBind = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(afterBind.json.checkpoint.title, "Approve the brief");
    assert.equal(afterBind.json.workflow.skillName, "shape-feature");
    assert.equal(afterBind.json.status, "awaiting_approval");
    const continued = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/workflow/continue", {
      body: { checkpointId: afterBind.json.checkpoint.id, response: "Approved" }
    });
    assert.equal(continued.status, 202);
    const deadline = Date.now() + 3000;
    let latest;
    while (Date.now() < deadline) {
      latest = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
      if (latest.json.checkpoint && latest.json.checkpoint.kind === "requirements_review") break;
      if (latest.json.lastError) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(latest.json.lastError, null);
    assert.equal(latest.json.checkpoint.kind, "requirements_review");
  });
});

test("agent-plan CLI wait is non-zero on needs_attention", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "needs_attention", lastError: "stalled", checkpoint: { kind: "needs_attention", title: "Correction stalled" } });
    const result = await runAgainstDaemon(daemon, ["wait", id]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /needs_attention/);
  });
});

test("agent-plan CLI wait returns when an operator pauses the run", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "paused", checkpoint: null });
    const result = await runAgainstDaemon(daemon, ["wait", id]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /paused/);
  });
});

test("operator can auditably expand one blocked step to a directly affected test", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", status: "needs_attention", writeScope: "src/app.js", expectedFiles: ["src/app.js"] }] });
    const id = await seedRun(daemon, { status: "needs_attention", lastError: "Regression failed", checkpoint: { kind: "needs_attention", stepId: "build", prompt: "Regression failed" }, plan });
    const expanded = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, {
      body: { paths: ["test/e2e.test.js"], reason: "The canonical failure directly exercises this changed contract." }
    });
    assert.equal(expanded.status, 200, expanded.text);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.plan.nodes[0].writeScope, "src/app.js,test/e2e.test.js");
    assert.deepEqual(run.plan.nodes[0].expectedFiles, ["src/app.js", "test/e2e.test.js"]);
    assert.deepEqual(run.plan.nodes[0].scopeChanges.at(-1).paths, ["test/e2e.test.js"]);
    assert.match(run.checkpoint.prompt, /Approved scope expansion/);

    run.plan.nodes[0].status = "needs_input";
    const inputExpansion = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, {
      body: { paths: ["test/focused.test.js"], reason: "The worker requested this exact bounded test scope." }
    });
    assert.equal(inputExpansion.status, 200, inputExpansion.text);

    const rejected = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, { body: { paths: ["../outside"], reason: "No" } });
    assert.equal(rejected.status, 400);
  });
});

test("operator can auditably waive a stopped false verifier finding without accepting the step", async () => {
  await withDaemon(async (daemon) => {
    const finding = { severity: "medium", claim: "Implement a later slice", evidence: [{ file: "src/app.js", line: 1 }] };
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build", permission: "write", status: "needs_attention", writeScope: "src/app.js",
      attempts: [{ verification: { findings: [finding] } }]
    }] });
    const id = await seedRun(daemon, {
      status: "needs_attention", lastError: "Correction stalled", plan,
      checkpoint: { kind: "needs_attention", source: "verification", stepId: "build", title: "Correction stalled" }
    });
    const waived = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/waive`, { body: { reason: "This behavior is explicitly owned by the next slice." } });
    assert.equal(waived.status, 200, waived.text);
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.status, "awaiting_step_review");
    assert.equal(run.plan.nodes[0].status, "review_ready");
    assert.equal(run.plan.nodes[0].verificationWaivers[0].reason, "This behavior is explicitly owned by the next slice.");
    assert.deepEqual(run.plan.nodes[0].verificationWaivers[0].findings, [finding]);
    assert.deepEqual(run.plan.nodes[0].attempts[0].verificationDisposition, {
      status: "waived", at: run.plan.nodes[0].verificationWaivers[0].at,
      reason: "This behavior is explicitly owned by the next slice.", source: "operator"
    });
    assert.equal(run.checkpoint.kind, "step_review");
    assert.match(run.checkpoint.title, /verification waiver/);
  });
});

test("step execution failures persist an actionable run checkpoint", async () => {
  const harness = {
    ...mockHarness(),
    runStep: async () => ({ report: { status: "completed", summary: "implemented" }, output: "implemented", prompt: "build", reviewNotes: [], rawOutput: "" }),
    runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: [] }),
    evidenceImages: async () => [],
    verifyStep: async () => { throw new Error("Verification exceeded its inspection budget."); }
  };
  await withDaemon(async (daemon, { cwd }) => {
    const ticket = { id: "failed-step", identifier: "LOCAL-failed", title: "Fail visibly", description: "Expose the failure", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src", expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"] }] });
    const id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { id: "plan", kind: "awaiting_approval", title: "Approve" } });

    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: true } });
    assert.equal(approved.status, 202, approved.text);
    const deadline = Date.now() + 3000;
    let run;
    while (Date.now() < deadline) {
      run = daemon.store.read().ticketRuns[id];
      if (run.status === "needs_attention") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(run.status, "needs_attention");
    assert.equal(run.lastError, "Verification exceeded its inspection budget.");
    assert.equal(run.plan.nodes[0].attempts.at(-1).report.summary, "implemented");
    assert.equal(run.plan.nodes[0].attempts.at(-1).checks.status, "passed");
    assert.equal(run.plan.nodes[0].attempts.at(-1).diff.available, true);
    assert.ok(run.plan.nodes[0].attempts.at(-1).artifacts.some((artifact) => artifact.kind === "agent-prompt"));
    assert.deepEqual({ kind: run.checkpoint.kind, stepId: run.checkpoint.stepId, source: run.checkpoint.source, prompt: run.checkpoint.prompt }, {
      kind: "needs_attention", stepId: "build", source: "execution", prompt: "Verification exceeded its inspection budget."
    });
  }, { harness });
});

test("provider usage exhaustion pauses a step without blaming its implementation", async () => {
  const harness = {
    ...mockHarness(),
    runStep: async () => { throw new Error("Codex error: The usage limit has been reached. Try again at Sep 7th, 2026 8:42 PM."); }
  };
  await withDaemon(async (daemon, { cwd }) => {
    const ticket = { id: "provider-wait", identifier: "LOCAL-wait", title: "Wait durably", description: "Resume after quota reset", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src", expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"] }] });
    const id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { id: "plan", kind: "awaiting_approval", title: "Approve" } });

    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: true } });
    assert.equal(approved.status, 202, approved.text);
    const deadline = Date.now() + 3000;
    let run;
    while (Date.now() < deadline) {
      run = daemon.store.read().ticketRuns[id];
      if (run.status === "paused") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(run.status, "paused");
    assert.equal(run.plan.nodes[0].status, "interrupted");
    assert.equal(run.checkpoint.kind, "provider_wait");
    assert.equal(run.checkpoint.retryAt, "Sep 7th, 2026 8:42 PM");
    assert.equal(run.stages.find((stage) => stage.id === "implement").status, "paused");
  }, { harness });
});

test("write-scope enforcement attributes repository-check side effects to the check", async () => {
  const harness = {
    ...mockHarness(),
    runStep: async ({ cwd }) => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src/app.js"), "export const ready = true;\n");
      return { report: { status: "completed", summary: "implemented" }, output: "implemented", prompt: "build", reviewNotes: [], rawOutput: "" };
    },
    runRepositoryChecks: async ({ cwd }) => {
      await mkdir(join(cwd, ".agent-plan"), { recursive: true });
      await writeFile(join(cwd, ".agent-plan/evidence.png"), "generated by checks\n");
      return { status: "passed", command: "verify", summary: "passed", output: "", evidence: [] };
    },
    evidenceImages: async () => [],
    verifyStep: async () => ({ summary: "verified", findings: [], rawOutput: "{}" }),
    generateCommitMessage: async () => "test: attribute check side effects\n\nWhy: Worker scope must reflect worker changes only.\nRequirement: Keep checks auditable."
  };
  await withDaemon(async (daemon, { cwd }) => {
    const ticket = { id: "check-side-effect", identifier: "LOCAL-check", title: "Attribute changes", description: "Keep check output separate", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src", expectedFiles: ["src/app.js"], estimatedChangedLines: 5, acceptanceCriteria: ["Works"] }] });
    const id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { id: "plan", kind: "awaiting_approval", title: "Approve" } });

    await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    const deadline = Date.now() + 3000;
    let run;
    while (Date.now() < deadline) {
      run = daemon.store.read().ticketRuns[id];
      if (run.status === "awaiting_step_review" || run.status === "needs_attention") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(run.status, "awaiting_step_review", run.lastError);
    const attempt = run.plan.nodes[0].attempts.at(-1);
    assert.deepEqual(attempt.violations, []);
    assert.deepEqual(attempt.diff.files, ["src/app.js"]);
    assert.deepEqual(attempt.checkDiff.files, [".agent-plan/evidence.png"]);
  }, { harness });
});

test("proof routes keep archived attempts and review rounds distinct", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "accepted", acceptanceCriteria: ["Works"] }] });
    const step = plan.nodes[0];
    step.attempts = [{ attemptId: "attempt-2", verification: { checks: { status: "passed", output: "new check" } }, diff: { available: true, patch: "new diff", files: ["new.js"] } }];
    const id = await seedRun(daemon, {
      plan,
      archivedAttempts: [{ stepId: "build", attemptId: "attempt-1", verification: { checks: { status: "passed", output: "old check" } }, diff: { available: true, patch: "old diff", files: ["old.js"] } }],
      finalChecks: { status: "passed", output: "new final" },
      finalCheckHistory: { "final-review-1": { status: "passed", output: "old final" }, "final-review-2": { status: "passed", output: "new final" } },
      reviews: [
        { round: 1, reviewId: "final-review-1", finalChecks: { status: "passed", output: "old final" }, diff: { available: true, patch: "old final diff", files: ["old.js"] } },
        { round: 2, reviewId: "final-review-2", finalChecks: { status: "passed", output: "new final" }, diff: { available: true, patch: "new final diff", files: ["new.js"] } }
      ]
    });

    const oldAttempt = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=attempt&stepId=build&attemptId=attempt-1`);
    const newAttempt = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=attempt&stepId=build&attemptId=attempt-2`);
    const oldDiff = await invoke(daemon, "GET", `/api/tickets/${id}/proof/diff?scope=attempt&stepId=build&attemptId=attempt-1`);
    const newDiff = await invoke(daemon, "GET", `/api/tickets/${id}/proof/diff?scope=attempt&stepId=build&attemptId=attempt-2`);
    const oldFinal = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=final&reviewId=final-review-1`);
    const newFinal = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=final&reviewId=final-review-2`);

    assert.equal(oldAttempt.json.output, "old check");
    assert.equal(newAttempt.json.output, "new check");
    assert.equal(oldDiff.json.patch, "old diff");
    assert.equal(newDiff.json.patch, "new diff");
    assert.equal(oldFinal.json.output, "old final");
    assert.equal(newFinal.json.output, "new final");
  });
});

test("final proof checkpoint exposes durable review metadata", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      status: "awaiting_evidence_review",
      checkpoint: {
        id: "proof-1", kind: "evidence_review", title: "Review final proof before integration",
        finalChecks: { status: "passed", summary: "npm test passed" },
        media: [{ id: "shot-1", name: "desktop.png", path: "/tmp/desktop.png" }],
        evidenceArtifactIds: ["shot-1"], videoRequired: true
      }
    });
    const compact = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(compact.json.status, "awaiting_evidence_review");
    assert.equal(compact.json.checkpoint.kind, "evidence_review");
    assert.deepEqual(compact.json.checkpoint.evidenceArtifactIds, ["shot-1"]);
    assert.equal(compact.json.checkpoint.videoRequired, true);

    const legacyApproval = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/context/approve");
    assert.equal(legacyApproval.status, 400);
    assert.match(legacyApproval.json.error, /Product-context proposal not found/);
  });
});

test("proof eligibility blocks both the human step and final-proof gates", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", acceptanceCriteria: ["Works"] }] });
    const proofMap = initializeProofMap(plan, { approvedAt: "2026-09-10T10:00:00.000Z" });
    const id = await seedRun(daemon, { plan, proofMap, status: "awaiting_step_review", checkpoint: { id: "step-proof", kind: "step_review", stepId: "build" } });
    const step = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} });
    assert.equal(step.status, 400);
    assert.match(step.json.error, /Proof gate blocked: .*criterion-/);

    await daemon.store.update((state) => {
      const run = state.ticketRuns[id];
      run.status = "awaiting_evidence_review";
      run.checkpoint = { id: "final-proof", kind: "evidence_review" };
    });
    const final = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(final.status, 400);
    assert.match(final.json.error, /Proof gate blocked: .*criterion-/);

    const correction = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/changes`, { body: { feedback: "Recheck proof" } });
    assert.equal(correction.status, 400);
    assert.match(correction.json.error, /Identify at least one affected criterion/);
  });
});

test("final proof approval rejects pathless visual-evidence locators", async () => {
  await withDaemon(async (daemon, { dataDir }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "accepted", acceptanceCriteria: ["Visible"] }] });
    const map = initializeProofMap(plan, { approvedAt: "2026-09-10T10:00:00.000Z" });
    const artifacts = [{ id: "screen", kind: "visual-evidence", name: "screen.png", content: "inline capture" }];
    const proofMap = applyProofReports(map, [{
      criterionId: map.criteria[0].id, status: "verified", evidence: [{ type: "media", artifactId: "screen" }]
    }], { plan, artifacts, proofStorageRoot: dataDir }, { reportedAt: "2026-09-10T11:00:00.000Z" });
    assert.equal(proofMap.criteria[0].current.status, "not_yet_verified");

    const id = await seedRun(daemon, {
      plan, artifacts, proofMap, proofStorageRoot: dataDir, status: "awaiting_evidence_review",
      checkpoint: { id: "final-proof", kind: "evidence_review" }
    });
    const approval = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(approval.status, 400);
    assert.match(approval.json.error, /status_not_yet_verified/);
  });
});

test("plan approval snapshots proof once and exposes the compatibility projection", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", acceptanceCriteria: ["Works"] }] });
    const id = await seedRun(daemon, {
      plan, status: "awaiting_approval",
      checkpoint: { id: "plan-proof", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: {} });
    assert.equal(approved.status, 202);
    const saved = daemon.store.read().ticketRuns[id];
    assert.equal(saved.proofMap.criteria.length, 1);
    const projected = await invoke(daemon, "GET", `/api/tickets/${id}/run`);
    assert.equal(projected.json.proofMap.compatibility, false);
    assert.equal(projected.json.proofMap.criteria[0].text, "Works");
  });
});

test("final proof changes require concrete feedback", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      status: "awaiting_evidence_review",
      checkpoint: { id: "proof-2", kind: "evidence_review", title: "Review final proof" }
    });
    const result = await invoke(daemon, "POST", "/api/tickets/" + encodeURIComponent(id) + "/evidence/changes", { body: { feedback: "   " } });
    assert.equal(result.status, 400);
    assert.match(result.json.error, /Describe the final-proof changes required/);
    const after = await invoke(daemon, "GET", "/api/tickets/" + encodeURIComponent(id) + "/run");
    assert.equal(after.json.checkpoint.kind, "evidence_review");
  });
});
