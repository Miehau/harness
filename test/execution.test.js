import test from "node:test";
import assert from "node:assert/strict";
import { actionableFindings, archiveRun, auditVisualEvidencePolicy, clearInactiveRuns, compactRun, correctionPauseReason, correctionWindowRound, createActivityCapture, finalReviewFixFeedback, finalReviewFixStep, finalReviewRepositoryBoundary, findingsFingerprint, groupActivityEvents, interruptedStepFeedback, markRunCancelled, markRunPaused, nextCorrectionRound, nextRunnableBatch, nextRunnableStep, pendingReviewFix, planApprovalPending, prepareRunResume, providerWaitCheckpoint, publicPreviewState, publicState, recoverableCleanReview, recurringReviewClusters, refreshedReviewFindings, resumeStage, rewindRun, sessionImages, shouldPauseCorrection, unaddressedReviewClusters, verificationFocusFindings, visualEvidencePolicy } from "../src/execution.js";
import { normalizePlan } from "../src/plan.js";

test("only the first dependency-ready implementation slice is selected", () => {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "First slice", permission: "write" },
    { id: "two", title: "Second slice", permission: "write", dependsOn: ["one"] },
    { id: "three", title: "Third slice", permission: "write", dependsOn: ["two"] }
  ] });
  assert.equal(nextRunnableStep(plan).id, "one");
  plan.nodes[0].status = "review_ready";
  assert.equal(nextRunnableStep(plan), null);
  plan.nodes[0].status = "accepted";
  assert.equal(nextRunnableStep(plan).id, "two");
});

test("dependency-ready siblings in one group form a parallel batch", () => {
  const plan = normalizePlan({ nodes: [{
    id: "parallel", type: "group", title: "Parallel", children: [
      { id: "feature", title: "Feature", permission: "write" },
      { id: "ci", title: "CI", permission: "write" }
    ]
  }] });
  assert.deepEqual(nextRunnableBatch(plan).map((step) => step.id), ["feature", "ci"]);
  plan.nodes[0].children[0].status = "review_ready";
  assert.deepEqual(nextRunnableBatch(plan), []);
});

test("resuming a run makes attention-blocked workers runnable again", () => {
  const run = {
    status: "needs_attention",
    plan: normalizePlan({ nodes: [
      { id: "blocked", title: "Blocked", status: "needs_attention" },
      { id: "later", title: "Later", dependsOn: ["blocked"] }
    ] })
  };
  assert.equal(prepareRunResume(run), true);
  assert.equal(run.status, "interrupted");
  assert.equal(run.plan.nodes[0].status, "interrupted");
  assert.equal(nextRunnableStep(run.plan).id, "blocked");
});

test("final review keeps every unique actionable finding", () => {
  const duplicate = { severity: "blocking", claim: "Missing guard", evidence: [{ file: "src/a.ts", line: 9 }] };
  const findings = actionableFindings([
    { findings: [duplicate, { severity: "medium", claim: "Missing browser coverage", evidence: [{ file: "test/app.test.ts", line: 2 }] }] },
    { findings: [duplicate, { severity: "blocking", claim: "No regression test", evidence: [{ file: "test/a.test.ts", line: 1 }] }] }
  ]);
  assert.equal(findings.length, 3);
});

test("final review collapses a generic test failure and reviewer paraphrases into one concrete defect", () => {
  const criterion = "Full repository tests pass.";
  const findings = actionableFindings([
    { findings: [{ severity: "blocking", category: "tests", claim: "Repository check failed: node verify.mjs", suggestedFix: "not ok 4" }] },
    { findings: [{ severity: "high", category: "tests", claim: "An async test was cancelled.", acceptanceCriterion: criterion, evidence: [{ file: "test/run.test.js", line: 20 }] }] },
    { findings: [{ severity: "high", category: "tests", claim: "The worker test deadlocks while awaiting resume.", acceptanceCriterion: criterion, evidence: [{ file: "test/run.test.js", line: 24 }, { file: "src/server.js", line: 10 }], suggestedFix: "Start resume without awaiting it, release the worker, and then await resume." }] },
    { findings: [{ severity: "high", category: "requirements", claim: "Ambiguous input is accepted.", evidence: [{ file: "src/steering.js", line: 12 }] }] }
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0].claim, /deadlocks/);
  assert.match(findings[1].claim, /Ambiguous/);
});

