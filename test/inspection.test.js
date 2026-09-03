import test from "node:test";
import assert from "node:assert/strict";
import { projectInspection } from "../src/inspection.js";
import { initialStages, markRunCancelled } from "../src/execution.js";

const at = (minute) => `2026-09-03T10:${String(minute).padStart(2, "0")}:00.000Z`;

function step(id, status = "ready", extras = {}) {
  return {
    id, type: "step", title: `Worker ${id}`, description: `Deliver ${id}`, role: "implementation",
    permission: "write", writeScope: `src/${id}.js`, acceptanceCriteria: [`${id} works`], expectedArtifacts: [`${id}.md`],
    required: true, dependsOn: [], attempts: [], ...extras, status
  };
}

function run(extras = {}) {
  return {
    id: "ticket-1", runId: "run-1", status: "running", createdAt: at(0), stages: initialStages().map((stage) => ({ ...stage, status: "pending" })),
    stageProfiles: { implementation: { model: "test-model" } }, artifacts: [], activeRuns: {},
    plan: { nodes: [step("build")] }, checkpoint: null, lastError: null, ...extras
  };
}

function completedAttempt(id = "attempt-1", extras = {}) {
  return {
    attemptId: id, runId: `worker-${id}`, status: "verified", startedAt: at(1), completedAt: at(2),
    report: { status: "completed", summary: "done" }, verification: { findings: [], checks: { status: "passed", command: "test" } },
    diff: { available: true, files: ["src/build.js"] }, ...extras
  };
}

function attemptArtifacts(stepId = "build", attemptId = "attempt-1", visual = false) {
  return [
    { id: "out", stepId, attemptId, stageId: "implement", kind: "agent-output", name: `${stepId}.md` },
    { id: "prompt", stepId, attemptId, stageId: "implement", kind: "agent-prompt", name: "prompt.md" },
    ...(visual ? [{ id: "shot", stepId, attemptId, stageId: "verify", kind: "visual-evidence", name: "desktop.png" }] : [])
  ];
}

test("projects every workflow stage and parallel worker with stable selectable identities", () => {
  const stages = initialStages().map((stage, index) => ({ ...stage, status: index < 3 ? "completed" : index === 3 ? "active" : "pending", updatedAt: at(index) }));
  const first = step("api", "running", { agentId: "worker:api" });
  const second = step("ui", "running", { agentId: "worker:ui" });
  const projection = projectInspection(run({
    stages,
    plan: { nodes: [{ id: "parallel", type: "group", children: [first, second] }] },
    activeRuns: {
      api: { runId: "active-api", startedAt: at(6), lastEventAt: at(7), lastEvent: "Editing API", activity: { prompts: [{ content: "Continue the API worker" }] } },
      ui: { runId: "active-ui", startedAt: at(6), lastEventAt: at(8), lastEvent: "Editing UI" }
    }
  }), { now: Date.parse(at(9)), revision: 12 });

  assert.equal(projection.version, 1);
  assert.equal(projection.revision, 12);
  assert.deepEqual(projection.stages.map((stage) => stage.id), ["stage:requirements", "stage:explore", "stage:design", "stage:implement", "stage:verify", "stage:handoff"]);
  assert.deepEqual(projection.workers.map((worker) => worker.id), ["worker:api", "worker:ui"]);
  assert.deepEqual(projection.attempts.map((attempt) => attempt.id), ["attempt:api:active-active-api", "attempt:ui:active-active-ui"]);
  assert.deepEqual(projection.focus, { stageId: "stage:implement", workerId: "worker:api", attemptId: "attempt:api:active-active-api", reason: "active" });
  assert.equal(projection.attempts[0].timing.elapsedMs, 180000);
  assert.equal(projection.attempts[0].resources.output.state, "not_yet_available");
  assert.equal(projection.attempts[0].resources.prompt.state, "available");
});

