import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizePlan } from "../src/plan.js";
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

test("ticket inspection API returns the canonical compact projection and state only adds focus metadata", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build /Users/person/private with ghp_0123456789abcdefghijklmnop", status: "running", permission: "write", writeScope: "src/build.js",
      expectedArtifacts: ["build.md"], acceptanceCriteria: ["Works"]
    }] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      stages: [{ id: "implement", title: "Implement", status: "active", summary: "Implementing Build" }],
      activeRuns: { build: { runId: "worker-1", startedAt: "2026-09-03T10:00:00.000Z", lastEvent: "Editing implementation" } }
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
      rawOutput: "trace ghp_0123456789abcdefghijklmnop"
    })
  };
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", permission: "write", writeScope: "src" }] });
    plan.nodes[0].attempts = [{
      attemptId: "attempt-1", runId: "worker-1", status: "verified", startedAt: "2026-09-03T10:00:00.000Z", completedAt: "2026-09-03T10:01:00.000Z",
      rawOutput: "ghp_0123456789abcdefghijklmnop " + "x".repeat(21000),
      events: [{ type: "tool_end", result: "password=secret_abcdefgh" }],
      diff: { files: ["src/a.js"], stat: "1 file", patch: "diff --git a/src/a.js b/src/a.js\n" + "x".repeat(21000) },
      verification: { checks: { status: "passed", command: "node test", summary: "Passed", output: "token=secret_abcdefgh" } },
      sessionFile: "/tmp/private-session.jsonl"
    }];
    const id = await seedRun(daemon, {
      plan,
      artifacts: [
        { id: "prompt", name: "prompt.md", kind: "agent-prompt", stepId: "build", attemptId: "attempt-1", content: "Prompt api_key=secret_abcdefgh", path: "/tmp/prompt.md" },
        { id: "output", name: "output.md", kind: "agent-output", stepId: "build", attemptId: "attempt-1", content: "Output token=secret_abcdefgh", path: "/tmp/output.md" },
        { id: "diff", name: "diff.patch", kind: "git-attempt-diff", stepId: "build", attemptId: "attempt-1", content: "diff", path: "/tmp/diff.patch" }
      ]
    });
    const path = `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`;
    const detail = await invoke(daemon, "GET", path);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.output.state, "truncated");
    assert.equal(detail.json.diff.state, "truncated");
    assert.equal(detail.json.prompt.content.includes("secret_abcdefgh"), false);
    assert.equal(JSON.stringify(detail.json).includes("ghp_0123456789abcdefghijklmnop"), false);
    assert.equal(JSON.stringify(detail.json).includes("/tmp/private-session.jsonl"), false);
    assert.equal(detail.json.trace.content.events[0].type, "reasoning_summary");
    assert.equal((await invoke(daemon, "GET", `/api/tickets/${id}/runs/other/steps/build/attempts/attempt-1/details`)).status, 400);

    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes("rawOutput"), false);
    assert.equal(JSON.stringify(state.json).includes("secret_abcdefgh"), false);
    const artifact = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/prompt`);
    assert.equal(artifact.json.content, undefined);
    assert.equal(artifact.json.path, undefined);
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