test("final review collapses nearby paraphrases of the same defect across criteria", () => {
  const findings = actionableFindings([
    { findings: [{ severity: "high", category: "tests", claim: "The verification gate fails because completeRunCleanup stores the trigger object instead of flattening its fields, leaving lifecycle evidence malformed.", suggestedFix: "Preserve the complete trigger payload and timestamp, then deduplicate only exact records.", acceptanceCriterion: "Full tests pass.", evidence: [{ file: "src/execution.js", line: 147 }, { file: "src/execution.js", line: 155 }] }] },
    { findings: [{ severity: "high", category: "correctness", claim: "Cleanup trigger persistence drops payload fields because completeRunCleanup records only trigger and timestamp, producing mismatched lifecycle evidence.", suggestedFix: "Pass the complete trigger payload and timestamp through cleanup, then deduplicate only exact records.", acceptanceCriterion: "Repeated cleanup retains every trigger.", evidence: [{ file: "src/execution.js", line: 154 }, { file: "src/execution.js", line: 155 }] }] },
    { findings: [{ severity: "high", category: "correctness", claim: "Cleanup can terminate a newly launched process after ownership transfers.", acceptanceCriterion: "Process ownership transfers safely.", evidence: [{ file: "src/execution.js", line: 90 }] }] }
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0].claim, /lifecycle/);
  assert.match(findings[1].claim, /newly launched/);
});

test("final review collapses independently worded findings on the same code defect", () => {
  const findings = actionableFindings([
    { findings: [{ severity: "high", category: "correctness", claim: "Restarting an approved run does not reset or invalidate its proof map, so a rerun can inherit verified records for superseded code.", suggestedFix: "Discard prior proof on design restart and invalidate affected criteria on step restart.", evidence: [{ file: "src/execution.js", line: 300 }] }] },
    { findings: [{ severity: "high", category: "correctness", claim: "Run rewind does not reconcile the proof map with restored code or redesigned plans, retaining obsolete proof after restarts.", suggestedFix: "Make rewind proof-aware and archive prior approved proof before redesign.", evidence: [{ file: "src/execution.js", line: 302 }] }] },
    { findings: [{ severity: "high", category: "correctness", claim: "Media evidence remains valid when an unrelated cache entry changes.", suggestedFix: "Scope cache identity to the run.", evidence: [{ file: "src/execution.js", line: 302 }] }] }
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0].claim, /Restarting|rewind/);
  assert.match(findings[1].claim, /Media evidence/);
});

test("final review retains distinct failures on the same criterion and code surface", () => {
  const shared = { severity: "high", category: "correctness", acceptanceCriterion: "Historical evidence remains valid" };
  const findings = actionableFindings([{ findings: [
    { ...shared, claim: "Rewind reuses attempt IDs and aliases old evidence to a new attempt", evidence: [{ file: "src/proof-map.js", line: 84 }] },
    { ...shared, claim: "Stale locators can be resubmitted without evidence produced after invalidation", evidence: [{ file: "src/proof-map.js", line: 84 }] }
  ] }]);
  assert.equal(findings.length, 2);
});

test("resuming review refreshes canonical findings from durable raw reviewer output", () => {
  const distinct = [
    { severity: "high", category: "correctness", claim: "Attempt IDs alias old evidence", evidence: [{ file: "src/proof-map.js", line: 84 }] },
    { severity: "high", category: "correctness", claim: "Stale locators bypass freshness", evidence: [{ file: "src/proof-map.js", line: 84 }] }
  ];
  const review = { reviews: [{ role: "verification", findings: distinct }], actionableFindings: [distinct[0]] };
  assert.deepEqual(refreshedReviewFindings(review), distinct);
});

test("automatic corrections ignore findings below medium severity", () => {
  const findings = actionableFindings([{ findings: [
    { severity: "low", claim: "Could rename this helper" },
    { severity: "medium", claim: "Cancellation leaves the request running" },
    { severity: "high", claim: "Write access bypasses the guard" },
    { severity: "critical", claim: "Credentials are exposed" }
  ] }]);
  assert.deepEqual(findings.map((finding) => finding.severity), ["medium", "high", "critical"]);
});

