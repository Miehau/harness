import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { snapshotTree } from "../src/git.js";
import { normalizePlan } from "../src/plan.js";
import { applyProofReports, initializeProofMap } from "../src/proof-map.js";
import { ensureTicketWorktree } from "../src/worktrees.js";
import { invoke, mockHarness, seedRun, withDaemon } from "./helpers.js";

const exec = promisify(execFile);
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Criterion Proof",
  GIT_AUTHOR_EMAIL: "criterion-proof@example.test",
  GIT_COMMITTER_NAME: "Criterion Proof",
  GIT_COMMITTER_EMAIL: "criterion-proof@example.test"
};

async function initializeRepository(cwd) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await writeFile(join(cwd, "baseline.txt"), "baseline\n");
  await exec("git", ["add", "baseline.txt"], { cwd });
  await exec("git", ["commit", "-qm", "baseline"], { cwd, env: gitIdentity });
}

function plan(criteria = ["Persists canonical evidence", "Retains unaffected proof", "Requires re-verification after a correction", "Rejects prose-only claims"]) {
  return normalizePlan({
    title: "Criterion proof flow",
    nodes: [{
      id: "build", title: "Build proof flow", permission: "write", writeScope: "baseline.txt",
      expectedFiles: ["baseline.txt"], estimatedChangedLines: 1, acceptanceCriteria: criteria
    }]
  });
}

