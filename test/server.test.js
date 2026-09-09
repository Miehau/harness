import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { canonicalPrimaryPath, freezeRunAccess, normalizeProjectPolicy, storedProjectPolicy } from "../src/access-policy.js";
import { normalizePlan } from "../src/plan.js";
import { applyProofReports, initializeProofMap } from "../src/proof-map.js";
import { runRoot } from "../src/retention.js";
import { JsonStore } from "../src/store.js";
import { commitWorkspace, createZeroStateWorkspace, ensureTicketWorktree } from "../src/worktrees.js";
import { auditHarnessWriteScopes, captureProofCriteria, closeSseClients, createDaemon, deliveryFailureNeedsFix, deliveryFeedbackReferences, reconcileVisualChecks, repositoryCheckReview, settleScheduledDelivery } from "../src/server.js";
import { snapshotTree } from "../src/git.js";
import { initializeJjWorkspace } from "../src/jj.js";
import { scopedWorkerTools } from "../src/pi-harness.js";
import { persistArtifact } from "../src/artifacts.js";
import { runAgainstDaemon, invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

test("capture criteria exclude backend requirements when the plan explicitly identifies visual proof", () => {
  const criteria = [
    { id: "backend", stepId: "store", text: "Persistence survives reload" },
    { id: "dialog", stepId: "ui", text: "Policy is visible", requiresVisualEvidence: true },
    { id: "keyboard", stepId: "ui", text: "Keyboard controls work", requiresVideoEvidence: true }
  ];
  assert.deepEqual(captureProofCriteria(criteria).map(c => c.id), ["dialog", "keyboard"]);
  assert.deepEqual(captureProofCriteria(criteria, "store"), []);
  assert.deepEqual(captureProofCriteria(criteria, "ui").map(c => c.id), ["dialog", "keyboard"]);
  assert.deepEqual(captureProofCriteria(criteria.slice(0, 1)).map(c => c.id), ["backend"]);
});

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

test("repository check failures name the repository that failed", () => {
  const review = repositoryCheckReview({
    status: "failed",
    command: "verify-a\nverify-b",
    summary: "Repository checks failed in repo-b",
    output: "no-b",
    failedRepositories: [{ repositoryId: "r-b", displayPath: "repo-b", status: "failed" }]
  });
  assert.equal(review.findings[0].category, "tests");
  assert.match(review.findings[0].claim, /repo-b/);
  assert.equal(review.findings[0].evidence[0].file, "repo-b");
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

test("delivery recovery fixes repository defects but not provider failures", () => {
  assert.equal(deliveryFailureNeedsFix("SyntaxError: Unexpected token '}' at src/pi-harness.js:228"), true);
  assert.equal(deliveryFailureNeedsFix("AssertionError: expected complete"), true);
  assert.equal(deliveryFailureNeedsFix("Visual verification produced no desktop or mobile evidence.\nError: Dashboard did not render the steering form"), true);
  assert.equal(deliveryFailureNeedsFix("GITHUB_TOKEN is required for GitHub delivery"), false);
  assert.equal(deliveryFailureNeedsFix("fetch failed"), false);
});

test("unbound screenshots cannot pass a ticket-bound visual check", () => {
  const checks = reconcileVisualChecks({
    status: "passed",
    command: "node .agent-plan/verify.mjs",
    summary: "node .agent-plan/verify.mjs passed with 1 visual artifact.",
    evidence: [{ name: "desktop.png", path: "/tmp/desktop.png", mediaKind: "image" }]
  }, [], { required: true, ticketId: "ticket-1", runId: "run-2" });
  assert.equal(checks.status, "failed");
  assert.equal(checks.failureKind, "visual-evidence");
  assert.match(checks.summary, /ticket-bound/);
  assert.equal(repositoryCheckReview(checks).findings[0].category, "evidence");
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
    reason: "Feature workers maintain the repository verification, discovery and UI CLI contract."
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

test("dashboard assets are served through the daemon", async () => {
  await withDaemon(async (daemon) => {
    const app = await invoke(daemon, "GET", "/app.js");
    const styles = await invoke(daemon, "GET", "/styles.css");
    assert.equal(app.status, 200);
    assert.match(app.headers["content-type"], /text\/javascript/);
    assert.equal(styles.status, 200);
    assert.match(styles.headers["content-type"], /text\/css/);
  });
});

test("ticket inspection API returns the canonical compact projection and state only adds focus metadata", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build /Users/person/private with ghp_0123456789abcdefghijklmnop", status: "running", permission: "write", writeScope: "src/build.js",
      expectedArtifacts: ["build.md"], acceptanceCriteria: ["Works"]
    }] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      stages: [{ id: "implement", title: "Implement", status: "active", summary: "Implementing Build" }],
      activeRuns: { build: { runId: "worker-1", startedAt: "2026-09-03T10:00:00.000Z", lastEvent: "Editing implementation" } },
      merge: { sourceCwd: "/Users/person/private/workspace", error: "Merge failed in /Users/person/private/workspace" },
      integration: { sourceCwd: "/Users/person/private/workspace", commit: "abc123" }
    });
    const result = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/inspection`);
    assert.equal(result.status, 200);
    assert.equal(result.json.version, 1);
    assert.equal(result.json.ticketId, id);
    assert.equal(result.json.revision > 0, true);
    assert.equal(result.json.focus.workerId, "worker:build");
    assert.equal(result.json.attempts[0].resources.output.state, "not_yet_available");
    assert.equal(JSON.stringify(result.json).includes("rawOutput"), false);
    assert.equal(JSON.stringify(result.json).includes("/Users/person"), false);
    assert.equal(JSON.stringify(result.json).includes("ghp_0123456789abcdefghijklmnop"), false);

    const state = await invoke(daemon, "GET", "/api/state");
    assert.deepEqual(state.json.ticketRuns[id].inspectionFocus, {
      version: 1, stageId: "stage:implement", workerId: "worker:build",
      attemptId: "attempt:build:active-worker-1", reason: "active"
    });
    assert.equal("stages" in state.json.ticketRuns[id].inspectionFocus, false);
    assert.equal(JSON.stringify(state.json).includes("/Users/person/private/workspace"), false);
  });
});

test("inspection histories keep fresh-restart artifacts and media scoped to their archived run", async () => {
  await withDaemon(async (daemon, { dataDir }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "needs_attention", permission: "write", writeScope: "src/build.js", attempts: [{ attemptId: "original-attempt", runId: "worker-original", status: "failed", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:01:00.000Z" }] }] });
    const id = await seedRun(daemon, { status: "needs_attention", plan });
    const originalRunId = daemon.store.read().ticketRuns[id].runId;
    const ticket = daemon.store.read().ticketRuns[id].ticket;
    const historicalHandoff = await persistArtifact(dataDir, ticket, { runId: originalRunId, stageId: "handoff", name: "handoff.md", kind: "handoff", content: "historical handoff" });
    const historicalMediaPath = join(dataDir, "historical-proof.png");
    await writeFile(historicalMediaPath, "historical media");
    await daemon.store.update((state) => {
      state.ticketRuns[id].artifacts.push(historicalHandoff, { id: "proof", name: "proof.png", kind: "visual-evidence", stageId: "handoff", path: historicalMediaPath });
    });

    const restarted = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/restart`, { body: { target: "fresh", confirmed: true } });
    assert.equal(restarted.status, 202);
    const activeRunId = daemon.store.read().ticketRuns[id].runId;
    const currentHandoff = await persistArtifact(dataDir, ticket, { runId: activeRunId, stageId: "handoff", name: "handoff.md", kind: "handoff", content: "current handoff" });
    const currentMediaPath = join(dataDir, "current-proof.png");
    await writeFile(currentMediaPath, "current media");
    await daemon.store.update((state) => {
      state.ticketRuns[id].artifacts.push(currentHandoff, { id: "proof", name: "proof.png", kind: "visual-evidence", stageId: "handoff", path: currentMediaPath });
    });
    assert.equal(currentHandoff.id, historicalHandoff.id);

    const histories = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/runs`);
    assert.deepEqual(histories.json.runs.map((run) => [run.runId, run.archived, run.attemptCount]), [[activeRunId, false, 0], [originalRunId, true, 1]]);
    const archived = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/runs/${encodeURIComponent(originalRunId)}/inspection`);
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.json.attempts.map((attempt) => attempt.id), ["attempt:build:original-attempt"]);

    const artifactId = encodeURIComponent(historicalHandoff.id);
    const [historicalBody, currentBody, historicalMedia, currentMedia] = await Promise.all([
      invoke(daemon, "GET", `/api/tickets/${id}/runs/${originalRunId}/artifacts/${artifactId}/content`),
      invoke(daemon, "GET", `/api/tickets/${id}/runs/${activeRunId}/artifacts/${artifactId}/content`),
      invoke(daemon, "GET", `/api/tickets/${id}/runs/${originalRunId}/artifacts/proof/media`),
      invoke(daemon, "GET", `/api/tickets/${id}/runs/${activeRunId}/artifacts/proof/media`)
    ]);
    assert.equal(historicalBody.json.content, "historical handoff");
    assert.equal(currentBody.json.content, "current handoff");
    assert.equal(historicalMedia.text, "historical media");
    assert.equal(currentMedia.text, "current media");
  });
});

test("ticket inspection keeps every retained worker attempt individually addressable", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "parallel-a", title: "Parallel A", permission: "write", writeScope: "src/a.js" }, { id: "parallel-b", title: "Parallel B", permission: "write", writeScope: "src/b.js" }] });
    plan.nodes[0].attempts = [
      { attemptId: "first", runId: "a-1", status: "failed", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:01:00.000Z", terminationReason: "worker_failure", failureKind: "provider", failurePhase: "execution", failure: { kind: "provider", phase: "execution", message: "rate limit" }, rawOutput: "old result" },
      { attemptId: "second", runId: "a-2", status: "verified", startedAt: "2026-09-03T10:02:00.000Z", completedAt: "2026-09-03T10:03:00.000Z", rawOutput: "new result" }
    ];
    plan.nodes[1].attempts = [{ attemptId: "only", runId: "b-1", status: "verified", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:03:00.000Z", rawOutput: "sibling result" }];
    const id = await seedRun(daemon, { plan, stages: [{ id: "implement", title: "Implement", status: "completed" }] });
    const inspection = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/inspection`);
    assert.deepEqual(inspection.json.attempts.map((attempt) => attempt.id), ["attempt:parallel-a:first", "attempt:parallel-a:second", "attempt:parallel-b:only"]);
    assert.deepEqual(inspection.json.workers.find((worker) => worker.stepId === "parallel-a").attemptIds, ["attempt:parallel-a:first", "attempt:parallel-a:second"]);
    assert.deepEqual(inspection.json.attempts.map((attempt) => attempt.workerId), ["worker:parallel-a", "worker:parallel-a", "worker:parallel-b"]);
    assert.deepEqual(inspection.json.attempts[0].resources.prompt, { state: "not_retained" });
    assert.deepEqual({
      terminationReason: inspection.json.attempts[0].terminationReason,
      failureKind: inspection.json.attempts[0].failureKind,
      failurePhase: inspection.json.attempts[0].failurePhase
    }, { terminationReason: "worker_failure", failureKind: "provider", failurePhase: "execution" });
    const detail = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/parallel-a/attempts/first/details`);
    assert.deepEqual({
      terminationReason: detail.json.terminationReason,
      failureKind: detail.json.failureKind,
      failurePhase: detail.json.failurePhase,
      failureMessage: detail.json.failure?.message
    }, { terminationReason: "worker_failure", failureKind: "provider", failurePhase: "execution", failureMessage: "rate limit" });
  });
});

