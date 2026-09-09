import { diffOutline } from "./git.js";
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
    if (artifact.stepId && statuses.get(artifact.stepId) !== "accepted") return;
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
      ...(artifact.kind === "visual-evidence" ? { criterionIds: artifact.criterionIds || [], commands: artifact.commands || [], assertions: artifact.assertions || [], videoPath: artifact.videoPath || null } : { content: clip(artifact.content || artifact.summary, 4_000) })
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
        acceptanceCriteria: clippedStrings(step.acceptanceCriteria, 100, 500),
        requiresVisualEvidence: Boolean(step.requiresVisualEvidence || step.requiresVideoEvidence),
        requiresVideoEvidence: Boolean(step.requiresVideoEvidence)
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

// Full detail stays in immutable run-owned files. The initial prompt never grows
// with accumulated review history, patch size or attached image bytes.
export async function writeReviewIndex(directory, { ticket = {}, plan = {}, artifacts = [], diff = {}, checks = {}, proofMap = {}, focusFindings = [], operatorFeedback = "", currentStepId = null }) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const files = new Map();
  const put = (name, value) => { files.set(name, typeof value === "string" ? value : JSON.stringify(value, null, 2)); return name; };
  const criteria = (proofMap?.criteria || []).map(({ history, ...criterion }, index) => ({
    id: criterion.id, stepId: criterion.stepId, title: clip(criterion.text, 180), detail: put(`criterion-${index + 1}.json`, criterion)
  }));
  const latest = new Map();
  for (const artifact of artifacts) {
    if (!relevantArtifactKinds.has(artifact.kind)) continue;
    const step = flattenSteps(plan).find((step) => step.id === artifact.stepId);
    if (artifact.stepId && (!step || (step.status !== "accepted" && step.id !== currentStepId))) continue;
    latest.set(artifact.kind === "visual-evidence" ? artifact.id : `${artifact.kind}:${artifact.stepId || "run"}`, artifact);
  }
  const evidence = [...latest.values()].map((artifact, index) => ({
    id: artifact.id, kind: artifact.kind, stepId: artifact.stepId, name: artifact.name,
    detail: put(`artifact-${index + 1}.json`, artifact)
  }));
  const findings = focusFindings.map((finding, index) => ({
    id: `finding-${index + 1}`, claim: clip(finding.claim, 180), detail: put(`finding-${index + 1}.json`, finding)
  }));
  const groups = flattenSteps(plan).map((step, index) => ({
    id: step.id, title: clip(step.title, 180),
    detail: put(`behavior-${index + 1}.json`, {
      id: step.id, title: step.title, repositoryId: step.repositoryId || null, uiPlan: step.uiPlan || null, references: step.references || [], dependsOn: step.dependsOn || [],
      criteria: criteria.filter((criterion) => criterion.stepId === step.id),
      evidence: evidence.filter((artifact) => !artifact.stepId || artifact.stepId === step.id),
      expectedFiles: step.expectedFiles || [], acceptanceCriteria: step.acceptanceCriteria || []
    })
  }));
  const repositories = (diff.repositories?.length ? diff.repositories : [{ repositoryId: "primary", ...diff }]).map((repository, repositoryIndex) => {
    const { patch = "", ...metadata } = repository;
    const blocks = String(patch).split(/(?=^diff --git )/m).filter(Boolean);
    const outline = diffOutline(patch);
    return { ...metadata, patches: blocks.map((block, index) => ({
      file: outline[index]?.file || "Unstructured patch", hunks: outline[index]?.hunks || [], characters: block.length,
      detail: put(`repository-${repositoryIndex + 1}-file-${index + 1}.patch`, block)
    })) };
  });
  const index = {
    ticket: put("ticket.json", { id: ticket.id, identifier: ticket.identifier, title: ticket.title, description: ticket.description, scope: plan.summary }),
    revision: { before: diff.before || null, after: diff.after || null, reference: diff.reference || null },
    changes: put("changes.json", { files: diff.files || [], stat: diff.stat, repositories, error: diff.error || null, truncated: Boolean(diff.truncated || repositories.some((repository) => repository.truncated)), patch: put("changes.patch", diff.patch || "No textual diff") }),
    checks: put("checks.json", checks), constraints: put("constraints.md", operatorFeedback || "No additional operator constraints."),
    criteria, findings, groups, evidence
  };
  put("index.json", index);
  const digest = createHash("sha256").update(JSON.stringify([...files])).digest("hex");
  const root = join(directory, digest);
  await mkdir(root, { recursive: true });
  await Promise.all([...files].map(([name, content]) => writeFile(join(root, name), content, "utf8")));
  const summary = {
    index: join(root, "index.json"), revision: { before: clip(index.revision.before, 128), after: clip(index.revision.after, 128), reference: clip(index.revision.reference, 200) },
    ticket: clip(ticket.identifier || ticket.id, 100), title: clip(ticket.title, 300), scope: clip(plan.summary, 800),
    checks: { status: checks.status || "unknown", summary: clip(checks.summary, 500), detail: join(root, "checks.json") },
    constraints: join(root, "constraints.md"), changes: join(root, "changes.json"),
    counts: { criteria: criteria.length, unresolvedFindings: findings.length, behaviors: groups.length, evidence: evidence.length },
    // This is navigation, not a cutoff: the complete index retains every entry.
    behaviors: groups.slice(0, 8).map((group) => ({ ...group, id: clip(group.id, 200) })), criteria: criteria.slice(0, 8).map((criterion) => ({ ...criterion, id: clip(criterion.id, 200), stepId: clip(criterion.stepId, 200) })), findings: findings.slice(0, 4), evidence: evidence.slice(0, 6).map((artifact) => ({ ...artifact, name: clip(artifact.name, 180) })),
    more: "Read index.json for the complete inventory; detail paths are relative to its directory."
  };
  if (JSON.stringify(summary).length > 12000) Object.assign(summary, { behaviors: [], criteria: [], findings: [], evidence: [] });
  const textCharacters = JSON.stringify(summary).length;
  if (textCharacters > 12000) throw new Error("Review index metadata exceeds its 12000-character input budget");
  return { summary, root, digest, textCharacters };
}
