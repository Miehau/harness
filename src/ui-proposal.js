import { createHash, randomUUID } from "node:crypto";
import { flattenSteps } from "./plan.js";
import { persistArtifact } from "./artifacts.js";
import { redactText } from "./redaction.js";

export function uiPlanHash(plan) {
  const steps = flattenSteps(plan).map(({ id, description, writeScope, expectedFiles, acceptanceCriteria, criterionBindings, uiPlan }) => ({ id, description, writeScope, expectedFiles, acceptanceCriteria, criterionBindings, uiPlan }));
  return createHash("sha256").update(JSON.stringify({ impact: plan.uiImpact, steps })).digest("hex");
}

export function requiresUiProposal(run) {
  return run.uiReviewRequired === true || run.plan?.uiImpact?.level === "material";
}

export function assertUiProposal(run, revision = null, { approving = false } = {}) {
  if (!requiresUiProposal(run)) return;
  const proposal = run.uiProposal;
  if (!proposal || proposal.invalidatedAt || proposal.planHash !== uiPlanHash(run.plan) || (approving ? revision !== proposal.revisionId : !proposal.approvedAt)) {
    throw new Error("Review and approve the current UI proposal revision before implementation or delivery; request a revised proposal if the plan changed");
  }
}

export async function buildUiProposal({ dataDir, run, plan, design, feedback = "", harness, signal, onEvent }) {
  if (plan.uiImpact?.level !== "material") return null;
  const result = await harness.proposeUi({ cwd: run.workspace.cwd, ticket: run.ticket, runId: run.runId, plan, design, feedback,
    profile: run.stageProfiles.architecture, access: run.access, repositories: run.repositories || [], signal, onEvent });
  signal?.throwIfAborted();
  const html = redactText(result.html || "");
  if (!/<[a-z][\s>]/i.test(html) && !/<(?:html|main|section|div|body)\b/i.test(html)) throw new Error("UI proposal must contain rendered HTML");
  if (html.length > 16000) throw new Error("UI proposal exceeds 16000 characters; simplify the prototype");
  const revisionId = randomUUID();
  const artifact = await persistArtifact(dataDir, run.ticket, { runId: run.runId, stageId: "design", name: "ui-proposal.html", kind: "ui-proposal", storageKey: revisionId, content: html });
  return { revisionId, contentHash: createHash("sha256").update(html).digest("hex"), planHash: uiPlanHash(plan), artifactId: artifact.id, artifact, summary: redactText(result.summary || "UI direction for review").slice(0, 2000), approvedAt: null, createdAt: new Date().toISOString() };
}
