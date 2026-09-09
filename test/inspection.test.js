import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInspectionService, projectInspection } from "../src/inspection.js";
import { createArtifactReader } from "../src/artifacts.js";
import { initialStages, markRunCancelled } from "../src/execution.js";
import { aggregateProofDiffs, combineRepositoryChecks, diffFileSnapshots, extraProofRoots, snapshotProofPath } from "../src/git.js";

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

test("inspection service keeps run identity, details, and prompt reads bounded", async () => {
  const current = run({
    createdAt: at(2),
    stages: [{ id: "design", title: "Design", status: "completed", activity: { startedAt: at(1), completedAt: at(2) } }],
    sessionFile: "/private/design.jsonl",
    plan: { nodes: [step("build", "verified", { attempts: [{ attemptId: "attempt-1", status: "verified", report: { summary: "api_key=secret_abcdefgh" } }] })] },
    artifacts: [{ id: "output", stepId: "build", attemptId: "attempt-1", kind: "agent-output", content: "api_key=secret_abcdefgh" }]
  });
  const archived = run({ runId: "run-0", createdAt: at(0), status: "completed" });
  const reader = createArtifactReader({ dataDir: "/safe" });
  const service = createInspectionService({
    artifactContent: reader.artifactContent,
    sessionTrace: async (file, bounds) => ({ prompts: [{ prompt: `Prompt from ${file}`, at: at(1) }], bounds })
  });
  const state = { revision: 7, ticketRuns: { "ticket-1": current }, retainedRuns: { old: archived } };
  assert.deepEqual(service.inspectionHistories(state, "ticket-1").map((item) => [item.runId, item.archived]), [["run-1", false], ["run-0", true]]);
  assert.throws(() => service.artifactForIdentity(state, "ticket-1", "run-0", "missing"), /Artifact not found/);
  const detail = await service.attemptDetails(current, current.plan.nodes[0], current.plan.nodes[0].attempts[0]);
  assert.equal(detail.output.content.includes("secret_abcdefgh"), false);
  const prompts = await service.promptsForStage(current, current.stages[0]);
  assert.equal(prompts.prompts[0].prompt, "Prompt from [path]");
  assert.deepEqual(prompts.trace, { state: "available", retained: 1, available: 1 });
});

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