test("cancelling a run stops every active step and preserves it for resume", () => {
  const run = {
    status: "verifying", checkpoint: { kind: "step_review" }, activeRuns: { one: {} },
    stages: [{ status: "active", summary: "Working" }],
    plan: normalizePlan({ nodes: [{ title: "One", status: "running" }, { title: "Two", status: "fixing" }, { title: "Later" }] })
  };
  markRunCancelled(run, "2026-08-24T20:00:00.000Z");
  assert.deepEqual(run.plan.nodes.map((step) => step.status), ["cancelled", "cancelled", "ready"]);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(run.activeRuns, {});
  assert.equal(run.stages[0].summary, "Run cancelled");
});

test("pausing a run preserves the live attempt and session as an audit checkpoint", () => {
  const plan = normalizePlan({ nodes: [{ id: "one", title: "One", status: "verifying", attempts: [] }] });
  const run = {
    status: "running", checkpoint: null, sessionFile: "/tmp/supervisor.jsonl",
    stages: [{ id: "implement", status: "active", summary: "Working" }], plan,
    activeRuns: { one: {
      runId: "worker-1", sessionFile: "/tmp/worker.jsonl", startedAt: "2026-09-02T10:00:00.000Z",
      activity: { lastEventAt: "2026-09-02T10:01:00.000Z", lastEvent: "Editing", rawOutput: "partial", events: [{ type: "phase", label: "Editing" }], groups: [{ title: "Change implementation" }] }
    } }
  };
  const audit = markRunPaused(run, "2026-09-02T10:02:00.000Z");
  assert.equal(run.status, "paused");
  assert.equal(run.stages[0].status, "paused");
  assert.equal(run.plan.nodes[0].status, "interrupted");
  assert.equal(run.plan.nodes[0].sessionFile, "/tmp/worker.jsonl");
  assert.equal(run.plan.nodes[0].attempts[0].sessionFile, "/tmp/worker.jsonl");
  assert.equal(run.plan.nodes[0].attempts[0].rawOutput, "partial");
  assert.deepEqual(run.activeRuns, {});
  assert.equal(audit.steps[0].lastEvent, "Editing");
  assert.equal(run.pauseHistory[0].id, "pause-1");
});

test("failed and paused workflows can resume from their persisted stage", () => {
  const failed = {
    status: "failed", plan: null, lastError: "planner stopped",
    artifacts: [{ kind: "requirements" }, { kind: "implementation-delta" }],
    stages: [
      { id: "requirements", status: "completed" },
      { id: "explore", status: "completed" },
      { id: "design", status: "blocked" }
    ]
  };
  assert.equal(resumeStage(failed), "design");
  assert.equal(prepareRunResume(failed), true);
  assert.equal(failed.status, "interrupted");
  assert.equal(failed.lastError, null);

  const paused = { status: "paused", plan: normalizePlan({ nodes: [{ id: "one", title: "One", status: "interrupted" }] }), pauseHistory: [{ id: "pause-1" }] };
  assert.equal(resumeStage(paused), "run");
  assert.equal(prepareRunResume(paused), true);
  assert.ok(paused.pauseHistory[0].resumedAt);
});

test("clearing the queue preserves active runs", () => {
  const state = { selectedTicketId: "old", ticketRuns: { old: { status: "cancelled" }, stale: { status: "awaiting_approval" }, active: { status: "running" }, merge: { status: "merging" } } };
  assert.equal(clearInactiveRuns(state, new Set(["stale", "active", "merge"])), 2);
  assert.deepEqual(Object.keys(state.ticketRuns), ["active", "merge"]);
  assert.deepEqual(Object.keys(state.retainedRuns), ["old:legacy", "stale:legacy"]);
  assert.equal(state.selectedTicketId, null);
});

test("a preserved plan checkpoint remains approvable after setup fails", () => {
  assert.equal(planApprovalPending({ status: "needs_attention", plan: { nodes: [] }, checkpoint: { kind: "awaiting_approval" } }), true);
  assert.equal(planApprovalPending({ status: "needs_attention", plan: { nodes: [] }, checkpoint: null }), false);
});

test("an interrupted pre-plan run resumes its active workflow stage", () => {
  assert.equal(resumeStage({ status: "interrupted", plan: null, stages: [{ id: "explore", status: "active" }] }), "explore");
  assert.equal(resumeStage({ status: "interrupted", plan: { nodes: [] }, stages: [] }), "run");
});