test("focus falls back from actionable failure to the latest evidence-backed completion", () => {
  const failed = step("failed", "failed", { lastError: "provider model request timed out" });
  const done = step("done", "accepted", { acceptedAt: at(8), attempts: [completedAttempt("attempt-1", { completedAt: at(7) })] });
  let projection = projectInspection(run({ status: "needs_attention", plan: { nodes: [done, failed] }, artifacts: attemptArtifacts("done") }));
  assert.equal(projection.focus.workerId, "worker:failed");
  assert.equal(projection.focus.reason, "actionable");
  assert.equal(projection.workers[1].blocker.type, "provider");

  projection = projectInspection(run({
    status: "completed",
    stages: initialStages().map((stage) => ({ ...stage, status: "completed", updatedAt: at(9) })),
    plan: { nodes: [done] }, artifacts: attemptArtifacts("done")
  }));
  assert.deepEqual(projection.focus, { stageId: "stage:implement", workerId: "worker:done", attemptId: "attempt:done:attempt-1", reason: "latest_completion" });
  assert.equal(projection.workers[0].lifecycle, "completed");
  assert.equal(projection.workers[0].evidence.state, "complete");
});

test("does not claim accepted success when an attempt or its required evidence is absent", () => {
  const noAttempt = projectInspection(run({ status: "completed", plan: { nodes: [step("build", "accepted", { acceptedAt: at(3) })] } }));
  assert.equal(noAttempt.workers[0].lifecycle, "incomplete");
  assert.deepEqual(noAttempt.workers[0].evidence.missing, ["attempt"]);

  const incomplete = step("build", "accepted", {
    requiresVisualEvidence: true,
    attempts: [{ attemptId: "attempt-1", status: "verified", startedAt: at(1), completedAt: at(2) }]
  });
  const projection = projectInspection(run({ status: "completed", plan: { nodes: [incomplete] } }));
  assert.equal(projection.lifecycle, "incomplete");
  assert.equal(projection.workers[0].lifecycle, "incomplete");
  assert.deepEqual(projection.workers[0].evidence.missing, ["report", "checks", "approval", "artifact", "visual_evidence"]);
  assert.equal(projection.workers[0].blocker.type, "evidence");

  incomplete.acceptedAt = at(3);
  incomplete.attempts = [completedAttempt()];
  const complete = projectInspection(run({
    status: "completed", plan: { nodes: [incomplete] },
    artifacts: [...attemptArtifacts("build", "attempt-1", true), { kind: "handoff", stageId: "handoff" }],
    reviews: [{ reviews: [{ role: "deterministic", checks: { status: "passed" } }] }],
    integration: { integratedAt: at(4) }, finalEvidenceArtifactIds: ["shot"]
  }));
  assert.equal(complete.lifecycle, "completed");
  assert.equal(complete.evidence.state, "complete");
  assert.equal(complete.workers[0].lifecycle, "completed");
  assert.equal(complete.workers[0].evidence.state, "complete");
});

