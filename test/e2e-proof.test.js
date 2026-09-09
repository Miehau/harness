import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ticketProofManifest, visualEvidenceManifestName } from "../src/visual-evidence.js";
import { promisify } from "node:util";
import { normalizePlan } from "../src/plan.js";
import { applyProofReports, initializeProofMap } from "../src/proof-map.js";
import { beginJjChange, initializeJjWorkspace } from "../src/jj.js";
import { persistArtifact } from "../src/artifacts.js";
import { commitWorkspace, ensureTicketWorktree } from "../src/worktrees.js";
import { mockHarness, invoke, seedRun, withDaemon } from "./helpers.js";

const exec = promisify(execFile);
const hasJj = await exec("jj", ["--version"]).then(() => true, () => false);
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Proof Test",
  GIT_AUTHOR_EMAIL: "proof@example.test",
  GIT_COMMITTER_NAME: "Proof Test",
  GIT_COMMITTER_EMAIL: "proof@example.test"
};

function verifiedProofMap(plan, run, evidence) {
  const map = initializeProofMap(plan, { approvedAt: "2026-09-10T10:00:00.000Z" });
  return applyProofReports(map, map.criteria.map((criterion) => ({
    criterionId: criterion.id, status: "verified", evidence
  })), run);
}

async function proofFixture(daemon, { dataDir, cwd }, calls) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await writeFile(join(cwd, "baseline.txt"), "baseline\n");
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "-qm", "baseline"], { cwd, env: gitIdentity });

  const ticket = { id: "proof-local", identifier: "LOCAL-proof", title: "Proof delivery", description: "Gate delivery on proof", source: "local", state: { name: "Local", type: "local" } };
  const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" });
  await writeFile(join(workspace.cwd, "delivered.txt"), "approved\n");
  await commitWorkspace(workspace.cwd, "feat: proof delivery\n\nWhy: Exercise the final proof gate.\nRequirement: REQ-proof");

  const mediaDir = join(dataDir, "visual-evidence", "proof-local");
  await mkdir(mediaDir, { recursive: true });
  const imagePath = join(mediaDir, "desktop.png");
  const videoPath = join(mediaDir, "interaction.webm");
  await writeFile(imagePath, "png-proof");
  await writeFile(videoPath, "webm-proof");
  await writeFile(join(mediaDir, visualEvidenceManifestName), JSON.stringify(ticketProofManifest({
    ticketId: ticket.id, runId: "run-1",
    captures: [{ name: "desktop", path: "desktop.png" }, { name: "interaction", path: "interaction.webm" }]
  })));
  calls.evidence = [
    { name: "desktop.png", path: imagePath, mediaType: "image/png", mediaKind: "image", boundTicketId: ticket.id, boundRunId: "run-1" },
    { name: "interaction.webm", path: videoPath, mediaType: "video/webm", mediaKind: "video", boundTicketId: ticket.id, boundRunId: "run-1" }
  ];

  const plan = normalizePlan({ title: "Proof", nodes: [{
    id: "build", title: "Build", permission: "write", writeScope: "delivered.txt",
    expectedFiles: ["delivered.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["Delivery is visible"],
    requirementIds: ["REQ-proof"], requiresVideoEvidence: true
  }] });
  plan.nodes[0].status = "accepted";
  const criterionIds = initializeProofMap(plan).criteria.map(({ id }) => id);
  for (const item of calls.evidence) Object.assign(item, { criterionIds, commands: ["open delivery", "submit delivery"], assertions: ["Delivery is visible"] });
  const artifacts = calls.evidence.map((item, index) => ({ ...item, id: `media-${index}`, kind: "visual-evidence", stageId: "verify", boundTicketId: ticket.id, boundRunId: "run-1" }));
  const finalChecks = { status: "passed", summary: "integration checks passed" };
  const proofMap = verifiedProofMap(plan, { plan, artifacts, finalChecks, proofStorageRoot: dataDir }, [{ type: "check", scope: "final" }]);
  const id = await seedRun(daemon, {
    ticket, workspace, plan, artifacts, proofMap, proofStorageRoot: dataDir, finalChecks, reviews: [{ round: 1, diff: { stat: "1 file changed" }, reviews: [], actionableFindings: [] }],
    status: "awaiting_evidence_review",
    checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks, evidenceArtifactIds: artifacts.map((item) => item.id), videoRequired: true }
  });
  return { id, imagePath, videoPath };
}