test("attempt details are bounded, redacted, and require the exact retained identity", async () => {
  const harness = {
    ...mockHarness(),
    sessionTrace: async () => ({
      prompts: [{ prompt: "trace token=secret_abcdefgh", at: "2026-09-03T10:00:00.000Z" }],
      events: [{ type: "reasoning_summary", detail: "Safe summary", at: "2026-09-03T10:00:01.000Z" }],
      rawOutput: "trace ghp_0123456789abcdefghijklmnop " + "y".repeat(21000)
    })
  };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src" }] });
    plan.nodes[0].attempts = [{
      attemptId: "attempt-1", runId: "worker-1", status: "verified", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:01:00.000Z",
      rawOutput: "ghp_0123456789abcdefghijklmnop " + "x".repeat(21000),
      events: Array.from({ length: 200 }, (_, index) => ({ type: "tool_end", result: `password=secret_abcdefgh-${index}` })),
      diff: { files: ["src/a.js"], stat: "1 file", patch: "diff --git a/src/a.js b/src/a.js\n" + "x".repeat(21000) },
      verification: { checks: { status: "passed", command: "node test", summary: "Passed", output: "token=secret_abcdefgh " + "z".repeat(17000) } },
      sessionFile: "/tmp/private-session.jsonl"
    }];
    const id = await seedRun(daemon, {
      plan,
      artifacts: [
        { id: "prompt", name: "prompt.md", kind: "agent-prompt", stepId: "build", attemptId: "attempt-1", content: "Prompt api_key=secret_abcdefgh " + "p".repeat(17000), path: "/tmp/prompt.md" },
        { id: "output", name: "output.md", kind: "agent-output", stepId: "build", attemptId: "attempt-1", content: "Output token=secret_abcdefgh", path: "/tmp/output.md" },
        { id: "diff", name: "diff.patch", kind: "git-attempt-diff", stepId: "build", attemptId: "attempt-1", content: "diff", path: "/tmp/diff.patch" }
      ]
    });
    const path = `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`;
    const detail = await invoke(daemon, "GET", path);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.activity.state, "truncated");
    assert.deepEqual([detail.json.activity.returned, detail.json.activity.total], [100, 200]);
    assert.equal(detail.json.output.state, "available");
    assert.equal(detail.json.output.content, "Output [redacted]");
    assert.equal(detail.json.checks.state, "truncated");
    assert.equal(detail.json.diff.state, "truncated");
    assert.equal(detail.json.prompt.state, "truncated");
    assert.equal(detail.json.prompt.content.includes("secret_abcdefgh"), false);
    assert.equal(JSON.stringify(detail.json).includes("ghp_0123456789abcdefghijklmnop"), false);
    assert.equal(JSON.stringify(detail.json).includes("/tmp/private-session.jsonl"), false);
    assert.equal(detail.json.trace.content.events[0].type, "reasoning_summary");
    assert.equal(detail.json.trace.state, "truncated");
    assert.equal((await invoke(daemon, "GET", `/api/tickets/${id}/runs/other/steps/build/attempts/attempt-1/details`)).status, 400);

    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes("rawOutput"), false);
    assert.equal(JSON.stringify(state.json).includes("secret_abcdefgh"), false);
    const artifact = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/prompt`);
    assert.equal(artifact.json.content, undefined);
    assert.equal(artifact.json.path, undefined);
  }, { harness });
});

test("long live prompts retain truncation metadata after cancellation", async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const prompt = "p".repeat(20000);
  const harness = {
    ...mockHarness(),
    async runStep({ onEvent, signal }) {
      onEvent({ type: "prompt", label: "Prompt rendered", content: prompt });
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const startedRequest = invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry safely" } });
    await running;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && daemon.store.read().ticketRuns[id].activeRuns.build?.promptTotal !== prompt.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const live = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`);
    assert.equal(live.json.prompt.state, "truncated");
    assert.deepEqual([live.json.prompt.returned, live.json.prompt.total], [16000, prompt.length]);
    await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/cancel`, { body: {} });
    await startedRequest;
    const interrupted = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`);
    assert.equal(interrupted.json.prompt.state, "truncated");
    assert.deepEqual([interrupted.json.prompt.returned, interrupted.json.prompt.total], [16000, prompt.length]);
  }, { harness });
});

test("attempt details bound raw output without a retained output artifact", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src" }] });
    plan.nodes[0].attempts = [{
      attemptId: "attempt-1", runId: "worker-1", status: "verified",
      rawOutput: "x".repeat(21001)
    }];
    const id = await seedRun(daemon, { plan });
    const detail = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`);

    assert.equal(detail.status, 200);
    assert.equal(detail.json.output.state, "truncated");
    assert.equal(detail.json.output.returned, 20000);
    assert.equal(detail.json.output.total, 21001);
  });
});

test("attempt details prefer retained output artifacts and keep artifact bodies on the bounded content route", async () => {
  await withDaemon(async (daemon, { dataDir }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "running", permission: "write", writeScope: "src" }] });
    plan.nodes[0].attempts = [{ status: "interrupted", rawOutput: "" }];
    const id = await seedRun(daemon, {
      status: "running", plan,
      activeRuns: { build: {
        runId: "worker-1", attemptId: "active-worker-1",
        activity: { events: [{ type: "phase", label: "Editing" }], prompts: [{ content: "Use api_key=0123456789abcdef" }], rawOutput: "live output" }
      } }
    });
    const artifact = await persistArtifact(dataDir, { identifier: "T-1" }, {
      name: "result.md", content: "artifact api_key=0123456789abcdef", runId: "run-1", stageId: "implement", stepId: "build", attemptId: "attempt-1"
    });
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(artifact); });

    const active = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/active-worker-1/details`);
    assert.equal(active.status, 200);
    assert.equal(active.json.prompt.state, "available");
    assert.equal(active.json.prompt.content, "Use [redacted]");
    assert.equal(active.json.activity.state, "available");
    assert.equal(active.json.output.content, "live output");
    assert.equal(active.json.diff.state, "not_retained");
    assert.equal(active.json.checks.state, "not_retained");
    assert.equal(active.json.artifacts.state, "not_retained");
    assert.equal(JSON.stringify(active.json).includes("0123456789abcdef"), false);

    const legacy = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.json.output.state, "available");
    assert.equal(legacy.json.output.content, "artifact [redacted]");
    const metadata = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/${encodeURIComponent(artifact.id)}`);
    assert.equal(metadata.json.content, undefined);
    const content = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/${encodeURIComponent(artifact.id)}/content`);
    assert.equal(content.json.state, "available");
    assert.equal(content.json.content.includes("0123456789abcdef"), false);
  });
});

test("migrated colliding artifact IDs retrieve their own retained bodies", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-migrated-artifacts-"));
  try {
    await writeFile(join(dataDir, "state-v3.json"), JSON.stringify({
      version: 5, workspace: { cwd: dataDir }, ticketRuns: {
        legacy: {
          id: "legacy", runId: "legacy-run", status: "completed", ticket: { id: "legacy", identifier: "LEG-1" }, plan: { nodes: [] },
          artifacts: [
            { id: "legacy-output", name: "output.md", kind: "agent-output", stageId: "implement", stepId: "build", attemptId: "attempt-1", content: "first body" },
            { id: "legacy-output", name: "output.md", kind: "agent-output", stageId: "implement", stepId: "build", attemptId: "attempt-1", content: "second body" }
          ]
        }
      }
    }));
    await withDaemon(async (daemon) => {
      const artifacts = daemon.store.read().ticketRuns.legacy.artifacts;
      assert.notEqual(artifacts[0].id, artifacts[1].id);
      const first = await invoke(daemon, "GET", `/api/tickets/legacy/artifacts/${encodeURIComponent(artifacts[0].id)}/content`);
      const second = await invoke(daemon, "GET", `/api/tickets/legacy/artifacts/${encodeURIComponent(artifacts[1].id)}/content`);
      assert.equal(first.json.content, "first body");
      assert.equal(second.json.content, "second body");
    }, { dataDir, cwd: dataDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an expected prompt.md output and the worker prompt remain independently retrievable", async () => {
  const harness = {
    ...mockHarness(),
    runStep: async () => ({ report: { status: "completed", summary: "Completed" }, output: "agent output", prompt: "worker prompt", rawOutput: "" }),
    runRepositoryChecks: async () => ({ status: "passed", command: "node --test", summary: "Passed", output: "", evidence: [] }),
    evidenceImages: async () => [],
    verifyStep: async () => ({ summary: "Verified", findings: [] }),
    generateCommitMessage: async () => "feat: retain artifacts"
  };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [], expectedArtifacts: ["prompt.md"]
    }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const response = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry safely" } });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !daemon.store.read().ticketRuns[id].artifacts.some((artifact) => artifact.kind === "agent-prompt")) await new Promise((resolve) => setTimeout(resolve, 10));

    const artifacts = daemon.store.read().ticketRuns[id].artifacts;
    const output = artifacts.find((artifact) => artifact.kind === "agent-output");
    const prompt = artifacts.find((artifact) => artifact.kind === "agent-prompt");
    assert.ok(output);
    assert.ok(prompt);
    assert.notEqual(output.id, prompt.id);
    assert.notEqual(output.path, prompt.path);
    const [outputBody, promptBody] = await Promise.all([
      invoke(daemon, "GET", `/api/tickets/${id}/artifacts/${encodeURIComponent(output.id)}/content`),
      invoke(daemon, "GET", `/api/tickets/${id}/artifacts/${encodeURIComponent(prompt.id)}/content`)
    ]);
    assert.equal(outputBody.json.content, "agent output");
    assert.equal(promptBody.json.content, "worker prompt");
  }, { harness });
});