test("accepted implementation stays complete while final visual proof is being produced", () => {
  const projection = projectInspection(run({
    status: "fixing",
    stages: initialStages().map(stage => ({ ...stage, status: stage.id === "implement" ? "completed" : stage.id === "verify" ? "active" : "pending" })),
    plan: { nodes: [step("build", "accepted", { acceptedAt: at(3), requiresVisualEvidence: true, attempts: [completedAttempt()] })] },
    artifacts: attemptArtifacts()
  }));
  assert.equal(projection.workers[0].evidence.visualEvidence, "pending_final_verification");
  assert.equal(projection.workers[0].lifecycle, "completed");
  assert.equal(projection.stages.find(stage => stage.stageId === "implement").lifecycle, "completed");
  assert.notEqual(projection.lifecycle, "completed");
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

function twoRepoRun(extras = {}) {
  const extraId = "r-repob";
  const attempt = completedAttempt("attempt-1", {
    diff: {
      available: true,
      files: ["one-a.txt", `root:${extraId}:one-b.txt`],
      patch: "# repository primary (repo-a)\ndiff --git a/one-a.txt b/one-a.txt\n+from-a\n# repository r-repob (repo-b)\ndiff --git a/one-b.txt b/one-b.txt\n+from-b\n",
      repositories: [
        { repositoryId: "primary", displayPath: "repo-a", kind: "primary", evidenceKind: "git", available: true, files: ["one-a.txt"], patch: "+from-a" },
        { repositoryId: extraId, displayPath: "repo-b", kind: "extra", evidenceKind: "git", available: true, files: ["one-b.txt"], patch: "+from-b" }
      ]
    },
    verification: {
      checks: {
        status: "passed",
        command: "verify",
        repositories: [
          { repositoryId: "primary", displayPath: "repo-a", status: "passed" },
          { repositoryId: extraId, displayPath: "repo-b", status: "passed" }
        ],
        failedRepositories: []
      }
    }
  });
  return run({
    access: {
      mode: "restricted",
      primary: { id: "primary", displayPath: "repo-a", mode: "read/write" },
      extraRoots: [{ id: extraId, displayPath: "repo-b", mode: "read/write", path: "/tmp/repo-b" }]
    },
    repositories: [
      { id: "primary", kind: "primary", displayPath: "repo-a" },
      { id: extraId, kind: "extra", displayPath: "repo-b" }
    ],
    plan: { nodes: [step("build", "review_ready", { attempts: [attempt], writeScope: `one-a.txt,root:${extraId}:one-b.txt` })] },
    artifacts: attemptArtifacts(),
    ...extras
  });
}

test("inspection names both repositories when a ticket changed A and B", () => {
  const projection = projectInspection(twoRepoRun());
  assert.deepEqual(projection.repositories.map((item) => [item.repositoryId, item.displayPath]), [
    ["primary", "repo-a"],
    ["r-repob", "repo-b"]
  ]);
  assert.equal(JSON.stringify(projection).includes("/tmp/repo-b"), false);
  const resources = projection.attempts[0].resources;
  assert.deepEqual(resources.diff.repositories.map((item) => [item.repositoryId, item.displayPath, item.state]), [
    ["primary", "repo-a", "available"],
    ["r-repob", "repo-b", "available"]
  ]);
  assert.deepEqual(resources.checks.repositories.map((item) => [item.displayPath, item.status]), [
    ["repo-a", "passed"],
    ["repo-b", "passed"]
  ]);
});

test("inspection keeps primary-only packets as a single repository", () => {
  const projection = projectInspection(run({
    access: { mode: "restricted", primary: { id: "primary", displayPath: "repo-a", mode: "read/write" }, extraRoots: [] },
    repositories: [{ id: "primary", kind: "primary", displayPath: "repo-a" }],
    plan: { nodes: [step("build", "review_ready", { attempts: [completedAttempt()] })] },
    artifacts: attemptArtifacts()
  }));
  assert.deepEqual(projection.repositories.map((item) => item.repositoryId), ["primary"]);
  assert.equal(projection.attempts[0].resources.diff.repositories.length, 1);
  assert.equal(projection.attempts[0].resources.diff.repositories[0].repositoryId, "primary");
});

test("inspection lists labeled absence instead of implying missing repo evidence", () => {
  const extraId = "r-repob";
  const attempt = completedAttempt("attempt-1", {
    diff: {
      available: true,
      files: ["one-a.txt"],
      repositories: [{ repositoryId: "primary", displayPath: "repo-a", available: true, files: ["one-a.txt"], patch: "+a" }]
    }
  });
  const projection = projectInspection(run({
    repositories: [
      { id: "primary", kind: "primary", displayPath: "repo-a" },
      { id: extraId, kind: "extra", displayPath: "repo-b" }
    ],
    plan: { nodes: [step("build", "review_ready", {
      attempts: [attempt],
      repositoryDiffs: { [extraId]: { files: ["one-b.txt"] } }
    })] },
    artifacts: attemptArtifacts()
  }));
  assert.equal(projection.attempts[0].resources.diff.repositories.find((item) => item.repositoryId === extraId).state, "missing");
  assert.ok(projection.attempts[0].evidence.missing.includes(`diff:${extraId}`));
});

test("inspection attributes a check failure to the repository that failed", () => {
  const extraId = "r-repob";
  const attempt = completedAttempt("attempt-1", {
    status: "verification_failed",
    verification: {
      checks: {
        status: "failed",
        command: "verify",
        summary: "Repository checks failed in repo-b",
        repositories: [
          { repositoryId: "primary", displayPath: "repo-a", status: "passed" },
          { repositoryId: extraId, displayPath: "repo-b", status: "failed" }
        ],
        failedRepositories: [{ repositoryId: extraId, displayPath: "repo-b", status: "failed" }]
      }
    }
  });
  const projection = projectInspection(run({
    status: "needs_attention",
    repositories: [
      { id: "primary", kind: "primary", displayPath: "repo-a" },
      { id: extraId, kind: "extra", displayPath: "repo-b" }
    ],
    plan: { nodes: [step("build", "needs_attention", { attempts: [attempt] })] }
  }));
  assert.equal(projection.workers[0].blocker.type, "repository-check");
  assert.match(projection.workers[0].blocker.summary, /repo-b/);
  assert.equal(projection.attempts[0].resources.checks.failedRepositories[0].repositoryId, extraId);
});

test("configured identity paths stay visible while secrets still redact", () => {
  const projection = projectInspection(run({
    access: {
      mode: "restricted",
      primary: { id: "primary", displayPath: "/Users/owner/saved-a", mode: "read/write" },
      extraRoots: [{ id: "r-b", displayPath: "/Users/owner/saved-b", mode: "read/write", path: "/Users/owner/saved-b" }]
    },
    repositories: [
      { id: "primary", displayPath: "/Users/owner/saved-a" },
      { id: "r-b", displayPath: "/Users/owner/saved-b" }
    ],
    plan: { nodes: [step("build", "ready", { lastError: "token sk-secretvalue123 at /Users/person/private" })] }
  }));
  assert.equal(projection.repositories[0].displayPath, "/Users/owner/saved-a");
  assert.equal(projection.repositories[1].displayPath, "/Users/owner/saved-b");
  assert.equal(JSON.stringify(projection).includes("sk-secretvalue123"), false);
  assert.equal(JSON.stringify(projection).includes("/Users/person/private"), false);
});

test("non-Git read/write extra roots appear in proof diffs and are not dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-nongit-"));
  try {
    await writeFile(join(root, "notes.txt"), "before\n");
    const before = await snapshotProofPath(root);
    await writeFile(join(root, "notes.txt"), "after\n");
    const after = await snapshotProofPath(root);
    const labeled = aggregateProofDiffs([{
      ...diffFileSnapshots(before, after),
      repositoryId: "r-nongit",
      displayPath: "notes-root",
      evidenceKind: "nongit"
    }]);
    assert.deepEqual(labeled.files, ["root:r-nongit:notes.txt"]);
    assert.match(labeled.patch, /# repository r-nongit \(notes-root\)/);
    assert.match(labeled.patch, /\+after/);
    const roots = extraProofRoots({
      access: {
        mode: "restricted",
        primary: { id: "primary", path: "/tmp/a", displayPath: "repo-a" },
        extraRoots: [{ id: "r-nongit", path: root, displayPath: "notes-root", mode: "read/write" }]
      },
      repositories: [{ id: "primary" }]
    });
    assert.equal(roots[0].kind, "nongit");
    assert.equal(roots[0].displayPath, "notes-root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined checks fail when B fails even if A passed", () => {
  const combined = combineRepositoryChecks([
    { repositoryId: "primary", displayPath: "repo-a", status: "passed", command: "verify-a", summary: "A passed", output: "ok-a", evidence: [] },
    { repositoryId: "r-repob", displayPath: "repo-b", status: "failed", command: "verify-b", summary: "B failed", output: "no-b", evidence: [] }
  ]);
  assert.equal(combined.status, "failed");
  assert.match(combined.summary, /repo-b/);
  assert.deepEqual(combined.failedRepositories, [{ repositoryId: "r-repob", displayPath: "repo-b", status: "failed" }]);
  assert.equal(combined.repositories.length, 2);
});

test("directory proof records an output limit instead of dropping the change", () => {
  const before = { files: { "huge.bin": { hash: "a", size: 1, binary: true, content: null } } };
  const after = { files: { "huge.bin": { hash: "b", size: 1, binary: true, content: null } } };
  const diff = diffFileSnapshots(before, after);
  assert.equal(diff.available, true);
  assert.deepEqual(diff.files, ["huge.bin"]);
  const omitted = aggregateProofDiffs([{
    available: true,
    files: ["notes.txt"],
    patch: "",
    displayPath: "notes-root",
    repositoryId: "r-nongit",
    evidenceKind: "nongit"
  }]);
  assert.match(omitted.error, /output_limit/);
  assert.deepEqual(omitted.files, ["root:r-nongit:notes.txt"]);
});