async function freshVisualChecks(calls, environment = {}) {
  const directory = await mkdtemp(join(calls.evidence[0].path, "..", "capture-"));
  const criterionIds = JSON.parse(environment.AGENT_PLAN_CAPTURE_CRITERIA || "[]").map(({ id }) => id);
  const evidence = await Promise.all(calls.evidence.map(async (item) => {
    const path = join(directory, item.name);
    await copyFile(item.path, path);
    return { ...item, path, criterionIds, commands: [["tasks", "open", "proof-local"]], assertions: [{ selector: "#ticket-header", text: "Proof delivery" }] };
  }));
  const framePath = join(directory, "recording-frame.png");
  await copyFile(evidence[0].path, framePath);
  evidence.push({ ...evidence[0], name: "recording-frame.png", path: framePath, videoPath: evidence[1].path });
  return { status: "passed", command: "verify", summary: "new final checks", output: "new output", evidence };
}

function independentResults(proofMap, artifacts = []) {
  return proofMap.criteria.map((criterion) => ({
    criterionId: criterion.id, status: "verified", explanation: { summary: "Fixture independent verification" },
    evidence: [{ type: "check", scope: "final" }, ...artifacts.filter((artifact) => artifact.criterionIds?.includes(criterion.id)).map(({ id }) => ({ type: "media", artifactId: id }))]
  }));
}

