import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePlan } from "../src/plan.js";
import { captureTicketProof } from "../scripts/capture-ticket-proof.mjs";
import {
  applyVerifyEvidenceGate, planRequiresVideoEvidence, planRequiresVisualEvidence,
  ticketBoundVisualEvidence, ticketProofManifest, verifyStageEvidenceError, visualEvidenceManifestName
} from "../src/visual-evidence.js";

test("non-UI plans need tests only; UI plans require visual proof", () => {
  assert.equal(planRequiresVisualEvidence(normalizePlan({ nodes: [{ id: "logic", title: "Compute" }] })), false);
  assert.equal(planRequiresVisualEvidence(normalizePlan({ nodes: [{ id: "ui", title: "Show it", requiresVisualEvidence: true }] })), true);
  assert.equal(planRequiresVideoEvidence(normalizePlan({ nodes: [{ id: "ui", title: "Show it", requiresVideoEvidence: true }] })), true);
});

test("unbound screenshots cannot satisfy a ticket-bound verify gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unbound-evidence-"));
  const screenshot = { name: "desktop.png", path: join(directory, "desktop.png"), mediaKind: "image", mediaType: "image/png" };
  await writeFile(screenshot.path, "png");
  assert.equal(ticketBoundVisualEvidence([screenshot], { ticketId: "ticket-1", runId: "run-2" }).bound, false);
  const checks = applyVerifyEvidenceGate({ status: "passed", evidence: [screenshot] }, {
    required: true, ticketId: "ticket-1", runId: "run-2"
  });
  assert.equal(checks.status, "failed");
  assert.equal(checks.failureKind, "visual-evidence");
  assert.match(checks.summary, /ticket-bound/);
});

test("a live-ticket manifest binds screenshots to that ticket and run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bound-evidence-"));
  const screenshot = { name: "desktop.png", path: join(directory, "desktop.png"), mediaKind: "image", mediaType: "image/png" };
  const video = { name: "interaction.webm", path: join(directory, "interaction.webm"), mediaKind: "video", mediaType: "video/webm" };
  await mkdir(directory, { recursive: true });
  await writeFile(screenshot.path, "png");
  await writeFile(video.path, "webm");
  await writeFile(join(directory, visualEvidenceManifestName), JSON.stringify(ticketProofManifest({
    ticketId: "ticket-1", runId: "run-2", captures: [{ name: "desktop", path: "desktop.png" }]
  })));
  assert.equal(ticketBoundVisualEvidence([screenshot, video], { ticketId: "ticket-1", runId: "run-2" }).bound, true);
  assert.equal(ticketBoundVisualEvidence([screenshot, video], { ticketId: "other", runId: "run-2" }).bound, false);
  const passed = applyVerifyEvidenceGate({ status: "passed", evidence: [screenshot, video] }, {
    required: true, requiredVideo: true, ticketId: "ticket-1", runId: "run-2"
  });
  assert.equal(passed.status, "passed");
});

test("stamped artifact identity also binds without a manifest", () => {
  const evidence = [{ name: "desktop.png", mediaKind: "image", boundTicketId: "ticket-1", boundRunId: "run-2" }];
  assert.equal(ticketBoundVisualEvidence(evidence, { ticketId: "ticket-1", runId: "run-2" }).bound, true);
  assert.equal(verifyStageEvidenceError({
    ticket: { id: "ticket-1" }, runId: "run-2",
    plan: normalizePlan({ nodes: [{ id: "ui", title: "Show it", requiresVisualEvidence: true }] }),
    artifacts: [{ kind: "visual-evidence", ...evidence[0] }]
  }), null);
  assert.match(verifyStageEvidenceError({
    ticket: { id: "ticket-1" }, runId: "run-2",
    plan: normalizePlan({ nodes: [{ id: "ui", title: "Show it", requiresVisualEvidence: true }] }),
    artifacts: [{ kind: "visual-evidence", name: "desktop.png", mediaKind: "image" }]
  }), /ticket-bound/);
});

test("ticket-bound capture refuses to run without live ticket identity", async () => {
  await assert.rejects(captureTicketProof({ url: "", ticketId: "t", runId: "r", evidenceDir: "/tmp" }), /AGENT_PLAN_CAPTURE_URL/);
  await assert.rejects(captureTicketProof({ url: "http://127.0.0.1:4317", ticketId: "", runId: "r", evidenceDir: "/tmp" }), /AGENT_PLAN_CAPTURE_TICKET_ID/);
});

test("repository failures stay test failures even when screenshots are missing", () => {
  const checks = applyVerifyEvidenceGate({
    status: "failed", command: "node .agent-plan/verify.mjs", summary: "node .agent-plan/verify.mjs failed.", evidence: []
  }, { required: true, ticketId: "ticket-1", runId: "run-2" });
  assert.equal(checks.failureKind, undefined);
  assert.equal(checks.summary, "node .agent-plan/verify.mjs failed.");
});