test("archives repeated ticket runs without overwriting their audit history", () => {
  const state = { ticketRuns: { ticket: { id: "ticket", runId: "run-2" } }, retainedRuns: { "ticket:run-1": { runId: "run-1" } } };
  archiveRun(state, "ticket");
  assert.deepEqual(Object.keys(state.retainedRuns), ["ticket:run-1", "ticket:run-2"]);
  assert.equal(state.ticketRuns.ticket, undefined);
});

test("rewinds a step and every later step to its recorded tree", () => {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "One", status: "accepted" },
    { id: "two", title: "Two", status: "review_ready" },
    { id: "three", title: "Three", status: "ready", dependsOn: ["two"] }
  ] });
  Object.assign(plan.nodes[0], { baseTree: "base", attempts: [{}] });
  Object.assign(plan.nodes[1], { baseTree: "after-one", attempts: [{}, {}] });
  const run = {
    status: "awaiting_step_review", checkpoint: { kind: "step_review" }, activeRuns: {}, baselineTree: "base", plan,
    stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((id) => ({ id, status: "completed", activity: {} }))
  };
  const audit = rewindRun(run, "step:two", "2026-08-27T12:00:00.000Z");
  assert.equal(audit.restoredTree, "after-one");
  assert.deepEqual(audit.resetStepIds, ["two", "three"]);
  assert.equal(audit.discardedAttempts, 2);
  assert.deepEqual(run.plan.nodes.map((step) => step.status), ["accepted", "ready", "ready"]);
  assert.equal(run.stages.find((stage) => stage.id === "implement").status, "pending");
  assert.equal(run.restartHistory[0].fromCheckpoint, "step_review");
});

test("restarts verification without discarding accepted implementation", () => {
  const run = {
    status: "needs_attention", checkpoint: null, activeRuns: {}, reviews: [{}],
    stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((id) => ({ id, status: "completed" })),
    plan: normalizePlan({ nodes: [{ id: "one", title: "One", status: "accepted" }] })
  };
  rewindRun(run, "stage:verify");
  assert.equal(run.plan.nodes[0].status, "accepted");
  assert.deepEqual(run.reviews, []);
  assert.equal(run.stages.find((stage) => stage.id === "verify").status, "pending");
});

test("activity capture bounds memory and coalesces pending persistence", async () => {
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => { releaseFirstWrite = resolve; });
  let writes = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const capture = createActivityCapture({
    outputLimit: 100,
    eventLimit: 5,
    now: () => 1,
    persist: async () => {
      writes++;
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      if (writes === 1) await firstWrite;
      activeWrites--;
    }
  });

  capture.onEvent({ type: "tool_start", label: "Started" });
  capture.onEvent({ type: "prompt", label: "Prompt rendered", content: "Keep this exact prompt" });
  for (let index = 0; index < 1000; index++) {
    capture.onEvent({ type: "tool_update", detail: "x".repeat(1000) });
    capture.onEvent({ type: "text_delta", delta: "output" });
  }

  assert.equal(writes, 1);
  assert.equal(capture.snapshot().events.length, 5);
  assert.equal(capture.snapshot().prompts[0].content, "Keep this exact prompt");
  assert.equal(capture.snapshot().rawOutput.length, 100);
  releaseFirstWrite();
  await capture.flush();
  assert.equal(writes, 2);
  assert.equal(maxActiveWrites, 1);
});

test("groups persisted activity into named repository, change, and verification steps", () => {
  const groups = groupActivityEvents([
    { type: "agent_start", at: "2026-09-02T09:59:59.000Z" },
    { type: "usage", input: 20, output: 4, at: "2026-09-02T10:00:00.000Z" },
    { type: "tool_start", tool: "read", callId: "read", at: "2026-09-02T10:00:00.000Z" },
    { type: "tool_end", tool: "read", callId: "read", at: "2026-09-02T10:00:01.000Z" },
    { type: "tool_start", tool: "edit", callId: "edit", at: "2026-09-02T10:00:02.000Z" },
    { type: "tool_end", tool: "edit", callId: "edit", at: "2026-09-02T10:00:03.000Z" },
    { type: "tool_start", tool: "bash", callId: "test", args: '{"command":"npm test"}', at: "2026-09-02T10:00:04.000Z" }
  ]);
  assert.deepEqual(groups.map((group) => [group.title, group.status, group.events.length]), [
    ["Explore repository", "complete", 2],
    ["Change implementation", "complete", 2],
    ["Run verification", "running", 1]
  ]);
});