/*
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

test("active and retained API state preserve all cleanup outcomes and details", async () => {
  await withDaemon(async (daemon) => {
    const records = {
      complete: { platform: { name: "linux", supported: true }, discovered: [{ pid: 71, ppid: 7, startTime: "101" }], actions: [{ pid: 71, signal: "SIGTERM", status: "sent", at: "2026-09-03T10:00:01.000Z" }], unresolved: [], diagnostics: [] },
      incomplete: { platform: { name: "linux", supported: true }, discovered: [{ pid: 72, ppid: 7, startTime: "102" }], actions: [{ pid: 72, signal: "SIGKILL", status: "sent", at: "2026-09-03T10:00:01.000Z" }], unresolved: [{ pid: 72, reason: "still-running-after-force" }], diagnostics: ["Process remained after force termination"] },
      unsupported: { platform: { name: "darwin", supported: false, reason: "Safe process identity discovery is not available" }, discovered: [], actions: [], unresolved: [], diagnostics: ["No safe adapter"] },
      "not-required": { platform: { name: "linux", supported: true }, discovered: [], actions: [], unresolved: [], diagnostics: [] }
    };
    for (const [outcome, details] of Object.entries(records)) {
      const id = `cleanup-${outcome}`;
      const execution = {
        executionId: `execution-${outcome}`, outcome, stepId: "build", attemptId: "attempt-1",
        ownership: { executionId: `execution-${outcome}`, establishedAt: "2026-09-03T10:00:00.000Z", tokenPresent: true },
        startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:00:02.000Z",
        triggers: [{ trigger: outcome === "unsupported" ? "daemon-shutdown" : "worker-completed", at: "2026-09-03T10:00:00.000Z" }],
        ...details
      };
      await seedRun(daemon, {
        ticket: { id, identifier: `CLEAN-${outcome}`, title: `${outcome} cleanup`, description: "", source: "local", state: { name: "Local", type: "local" }, team: { name: "Local" } },
        status: "completed",
        cleanup: { outcome, updatedAt: "2026-09-03T10:00:02.000Z", executions: [execution] }
      });
    }
    const active = await invoke(daemon, "GET", "/api/state");
    for (const outcome of Object.keys(records)) {
      const cleanup = active.json.ticketRuns[`cleanup-${outcome}`].cleanup;
      assert.equal(cleanup.outcome, outcome);
      assert.equal(cleanup.executions[0].platform.name, records[outcome].platform.name);
      assert.deepEqual(cleanup.executions[0].unresolved, records[outcome].unresolved);
      assert.deepEqual(cleanup.executions[0].diagnostics, records[outcome].diagnostics);
    }
    const compact = await invoke(daemon, "GET", "/api/tickets/cleanup-incomplete/run");
    assert.equal(compact.json.cleanup.outcome, "incomplete");
    assert.equal(compact.json.cleanup.executions[0].actions[0].signal, "SIGKILL");

    await invoke(daemon, "POST", "/api/queue/clear", { body: {} });
    const retained = await invoke(daemon, "GET", "/api/state");
    for (const outcome of Object.keys(records)) {
      const cleanup = retained.json.retainedRuns[`cleanup-${outcome}:run-1`].cleanup;
      assert.equal(cleanup.outcome, outcome);
      assert.equal(cleanup.executions[0].platform.supported, records[outcome].platform.supported);
      assert.deepEqual(cleanup.executions[0].discovered, records[outcome].discovered);
    }
    assert.equal(Object.keys(retained.json.ticketRuns).length, 0);
  });
*/

test("ticket selection returns a compact acknowledgment", async () => {
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
    const response = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact.id)}/content`);
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
      prompt: "Prompt from [path]",
      at: "2026-09-02T10:00:01.000Z",
      title: "Design & plan",
      status: "completed"
    }]);
  }, { harness });
});

test("verify-stage prompts retain independent review session handles without exposing paths", async () => {
  const reviewSessionFile = "/tmp/private-independent-review.jsonl";
  const harness = {
    ...mockHarness(),
    sessionTrace: async (sessionFile, bounds) => {
      assert.equal(sessionFile, reviewSessionFile);
      assert.deepEqual(bounds, { after: "2026-09-02T10:00:00.000Z", before: "2026-09-02T10:00:02.000Z" });
      return { prompts: [{ prompt: `Independent review from ${sessionFile}`, at: "2026-09-02T10:00:01.000Z" }] };
    }
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      reviews: [{ round: 1, reviews: [{ role: "verification", summary: "Reviewed", sessionFile: reviewSessionFile }] }],
      stages: [{ id: "verify", title: "Final review", status: "completed", activity: { startedAt: "2026-09-02T10:00:00.000Z", completedAt: "2026-09-02T10:00:02.000Z" } }]
    });
    const runId = daemon.store.read().ticketRuns[id].runId;
    const prompts = await invoke(daemon, "GET", `/api/tickets/${id}/runs/${runId}/stages/verify/prompts`);
    assert.equal(prompts.status, 200);
    assert.equal(prompts.json.prompts[0].title, "verification review · round 1");
    assert.equal(prompts.json.prompts[0].prompt, "Independent review from [path]");
    assert.deepEqual(prompts.json.trace, { state: "available", retained: 1, available: 1 });

    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes(reviewSessionFile), false);
    assert.equal(daemon.store.read().ticketRuns[id].reviews[0].reviews[0].sessionFile, reviewSessionFile);
  }, { harness });
});

test("verify-stage prompt inspection reports a retained but unavailable review trace", async () => {
  const reviewSessionFile = "/tmp/unavailable-independent-review.jsonl";
  const harness = { ...mockHarness(), sessionTrace: async () => { throw new Error("Session file is unavailable"); } };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      reviews: [{ round: 1, reviews: [{ role: "verification", summary: "Reviewed", sessionFile: reviewSessionFile }] }],
      stages: [{ id: "verify", title: "Final review", status: "completed" }]
    });
    const runId = daemon.store.read().ticketRuns[id].runId;
    const prompts = await invoke(daemon, "GET", `/api/tickets/${id}/runs/${runId}/stages/verify/prompts`);
    assert.equal(prompts.status, 200);
    assert.deepEqual(prompts.json, { prompts: [], trace: { state: "unavailable", retained: 1, available: 0 } });
    assert.equal(JSON.stringify(prompts.json).includes(reviewSessionFile), false);
  }, { harness });
});

test("provider failure snapshots the active worker before server state is cleared", async () => {
  const harness = { ...mockHarness(), runStep: async () => { throw new Error("Provider rate limit exceeded"); } };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const response = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry with provider access" } });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !daemon.store.read().ticketRuns[id].plan.nodes[0].attempts.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const step = daemon.store.read().ticketRuns[id].plan.nodes[0];
    assert.equal(step.status, "failed");
    assert.equal(step.attempts.length, 1);
    assert.equal(step.attempts[0].status, "failed");
    assert.equal(step.attempts[0].failureKind, "provider");
    assert.equal(step.attempts[0].terminationReason, "worker_failure");
    assert.equal(step.attempts[0].attemptId, "attempt-1");
  }, { harness });
});

test("worker contexts hydrate retained artifact bodies without restoring them to state", async () => {
  let receivedArtifacts;
  const harness = {
    ...mockHarness(),
    runStep: async ({ artifacts }) => {
      receivedArtifacts = artifacts;
      return { report: { status: "failed", summary: "Stop after inspecting context" }, output: "", prompt: "", rawOutput: "", events: [] };
    }
  };
  await withDaemon(async (daemon, { dataDir }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const artifact = await persistArtifact(dataDir, daemon.store.read().ticketRuns[id].ticket, {
      name: "architecture.md", content: "# Retained architecture\n\napi_key=secret_abcdefgh", runId: "run-1", stageId: "design", kind: "architecture"
    });
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(artifact); });
    await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Check retained context" } });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !receivedArtifacts) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(receivedArtifacts?.find((item) => item.id === artifact.id)?.content, "# Retained architecture\n\n[redacted]");
    assert.equal(daemon.store.read().ticketRuns[id].artifacts[0].content, undefined);
  }, { harness });
});

test("worker-report errors are redacted before durable failure state is written", async () => {
  const secret = "api_key=0123456789abcdef";
  const harness = {
    ...mockHarness(),
    runStep: async () => ({
      report: { status: "failed", summary: `Worker stopped with ${secret}`, request: `Rotate ${secret}` },
      output: "No changes", prompt: "Inspect the failure", rawOutput: ""
    })
  };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const response = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry safely" } });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && daemon.store.read().ticketRuns[id].plan.nodes[0].status !== "needs_attention") await new Promise((resolve) => setTimeout(resolve, 10));
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(run.plan.nodes[0].status, "needs_attention");
    assert.equal(JSON.stringify(run).includes("0123456789abcdef"), false);
    assert.equal(run.stages.find((stage) => stage.id === "implement").summary.includes("[redacted]"), true);
  }, { harness });
});

test("supervisor review replies are redacted before persistence and API projection", async () => {
  const secret = "api_key=0123456789abcdef";
  const harness = {
    ...mockHarness(),
    runStep: async () => ({ report: { status: "completed", summary: "Completed safely" }, output: "Done", prompt: "Implement safely", rawOutput: "" }),
    runRepositoryChecks: async () => ({ status: "passed", command: "node --test", summary: "Passed", output: "", evidence: [] }),
    evidenceImages: async () => [],
    verifyStep: async () => ({ summary: "Verified", findings: [] }),
    reviewWorkerReport: async () => ({ reply: `Supervisor reply includes ${secret}`, error: `Supervisor error includes ${secret}`, checkpoints: [] }),
    generateCommitMessage: async () => "feat: complete build"
  };
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan, sessionFile: "/tmp/supervisor-session.jsonl",
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const response = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry safely" } });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && daemon.store.read().ticketRuns[id].plan.nodes[0].status !== "review_ready") await new Promise((resolve) => setTimeout(resolve, 10));
    const step = daemon.store.read().ticketRuns[id].plan.nodes[0];
    assert.equal(step.status, "review_ready");
    assert.equal(step.supervisorReview.reply.includes(secret), false);
    assert.equal(step.supervisorReview.error.includes(secret), false);
    assert.equal(step.supervisorReview.reply.includes("[redacted]"), true);
    const reloaded = await new JsonStore(join(dataDir, "state-v3.json"), cwd).init();
    assert.equal(JSON.stringify(reloaded.ticketRuns[id]).includes(secret), false);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes(secret), false);
  }, { harness });
});

test("streamed worker output survives cancellation and persisted reload", async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const harness = {
    ...mockHarness(),
    async runStep({ onEvent, signal }) {
      onEvent({ type: "text_delta", delta: "streamed output tail" });
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  };
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, {
      status: "awaiting_step_review", plan,
      checkpoint: { id: "review-1", kind: "step_review", stepId: "build", title: "Review: Build" }
    });
    const startedRequest = invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/steps/build/changes`, { body: { feedback: "Retry after stream" } });
    await running;
    const cancelled = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/cancel`, { body: {} });
    await startedRequest;
    assert.equal(cancelled.status, 200);
    const attempt = daemon.store.read().ticketRuns[id].plan.nodes[0].attempts[0];
    assert.equal(attempt.rawOutput, "streamed output tail");

    const reloaded = await new JsonStore(join(dataDir, "state-v3.json"), cwd).init();
    assert.equal(reloaded.ticketRuns[id].plan.nodes[0].attempts[0].rawOutput, "streamed output tail");
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

test("GET /api/models lists xAI and OpenAI subscription models", async () => {
  const harness = {
    ...mockHarness(),
    async models(provider) {
      assert.equal(provider, undefined);
      return [
        { id: "grok-build-0.1", name: "Grok Build", provider: "xai" },
        { id: "gpt-test", name: "Test", provider: "openai-codex" },
        { id: "other", name: "Other", provider: "anthropic" }
      ];
    }
  };
  await withDaemon(async (daemon) => {
    const result = await invoke(daemon, "GET", "/api/models");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.providers, ["xai", "openai-codex"]);
    assert.deepEqual(result.json.models.map((model) => model.id), ["grok-build-0.1", "gpt-test"]);
  }, { harness });
});

test("POST preview start fails when the repository has no preview command", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "needs_attention" });
    const result = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/preview`, { body: { action: "start" } });
    assert.equal(result.status >= 400, true);
    assert.match(String(result.json?.error || result.text), /preview or start command/i);
  });
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