async function waitFor(daemon, id, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/run`);
    if (predicate(result.json)) return result.json;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for proof workflow");
}

test("final proof blocks local integration, streams image and video, then delivers after approval", { concurrency: true }, async () => {
  const calls = { evidence: [] };
  const harness = {
    ...mockHarness(),
    containmentFactory: ({ executionId }) => ({
      executionId,
      ownership: { executionId, token: "proof-check-owner", createdAt: "2026-09-03T10:00:00.000Z" },
      cleanup: async (trigger) => {
        calls.cleanupTriggers ||= [];
        calls.cleanupTriggers.push(trigger);
        return { executionId, outcome: "not-required", triggers: [trigger], discovered: [], actions: [], unresolved: [], diagnostics: [] };
      }
    }),
    runRepositoryChecks: async (input) => {
      calls.lastCheck = input;
      const cleanupTrigger = { trigger: "repository-check-exit", command: "node .agent-plan/verify.mjs", at: "2026-09-03T10:00:01.000Z" };
      const cleanup = await input.containment.cleanup(cleanupTrigger);
      return { status: "passed", command: "node .agent-plan/verify.mjs", summary: "integration checks passed", output: "", evidence: calls.evidence, cleanup, cleanupTrigger };
    }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    await assert.rejects(readFile(join(fixture.cwd, "delivered.txt")), /ENOENT/);

    const image = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/media-0/media`);
    const video = await invoke(daemon, "GET", `/api/tickets/${id}/artifacts/media-1/media`);
    assert.equal(image.headers["content-type"], "image/png");
    assert.equal(video.headers["content-type"], "video/webm");
    assert.equal(image.text, "png-proof");
    assert.equal(video.text, "webm-proof");

    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`);
    assert.equal(approved.status, 200);
    const completed = await waitFor(daemon, id, (run) => run.status === "completed" || run.lastError);
    assert.equal(completed.status, "completed", completed.lastError);
    assert.equal(await readFile(join(fixture.cwd, "delivered.txt"), "utf8"), "approved\n");
    assert.equal(calls.lastCheck.requireVisualEvidence, true);
    assert.equal(calls.lastCheck.requireVideoEvidence, true);
    const execution = daemon.store.read().ticketRuns[id].cleanup.executions.find(({ executionId }) => executionId === calls.lastCheck.containment.executionId);
    const exits = execution.triggers.filter(({ trigger }) => trigger === "repository-check-exit");
    assert.deepEqual(exits, [{ trigger: "repository-check-exit", command: "node .agent-plan/verify.mjs", at: "2026-09-03T10:00:01.000Z" }]);
    assert.equal(calls.cleanupTriggers.filter(({ trigger }) => trigger === "repository-check-exit").length, 2, "harness completion and daemon settlement share one durable trigger");
assert.equal(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_TICKET_ID, id);
    assert.equal(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_RUN_ID, "run-1");
    assert.match(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(daemon.store.read().ticketRuns[id].finalEvidenceArtifactIds, ["media-0", "media-1"]);
  }, { harness, listen: true });
});

test("a failed reviewer waits for its siblings before the run becomes retryable", async () => {
  const calls = { evidence: [] };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Set();
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async ({ environment }) => freshVisualChecks(calls, environment),
    evidenceImages: async () => [],
    reviewTicket: async ({ role }) => {
      started.add(role);
      if (role === "requirements") throw new Error("review provider failed");
      if (role === "integration") await held;
      return { role, summary: "Reviewed", findings: [] };
    }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    try {
      const restart = invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { confirmed: true, target: "stage:verify" } });
      const reviewing = await waitFor(daemon, id, () => started.size === 3);
      assert.notEqual(reviewing.status, "needs_attention");
      assert.equal(reviewing.lastError, null);
      release();
      const restarted = await restart;
      assert.equal(restarted.status, 202, restarted.text);
      const failed = await waitFor(daemon, id, (run) => run.status === "needs_attention");
      assert.match(failed.lastError, /review provider failed/);
    } finally { release(); }
  }, { harness });
});

test("verification restart preserves old final evidence and assigns a fresh review identity", async () => {
  const calls = { evidence: [] };
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async ({ environment, requireVisualEvidence, proofCriteria }) => {
      assert.equal(requireVisualEvidence, true, "declared capture-proof enables final evidence even without plan visual flags");
      assert.deepEqual(JSON.parse(environment.AGENT_PLAN_CAPTURE_CRITERIA), []);
      assert.ok(proofCriteria.length);
      return freshVisualChecks(calls, { ...environment, AGENT_PLAN_CAPTURE_CRITERIA: JSON.stringify(proofCriteria) });
    },
    evidenceImages: async () => [],
    reviewTicket: async ({ role, proofMap, artifacts }) => ({
      role, summary: `${role} passed`, findings: [],
      criterionResults: independentResults(proofMap, artifacts)
    })
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    const workspace = daemon.store.read().ticketRuns[id].workspace.cwd;
    await mkdir(join(workspace, ".agent-plan"), { recursive: true });
    await writeFile(join(workspace, ".agent-plan", "project.json"), JSON.stringify({ commands: { "capture-proof": ["node", "capture.mjs"] } }));
    const oldChecks = { status: "passed", command: "verify-old", summary: "old final checks", output: "old output" };
    const oldDiff = { available: true, patch: "old final diff", files: ["old.js"] };
    await daemon.store.update((state) => {
      const stored = state.ticketRuns[id];
      Object.assign(stored.plan.nodes[0], { requiresVisualEvidence: false, requiresVideoEvidence: false });
      for (const criterion of stored.proofMap.criteria) Object.assign(criterion, { requiresVisualEvidence: false, requiresVideoEvidence: false });
      Object.assign(stored, {
        reviews: [{ round: 1, reviewId: "final-review-1", finalChecks: oldChecks, diff: oldDiff, reviews: [], actionableFindings: [], createdAt: "2020-01-01T00:00:00.000Z" }],
        finalChecks: oldChecks,
        finalCheckHistory: { "final-review-1": oldChecks },
        finalDiffHistory: { "final-review-1": oldDiff },
        finalReviewHistory: { "final-review-1": { createdAt: "2020-01-01T00:00:00.000Z" } },
        finalReviewSequence: 1,
        status: "needs_attention",
        checkpoint: null
      });
      for (const criterion of stored.proofMap.criteria) criterion.current.evidence = [{ type: "check", scope: "final", reviewId: "final-review-1", validity: "valid" }];
    });

    const restarted = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { confirmed: true, target: "stage:verify" } });
    assert.equal(restarted.status, 202, restarted.text);
    const reverified = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "evidence_review" && run.proofMap?.criteria[0]?.current.evidence?.some((evidence) => evidence.reviewId === "final-review-2"));
    assert.equal(reverified.proofMap.eligibility.eligible, true);
    assert.equal(reverified.proofMap.criteria[0].current.evidence[0].reviewId, "final-review-2");
    assert.equal(reverified.proofMap.criteria[0].history.some((result) => result.evidence?.some((evidence) => evidence.reviewId === "final-review-1")), true);

    const oldCheck = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=final&reviewId=final-review-1`);
    const newCheck = await invoke(daemon, "GET", `/api/tickets/${id}/proof/check-output?scope=final&reviewId=final-review-2`);
    assert.equal(oldCheck.json.output, "old output");
    assert.equal(newCheck.json.output, "new output");
    assert.equal(daemon.store.read().ticketRuns[id].reviews.length, 2);
  }, { harness });
});