test("run-level final proof uses current evidence without blocking every worker or stage", () => {
  const accepted = step("build", "accepted", {
    acceptedAt: at(3), requiresVisualEvidence: true, attempts: [completedAttempt()]
  });
  const stages = initialStages().map((stage) => ({
    ...stage,
    status: ["requirements", "explore", "design", "implement", "verify"].includes(stage.id) ? "completed" : "blocked",
    updatedAt: at(4)
  }));
  const projection = projectInspection(run({
    status: "awaiting_evidence_review", stages, plan: { nodes: [accepted] },
    artifacts: [
      ...attemptArtifacts(),
      { id: "stale-proof", kind: "visual-evidence", stageId: "verify", name: "stale.png" },
      { id: "final-proof", kind: "visual-evidence", stageId: "verify", name: "final.png" }
    ],
    checkpoint: { id: "proof", kind: "evidence_review", title: "Review final proof", evidenceArtifactIds: ["final-proof"] }
  }));

  assert.equal(projection.workers[0].evidence.visualEvidence, "present");
  assert.equal(projection.workers[0].lifecycle, "completed");
  assert.equal(projection.workers[0].blocker, null);
  assert.equal(projection.workers[0].nextAction.kind, "none");
  assert.equal(projection.stages.filter((stage) => stage.lifecycle === "completed").length, 5);
  assert.equal(projection.stages.filter((stage) => stage.lifecycle === "completed").every((stage) => stage.blocker === null), true);
  assert.deepEqual(projection.focus, { stageId: "stage:verify", workerId: null, attemptId: null, reason: "final_proof" });
  assert.deepEqual(projection.nextAction, { kind: "review_evidence", label: "Approve final proof or request changes" });

  const staleOnly = projectInspection(run({
    status: "awaiting_evidence_review", stages, plan: { nodes: [accepted] },
    artifacts: [...attemptArtifacts(), { id: "stale-proof", kind: "visual-evidence", stageId: "verify", name: "stale.png" }],
    checkpoint: { id: "proof", kind: "evidence_review", title: "Review final proof", evidenceArtifactIds: ["final-proof"] }
  }));
  assert.equal(staleOnly.workers[0].evidence.visualEvidence, "missing");

  const completed = projectInspection(run({
    status: "completed", stages, plan: { nodes: [accepted] },
    artifacts: [...attemptArtifacts(), { id: "final-proof", kind: "visual-evidence", stageId: "verify", name: "final.png" }],
    finalEvidenceArtifactIds: ["final-proof"]
  }));
  assert.equal(completed.workers[0].evidence.visualEvidence, "present");

  const staleCompleted = projectInspection(run({
    status: "completed", stages, plan: { nodes: [accepted] },
    artifacts: [...attemptArtifacts("build", "attempt-1", true), { id: "stale-proof", kind: "visual-evidence", stageId: "verify", name: "stale.png" }],
    finalEvidenceArtifactIds: ["final-proof"]
  }));
  assert.equal(staleCompleted.workers[0].evidence.visualEvidence, "present");
  assert.deepEqual(staleCompleted.evidence.missing, ["final_checks", "integration", "handoff_artifact", "visual_evidence"]);
  assert.equal(staleCompleted.lifecycle, "incomplete");
});

test("cancellation materializes the live worker as an immutable inspectable attempt", () => {
  const current = run({
    status: "running",
    stages: initialStages().map((stage) => ({ ...stage, status: stage.id === "implement" ? "active" : "pending" })),
    plan: { nodes: [step("build", "running")] },
    activeRuns: { build: {
      runId: "active-build", startedAt: at(1), lastEventAt: at(2), lastEvent: "Editing implementation",
      sessionFile: "/private/session.jsonl", prompt: "Resume with api_key=0123456789abcdef", activity: { rawOutput: "partial output", prompts: [{ content: "Resume with api_key=0123456789abcdef" }] }
    } }
  });
  markRunCancelled(current, at(3));
  const projection = projectInspection(current, { now: Date.parse(at(4)) });
  assert.equal(current.activeRuns.build, undefined);
  assert.equal(current.plan.nodes[0].attempts[0].status, "cancelled");
  assert.equal(current.plan.nodes[0].attempts[0].prompt.includes("0123456789abcdef"), false);
  assert.equal(current.plan.nodes[0].attempts[0].prompts.length, 1);
  assert.deepEqual(projection.focus, {
    stageId: "stage:implement", workerId: "worker:build",
    attemptId: "attempt:build:attempt-1", reason: "actionable"
  });
  assert.equal(projection.attempts[0].runId, "active-build");
  assert.equal(projection.attempts[0].timing.elapsedMs, 120000);
  assert.equal(projection.attempts[0].latestAction, "Editing implementation");
  assert.equal(projection.attempts[0].latestActionAt, at(2));
  assert.equal(projection.attempts[0].resources.prompt.state, "available");
  assert.equal(projection.attempts[0].resources.activity.state, "available");
  assert.equal(projection.attempts[0].resources.output.state, "available");
  assert.equal(projection.attempts[0].resources.trace.state, "available");
  assert.equal(projection.attempts[0].terminationReason, "run_cancelled");
  assert.equal(projection.attempts[0].failureKind, "cancellation");
  assert.equal(projection.attempts[0].failurePhase, "execution");
  assert.equal(projection.attempts[0].blocker.type, "cancellation");
});