test("design output is redacted before artifact, checkpoint, plan, and API persistence", async () => {
  const secret = "api_key=design_plan_secret_12345678";
  const harness = {
    ...mockHarness(),
    async designTicket() {
      return {
        artifact: `# Design\n\n${secret}`,
        plan: normalizePlan({
          summary: `Plan summary ${secret}`,
          nodes: [{
            id: "redacted-design", title: `Implement ${secret}`, description: `Description ${secret}`,
            prompt: `Prompt ${secret}`, permission: "read", writeScope: `src/${secret}.js`,
            acceptanceCriteria: [`Criterion ${secret}`]
          }]
        }),
        sessionFile: null
      };
    }
  };
  await withDaemon(async (daemon, { dataDir }) => {
    const id = await seedRun(daemon, {
      status: "interrupted",
      stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((stage) => ({
        id: stage, title: stage, status: ["requirements", "explore"].includes(stage) ? "completed" : stage === "design" ? "blocked" : "pending", summary: ""
      }))
    });
    const run = daemon.store.read().ticketRuns[id];
    const artifacts = await Promise.all([
      ["requirements.md", "requirements"],
      ["product-context.md", "product-context-snapshot"],
      ["implementation-delta.md", "implementation-delta"]
    ].map(async ([name, kind]) => persistArtifact(dataDir, run.ticket, {
      name, content: `# ${kind}`, runId: run.runId, stageId: kind === "requirements" || kind === "product-context-snapshot" ? "requirements" : "explore", kind
    })));
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(...artifacts); });

    const resumed = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/resume`);
    assert.equal(resumed.status, 202);
    const durable = daemon.store.read().ticketRuns[id];
    assert.equal(durable.status, "awaiting_approval");
    assert.equal(JSON.stringify(durable).includes(secret), false);
    assert.match(durable.checkpoint.prompt, /\[redacted\]/);
    assert.match(durable.plan.summary, /\[redacted\]/);
    assert.match(await readFile(durable.artifacts.find((artifact) => artifact.kind === "architecture").path, "utf8"), /\[redacted\]/);
    assert.equal((await readFile(join(dataDir, "state-v3.json"), "utf8")).includes(secret), false);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes(secret), false);
  }, { harness });
});

test("continued workflow replies and checkpoints are redacted before durable persistence", async () => {
  const secret = "api_key=0123456789abcdef";
  const harness = {
    ...mockHarness(),
    continueWorkflow: async () => ({
      reply: `Supervisor reply includes ${secret}`,
      stages: [{ id: "follow-up", title: `Follow up ${secret}`, status: "active", summary: `Summary ${secret}` }],
      checkpoints: [{ kind: "needs_input", title: `Question ${secret}`, prompt: `Prompt ${secret}` }],
      sessionFile: "/tmp/supervisor.jsonl"
    })
  };
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, {
      status: "awaiting_approval",
      workflow: {
        skillName: "shape-feature", status: "awaiting_approval", stages: [],
        checkpoints: [{ id: "workflow-1", kind: "awaiting_approval", title: "Continue", prompt: "Continue", source: "supervisor", blocking: true, status: "pending" }]
      },
      checkpoint: { id: "workflow-1", kind: "awaiting_approval", title: "Continue", prompt: "Continue", source: "supervisor" }
    });
    const continued = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/workflow/continue`, {
      body: { checkpointId: "workflow-1", response: "Approved" }
    });
    assert.equal(continued.status, 202);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && daemon.store.read().ticketRuns[id].workflow.checkpoints.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    const durable = daemon.store.read().ticketRuns[id];
    assert.equal(JSON.stringify(durable).includes(secret), false);
    assert.equal(durable.workflow.lastReview.includes("[redacted]"), true);
    assert.equal(durable.checkpoint.prompt.includes("[redacted]"), true);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes(secret), false);
  }, { harness });
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

    await daemon.store.update((state) => { state.ticketRuns[id].plan.nodes[0].status = "needs_input"; });
    const inputExpansion = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, {
      body: { paths: ["test/focused.test.js"], reason: "The worker requested this exact bounded test scope." }
    });
    assert.equal(inputExpansion.status, 200, inputExpansion.text);

    await daemon.store.update((state) => { state.ticketRuns[id].plan.nodes[0].status = "review_ready"; });
    const reviewExpansion = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, {
      body: { paths: ["src/execution.js"], reason: "Review found a shared lifecycle correction before acceptance.", reviewBudget: { maxFiles: 12, maxChangedLines: 1400 } }
    });
    assert.equal(reviewExpansion.status, 200, reviewExpansion.text);
    assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].status, "review_ready");
    assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].reviewBudget.maxChangedLines, 1400);
    assert.equal(reviewExpansion.json.scopeChange.reviewBudget.maxFiles, 12);
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/scope`, {
      body: { paths: ["src/execution.js"], reason: "Invalid budget", reviewBudget: { maxFiles: 0, maxChangedLines: 1400 } }
    })).status, 400);

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

test("paused verification survives daemon reload without repeating unchanged worker work or checks", async () => {
  for (const changed of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "agent-plan-resume-verification-"));
    const cwd = join(root, "repo");
    const dataDir = join(root, "state");
    let workerCalls = 0, checkCalls = 0, reviewCalls = 0;
    const reviewFocus = [];
    let reviewing;
    const started = new Promise((resolve) => { reviewing = resolve; });
    const harness = {
      ...mockHarness(),
      runStep: async () => {
        workerCalls++;
        return { report: { status: "completed", summary: "implemented" }, output: "implemented", prompt: "build", reviewNotes: [], rawOutput: "" };
      },
      runRepositoryChecks: async () => {
        checkCalls++;
        if (checkCalls === 2) return { status: "failed", command: "verify", summary: "Fixture check failed", output: "Fixture check failed", evidence: [] };
        return { status: "passed", command: "verify", summary: "passed", output: "", evidence: [] };
      },
      evidenceImages: async () => [],
      generateCommitMessage: async () => "Keep completed work across pauses",
      verifyStep: async ({ signal, focusFindings }) => {
        reviewFocus.push(focusFindings);
        if (++reviewCalls === 2) {
          reviewing();
          await new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return { summary: "Verified", findings: [] };
      }
    };
    let id;
    try {
      await mkdir(cwd);
      await withDaemon(async (daemon) => {
        const ticket = { id: "resume-proof", identifier: "LOCAL-resume", title: "Resume proof", source: "local", state: { name: "Local", type: "local" } };
        const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
        const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src", expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"] }] });
        id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" } });
        assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: {} })).status, 202);
        const criterionIds = daemon.store.read().ticketRuns[id].proofMap?.criteria.map((criterion) => criterion.id) || [];
        const running = invoke(daemon, "POST", `/api/tickets/${id}/steps/build/changes`, { body: { feedback: "Keep policy saving disabled until loading succeeds.", criterionIds } });
        await Promise.race([started, running.then((response) => { throw new Error(`Worker stopped before verification: ${response.text}`); })]);
        assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/pause`, { body: {} })).status, 200);
        await running;
        assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].pendingVerification.checks.status, "passed");
        if (changed) {
          await mkdir(join(workspace.cwd, "src"), { recursive: true });
          await writeFile(join(workspace.cwd, "src", "changed.js"), "export const changed = true;\n");
        }
      }, { cwd, dataDir, harness });
      await withDaemon(async (daemon) => {
        const resumed = await invoke(daemon, "POST", `/api/tickets/${id}/resume`, { body: {} });
        assert.equal(resumed.status, 202, resumed.text);
        const step = daemon.store.read().ticketRuns[id].plan.nodes[0];
        assert.equal(step.status, "review_ready");
        assert.equal(step.pendingVerification, undefined);
        assert.equal(workerCalls, changed ? 4 : 3);
        assert.equal(checkCalls, changed ? 4 : 3);
        assert.equal(reviewCalls, 3);
        assert.ok(reviewFocus[1].some((finding) => finding.claim.includes("Keep policy saving disabled")));
        if (!changed) assert.deepEqual(reviewFocus[2], reviewFocus[1]);
      }, { cwd, dataDir, harness });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("async action requests acknowledge launch and retain later worker failures", { timeout: 10000 }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = { ...mockHarness(), runStep: async () => { await gate; throw new Error("Worker failed after acknowledgement"); } };
  try {
    await withDaemon(async (daemon, { cwd }) => {
      const ticket = { id: "async-action", identifier: "LOCAL-async", title: "Async action", source: "local", state: { name: "Local", type: "local" } };
      const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
      const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src", expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"] }] });
      const id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" } });
      if (!daemon.server.address()) await new Promise((resolve) => daemon.server.once("listening", resolve));
      const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/api/tickets/${id}/approve`, {
        method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" }, body: "{}", signal: AbortSignal.timeout(3000)
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).accepted, true);
      assert.equal(daemon.store.read().ticketRuns[id].lastError, null);
      release();
      const deadline = Date.now() + 3000;
      while (!daemon.store.read().ticketRuns[id].lastError && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(daemon.store.read().ticketRuns[id].lastError, "Worker failed after acknowledgement");
      assert.equal(daemon.store.read().ticketRuns[id].status, "needs_attention");
    }, { harness, listen: true });
  } finally { release(); }
});

test("oversized worker output stays intact and cannot resume until its budget is approved", async () => {
  let workerCalls = 0;
  const content = "required change\n".repeat(12);
  const harness = {
    ...mockHarness(),
    runStep: async ({ cwd }) => {
      workerCalls++;
      await writeFile(join(cwd, "change.txt"), content);
      return { report: { status: "completed", summary: "Implemented" }, output: "Implemented", prompt: "Build", reviewNotes: [], rawOutput: "" };
    },
    runRepositoryChecks: async () => ({ status: "passed", summary: "Passed", output: "", evidence: [] }),
    evidenceImages: async () => []
  };
  await withDaemon(async (daemon, { cwd }) => {
    const ticket = { id: "budget-preserved", identifier: "LOCAL-budget", title: "Preserve output", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await createZeroStateWorkspace({ cwd, ticket, runId: "run-1" });
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "change.txt", expectedFiles: ["change.txt"], estimatedChangedLines: 1, reviewBudget: { maxFiles: 1, maxChangedLines: 2 } }] });
    const id = await seedRun(daemon, { ticket, workspace, baselineTree: workspace.baselineTree, plan, status: "awaiting_approval", checkpoint: { kind: "awaiting_approval" } });
    const waitStopped = async () => {
      const deadline = Date.now() + 3000;
      while (daemon.store.read().ticketRuns[id].status !== "needs_attention" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(daemon.store.read().ticketRuns[id].status, "needs_attention");
    };
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } })).status, 202);
    await waitStopped();
    assert.equal(await readFile(join(workspace.cwd, "change.txt"), "utf8"), content);
    assert.equal(daemon.store.read().ticketRuns[id].checkpoint.title, "Review budget approval required");
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} })).status, 400);
    await invoke(daemon, "POST", `/api/tickets/${id}/resume`, { body: {} });
    await waitStopped();
    assert.equal(workerCalls, 1);
    assert.equal(await readFile(join(workspace.cwd, "change.txt"), "utf8"), content);
  }, { harness });
});

test("step execution failures persist an actionable run checkpoint", async () => {
  for (const source of ["execution", "verification"]) {
  let verifyCalls = 0;
  const workerFeedback = [];
  const harness = {
    ...mockHarness(),
    generateCommitMessage: async () => "fix: correct the scoped write guard\n\nWhy: Reverify operator corrections after a failed inspection.",
    runStep: async ({ feedback }) => {
      workerFeedback.push(feedback);
      return { report: { status: "completed", summary: "implemented" }, output: "implemented", prompt: "build", reviewNotes: [], rawOutput: "" };
    },
    runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: [] }),
    evidenceImages: async () => [],
    verifyStep: async () => {
      if (++verifyCalls === 1) throw new Error("Verification exceeded its inspection budget.");
      return { summary: "Correction reviewed", findings: [] };
    }
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
    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} })).status, 400);
    await daemon.store.update((state) => { state.ticketRuns[id].checkpoint.source = source; });
    const corrected = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/changes`, { body: {
      feedback: "Correct the reproduced scope escape.", criterionIds: run.proofMap.criteria.map((criterion) => criterion.id)
    } });
    assert.equal(corrected.status, 202, corrected.text);
    assert.equal(workerFeedback.at(-1), "Correct the reproduced scope escape.");
    assert.equal(verifyCalls, 2);
    assert.equal(daemon.store.read().ticketRuns[id].lastError, null);
    assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].status, "review_ready", daemon.store.read().ticketRuns[id].lastError);
  }, { harness });
  }
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