test("plan approval ignores supervisor workflow gates", () => {
  assert.equal(planApprovalPending({ plan: { nodes: [] }, checkpoint: { kind: "awaiting_approval", source: "supervisor" } }), false);
});

test("correction pauses when findings repeat but allows distinct medium-or-higher issues to progress", () => {
  const findings = [{ severity: "high", claim: "Missing guard", evidence: [{ file: "src/a.ts", line: 9 }] }];
  const first = shouldPauseCorrection({ round: 1, findings, previousFingerprint: "" });
  assert.equal(first.pause, false);
  const repeat = shouldPauseCorrection({ round: 2, findings, previousFingerprint: first.fingerprint });
  assert.equal(repeat.pause, true);
  assert.match(repeat.reason, /repeated/);
  const progressing = shouldPauseCorrection({ round: 3, findings, previousFingerprint: "other" });
  assert.equal(progressing.pause, false);
  const stillProgressing = shouldPauseCorrection({ round: 6, findings, previousFingerprint: "other" });
  assert.equal(stillProgressing.pause, false);
  const capped = shouldPauseCorrection({ round: 12, findings, previousFingerprint: "other" });
  assert.equal(capped.pause, true);
  assert.match(capped.reason, /12 verification attempts/);
});

test("changed repository failure diagnostics count as correction progress", () => {
  const first = [{ severity: "blocking", category: "tests", claim: "Repository check failed: node verify.mjs", suggestedFix: "not ok 1 - request returned 400" }];
  const second = [{ severity: "blocking", category: "tests", claim: "Repository check failed: node verify.mjs", suggestedFix: "not ok 1 - expected 0 actual 1" }];
  const fingerprint = findingsFingerprint(first);
  assert.equal(shouldPauseCorrection({ round: 2, findings: first, previousFingerprint: fingerprint }).pause, true);
  assert.equal(shouldPauseCorrection({ round: 2, findings: second, previousFingerprint: fingerprint }).pause, false);
});

test("new human proof feedback starts a fresh bounded correction window", () => {
  const reviews = [
    { round: 11, actionableFindings: [{ severity: "high", category: "tests", claim: "Old failure" }] },
    { round: 12, actionableFindings: [{ severity: "blocking", category: "human-proof-review", claim: "Remove harness artifacts" }] }
  ];
  assert.equal(correctionWindowRound(12, reviews), 1);
  assert.equal(correctionWindowRound(13, reviews), 2);
  assert.equal(correctionWindowRound(12, reviews.slice(0, 1)), 12);
});

test("recurring review clusters survive changed wording and duplicate reviewers", () => {
  const finding = (claim) => ({ severity: "high", category: "requirements", claim, evidence: [{ file: "src/steering.js", line: 12 }] });
  assert.deepEqual(recurringReviewClusters([
    { actionableFindings: [finding("Postgres is accepted"), finding("OAuth is accepted")] },
    { actionableFindings: [finding("CSV export is accepted")] },
    { actionableFindings: [finding("SQLite is accepted")] }
  ]), ["requirements:src/steering.js:12"]);
  assert.deepEqual(recurringReviewClusters([
    { actionableFindings: [finding("First occurrence")] },
    { actionableFindings: [finding("Second occurrence")] }
  ]), []);
  assert.deepEqual(recurringReviewClusters([
    { actionableFindings: [{ severity: "blocking", category: "tests", claim: "Repository check failed" }] },
    { actionableFindings: [{ severity: "blocking", category: "tests", claim: "Repository check failed" }] },
    { actionableFindings: [{ severity: "blocking", category: "tests", claim: "Repository check failed" }] }
  ]), []);
  assert.deepEqual(recurringReviewClusters([
    { actionableFindings: [{ ...finding("First defect"), evidence: [{ file: "test/run.test.js", line: 10 }] }] },
    { actionableFindings: [{ ...finding("Second defect"), evidence: [{ file: "test/run.test.js", line: 40 }] }] },
    { actionableFindings: [{ ...finding("Third defect"), evidence: [{ file: "test/run.test.js", line: 80 }] }] }
  ]), []);
});

