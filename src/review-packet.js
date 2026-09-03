import { flattenSteps } from "./plan.js";

const relevantArtifactKinds = new Set([
  "requirements",
  "feature-brief",
  "product-context-snapshot",
  "implementation-delta",
  "architecture",
  "agent-output",
  "step-verification",
  "product-context-update",
  "visual-evidence"
]);
const essentialArtifactKinds = new Set(["requirements", "feature-brief", "implementation-delta", "architecture"]);

function clip(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [${omitted} characters omitted] …\n${text.slice(-half)}`;
}

function clippedStrings(values, count, length) {
  return (Array.isArray(values) ? values : []).slice(0, count).map((value) => clip(value, length));
}

function compactProofMap(proofMap) {
  if (!proofMap) return null;
  return {
    version: proofMap.version || 1,
    approvedAt: proofMap.approvedAt || null,
    compatibility: Boolean(proofMap.compatibility),
    eligibility: structuredClone(proofMap.eligibility || { eligible: false, blockingReasons: [] }),
    criteria: (proofMap.criteria || []).map((criterion) => ({
      id: criterion.id,
      stepId: criterion.stepId,
      stepTitle: criterion.stepTitle || "",
      stepRequired: criterion.stepRequired !== false,
      index: criterion.index,
      text: criterion.text,
      current: structuredClone(criterion.current),
      history: structuredClone(criterion.history || [])
    })),
    ...(proofMap.legacy ? { legacy: structuredClone(proofMap.legacy) } : {})
  };
}

export function compactReviewPacket({ ticket = {}, plan = {}, artifacts = [], diff = {}, checks = {}, proofMap = null }) {
  const steps = flattenSteps(plan);
  const statuses = new Map(steps.map((step) => [step.id, step.status]));
  const latestArtifacts = new Map();

  artifacts.forEach((artifact, index) => {
    const content = artifact?.content || artifact?.summary;
    if ((!content && artifact?.kind !== "visual-evidence") || !relevantArtifactKinds.has(artifact?.kind)) return;
    if (artifact.stepId && statuses.has(artifact.stepId) && statuses.get(artifact.stepId) !== "accepted") return;
    // Media is evidence by immutable artifact ID, not a replaceable step summary.
    const key = artifact.kind === "visual-evidence" ? `${artifact.kind}:${artifact.id || index}` : `${artifact.kind}:${artifact.stepId || "run"}`;
    latestArtifacts.set(key, { artifact, index });
  });

  const retained = [...latestArtifacts.values()];
  const selectedArtifacts = [
    ...retained.filter(({ artifact }) => artifact.kind === "visual-evidence"),
    ...retained.filter(({ artifact }) => artifact.kind !== "visual-evidence")
      .sort((left, right) => Number(essentialArtifactKinds.has(right.artifact.kind)) - Number(essentialArtifactKinds.has(left.artifact.kind)) || right.index - left.index)
      .slice(0, 20)
  ].map(({ artifact }) => ({

      id: artifact.id || null,
      kind: artifact.kind,
      name: clip(artifact.name, 300),
      stepId: artifact.stepId ? clip(artifact.stepId, 200) : null,
      sourceStepTitle: artifact.sourceStepTitle ? clip(artifact.sourceStepTitle, 300) : null,
      path: artifact.path ? clip(artifact.path, 1_000) : null,
      ...(artifact.kind === "visual-evidence" ? {} : { content: clip(artifact.content || artifact.summary, 4_000) })
    }));

  const files = clippedStrings(diff.files, 100, 300);
  return {
    ticket: {
      identifier: clip(ticket.identifier || ticket.id, 200),
      title: clip(ticket.title, 500),
      description: clip(ticket.description, 4_000)
    },
    plan: {
      title: clip(plan.title, 500),
      summary: clip(plan.summary, 2_000),
      outcomes: steps.map((step) => ({
        id: step.id,
        title: clip(step.title, 300),
        description: clip(step.description, 500),
        status: step.status,
        requirementIds: clippedStrings(step.requirementIds, 100, 100),
        capabilityIds: clippedStrings(step.capabilityIds, 100, 100),
        deltaIds: clippedStrings(step.deltaIds, 100, 100),
        acceptanceCriteria: clippedStrings(step.acceptanceCriteria, 100, 500)
      }))
    },
    artifacts: selectedArtifacts,
    media: selectedArtifacts.filter((artifact) => artifact.kind === "visual-evidence").map(({ id, name, stepId, path }) => ({ id, name, stepId, path })),
    canonicalDiff: {
      reference: diff.reference || diff.path || null,
      files,
      omittedFiles: Math.max(0, (diff.files?.length || 0) - files.length),
      stat: clip(diff.stat, 4_000),
      patch: clip(diff.patch || "No textual diff", 60_000)
    },
    proofMap: compactProofMap(proofMap),
    checks: {
      status: String(checks.status || "unknown"),
      command: clip(checks.command, 1_000),
      summary: clip(checks.summary, 2_000),
      output: clip(checks.output, 12_000),
      durationMs: Number.isFinite(checks.durationMs) ? checks.durationMs : null,
      evidence: (Array.isArray(checks.evidence) ? checks.evidence : []).slice(0, 20).map((item) => ({
        name: clip(item?.name, 300),
        path: clip(item?.path, 1_000)
      }))
    }
  };
}