test("final proof approval blocks UI tickets without ticket-bound screenshots", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build", status: "accepted", requiresVisualEvidence: true, acceptanceCriteria: ["Visible"]
    }] });
    const map = initializeProofMap(plan, { approvedAt: "2026-09-10T10:00:00.000Z" });
    const finalChecks = { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed" };
    const proofMap = applyProofReports(map, [{
      criterionId: map.criteria[0].id, status: "verified", evidence: [{ type: "check", scope: "final" }]
    }], { plan, artifacts: [], finalChecks }, { reportedAt: "2026-09-10T11:00:00.000Z" });
    const id = await seedRun(daemon, {
      plan, proofMap, finalChecks, status: "awaiting_evidence_review",
      checkpoint: {
        id: "final-proof", kind: "evidence_review", finalChecks,
        media: [{ id: "screen", kind: "visual-evidence", name: "desktop.png", path: "/tmp/unbound-desktop.png", mediaKind: "image" }]
      }
    });
    const approval = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(approval.status, 400, approval.text);
    assert.match(approval.json.error, /ticket-bound/);
  });
});

test("plan approval surfaces that named commands are not a filesystem sandbox", async () => {
  const harness = {
    ...mockHarness(),
    async designTicket() {
      return {
        artifact: "# Design\n\nChosen approach.",
        plan: normalizePlan({ nodes: [{ id: "build", title: "Build", acceptanceCriteria: ["Works"] }] }),
        sessionFile: null
      };
    }
  };
  await withDaemon(async (daemon, { dataDir }) => {
    const id = await seedRun(daemon, {
      status: "interrupted",
      stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((stage) => ({
        id: stage, title: stage, status: ["requirements", "explore"].includes(stage) ? "completed" : stage === "design" ? "blocked" : "pending", summary: ""
      }))
    });
    const run = daemon.store.read().ticketRuns[id];
    const artifacts = await Promise.all([
      ["requirements.md", "requirements"],
      ["product-context.md", "product-context-snapshot"],
      ["implementation-delta.md", "implementation-delta"]
    ].map(async ([name, kind]) => persistArtifact(dataDir, run.ticket, {
      name, content: `# ${kind}`, runId: run.runId, stageId: kind === "requirements" || kind === "product-context-snapshot" ? "requirements" : "explore", kind
    })));
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(...artifacts); });
    const resumed = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/resume`);
    assert.equal(resumed.status, 202);
    let durable;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      durable = daemon.store.read().ticketRuns[id];
      if (durable.status === "awaiting_approval" && durable.checkpoint?.notice) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(durable.status, "awaiting_approval", durable.lastError || durable.status);
    assert.match(String(durable.checkpoint?.prompt || ""), /not a filesystem sandbox/);
    assert.match(String(durable.checkpoint?.notice || ""), /agent file-tool boundaries/);
    assert.match(String(durable.checkpoint?.notice || ""), /not a filesystem sandbox/);
    assert.doesNotMatch(String(durable.checkpoint?.notice || ""), /sandbox(?:ed)? (?:the )?subprocess|subprocess(?:es)? (?:are|is|remain) restricted/i);
    const exposed = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/run`);
    assert.match(String(exposed.json.checkpoint?.notice || ""), /not a filesystem sandbox/);
    assert.match(String(exposed.json.checkpoint?.notice || ""), /agent file-tool boundaries/);
  }, { harness });
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