test("normalizes named failure provenance without exposing paths or provider secrets", () => {
  const cases = [
    ["repository-check", { attempt: completedAttempt("attempt-1", { status: "verification_failed", verification: { checks: { status: "failed" } } }) }],
    ["provider", { error: "Provider rate limit for token sk-secretvalue123" }],
    ["review", { checkpoint: { kind: "review_blocked", title: "Independent review found an issue", stepId: "build" } }],
    ["scope", { attempt: completedAttempt("attempt-1", { status: "needs_attention", violations: ["private.txt"] }) }],
    ["merge", { error: "Merge conflict in /Users/person/private/repo.js", merge: { status: "failed" } }],
    ["preview", { error: "Preview port bind failed" }],
    ["evidence", { checkpoint: { kind: "evidence_review", title: "Review final proof", stepId: "build" } }],
    ["cancellation", { status: "cancelled" }],
    ["interruption", { status: "interrupted" }]
  ];
  for (const [expected, fixture] of cases) {
    const worker = step("build", fixture.status || "needs_attention", {
      lastError: fixture.error,
      attempts: fixture.attempt ? [fixture.attempt] : []
    });
    const projection = projectInspection(run({
      status: fixture.status || "needs_attention", lastError: fixture.error || null,
      checkpoint: fixture.checkpoint || null, merge: fixture.merge, plan: { nodes: [worker] },
      artifacts: fixture.attempt ? attemptArtifacts() : []
    }));
    assert.equal(projection.workers[0].blocker.type, expected, expected);
    assert.equal(JSON.stringify(projection).includes("sk-secretvalue123"), false);
    assert.equal(JSON.stringify(projection).includes("/Users/person"), false);
  }

  const titled = projectInspection(run({
    stages: [{ id: "implement", title: "Inspect /Users/person/private with ghp_0123456789abcdefghijklmnop", status: "active" }],
    plan: { nodes: [step("build", "ready", { title: "Edit /Users/person/private using ghp_0123456789abcdefghijklmnop", description: "   " })] }
  }));
  assert.equal(titled.stages[0].title.includes("/Users/person"), false);
  assert.equal(titled.stages[0].title.includes("ghp_0123456789abcdefghijklmnop"), false);
  assert.equal(titled.workers[0].title.includes("ghp_0123456789abcdefghijklmnop"), false);
  assert.equal(titled.workers[0].purpose.includes("ghp_0123456789abcdefghijklmnop"), false);
});

test("run-level approval remains actionable across queued workers", () => {
  const foundation = step("foundation", "accepted", { permission: "read", acceptedAt: at(3), expectedArtifacts: [], attempts: [] });
  const build = step("build", "ready", { dependsOn: ["foundation"] });
  const projection = projectInspection(run({ status: "awaiting_approval", plan: { nodes: [foundation, build] }, checkpoint: { kind: "awaiting_approval", title: "Approve implementation plan" } }));
  assert.deepEqual(projection.workers[1].dependencies, [{ workerId: "worker:foundation", status: "accepted", satisfied: true }]);
  assert.equal(projection.workers[0].writeScope, "not applicable");
  assert.deepEqual(projection.nextAction, { kind: "approve", label: "Approve implementation plan" });
  assert.deepEqual(projection.workers.map((worker) => worker.nextAction.kind), ["approve", "approve"]);
  assert.equal(projection.workers[1].latestAction, "Not started");

  const started = projectInspection(run({ status: "running", plan: { nodes: [foundation, build] } }));
  assert.deepEqual(started.workers.map((worker) => worker.nextAction.kind), ["none", "start"]);
});
