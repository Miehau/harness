import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePlan } from "../src/plan.js";
import { persistArtifact } from "../src/artifacts.js";
import { runRoot } from "../src/retention.js";
import { JsonStore } from "../src/store.js";
import { runAgainstDaemon, invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

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
      { attemptId: "first", runId: "a-1", status: "failed", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:01:00.000Z", terminationReason: "worker_failure", rawOutput: "old result" },
      { attemptId: "second", runId: "a-2", status: "verified", startedAt: "2026-09-03T10:02:00.000Z", completedAt: "2026-09-03T10:03:00.000Z", rawOutput: "new result" }
    ];
    plan.nodes[1].attempts = [{ attemptId: "only", runId: "b-1", status: "verified", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:03:00.000Z", rawOutput: "sibling result" }];
    const id = await seedRun(daemon, { plan, stages: [{ id: "implement", title: "Implement", status: "completed" }] });
    const inspection = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/inspection`);
    assert.deepEqual(inspection.json.attempts.map((attempt) => attempt.id), ["attempt:parallel-a:first", "attempt:parallel-a:second", "attempt:parallel-b:only"]);
    assert.deepEqual(inspection.json.workers.find((worker) => worker.stepId === "parallel-a").attemptIds, ["attempt:parallel-a:first", "attempt:parallel-a:second"]);
    assert.deepEqual(inspection.json.attempts.map((attempt) => attempt.workerId), ["worker:parallel-a", "worker:parallel-a", "worker:parallel-b"]);
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

test("ticket selection returns a compact acknowledgment", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon);
    const selected = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/select`, { body: {} });
    assert.deepEqual(Object.keys(selected.json).sort(), ["revision", "selectedTicketId"]);
    assert.equal(selected.json.selectedTicketId, id);
    assert.equal(selected.json.revision > 0, true);
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
      }
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

    const resumed = await invoke(daemon, "POST", `/api/tickets/${ticket.id}/resume`, { body: {} });
    assert.equal(resumed.status, 202);
    const after = daemon.store.read().ticketRuns[ticket.id];
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
    const state = await invoke(daemon, "GET", "/api/state");
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