test("a recurring surface receives one root-cause escalation without blocking later distinct findings", () => {
  const finding = (claim) => ({ severity: "high", category: "requirements", claim, evidence: [{ file: "src/steering.js" }] });
  const reviews = [
    { actionableFindings: [finding("First bypass")] },
    { actionableFindings: [finding("Second bypass")] },
    { actionableFindings: [finding("Third bypass")], fix: { rootCauseClusters: ["requirements:src/steering.js"] } },
    { actionableFindings: [finding("New ambiguity on the same surface")] }
  ];
  assert.deepEqual(recurringReviewClusters(reviews), ["requirements:src/steering.js"]);
  assert.deepEqual(unaddressedReviewClusters(reviews), []);
});

test("correction pause output retains the latest actionable evidence", () => {
  const reason = correctionPauseReason("Paused after 3 verification attempts.", [{
    severity: "high",
    claim: "Sentence-final root paths evade scope checks",
    evidence: [{ file: "src/scope.js", line: 42 }],
    suggestedFix: "Cover punctuation delimiters with a table-driven regression."
  }]);
  assert.match(reason, /\[HIGH\] Sentence-final root paths evade scope checks/);
  assert.match(reason, /src\/scope\.js:42/);
  assert.match(reason, /table-driven regression/);
});

test("final-review fixes keep audit prose out of the product repository", () => {
  const findings = [{ severity: "high", claim: "Cleanup can miss a late child" }];
  const step = finalReviewFixStep(2, findings, ["correctness:src/process.js"]);
  assert.deepEqual(step.expectedArtifacts, []);
  assert.match(step.prompt, /Cleanup can miss a late child/);
  assert.match(step.prompt, /external audit records, not product artifacts/);
  assert.match(step.prompt, /Fix the general invariant/);
  assert.match(finalReviewRepositoryBoundary, /harness removes its legacy copies/);
  assert.match(finalReviewFixFeedback(findings), /supersedes any earlier duplicated or stale finding list/);
  assert.match(finalReviewFixFeedback(findings), /Cleanup can miss a late child/);
});

test("an interrupted final-review fix resumes from persisted findings", () => {
  const findings = [{ severity: "high", claim: "Cleanup can miss a late child", evidence: [{ file: "src/process.js", line: 42 }] }];
  assert.deepEqual(pendingReviewFix([{ round: 2, actionableFindings: findings }]), { round: 2, findings, sessionFile: null });
  assert.deepEqual(pendingReviewFix([{ round: 2, actionableFindings: findings, fix: { sessionFile: "/tmp/review-fix.jsonl" } }]), { round: 2, findings, sessionFile: "/tmp/review-fix.jsonl" });
  assert.deepEqual(pendingReviewFix([{ round: 2, actionableFindings: findings, fix: { report: { status: "needs_input" } } }]), { round: 2, findings, sessionFile: null });
  assert.equal(pendingReviewFix([{ round: 2, actionableFindings: findings, fix: { report: { status: "completed" } } }]), null);
  assert.equal(pendingReviewFix([{ round: 2, actionableFindings: [] }]), null);
});

test("a persisted clean review resumes at final proof without rerunning reviewers", () => {
  const clean = { round: 4, actionableFindings: [], diff: { summary: "clean" }, reviews: [
    { role: "deterministic", checks: { status: "passed", summary: "240 tests passed" } }
  ] };
  assert.deepEqual(recoverableCleanReview({ reviews: [clean] }), {
    round: 4, checks: clean.reviews[0].checks, diff: clean.diff
  });
  assert.equal(recoverableCleanReview({ reviews: [{ ...clean, actionableFindings: [{ severity: "medium" }] }] }), null);
  assert.equal(recoverableCleanReview({ reviews: [clean], pendingEvidenceFeedback: "Please revise" }), null);
  assert.equal(recoverableCleanReview({ reviews: [clean], checkpoint: { kind: "evidence_review" } }), null);
  assert.equal(recoverableCleanReview({ reviews: [{ ...clean, reviews: [] }] }), null);
});

test("resuming a model session does not re-embed its existing image context", () => {
  const images = [{ mimeType: "image/png", data: "large-base64-payload" }];
  assert.equal(sessionImages(null, images), images);
  assert.deepEqual(sessionImages("/tmp/persisted-session.jsonl", images), []);
});