function passedChecks() {
  return { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed", output: "" };
}

function checkResult(criterionId, scope = "step") {
  return {
    criterionId, status: "verified", explanation: { summary: "Canonical check passed." },
    evidence: [{ type: "check", scope, ...(scope === "final" ? {} : { stepId: "build" }) }]
  };
}

async function waitFor(daemon, ticketId, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await invoke(daemon, "GET", `/api/tickets/${ticketId}/run`);
    if (predicate(result.json)) return result.json;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for criterion proof flow");
}

test("approved proof survives omitted and prose claims, selective correction, final review, reload, and daemon restart", async () => {
  let workerRuns = 0;
  const staleSnapshots = [];
  const harness = {
    ...mockHarness(),
    async runRepositoryChecks() { return passedChecks(); },
    async evidenceImages() { return []; },
    async generateCommitMessage() { return "test: preserve proof"; },
    async runStep({ proofMap }) {
      workerRuns++;
      const stale = proofMap.criteria.filter((criterion) => criterion.current.evidenceValidity === "stale");
      staleSnapshots.push(stale.map((criterion) => criterion.id));
      const criterionResults = workerRuns === 1
        ? [
            checkResult(proofMap.criteria[0].id),
            checkResult(proofMap.criteria[1].id),
            { criterionId: proofMap.criteria[3].id, status: "verified", summary: "trust the prose", exitCode: 0 }
          ]
        : stale.map((criterion) => checkResult(criterion.id));
      return {
        report: { status: "completed", summary: "worker finished", artifact: "result", criterionResults },
        output: "worker result", prompt: "worker prompt", rawOutput: "worker result", sessionFile: null
      };
    },
    async verifyStep({ proofMap }) {
      return {
        summary: "verification finished",
        criterionResults: proofMap.criteria
          .filter((criterion) => criterion.current.evidenceValidity === "stale")
          .map((criterion) => checkResult(criterion.id)),
        findings: [], rawOutput: "", sessionFile: null
      };
    },
    async reviewTicket({ role, proofMap }) {
      return {
        role, summary: `${role} passed`, findings: [],
        criterionResults: proofMap.criteria.map((criterion) => checkResult(criterion.id, "final"))
      };
    }
  };

  await withDaemon(async (daemon, { cwd, dataDir }) => {
    await initializeRepository(cwd);
    const ticket = { id: "criterion-flow", identifier: "PROOF-1", title: "Criterion proof flow", description: "Keep proof durable", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });
    const id = await seedRun(daemon, {
      ticket, plan: plan(), status: "awaiting_approval",
      workspace, baselineTree: await snapshotTree(workspace.cwd),
      checkpoint: { id: "approve-proof-plan", kind: "awaiting_approval", title: "Approve proof plan" }
    });

    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } });
    assert.equal(approved.status, 202, approved.text);
    const firstReview = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "step_review");
    assert.equal(firstReview.proofMap.compatibility, false);
    assert.deepEqual(firstReview.proofMap.criteria.map((criterion) => criterion.text), ["Persists canonical evidence", "Retains unaffected proof", "Requires re-verification after a correction", "Rejects prose-only claims"]);
    assert.deepEqual(firstReview.proofMap.criteria.map((criterion) => criterion.current.status), ["verified", "verified", "not_yet_verified", "not_yet_verified"]);
    assert.equal(new Set(firstReview.proofMap.criteria.map((criterion) => criterion.id)).size, 4);
    assert.match(firstReview.proofMap.criteria[3].current.explanation.summary, /resolvable run evidence/);

    const rejectedStep = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} });
    assert.equal(rejectedStep.status, 400);
    assert.match(rejectedStep.json.error, /status_not_yet_verified/);

    const [correctedCriterion, , omittedCriterion, proseCriterion] = firstReview.proofMap.criteria.map((criterion) => criterion.id);
    const unaffectedHistoryLength = firstReview.proofMap.criteria[1].history.length;
    const correction = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/changes`, {
      body: { feedback: "Re-run only the changed and omitted criteria with canonical evidence", criterionIds: [correctedCriterion, omittedCriterion] }
    });
    assert.equal(correction.status, 202, correction.text);
    const reverified = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.proofMap.criteria[2].current.evidenceValidity === "valid");
    assert.deepEqual(reverified.proofMap.criteria.map((criterion) => criterion.current.status), ["verified", "verified", "verified", "not_yet_verified"]);
    assert.deepEqual(staleSnapshots[1], [correctedCriterion, omittedCriterion]);
    assert.equal(reverified.proofMap.criteria[1].history.length, unaffectedHistoryLength, "unaffected proof is retained without invalidation");
    assert.equal(reverified.proofMap.criteria[0].history.some((result) => result.evidenceValidity === "stale"), true);
    assert.equal(reverified.proofMap.criteria[2].history.some((result) => result.evidenceValidity === "stale"), true);

    const proseCorrection = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/changes`, {
      body: { feedback: "Replace the prose-only claim with canonical evidence", criterionIds: [proseCriterion] }
    });
    assert.equal(proseCorrection.status, 202, proseCorrection.text);
    const fullyReverified = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "step_review" && run.proofMap.criteria.every((criterion) => criterion.current.evidenceValidity === "valid"));
    assert.deepEqual(staleSnapshots[2], [proseCriterion]);
    assert.ok(fullyReverified.proofMap.criteria[3].history.length >= 3, "prose claim, invalidation, and re-verification are auditable");

    const acceptedStep = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} });
    assert.equal(acceptedStep.status, 202, acceptedStep.text);
    await waitFor(daemon, id, (run) => run.checkpoint?.kind === "evidence_review");
    const acceptedFinal = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`, { body: {} });
    assert.equal(acceptedFinal.status, 200, acceptedFinal.text);
    const completed = await waitFor(daemon, id, (run) => run.status === "completed");
    assert.equal(completed.proofMap.eligibility.eligible, true);
    assert.ok(daemon.store.read().ticketRuns[id].artifacts.filter((artifact) => artifact.kind === "proof-map").length >= 6);
    const finalCheck = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=final`);
    assert.equal(finalCheck.status, 200);
    assert.deepEqual(finalCheck.json, { status: "passed", command: "node .agent-plan/verify.mjs", summary: "passed", output: "", durationMs: null, evidence: [] });

    await daemon.close({ exit: false });
    await withDaemon(async (restarted) => {
      const reloaded = await invoke(restarted, "GET", `/api/tickets/${id}/run`);
      assert.equal(reloaded.status, 200);
      assert.deepEqual(reloaded.json.proofMap.criteria.map((criterion) => [criterion.id, criterion.text, criterion.current.status]), completed.proofMap.criteria.map((criterion) => [criterion.id, criterion.text, criterion.current.status]));
      assert.equal(reloaded.json.proofMap.criteria[0].history.some((result) => result.evidenceValidity === "stale"), true);
      assert.equal(reloaded.json.proofMap.criteria[2].history.some((result) => result.evidenceValidity === "stale"), true);
      assert.equal(reloaded.json.proofMap.criteria[3].history.some((result) => result.evidenceValidity === "stale"), true);
      assert.equal(reloaded.json.proofMap.criteria.every((criterion) => criterion.current.evidence[0].validity === "valid"), true);
    }, { cwd, dataDir, harness, keep: true });
  }, { harness });
});