test("verified tracker tickets with no changes complete without remote delivery", { concurrency: true }, async () => {
  const trackerCalls = [];
  const trackers = {
    async comment(ticket, body) { trackerCalls.push(["comment", ticket.id, body]); return { id: "comment-1" }; },
    async transition(ticket, target) { trackerCalls.push(["transition", ticket.id, target]); return { type: "completed" }; }
  };
  await withDaemon(async (daemon, { cwd }) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd });
    await writeFile(join(cwd, "baseline.txt"), "baseline\n");
    await exec("git", ["add", "-A"], { cwd });
    await exec("git", ["commit", "-qm", "baseline"], { cwd, env: gitIdentity });
    await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd });
    const ticket = { id: "linear-no-change", identifier: "MEA-no-change", title: "Already shipped", description: "Verify existing behavior", source: "linear", provider: "linear", state: { name: "In Progress", type: "started" } };
    const workspace = await ensureTicketWorktree({ sourceCwd: cwd, dataDir: daemon.dataDir, ticket, runId: "run-1" });
    const plan = normalizePlan({ title: "No change", nodes: [{ id: "verify", title: "Verify", permission: "read", acceptanceCriteria: ["Existing behavior passes"] }] });
    plan.nodes[0].status = "accepted";
    const diff = { available: true, files: [], fileStats: [], additions: 0, deletions: 0, changedLines: 0, patch: "", stat: "" };
    const finalChecks = { status: "passed", summary: "passed" };
    const artifacts = [{ id: "context", name: "product-context-update.md", kind: "product-context-update", content: "# Product context\n" }];
    const proofMap = verifiedProofMap(plan, { plan, artifacts, finalChecks }, [{ type: "check", scope: "final" }]);
    const id = await seedRun(daemon, {
      ticket, workspace, plan, artifacts, proofMap, finalChecks,
      reviews: [{ round: 1, diff, reviews: [], actionableFindings: [] }], status: "awaiting_evidence_review",
      checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks }
    });

    const approved = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/approve`);
    assert.equal(approved.status, 200);
    const completed = await waitFor(daemon, id, (run) => run.status === "completed" || run.lastError);
    assert.equal(completed.status, "completed", completed.lastError);
    const stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.integration.noChange, true);
    assert.equal(stored.merge.status, "not_required");
    assert.deepEqual(trackerCalls.map(([kind, , value]) => [kind, kind === "comment" ? value.includes("already satisfied") : value]), [["comment", true], ["transition", "done"]]);
  }, { trackers });
});

test("accepting a no-change Jujutsu step does not create an empty ticket commit", { skip: !hasJj }, async () => {
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: [] }),
    evidenceImages: async () => [],
    reviewTicket: async ({ role, proofMap, artifacts }) => ({ role, summary: `${role} passed`, findings: [], criterionResults: independentResults(proofMap, artifacts) })
  };
  await withDaemon(async (daemon, { cwd, dataDir }) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd });
    await writeFile(join(cwd, "baseline.txt"), "baseline\n");
    await exec("git", ["add", "-A"], { cwd });
    await exec("git", ["commit", "-qm", "baseline"], { cwd, env: gitIdentity });
    const ticket = { id: "jj-no-change", identifier: "LOCAL-jj", title: "Already shipped", description: "Verify existing behavior", source: "local", state: { name: "Local", type: "local" } };
    const workspace = { ...await ensureTicketWorktree({ sourceCwd: cwd, dataDir, ticket, runId: "run-1" }), vcs: "jj" };
    await initializeJjWorkspace(workspace.cwd);
    const vcsChange = await beginJjChange(workspace.cwd, { title: "No changes" });
    const plan = normalizePlan({ title: "No change", nodes: [{ id: "verify", title: "Verify", permission: "write", writeScope: "baseline.txt", acceptanceCriteria: ["Existing behavior passes"] }] });
    Object.assign(plan.nodes[0], { status: "review_ready", vcsChange, checks: { status: "passed", summary: "passed" }, diff: { available: true, files: [], changedLines: 0, patch: "", stat: "" } });
    const proofMap = verifiedProofMap(plan, { plan }, [{ type: "check", scope: "step", stepId: "verify" }]);
    const id = await seedRun(daemon, { ticket, workspace, plan, proofMap, status: "awaiting_step_review", checkpoint: { id: "review", kind: "step_review", stepId: "verify", title: "Review" } });

    const accepted = await invoke(daemon, "POST", `/api/tickets/${id}/steps/verify/accept`, { body: {} });
    assert.equal(accepted.status, 202, accepted.text);
    const reviewed = await waitFor(daemon, id, (run) => run.status === "awaiting_evidence_review" || run.lastError);
    assert.equal(reviewed.status, "awaiting_evidence_review", reviewed.lastError);
    assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].commit, undefined);
    const commits = (await exec("git", ["rev-list", "--count", "main..HEAD"], { cwd: workspace.cwd })).stdout.trim();
    assert.equal(commits, "0");
  }, { harness });
});

test("requesting proof changes enters the correction loop and returns to final review", { concurrency: true }, async () => {
  const calls = { evidence: [], fixes: [] };
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async ({ environment }) => ({ ...await freshVisualChecks(calls, environment), output: "api_key=lowercase_secret_abcdefgh" }),
    evidenceImages: async () => [],
    reviewTicket: async ({ role, proofMap, artifacts }) => {
      calls.reviewArtifacts = artifacts;
      return { role, summary: `${role} api_key=lowercase_secret_abcdefgh`, findings: [], criterionResults: independentResults(proofMap, artifacts) };
    },
    runStep: async ({ step }) => { calls.fixes.push(step.prompt); return { report: { status: "completed", summary: "fixed" }, output: "fixed", events: [], rawOutput: "" }; }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
const context = await persistArtifact(fixture.dataDir, daemon.store.read().ticketRuns[id].ticket, { name: "architecture.md", content: "# Retained architecture", runId: "run-1", stageId: "design", kind: "architecture" });
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(context); });
    const criterionId = daemon.store.read().ticketRuns[id].proofMap.criteria[0].id;
    const response = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/changes`, { body: { feedback: "The confirmation state is missing from the recording", criterionIds: [criterionId] } });
    assert.equal(response.status, 202);
    const reviewed = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "evidence_review" && run.checkpoint.id !== "proof-1" || run.lastError);
    assert.equal(reviewed.checkpoint?.kind, "evidence_review", reviewed.lastError);
    assert.ok(calls.fixes.some((prompt) => prompt.includes("confirmation state is missing")));
    assert.equal(calls.fixes.some((prompt) => prompt.includes("lowercase_secret_abcdefgh")), false);
    assert.equal(calls.reviewArtifacts.find((artifact) => artifact.id === context.id)?.content, "# Retained architecture");
    const stored = daemon.store.read().ticketRuns[id];
    const proofFinding = stored.reviews.flatMap((round) => round.actionableFindings || []).find((finding) => finding.category === "human-proof-review");
    assert.ok(proofFinding);
    assert.equal(proofFinding.claim.includes("lowercase_secret_abcdefgh"), false);
    assert.equal(proofFinding.suggestedFix.includes("lowercase_secret_abcdefgh"), false);
    assert.equal(JSON.stringify(stored).includes("lowercase_secret_abcdefgh"), false);
    const publicState = await invoke(daemon, "GET", "/api/state");
    assert.equal(JSON.stringify(publicState.json).includes("lowercase_secret_abcdefgh"), false);
    const reviewArtifacts = stored.artifacts.filter((artifact) => artifact.kind === "independent-review");
    const bodies = await Promise.all(reviewArtifacts.map((artifact) => readFile(artifact.path, "utf8")));
    assert.equal(bodies.some((body) => body.includes("lowercase_secret_abcdefgh")), false);
  }, { harness });
});

test("failed verification skips independent reviewers and carries the exact failure into correction", async () => {
  const calls = { evidence: [], reviewers: 0 };
  let correction;
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async () => ({ status: "failed", failureKind: "capture-preflight", command: "test-capture-proof", summary: "Fixture rejected instruction", output: "submitSteering returned rejected", evidence: [] }),
    evidenceImages: async () => [],
    reviewTicket: async () => { calls.reviewers++; throw new Error("Review must not run"); },
    runStep: async (input) => { correction = input; throw new Error("Stop at correction boundary"); }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    await invoke(daemon, "POST", `/api/tickets/${id}/restart`, { body: { confirmed: true, target: "stage:verify" } });
    await waitFor(daemon, id, (run) => run.status === "needs_attention");
    assert.equal(calls.reviewers, 0);
    const stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.reviews.at(-1).reviewMode, "prerequisite");
    assert.match(JSON.stringify(correction), /submitSteering returned rejected/);
    assert.equal(stored.reviews.at(-1).reviews.length, 1);
  }, { harness });
});