test("a verifier transport failure does not resurrect superseded correction feedback", () => {
  const oldFinding = { severity: "blocking", claim: "Old repository failure", suggestedFix: "Very large stale log" };
  const step = { attempts: [
    { status: "verification_failed", verification: { findings: [oldFinding] } },
    { status: "failed", report: { status: "completed" }, checks: { status: "passed" }, verification: null, error: "Provider rejected image" }
  ] };
  const feedback = interruptedStepFeedback(step);
  assert.match(feedback, /independent verifier failed/);
  assert.match(feedback, /make no edits/);
  assert.doesNotMatch(feedback, /Old repository failure|stale log/);
});

test("an audited scope expansion starts a fresh bounded correction window", () => {
  const step = {
    attempts: [
      { completedAt: "2026-09-03T10:00:00.000Z", verification: { findings: [{ severity: "high", claim: "Old" }] } },
      { completedAt: "2026-09-03T10:05:00.000Z", error: "provider timeout" },
      { completedAt: "2026-09-03T10:10:00.000Z", report: { status: "needs_input" } },
      { completedAt: "2026-09-03T10:20:00.000Z", verification: { findings: [{ severity: "medium", claim: "New" }] } }
    ],
    scopeChanges: [{ at: "2026-09-03T10:15:00.000Z", paths: ["test/e2e.test.js"] }]
  };
  assert.equal(nextCorrectionRound(step), 2);
  assert.equal(nextCorrectionRound({ attempts: step.attempts }), 3);
});

test("the strict visual-evidence policy audit resets legacy correction windows once", () => {
  const run = {
    plan: normalizePlan({ nodes: [{ id: "visual", title: "Prove it", requiresVisualEvidence: true }, { id: "logic", title: "Check it" }] })
  };
  run.plan.nodes[0].attempts = [{ completedAt: "2026-09-03T10:00:00.000Z", verification: { findings: [{ severity: "high", claim: "Old preview mismatch" }] } }];
  assert.deepEqual(auditVisualEvidencePolicy(run, "2026-09-03T10:15:00.000Z"), ["visual"]);
  assert.equal(run.harnessEvidencePolicy, visualEvidencePolicy);
  assert.equal(nextCorrectionRound(run.plan.nodes[0]), 1);
  assert.deepEqual(auditVisualEvidencePolicy(run, "2026-09-03T10:20:00.000Z"), []);
  assert.equal(run.plan.nodes[0].correctionResets.length, 1);
});

test("a correction keeps its verification focus after the round window resets", () => {
  const findings = [{ severity: "high", claim: "The supplied screenshot is incomplete" }];
  assert.deepEqual(verificationFocusFindings("Retry the interrupted correction", findings), findings);
  assert.deepEqual(verificationFocusFindings("", findings), []);
});

test("provider usage exhaustion becomes a durable wait checkpoint", () => {
  assert.deepEqual(providerWaitCheckpoint(new Error("Codex error: The usage limit has been reached. Try again at Sep 7th, 2026 8:42 PM.")), {
    kind: "provider_wait", title: "Paused for provider capacity",
    prompt: "Codex error: The usage limit has been reached. Try again at Sep 7th, 2026 8:42 PM.",
    retryAt: "Sep 7th, 2026 8:42 PM"
  });
  assert.equal(providerWaitCheckpoint(new Error("Verification failed")), null);
});

