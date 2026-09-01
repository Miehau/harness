import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizePlan } from "../src/plan.js";
import { commitWorkspace, ensureTicketWorktree } from "../src/worktrees.js";
import { mockHarness, invoke, seedRun, withDaemon } from "./helpers.js";

const exec = promisify(execFile);
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
  }, { harness });
});

test("requesting proof changes enters the correction loop and returns to final review", { concurrency: true }, async () => {
  const calls = { evidence: [], fixes: [] };
  const harness = {
    ...mockHarness(),
    runRepositoryChecks: async () => ({ status: "passed", command: "verify", summary: "passed", output: "", evidence: calls.evidence }),
    evidenceImages: async () => [],
    reviewTicket: async ({ role }) => ({ role, summary: `${role} passed`, findings: [] }),
    runStep: async ({ step }) => { calls.fixes.push(step.prompt); return { report: { status: "completed", summary: "fixed" }, output: "fixed", events: [], rawOutput: "" }; }
  };
  await withDaemon(async (daemon, fixture) => {
    const { id } = await proofFixture(daemon, fixture, calls);
    const response = await invoke(daemon, "POST", `/api/tickets/${id}/evidence/changes`, { body: { feedback: "The confirmation state is missing from the recording" } });
    assert.equal(response.status, 202);
    const reviewed = await waitFor(daemon, id, (run) => run.checkpoint?.kind === "evidence_review" && run.checkpoint.id !== "proof-1" || run.lastError);
    assert.equal(reviewed.checkpoint?.kind, "evidence_review", reviewed.lastError);
    assert.ok(calls.fixes.some((prompt) => prompt.includes("confirmation state is missing")));
    const stored = daemon.store.read().ticketRuns[id];
    assert.equal(stored.reviews.some((round) => round.actionableFindings?.some((finding) => finding.category === "human-proof-review")), true);
  }, { harness });
});
