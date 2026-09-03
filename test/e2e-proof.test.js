import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizePlan } from "../src/plan.js";
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
  calls.evidence = [
    { name: "desktop.png", path: imagePath, mediaType: "image/png", mediaKind: "image" },
    { name: "interaction.webm", path: videoPath, mediaType: "video/webm", mediaKind: "video" }
  ];

  const plan = normalizePlan({ title: "Proof", nodes: [{
    id: "build", title: "Build", permission: "write", writeScope: "delivered.txt",
    expectedFiles: ["delivered.txt"], estimatedChangedLines: 1, acceptanceCriteria: ["Delivery is visible"],
    requirementIds: ["REQ-proof"], requiresVideoEvidence: true
  }] });
  plan.nodes[0].status = "accepted";
  const artifacts = calls.evidence.map((item, index) => ({ ...item, id: `media-${index}`, kind: "visual-evidence", stageId: "verify" }));
  const id = await seedRun(daemon, {
    ticket, workspace, plan, artifacts, reviews: [{ round: 1, diff: { stat: "1 file changed" }, reviews: [], actionableFindings: [] }],
    status: "awaiting_evidence_review",
    checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks: { status: "passed", summary: "integration checks passed" }, evidenceArtifactIds: artifacts.map((item) => item.id), videoRequired: true }
  });
  return { id, imagePath, videoPath };
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
    runRepositoryChecks: async (input) => {
      calls.lastCheck = input;
      return { status: "passed", command: "node .agent-plan/verify.mjs", summary: "integration checks passed", output: "", evidence: calls.evidence };
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
    assert.equal(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_TICKET_ID, id);
    assert.equal(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_RUN_ID, "run-1");
    assert.match(calls.lastCheck.environment.AGENT_PLAN_CAPTURE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(daemon.store.read().ticketRuns[id].finalEvidenceArtifactIds, ["media-0", "media-1"]);
  }, { harness, listen: true });
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
    const id = await seedRun(daemon, {
      ticket, workspace, plan, artifacts: [{ id: "context", name: "product-context-update.md", kind: "product-context-update", content: "# Product context\n" }],
      reviews: [{ round: 1, diff, reviews: [], actionableFindings: [] }], status: "awaiting_evidence_review",
      checkpoint: { id: "proof-1", kind: "evidence_review", title: "Review final proof", finalChecks: { status: "passed", summary: "passed" } }
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
    reviewTicket: async ({ role }) => ({ role, summary: `${role} passed`, findings: [] })
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
    Object.assign(plan.nodes[0], { status: "review_ready", vcsChange, diff: { available: true, files: [], changedLines: 0, patch: "", stat: "" } });
    const id = await seedRun(daemon, { ticket, workspace, plan, status: "awaiting_step_review", checkpoint: { id: "review", kind: "step_review", stepId: "verify", title: "Review" } });

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
    runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "api_key=lowercase_secret_abcdefgh", evidence: calls.evidence }),
    evidenceImages: async () => [],
    reviewTicket: async ({ role, artifacts }) => { calls.reviewArtifacts = artifacts; return { role, summary: `${role} api_key=lowercase_secret_abcdefgh`, findings: [] }; },
    runStep: async ({ step }) => { calls.fixes.push(step.prompt); return { report: { status: "completed", summary: "fixed" }, output: "fixed", events: [], rawOutput: "" }; }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    const context = await persistArtifact(fixture.dataDir, daemon.store.read().ticketRuns[id].ticket, {
      name: "architecture.md", content: "# Retained architecture", runId: "run-1", stageId: "design", kind: "architecture"
    });
    await daemon.store.update((state) => { state.ticketRuns[id].artifacts.push(context); });
    const proofFeedback = "The confirmation state is missing from the recording; api_key=lowercase_secret_abcdefgh";
    const response = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/changes`, { body: { feedback: proofFeedback } });
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