test("compact run and public state omit artifact bodies", () => {
  const run = {
    id: "t1", runId: "r1", status: "awaiting_approval", lastError: null,
    ticket: { id: "t1", identifier: "MEA-1", title: "Compact title", source: "linear", state: { id: "s1", name: "In Progress", type: "started", color: "#fff" }, description: "large private description" },
    checkpoint: { kind: "awaiting_approval", title: "Approve" },
    workflow: { skillName: "shape-feature", checkpoints: [] },
    stages: [{ id: "design", diff: { files: ["a.js"], patch: "large stage patch" }, activity: { prompts: [{ content: "# private prompt" }], rawOutput: "private output", groups: [{ events: [] }], events: [{ type: "tool_end", output: "x".repeat(3000) }] } }],
    artifacts: [{ id: "a", name: "design.md", path: "/tmp/design.md", kind: "architecture", content: "# secret body" }],
    plan: { nodes: [{ id: "one", type: "step", artifacts: [{ id: "b", name: "out.md", content: "worker body" }], attempts: [
      { rawOutput: "old", activityGroups: [{ events: [] }], events: [{ type: "tool_end", output: "historical detail" }] },
      { rawOutput: "latest", activityGroups: [{ events: [] }], events: [{ type: "tool_end", output: "y".repeat(3000) }], verification: { rawOutput: "review transcript" }, diff: { files: ["a.js"], patch: "attempt patch" }, checkDiff: { patch: "check patch" }, aggregateDiff: { patch: "aggregate patch" } }
    ] }] },
    reviews: [{ diff: { files: ["a.js"], patch: "repeated review patch" }, fix: { diff: { files: ["a.js"], patch: "fix patch" } } }]
  };
  const compact = compactRun(run, 9);
  assert.equal(compact.revision, 9);
  assert.equal(compact.status, "awaiting_approval");
  assert.equal(compact.checkpoint.title, "Approve");
  assert.equal(compact.workflow.skillName, "shape-feature");
  assert.deepEqual(compact.ticket, { id: "t1", identifier: "MEA-1", title: "Compact title", source: "linear", provider: null, state: { id: "s1", name: "In Progress", type: "started" } });
  assert.equal(compact.ticket.description, undefined);
  assert.equal("artifacts" in compact, false);
  const published = publicState({ selectedTicketId: "t1", ticketRuns: { t1: run }, retainedRuns: {} });
  assert.equal(published.ticketRuns.t1.artifacts[0].name, "design.md");
  assert.equal(published.ticketRuns.t1.artifacts[0].content, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].artifacts[0].content, undefined);
  assert.equal(published.ticketRuns.t1.stages[0].activity.prompts, undefined);
  assert.equal(published.ticketRuns.t1.stages[0].activity.rawOutput, undefined);
  assert.equal(published.ticketRuns.t1.stages[0].activity.groups, undefined);
  assert.equal(published.ticketRuns.t1.stages[0].diff.patch, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[0].events[0].output, undefined);
  assert.match(published.ticketRuns.t1.plan.nodes[0].attempts[1].events[0].output, /truncated/);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].rawOutput, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].activityGroups, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].verification.rawOutput, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].diff.patch, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].checkDiff.patch, undefined);
  assert.equal(published.ticketRuns.t1.plan.nodes[0].attempts[1].aggregateDiff.patch, undefined);
  assert.equal(published.ticketRuns.t1.reviews[0].diff.patch, undefined);
});

test("public state fully projects only the selected run", () => {
  const selected = { id: "selected", runId: "r1", status: "running", artifacts: [{ id: "a" }], stages: [], plan: { nodes: [] } };
  const other = { id: "other", runId: "r2", status: "paused", artifacts: [{ id: "b" }], stages: [], plan: { nodes: [] } };
  const published = publicState({ revision: 7, selectedTicketId: "selected", ticketRuns: { selected, other }, retainedRuns: {} });
  assert.ok(Array.isArray(published.ticketRuns.selected.artifacts));
  assert.deepEqual(published.ticketRuns.other, compactRun(other, 7));
});

test("preview state contains only the selected public run", () => {
  const selected = { id: "selected", runId: "r1", status: "verifying", ticket: { id: "selected", title: "Selected" }, artifacts: [{ id: "a", content: "private" }], stages: [], plan: { nodes: [] } };
  const other = { id: "other", runId: "r2", status: "completed", ticket: { id: "other", title: "Other" }, artifacts: [{ content: "x".repeat(10000) }], stages: [], plan: { nodes: [] } };
  const preview = publicPreviewState({ version: 6, revision: 8, workspace: { cwd: "/repo" }, settings: {}, stageProfiles: {}, notice: null, ticketRuns: { selected, other }, retainedRuns: { old: other } }, "selected");
  assert.equal(preview.selectedTicketId, "selected");
  assert.deepEqual(Object.keys(preview.ticketRuns), ["selected"]);
  assert.deepEqual(preview.retainedRuns, {});
  assert.equal(preview.ticketRuns.selected.ticket.title, "Selected");
  assert.equal(preview.ticketRuns.selected.artifacts[0].content, undefined);
});

test("public state keeps retained audits compact", () => {
  const retained = { id: "old", runId: "run-old", status: "completed", artifacts: [{ content: "x".repeat(10000) }] };
  const published = publicState({ revision: 4, ticketRuns: {}, retainedRuns: { "old:run-old": retained } });
  assert.deepEqual(published.retainedRuns["old:run-old"], compactRun(retained, 4));
});