test("final proof feedback is redacted before its pending durable state is exposed", async () => {
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    })
  };
  await withDaemon(async (daemon, { dataDir }) => {
    const id = await seedRun(daemon, {
      status: "awaiting_evidence_review",
      checkpoint: { id: "proof-redaction", kind: "evidence_review", title: "Review final proof" }
    });
    const secret = "api_key=proof_feedback_secret_12345678";
    const result = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/evidence/changes`, {
      body: { feedback: `Record the confirmation state again; ${secret}` }
    });
    assert.equal(result.status, 202);

    const pending = daemon.store.read().ticketRuns[id].pendingEvidenceFeedback;
    assert.match(pending, /Record the confirmation state again/);
    assert.equal(pending.includes(secret), false);
    assert.equal(JSON.stringify(await readFile(join(dataDir, "state-v3.json"), "utf8")).includes(secret), false);
    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes(secret), false);
  }, { harness });
});

test("stage output is bounded, redacted and readable from retained runs after reload", async () => {
  await withDaemon(async (daemon, { dataDir, cwd }) => {
    const id = await seedRun(daemon, { stages: [{ id: "requirements", status: "completed", activity: { rawOutput: "Saved clarification" } }, { id: "explore", status: "completed", activity: { rawOutput: "password=secret_abcdefgh " + "x".repeat(110000) } }] });
    const route = (stage) => `/api/tickets/${id}/runs/run-1/stages/${stage}/output`;
    assert.equal((await invoke(daemon, "GET", route("requirements"))).json.content, "Saved clarification");
    const output = (await invoke(daemon, "GET", route("explore"))).json;
    assert.ok(output.content.length <= 100000);
    assert.match(output.content, /redacted/);
    assert.doesNotMatch(output.content, /secret_abcdefgh/);
    await invoke(daemon, "POST", "/api/queue/clear", { body: {} });
    assert.equal((await invoke(daemon, "GET", route("requirements"))).json.content, "Saved clarification");
    const reloaded = new JsonStore(join(dataDir, "state-v3.json"), cwd);
    await reloaded.init();
    assert.equal(Object.values(reloaded.read().retainedRuns)[0].stages[0].activity.rawOutput, "Saved clarification");
    assert.ok((await invoke(daemon, "GET", route("missing"))).status >= 400);
  });
});

test("delivery recovery uses typed failures instead of inferring code work from arbitrary diagnostics", () => {
  assert.equal(deliveryFailureNeedsFix("Coverage incomplete", { kind: "visual-evidence" }), true);
  assert.equal(deliveryFailureNeedsFix("Fixture failed", { kind: "capture-preflight" }), true);
  assert.equal(deliveryFailureNeedsFix("SyntaxError mentioned in upload response", { kind: "evidence-publication" }), false);
  assert.equal(deliveryFailureNeedsFix("Provider unavailable", { kind: "provider" }), false);
});

test("workspace access policy saves per primary and leaves a previous policy unchanged on invalid update", async () => {
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    const extra = await mkdtemp(join(tmpdir(), "agent-plan-policy-extra-"));
    const otherPrimary = await mkdtemp(join(tmpdir(), "agent-plan-policy-other-"));
    const missing = join(extra, "does-not-exist");
    try {
      const unset = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(unset.status, 200);
      assert.deepEqual(unset.json, { mode: "restricted", extraRoots: [] });
      assert.equal(daemon.store.read().projectPolicies, undefined);

      const saved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: extra, mode: "read-only" }, { path: extra, mode: "read-only" }] }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.mode, "restricted");
      assert.equal(saved.json.extraRoots.length, 1);
      assert.equal(saved.json.extraRoots[0].mode, "read-only");
      assert.equal(saved.json.extraRoots[0].displayPath, extra);

      const invalidMode = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: extra, mode: "write-only" }] }
      });
      assert.equal(invalidMode.status, 400);
      assert.match(invalidMode.json.error, /Unknown extra root mode “write-only”/);

      const conflicting = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: extra, mode: "read-only" }, { path: extra, mode: "read/write" }] }
      });
      assert.equal(conflicting.status, 400);
      assert.match(conflicting.json.error, /different modes/);

      const missingPath = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: missing, mode: "read-only" }] }
      });
      assert.equal(missingPath.status, 400);
      assert.match(missingPath.json.error, /does not exist/);

      const invalidAny = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { mode: "any", extraRoots: [{ path: missing, mode: "read-only" }] }
      });
      assert.equal(invalidAny.status, 400);
      assert.match(invalidAny.json.error, /does not exist/);

      const previous = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(previous.status, 200);
      assert.equal(previous.json.mode, "restricted");
      assert.equal(previous.json.extraRoots.length, 1);
      assert.equal(previous.json.extraRoots[0].mode, "read-only");
      assert.equal("extraRoots" in daemon.store.read().settings, false);

      const switched = await invoke(daemon, "POST", "/api/workspace", { body: { cwd: otherPrimary } });
      assert.equal(switched.status, 200);
      const otherPolicy = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.deepEqual(otherPolicy.json, { mode: "restricted", extraRoots: [] });

      const reloaded = await new JsonStore(join(dataDir, "state-v3.json"), otherPrimary).init();
      const otherKey = await canonicalPrimaryPath(otherPrimary);
      assert.equal(Object.keys(reloaded.projectPolicies).length, 1);
      assert.equal(reloaded.projectPolicies[otherKey], undefined);
      assert.deepEqual(storedProjectPolicy(reloaded, otherKey), { mode: "restricted", extraRoots: [] });
      assert.equal(Object.values(reloaded.projectPolicies)[0].extraRoots.length, 1);

      const anySaved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { mode: "any" }
      });
      assert.equal(anySaved.status, 200);
      assert.equal(anySaved.json.mode, "any");
      assert.deepEqual(anySaved.json.extraRoots, []);

      const afterAny = await new JsonStore(join(dataDir, "state-v3.json"), otherPrimary).init();
      const originalKey = await canonicalPrimaryPath(cwd);
      assert.equal(afterAny.projectPolicies[originalKey].mode, "restricted");
      assert.equal(afterAny.projectPolicies[originalKey].extraRoots.length, 1);
      assert.equal(afterAny.projectPolicies[otherKey].mode, "any");
      assert.deepEqual(afterAny.projectPolicies[otherKey].extraRoots, []);

      await invoke(daemon, "POST", "/api/workspace", { body: { cwd } });
      const restored = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(restored.json.mode, "restricted");
      assert.equal(restored.json.extraRoots.length, 1);
      assert.equal(restored.json.extraRoots[0].displayPath, extra);
    } finally {
      await rm(extra, { recursive: true, force: true });
      await rm(otherPrimary, { recursive: true, force: true });
    }
  });
});

test("workspace access policy allows sibling extra roots and rejects nested overlap", async () => {
  await withDaemon(async (daemon) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plan-policy-siblings-"));
    const repo = join(root, "repo");
    const repoTwo = join(root, "repo-two");
    const nested = join(repo, "src");
    try {
      await mkdir(nested, { recursive: true });
      await mkdir(repoTwo);
      const saved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: {
          extraRoots: [
            { path: repo, mode: "read-only" },
            { path: repoTwo, mode: "read/write" }
          ]
        }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.extraRoots.length, 2);
      assert.equal(saved.json.extraRoots[0].displayPath, repo);
      assert.equal(saved.json.extraRoots[1].displayPath, repoTwo);
      assert.equal(saved.json.extraRoots[1].mode, "read/write");

      const nestedReject = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: {
          extraRoots: [
            { path: repo, mode: "read-only" },
            { path: nested, mode: "read-only" }
          ]
        }
      });
      assert.equal(nestedReject.status, 400);
      assert.match(nestedReject.json.error, /overlap \(ancestor\/descendant\)/);
      assert.match(nestedReject.json.error, /repo/);
      assert.match(nestedReject.json.error, /src/);

      const previous = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(previous.status, 200);
      assert.equal(previous.json.extraRoots.length, 2);
      assert.equal(previous.json.extraRoots[0].displayPath, repo);
      assert.equal(previous.json.extraRoots[1].displayPath, repoTwo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("workspace access policy resolves relative extra roots against the primary directory", async () => {
  await withDaemon(async (daemon, { cwd }) => {
    const extra = await mkdtemp(join(tmpdir(), "agent-plan-policy-rel-"));
    try {
      const rel = relative(cwd, extra);
      const saved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: rel, mode: "read-only" }] }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.extraRoots.length, 1);
      assert.equal(saved.json.extraRoots[0].path, await realpath(extra));
      assert.equal(saved.json.extraRoots[0].displayPath, rel);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

test("malformed access policy POST returns 400 and preserves the previous saved policy", async () => {
  await withDaemon(async (daemon) => {
    const extra = await mkdtemp(join(tmpdir(), "agent-plan-policy-malformed-"));
    try {
      const saved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: extra, mode: "read-only" }] }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.extraRoots.length, 1);
      assert.equal(saved.json.extraRoots[0].displayPath, extra);

      const cases = [
        [null, /must be an object with optional mode and extraRoots, not null/],
        [[], /must be an object with optional mode and extraRoots, not array/],
        ["restricted", /must be an object with optional mode and extraRoots, not string/],
        [true, /must be an object with optional mode and extraRoots, not boolean/],
        [{ mode: null }, /Access mode must be restricted or any, not null/],
        [{ extraRoots: null }, /extraRoots must be an array of \{ path, mode \} entries, not null/],
        [{ extraRoots: [{ path: extra }] }, /Missing extra root mode for .* Use read-only or read\/write/]
      ];
      for (const [body, pattern] of cases) {
        const rejected = await invoke(daemon, "POST", "/api/workspace/access-policy", { body });
        assert.equal(rejected.status, 400);
        assert.match(rejected.json.error, pattern);
      }

      const previous = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(previous.status, 200);
      assert.equal(previous.json.mode, "restricted");
      assert.equal(previous.json.extraRoots.length, 1);
      assert.equal(previous.json.extraRoots[0].displayPath, extra);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

const gitExec = promisify(execFile);

async function waitForRun(daemon, ticketId, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await invoke(daemon, "GET", `/api/tickets/${ticketId}/run`);
    if (last.status === 200 && predicate(last.json)) return last.json;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ticket ${ticketId}: ${last?.json?.status || last?.status} ${last?.json?.lastError || last?.text || ""}`);
}

function toolNamed(tools, name) {
  return tools.find((tool) => tool.name === name);
}