test("resuming a worker checkpoint invalidates omitted proof before the worker changes code", async () => {
  let workerRuns = 0;
  let resumedStaleCriteria = [];
  const harness = {
    ...mockHarness(),
    async runRepositoryChecks() { return passedChecks(); },
    async evidenceImages() { return []; },
    async generateCommitMessage() { return "test: require fresh proof"; },
    async runStep({ cwd, proofMap }) {
      workerRuns++;
      if (workerRuns === 1) {
        return {
          report: {
            status: "needs_input", summary: "Choose the correction", request: "Which correction should be applied?",
            criterionResults: [{
              criterionId: proofMap.criteria[0].id, status: "verified", explanation: { summary: "Prior artifact verifies the criterion." },
              evidence: [{ type: "artifact", artifactId: "worker-proof" }]
            }]
          },
          output: "worker paused", prompt: "worker prompt", rawOutput: "worker paused", sessionFile: null
        };
      }
      resumedStaleCriteria = proofMap.criteria.filter((criterion) => criterion.current.evidenceValidity === "stale").map((criterion) => criterion.id);
      await writeFile(join(cwd, "baseline.txt"), "corrected after feedback\n");
      return {
        report: { status: "completed", summary: "worker corrected the implementation", artifact: "result", criterionResults: [] },
        output: "worker corrected", prompt: "worker correction prompt", rawOutput: "worker corrected", sessionFile: null
      };
    },
    async verifyStep() { return { summary: "verification finished", criterionResults: [], findings: [], rawOutput: "", sessionFile: null }; }
  };

  await withDaemon(async (daemon, { cwd, dataDir }) => {
    await initializeRepository(cwd);
    const ticket = { id: "worker-resume-proof", identifier: "PROOF-RESUME", title: "Worker resume proof", description: "Invalidate proof on feedback", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });
    const evidencePath = join(dataDir, "worker-proof.md");
    await writeFile(evidencePath, "verified before the checkpoint\n");
    const id = await seedRun(daemon, {
      ticket, plan: plan(["Correction must be re-verified"]), status: "awaiting_approval", workspace,
      baselineTree: await snapshotTree(workspace.cwd), proofStorageRoot: dataDir,
      artifacts: [{ id: "worker-proof", name: "worker-proof.md", kind: "agent-output", path: evidencePath }],
      checkpoint: { id: "approve-worker-resume", kind: "awaiting_approval", title: "Approve worker-resume plan" }
    });

    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: { auto: false } })).status, 202);
    const paused = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "needs_input");
    const criterionId = paused.proofMap.criteria[0].id;
    assert.equal(paused.proofMap.criteria[0].current.evidenceValidity, "valid");

    assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/clarify`, { body: { answers: "Apply the correction" } })).status, 202);
    const resumed = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "step_review");
    assert.deepEqual(resumedStaleCriteria, [criterionId]);
    assert.equal(resumed.proofMap.criteria[0].current.evidenceValidity, "stale");
    assert.equal(await readFile(join(workspace.cwd, "baseline.txt"), "utf8"), "corrected after feedback\n");
    assert.ok(daemon.store.read().ticketRuns[id].artifacts.some((artifact) => artifact.name === "proof-map-worker-resume-correction.json"));

    const acceptance = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} });
    assert.equal(acceptance.status, 400);
    assert.match(acceptance.json.error, /evidence_stale/);
  }, { harness });
});

test("legacy compatibility runs preserve step and final human approval paths", async () => {
  const harness = {
    ...mockHarness(),
    async runRepositoryChecks() { return passedChecks(); },
    async evidenceImages() { return []; },
    async reviewTicket({ role }) { return { role, summary: `${role} passed`, findings: [], criterionResults: [] }; }
  };
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    await initializeRepository(cwd);
    const ticket = { id: "legacy-step", identifier: "LEGACY-STEP", title: "Legacy step", description: "Preserve prior approval", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });

    const stepPlan = plan(["Legacy step criterion"]);
    Object.assign(stepPlan.nodes[0], { status: "review_ready", diff: { available: true, files: [] } });
    const stepId = await seedRun(daemon, {
      ticket, plan: stepPlan, status: "awaiting_step_review", workspace,
      checkpoint: { id: "legacy-step-review", kind: "step_review", stepId: "build" }
    });
    const stepProjection = await invoke(daemon, "GET", `/api/tickets/${stepId}/run`);
    assert.equal(stepProjection.json.proofMap.compatibility, true);
    assert.equal(stepProjection.json.proofMap.criteria[0].current.status, "not_yet_verified");
    const stepApproval = await invoke(daemon, "POST", `/api/tickets/${stepId}/steps/build/accept`, { body: {} });
    assert.equal(stepApproval.status, 202, stepApproval.text);

    const finalTicket = { ...ticket, id: "legacy-final", identifier: "LEGACY-FINAL", title: "Legacy final" };
    const finalPlan = plan(["Legacy final criterion"]);
    Object.assign(finalPlan.nodes[0], { status: "accepted", diff: { available: true, files: [] } });
    const finalId = await seedRun(daemon, {
      ticket: finalTicket, plan: finalPlan, status: "awaiting_evidence_review", workspace,
      finalChecks: passedChecks(),
      reviews: [{ round: 1, diff: { available: true, files: [] }, reviews: [], actionableFindings: [] }],
      checkpoint: { id: "legacy-final-review", kind: "evidence_review", finalChecks: passedChecks() }
    });
    const finalProjection = await invoke(daemon, "GET", `/api/tickets/${finalId}/run`);
    assert.equal(finalProjection.json.proofMap.compatibility, true);
    assert.equal(finalProjection.json.proofMap.criteria[0].current.status, "not_yet_verified");
    const finalApproval = await invoke(daemon, "POST", `/api/tickets/${finalId}/evidence/approve`);
    assert.equal(finalApproval.status, 200, finalApproval.text);
    assert.equal(daemon.store.read().ticketRuns[finalId].status, "completed");
  }, { harness });
});

test("failed, blocked, missing-evidence, legacy, and empty-criterion runs fail closed without changing human approval", async () => {
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    await initializeRepository(cwd);
    const ticket = { id: "proof-failures", identifier: "PROOF-2", title: "Proof failures", description: "Fail closed", source: "local", state: { name: "Local", type: "local" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });
    const failurePlan = plan(["Missing evidence", "Fails explicitly", "Is blocked explicitly"]);
    failurePlan.nodes[0].status = "review_ready";
    const baseRun = { plan: failurePlan, artifacts: [], finalChecks: passedChecks() };
    const initial = initializeProofMap(failurePlan, { approvedAt: "2026-09-10T10:00:00.000Z" });
    const proofMap = applyProofReports(initial, [
      { criterionId: initial.criteria[0].id, status: "verified", evidence: [{ type: "artifact", artifactId: "gone" }] },
      { criterionId: initial.criteria[1].id, status: "failed", explanation: { summary: "The check failed." }, evidence: [{ type: "check", scope: "step", stepId: "build" }] },
      { criterionId: initial.criteria[2].id, status: "blocked", explanation: { summary: "Dependency is unavailable." } }
    ], baseRun, { reportedAt: "2026-09-10T10:05:00.000Z" });
    const id = await seedRun(daemon, {
      ticket, plan: failurePlan, proofMap, status: "awaiting_step_review",
      workspace, baselineTree: await snapshotTree(workspace.cwd), checkpoint: { id: "step-proof", kind: "step_review", stepId: "build" }
    });
    const step = await invoke(daemon, "POST", `/api/tickets/${id}/steps/build/accept`, { body: {} });
    assert.equal(step.status, 400);
    assert.match(step.json.error, /status_not_yet_verified.*status_failed.*status_blocked/);

    const finalId = await seedRun(daemon, {
      ticket: { ...ticket, id: "proof-final-failures" }, plan: failurePlan, proofMap, status: "awaiting_evidence_review",
      workspace, baselineTree: await snapshotTree(workspace.cwd), checkpoint: { id: "final-proof", kind: "evidence_review", finalChecks: passedChecks() }
    });
    const final = await invoke(daemon, "POST", `/api/tickets/${finalId}/evidence/approve`, { body: {} });
    assert.equal(final.status, 400);
    assert.match(final.json.error, /status_not_yet_verified.*status_failed.*status_blocked/);

    const legacyId = await seedRun(daemon, {
      ticket: { ...ticket, id: "proof-legacy" }, plan: failurePlan, status: "completed", finalChecks: passedChecks(),
      reviews: [{ summary: "Aggregate legacy pass" }], workspace, baselineTree: await snapshotTree(workspace.cwd)
    });
    const legacy = await invoke(daemon, "GET", `/api/tickets/${legacyId}/run`);
    assert.equal(legacy.json.proofMap.compatibility, true);
    assert.deepEqual(legacy.json.proofMap.criteria.map((criterion) => criterion.current.status), ["not_yet_verified", "not_yet_verified", "not_yet_verified"]);
    const packet = await invoke(daemon, "GET", `/api/tickets/${legacyId}/review-packet`);
    assert.equal(packet.json.proofMap.legacy.reviews[0].summary, "Aggregate legacy pass");

    const emptyPlan = plan([]);
    const emptyId = await seedRun(daemon, {
      ticket: { ...ticket, id: "proof-empty" }, plan: emptyPlan, status: "awaiting_evidence_review",
      workspace, baselineTree: await snapshotTree(workspace.cwd),
      reviews: [{ round: 1, diff: { available: true, files: [], fileStats: [], additions: 0, deletions: 0, patch: "", stat: "" }, reviews: [], actionableFindings: [] }],
      checkpoint: { id: "empty-proof", kind: "evidence_review", finalChecks: passedChecks() }
    });
    const empty = await invoke(daemon, "GET", `/api/tickets/${emptyId}/run`);
    assert.deepEqual(empty.json.proofMap.criteria, []);
    const approvedEmpty = await invoke(daemon, "POST", `/api/tickets/${emptyId}/evidence/approve`, { body: {} });
    assert.equal(approvedEmpty.status, 200, approvedEmpty.text);
    assert.equal((await waitFor(daemon, emptyId, (run) => run.status === "completed")).status, "completed");
  });
});