function multiRepoHarness(filesForStep, { mapOriginal = false } = {}) {
  return {
    ...mockHarness(),
    async runRepositoryChecks() {
      return { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed", output: "", evidence: [] };
    },
    async evidenceImages() { return []; },
    async generateCommitMessage({ step }) {
      return `feat: ${step.title}\n\nWhy: multi-repo slice.\nRequirement: REQ-multi`;
    },
    async verifyStep({ step, proofMap }) {
      const criteria = (proofMap?.criteria || []).filter((criterion) => criterion.stepId === step.id);
      return {
        summary: "ok",
        findings: [],
        criterionResults: criteria.map((criterion) => ({
          criterionId: criterion.id,
          status: "verified",
          explanation: { summary: "Canonical check passed." },
          evidence: [{ type: "check", scope: "step", stepId: step.id }]
        })),
        rawOutput: "",
        sessionFile: null
      };
    },
    async runStep({ cwd, step, repositories, access }) {
      const extra = (repositories || []).find((repo) => repo.id && repo.id !== "primary");
      const files = filesForStep(step) || {};
      if (mapOriginal) {
        const write = toolNamed(scopedWorkerTools(cwd, step.writeScope, { ...access, repositories }), "write");
        if (files.primary) await write.execute("primary", { path: files.primary.name, content: files.primary.content });
        if (files.extra && extra?.sourceCwd) {
          await write.execute("extra", { path: join(extra.sourceCwd, files.extra.name), content: files.extra.content });
        }
      } else {
        if (files.primary) await writeFile(join(cwd, files.primary.name), files.primary.content);
        if (files.extra && extra?.cwd) await writeFile(join(extra.cwd, files.extra.name), files.extra.content);
      }
      return {
        report: { status: "completed", summary: `${step.id} done`, artifact: "ok" },
        output: "ok", prompt: "p", rawOutput: "ok", sessionFile: null, reviewNotes: []
      };
    }
  };
}

async function porcelain(cwd) {
  return (await gitExec("git", ["status", "--porcelain"], { cwd })).stdout;
}

test("accepted A+B worktree changes survive the next step and a restart of B", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ab-life-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-ab-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-ab-b-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    await writeFile(join(primary, "dirty-a.txt"), "seeded-a\n");
    await writeFile(join(extra, "dirty-b.txt"), "seeded-b\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    let twoRuns = 0;
    daemon = await createDaemon({
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git",
      harness: multiRepoHarness((step) => {
        if (step.id === "one") {
          return { primary: { name: "one-a.txt", content: "from-one-a" }, extra: { name: "one-b.txt", content: "from-one-b" } };
        }
        twoRuns += 1;
        return {
          primary: { name: "two-a.txt", content: "from-two-a" },
          extra: twoRuns === 1 ? { name: "two-b.txt", content: "from-two-b" } : null
        };
      })
    });
    const ticket = { id: "ab-life", identifier: "TEXT-ab", title: "A and B", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    const plan = normalizePlan({
      title: "A and B",
      nodes: [
        {
          id: "one", title: "One", permission: "write",
          writeScope: `one-a.txt,root:${extraId}:one-b.txt`,
          expectedFiles: ["one-a.txt"], estimatedChangedLines: 4,
          acceptanceCriteria: ["One lands in A and B"]
        },
        {
          id: "two", title: "Two", permission: "write", dependsOn: ["one"],
          writeScope: `two-a.txt,root:${extraId}:two-b.txt`,
          expectedFiles: ["two-a.txt"], estimatedChangedLines: 4,
          acceptanceCriteria: ["Two lands in A and B"]
        }
      ]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "one");
    const acceptedOne = await invoke(daemon, "POST", `/api/tickets/${id}/steps/one/accept`, { body: {} });
    assert.equal(acceptedOne.status, 202, acceptedOne.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "two");
    assert.equal(await readFile(join(workspace.cwd, "one-a.txt"), "utf8"), "from-one-a");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    const acceptedTwo = await invoke(daemon, "POST", `/api/tickets/${id}/steps/two/accept`, { body: {} });
    assert.equal(acceptedTwo.status, 202, acceptedTwo.text);
    await waitForRun(daemon, id, () => findNodeStatus(daemon, id, "two") === "accepted");
    assert.equal(await readFile(join(workspace.cwd, "two-a.txt"), "utf8"), "from-two-a");
    assert.equal(await readFile(join(extraRepo.cwd, "two-b.txt"), "utf8"), "from-two-b");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    await invoke(daemon, "POST", `/api/tickets/${id}/pause`, { body: {} });
    const restarted = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { target: "step:two", confirmed: true } });
    assert.equal(restarted.status, 202, restarted.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "two");
    assert.equal(await readFile(join(workspace.cwd, "one-a.txt"), "utf8"), "from-one-a");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    await assert.rejects(readFile(join(extraRepo.cwd, "two-b.txt"), "utf8"), /ENOENT/);
    assert.match(await porcelain(primary), /dirty-a\.txt/);
    assert.doesNotMatch(await porcelain(primary), /one-a|two-a/);
    assert.match(await porcelain(extra), /dirty-b\.txt/);
    assert.doesNotMatch(await porcelain(extra), /one-b|two-b/);

  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

const hasJj = await gitExec("jj", ["--version"]).then(() => true, () => false);

test("serial jj A+B accepted changes survive the next step and rewind without reopening B", { skip: !hasJj }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ab-jj-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-ab-jj-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-ab-jj-b-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    await writeFile(join(primary, "dirty-a.txt"), "seeded-a\n");
    await writeFile(join(extra, "dirty-b.txt"), "seeded-b\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    let twoRuns = 0;
    daemon = await createDaemon({
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "jj",
      harness: multiRepoHarness((step) => {
        if (step.id === "one") {
          return { primary: { name: "one-a.txt", content: "from-one-a" }, extra: { name: "one-b.txt", content: "from-one-b" } };
        }
        twoRuns += 1;
        return {
          primary: { name: "two-a.txt", content: "from-two-a" },
          extra: twoRuns === 1 ? { name: "two-b.txt", content: "from-two-b" } : null
        };
      }, { mapOriginal: true })
    });
    const ticket = { id: "ab-jj", identifier: "TEXT-jj", title: "A and B jj", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    await initializeJjWorkspace(workspace.cwd);
    for (const repo of workspace.repositories.filter((item) => item.cwd !== workspace.cwd)) await initializeJjWorkspace(repo.cwd);
    workspace.vcs = "jj";
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    const plan = normalizePlan({
      title: "A and B jj",
      nodes: [
        {
          id: "one", title: "One", permission: "write",
          writeScope: `one-a.txt,root:${extraId}:one-b.txt`,
          expectedFiles: ["one-a.txt"], estimatedChangedLines: 4,
          acceptanceCriteria: ["One lands in A and B"]
        },
        {
          id: "two", title: "Two", permission: "write", dependsOn: ["one"],
          writeScope: `two-a.txt,root:${extraId}:two-b.txt`,
          expectedFiles: ["two-a.txt"], estimatedChangedLines: 4,
          acceptanceCriteria: ["Two lands in A and B"]
        }
      ]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "one");
    const acceptedOne = await invoke(daemon, "POST", `/api/tickets/${id}/steps/one/accept`, { body: {} });
    assert.equal(acceptedOne.status, 202, acceptedOne.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "two");
    assert.equal(await readFile(join(workspace.cwd, "one-a.txt"), "utf8"), "from-one-a");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    await assert.rejects(readFile(join(extra, "one-b.txt"), "utf8"), /ENOENT/);
    const acceptedTwo = await invoke(daemon, "POST", `/api/tickets/${id}/steps/two/accept`, { body: {} });
    assert.equal(acceptedTwo.status, 202, acceptedTwo.text);
    await waitForRun(daemon, id, () => findNodeStatus(daemon, id, "two") === "accepted");
    assert.equal(await readFile(join(extraRepo.cwd, "two-b.txt"), "utf8"), "from-two-b");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    await invoke(daemon, "POST", `/api/tickets/${id}/pause`, { body: {} });
    const restarted = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { target: "step:two", confirmed: true } });
    assert.equal(restarted.status, 202, restarted.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "two");
    assert.equal(await readFile(join(extraRepo.cwd, "one-b.txt"), "utf8"), "from-one-b");
    await assert.rejects(readFile(join(extraRepo.cwd, "two-b.txt"), "utf8"), /ENOENT/);
    assert.match(await porcelain(primary), /dirty-a\.txt/);
    assert.doesNotMatch(await porcelain(primary), /one-a|two-a/);
    assert.match(await porcelain(extra), /dirty-b\.txt/);
    assert.doesNotMatch(await porcelain(extra), /one-b|two-b/);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

function findNodeStatus(daemon, ticketId, stepId) {
  const run = daemon.store.read().ticketRuns[ticketId];
  const nodes = run.plan.nodes.flatMap((node) => node.type === "group" ? node.children : [node]);
  return nodes.find((node) => node.id === stepId)?.status;
}

test("parallel accepted changes integrate into both run worktrees", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ab-par-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-ab-par-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-ab-par-b-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    await writeFile(join(primary, "dirty-a.txt"), "seeded-a\n");
    await writeFile(join(extra, "dirty-b.txt"), "seeded-b\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    daemon = await createDaemon({
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git",
      harness: multiRepoHarness((step) => step.id === "left"
        ? { primary: { name: "left-a.txt", content: "left-a" }, extra: { name: "left-b.txt", content: "left-b" } }
        : { primary: { name: "right-a.txt", content: "right-a" }, extra: { name: "right-b.txt", content: "right-b" } })
    });
    const ticket = { id: "ab-par", identifier: "TEXT-par", title: "Parallel A B", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    const plan = normalizePlan({
      title: "Parallel A B",
      nodes: [{
        id: "pair", type: "group", title: "Pair",
        children: [
          {
            id: "left", title: "Left", permission: "write",
            writeScope: `left-a.txt,root:${extraId}:left-b.txt`,
            expectedFiles: ["left-a.txt"], estimatedChangedLines: 4,
            acceptanceCriteria: ["Left lands in A and B"]
          },
          {
            id: "right", title: "Right", permission: "write",
            writeScope: `right-a.txt,root:${extraId}:right-b.txt`,
            expectedFiles: ["right-a.txt"], estimatedChangedLines: 4,
            acceptanceCriteria: ["Right lands in A and B"]
          }
        ]
      }]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review");
    const left = await invoke(daemon, "POST", `/api/tickets/${id}/steps/left/accept`, { body: {} });
    const right = await invoke(daemon, "POST", `/api/tickets/${id}/steps/right/accept`, { body: {} });
    assert.equal(left.status, 202, left.text);
    assert.equal(right.status, 202, right.text);
    await waitForRun(daemon, id, () => findNodeStatus(daemon, id, "left") === "accepted" && findNodeStatus(daemon, id, "right") === "accepted");
    assert.equal(await readFile(join(workspace.cwd, "left-a.txt"), "utf8"), "left-a");
    assert.equal(await readFile(join(workspace.cwd, "right-a.txt"), "utf8"), "right-a");
    assert.equal(await readFile(join(extraRepo.cwd, "left-b.txt"), "utf8"), "left-b");
    assert.equal(await readFile(join(extraRepo.cwd, "right-b.txt"), "utf8"), "right-b");
    assert.doesNotMatch(await porcelain(primary), /left-a|right-a/);
    assert.doesNotMatch(await porcelain(extra), /left-b|right-b/);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

test("retrying accept after a persisted primary commit still finishes extra without duplicating A", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ab-retry-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-ab-retry-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-ab-retry-b-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    daemon = await createDaemon({ cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git", harness: mockHarness() });
    const ticket = { id: "ab-retry", identifier: "TEXT-retry", title: "Retry", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    await writeFile(join(workspace.cwd, "done-a.txt"), "primary-done\n");
    const primaryCommit = await commitWorkspace(workspace.cwd, "feat: already accepted A");
    await writeFile(join(extraRepo.cwd, "done-b.txt"), "extra-pending\n");
    const plan = normalizePlan({
      title: "Retry",
      nodes: [{
        id: "one", title: "One", permission: "write",
        writeScope: `done-a.txt,root:${extraId}:done-b.txt`,
        expectedFiles: ["done-a.txt"], estimatedChangedLines: 4,
        acceptanceCriteria: ["Both land"]
      }]
    });
    plan.nodes[0].status = "review_ready";
    plan.nodes[0].diff = { available: true, files: ["done-a.txt", `root:${extraId}:done-b.txt`] };
    plan.nodes[0].commitMessage = "feat: finish extra\n\nWhy: durable accept.\nRequirement: REQ-multi";
    plan.nodes[0].acceptedRepositories = { primary: { commit: primaryCommit } };
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_step_review",
      checkpoint: { id: "rev", kind: "step_review", stepId: "one", title: "Review" }
    });
    const accepted = await invoke(daemon, "POST", `/api/tickets/${id}/steps/one/accept`, { body: {} });
    assert.equal(accepted.status, 202, accepted.text);
    const head = (await gitExec("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    assert.equal(head, primaryCommit);
    assert.equal(await readFile(join(extraRepo.cwd, "done-b.txt"), "utf8"), "extra-pending\n");
    assert.equal((await gitExec("git", ["status", "--porcelain"], { cwd: extraRepo.cwd })).stdout, "");
    await assert.rejects(readFile(join(extra, "done-b.txt"), "utf8"), /ENOENT/);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

test("combined repository checks fail when B fails even if A passed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-ab-check-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-ab-check-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-ab-check-b-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await createZeroStateWorkspace({ cwd: extra, ticket: { identifier: "LOCAL-b" }, runId: "base" });
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    const ticket = { id: "ab-check", identifier: "TEXT-check", title: "Checks", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    assert.ok(extraRepo?.cwd);
    const primaryCwd = await realpath(workspace.cwd);
    const harness = multiRepoHarness(() => ({
      primary: { name: "one-a.txt", content: "from-a" },
      extra: { name: "one-b.txt", content: "from-b" }
    }));
    harness.runRepositoryChecks = async ({ cwd }) => {
      if (await realpath(cwd) === primaryCwd) {
        return { status: "passed", command: "verify-a", summary: "A passed", output: "ok-a", evidence: [] };
      }
      return { status: "failed", command: "verify-b", summary: "B failed", output: "no-b", evidence: [] };
    };
    daemon = await createDaemon({ cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git", harness });
    const plan = normalizePlan({
      title: "Checks",
      nodes: [{
        id: "one", title: "One", permission: "write",
        writeScope: `one-a.txt,root:${extraId}:one-b.txt`,
        expectedFiles: ["one-a.txt"], estimatedChangedLines: 4,
        acceptanceCriteria: ["A and B change"]
      }]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => ["needs_attention", "paused"].includes(run.status) || run.checkpoint?.kind === "needs_attention", 20_000);
    const inspection = await invoke(daemon, "GET", `/api/tickets/${id}/inspection`);
    assert.equal(inspection.status, 200, inspection.text);
    assert.equal(inspection.json.workers[0].blocker.type, "repository-check");
    assert.match(inspection.json.workers[0].blocker.summary, /repo-b/);
    const failedAttempt = [...inspection.json.attempts].reverse().find((attempt) => attempt.resources?.checks?.failedRepositories?.length);
    assert.equal(failedAttempt.resources.checks.failedRepositories[0].repositoryId, extraId);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

test("non-Git extra roots and Any-access writes stay in proof instead of being dropped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-nongit-proof-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-nongit-a-"));
  const nongit = await mkdtemp(join(tmpdir(), "agent-plan-nongit-notes-"));
  const external = await mkdtemp(join(tmpdir(), "agent-plan-nongit-ext-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd: primary, ticket: { identifier: "LOCAL-a" }, runId: "base" });
    await writeFile(join(nongit, "notes.txt"), "before\n");
    await writeFile(join(external, "outside.txt"), "before\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        mode: "any",
        extraRoots: [{ path: nongit, mode: "read/write", displayPath: "notes-root" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    const ticket = { id: "nongit-proof", identifier: "TEXT-nongit", title: "Notes", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    daemon = await createDaemon({
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git",
      harness: {
        ...multiRepoHarness(() => ({ primary: { name: "one-a.txt", content: "from-a" } })),
        async runStep({ cwd }) {
          await writeFile(join(cwd, "one-a.txt"), "from-a");
          await writeFile(join(nongit, "notes.txt"), "after-nongit\n");
          await writeFile(join(external, "outside.txt"), "after-external\n");
          return {
            report: { status: "completed", summary: "one done", artifact: "ok" },
            output: "ok", prompt: "p", rawOutput: "ok", sessionFile: null, reviewNotes: []
          };
        }
      }
    });
    const plan = normalizePlan({
      title: "Notes",
      nodes: [{
        id: "one", title: "One", permission: "write",
        writeScope: `one-a.txt,root:${extraId}:notes.txt,${external}`,
        expectedFiles: ["one-a.txt"], estimatedChangedLines: 4,
        acceptanceCriteria: ["Notes and external writes are retained"]
      }]
    });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan,
      status: "awaiting_approval",
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve" }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    await waitForRun(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.checkpoint.stepId === "one");
    const diff = await invoke(daemon, "GET", `/api/tickets/${id}/proof/diff?scope=step&stepId=one`);
    assert.equal(diff.status, 200, diff.text);
    const files = diff.json.files || [];
    const patch = String(diff.json.patch || (diff.json.repositories || []).map((item) => item.patch).filter(Boolean).join("\n"));
    assert.equal(files.some((file) => String(file).includes("notes.txt")), true, JSON.stringify(diff.json));
    assert.equal(files.some((file) => String(file).includes("outside.txt")), true, JSON.stringify(diff.json));
    assert.match(patch, /after-nongit/);
    assert.match(patch, /after-external/);
    const kinds = (diff.json.repositories || []).map((item) => item.evidenceKind || item.kind);
    assert.equal(kinds.includes("nongit"), true);
    assert.equal(kinds.includes("external"), true);
    const inspection = await invoke(daemon, "GET", `/api/tickets/${id}/inspection`);
    assert.equal(inspection.json.repositories.some((item) => item.displayPath === "notes-root"), true);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(nongit, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

const deliveryGitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Delivery Test",
  GIT_AUTHOR_EMAIL: "delivery@example.test",
  GIT_COMMITTER_NAME: "Delivery Test",
  GIT_COMMITTER_EMAIL: "delivery@example.test"
};

async function initSourcedRepo(cwd) {
  await gitExec("git", ["init", "-q", "-b", "main"], { cwd });
  await writeFile(join(cwd, "README.md"), "base\n");
  await gitExec("git", ["add", "-A"], { cwd });
  await gitExec("git", ["commit", "-qm", "baseline"], { cwd, env: deliveryGitIdentity });
  const bare = await mkdtemp(join(tmpdir(), "agent-plan-origin-"));
  await gitExec("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare });
  await gitExec("git", ["remote", "add", "origin", bare], { cwd });
  await gitExec("git", ["push", "-q", "-u", "origin", "main"], { cwd });
  await gitExec("git", ["remote", "set-head", "origin", "main"], { cwd });
  return bare;
}

function fakeForge(label, { failCreate = () => false } = {}) {
  const creates = [];
  const merges = [];
  return {
    creates,
    merges,
    async create(input) {
      if (failCreate()) throw new Error(`${label} hosting failed`);
      creates.push(input);
      return { provider: "github", id: creates.length, url: `https://github.com/acme/${label}/pull/${creates.length}`, headSha: `head-${label}-${creates.length}` };
    },
    async status(change) {
      return { headSha: change.headSha || `head-${label}`, feedback: [], checks: "passed", mergeable: true, ready: true, mergeState: "clean", merged: false };
    },
    async merge(change) {
      merges.push(change);
      return { commit: `merged-${label}-${change.id}` };
    },
    comment: async () => ({})
  };
}

function verifiedDeliveryProof(plan, run) {
  const map = initializeProofMap(plan, { approvedAt: "2026-09-10T10:00:00.000Z" });
  return applyProofReports(map, map.criteria.map((criterion) => ({
    criterionId: criterion.id, status: "verified", evidence: [{ type: "check", scope: "final" }]
  })), run);
}

test("mocked hosting delivers A once, records B failure, and retries only B after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-deliver-ab-"));
  const primary = await mkdtemp(join(tmpdir(), "agent-plan-deliver-a-"));
  const extra = await mkdtemp(join(tmpdir(), "agent-plan-deliver-b-"));
  const bares = [];
  let daemon;
  let failB = true;
  try {
    bares.push(await initSourcedRepo(primary), await initSourcedRepo(extra));
    await writeFile(join(primary, "user-dirty.txt"), "keep-me\n");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write", displayPath: "repo-b" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    const forgeA = fakeForge("repo-a");
    const forgeB = fakeForge("repo-b", { failCreate: () => failB });
    const harness = {
      ...mockHarness(),
      runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: [] })
    };
    const trackers = {
      async comment() { return { id: "c1" }; },
      async transition() { return { type: "completed" }; }
    };
    const daemonOptions = {
      cwd: primary, dataDir, listen: false, lock: false, vcsMode: "git", harness, trackers, deliveryPollMs: 5,
      deliveryForRemote(_remote, { repository } = {}) {
        return (repository?.id || "primary") === "primary" ? forgeA : forgeB;
      }
    };
    daemon = await createDaemon(daemonOptions);
    const ticket = {
      id: "deliver-ab", identifier: "MEA-ab", title: "Ship both", description: "Two repos",
      source: "linear", provider: "linear", state: { name: "In Progress", type: "started" }
    };
    const workspace = await ensureTicketWorktree({ sourceCwd: primary, dataDir, ticket, runId: "run-1", access });
    const extraRepo = workspace.repositories.find((repo) => repo.id === extraId);
    await writeFile(join(workspace.cwd, "done-a.txt"), "from-a\n");
    await commitWorkspace(workspace.cwd, "feat: a");
    await writeFile(join(extraRepo.cwd, "done-b.txt"), "from-b\n");
    await commitWorkspace(extraRepo.cwd, "feat: b");
    const plan = normalizePlan({
      title: "Both",
      nodes: [{ id: "one", title: "One", permission: "write", writeScope: `done-a.txt,root:${extraId}:done-b.txt`, acceptanceCriteria: ["Both land"] }]
    });
    plan.nodes[0].status = "accepted";
    const artifacts = [{ id: "context", name: "product-context-update.md", kind: "product-context-update", content: "# Product context\n" }];
    const finalChecks = { status: "passed", summary: "passed" };
    const proofMap = verifiedDeliveryProof(plan, { plan, artifacts, finalChecks });
    const id = await seedRun(daemon, {
      ticket, access, workspace, repositories: workspace.repositories,
      baselineTree: await snapshotTree(workspace.cwd), plan, artifacts, proofMap, finalChecks,
      reviews: [{ round: 1, diff: { available: true, files: ["done-a.txt", `root:${extraId}:done-b.txt`], stat: "2 files" }, reviews: [], actionableFindings: [] }],
      status: "awaiting_evidence_review",
      checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks }
    });
    assert.equal(forgeA.creates.length, 0);
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(approved.status, 200, approved.text);
    await waitForRun(daemon, id, (run) => run.status === "needs_attention" || run.status === "completed", 20_000);
    let stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.status, "needs_attention", stored.lastError);
    assert.notEqual(stored.status, "completed");
    assert.equal(forgeA.creates.length, 1);
    assert.equal(forgeA.merges.length, 1);
    assert.equal(forgeB.creates.length, 0);
    const deliveredA = (stored.deliveries || []).find((item) => item.repositoryId === "primary");
    const failedB = (stored.deliveries || []).find((item) => item.repositoryId === extraId);
    assert.equal(deliveredA?.status, "integrated");
    assert.equal(deliveredA?.remoteChangeId, 1);
    assert.equal(failedB?.status, "failed");
    assert.match(stored.lastError || "", /repo-b|hosting failed/);
    assert.equal(await readFile(join(primary, "user-dirty.txt"), "utf8"), "keep-me\n");

    await daemon.close({ exit: false });
    await daemon.store.queue;
    failB = false;
    daemon = await createDaemon(daemonOptions);
    const resumed = await invoke(daemon, "POST", `/api/tickets/${id}/resume`);
    assert.equal(resumed.status, 202, resumed.text);
    await waitForRun(daemon, id, (run) => run.status === "completed" || (run.status === "needs_attention" && run.lastError !== stored.lastError), 20_000);
    stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.status, "completed", stored.lastError);
    assert.equal(forgeA.creates.length, 1);
    assert.equal(forgeA.merges.length, 1);
    assert.equal(forgeB.creates.length, 1);
    assert.equal(forgeB.merges.length, 1);
    assert.equal((stored.deliveries || []).find((item) => item.repositoryId === extraId)?.status, "integrated");
    assert.equal(await readFile(join(primary, "user-dirty.txt"), "utf8"), "keep-me\n");
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
    for (const bare of bares) await rm(bare, { recursive: true, force: true });
  }
});

test("a primary-only project still completes through the existing single-repo delivery path", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-deliver-one-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-deliver-one-cwd-"));
  let daemon;
  try {
    await createZeroStateWorkspace({ cwd, ticket: { identifier: "LOCAL-one" }, runId: "base" });
    daemon = await createDaemon({
      cwd, dataDir, listen: false, lock: false, vcsMode: "git",
      harness: { ...mockHarness(), runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: [] }) }
    });
    const ticket = { id: "deliver-one", identifier: "LOCAL-one", title: "One repo", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });
    await writeFile(join(workspace.cwd, "shipped.txt"), "ok\n");
    await commitWorkspace(workspace.cwd, "feat: ship");
    const plan = normalizePlan({ title: "One", nodes: [{ id: "one", title: "One", permission: "write", writeScope: "shipped.txt", acceptanceCriteria: ["Shipped"] }] });
    plan.nodes[0].status = "accepted";
    const finalChecks = { status: "passed", summary: "passed" };
    const proofMap = verifiedDeliveryProof(plan, { plan, artifacts: [], finalChecks });
    const id = await seedRun(daemon, {
      ticket, workspace, repositories: workspace.repositories || [{ id: "primary", kind: "primary", sourceCwd: cwd, cwd: workspace.cwd, branch: workspace.branch, mode: "read/write" }],
      baselineTree: workspace.baselineTree || await snapshotTree(workspace.cwd), plan, proofMap, finalChecks,
      reviews: [{ round: 1, diff: { available: true, files: ["shipped.txt"], stat: "1 file" }, reviews: [], actionableFindings: [] }],
      status: "awaiting_evidence_review",
      checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks }
    });
    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(approved.status, 200, approved.text);
    const completed = await waitForRun(daemon, id, (run) => run.status === "completed" || run.status === "needs_attention", 20_000);
    assert.equal(completed.status, "completed", completed.lastError);
    const stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.merge.status, "integrated");
    assert.equal(Boolean(stored.integration.commit), true);
    assert.equal(await readFile(join(cwd, "shipped.txt"), "utf8"), "ok\n");
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
