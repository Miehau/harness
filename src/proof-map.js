import { createHash } from "node:crypto";
import { flattenSteps } from "./plan.js";

export const proofStatuses = Object.freeze(["unresolved", "verified", "failed", "blocked"]);
export const evidenceTypes = Object.freeze(["check", "artifact", "media", "diff"]);
const statusSet = new Set(proofStatuses);
const evidenceTypeSet = new Set(evidenceTypes);

function timestamp(value) {
  return value || new Date().toISOString();
}

function unresolved(at, reason = "No structured criterion result was reported.") {
  return { status: "unresolved", explanation: { summary: reason }, evidence: [], evidenceValidity: "missing", reportedAt: at };
}

export function criterionId(stepId, index, text) {
  const digest = createHash("sha256").update(`${stepId}\0${index}\0${text}`).digest("hex").slice(0, 16);
  return `criterion-${digest}`;
}

function criterionSnapshots(plan) {
  return flattenSteps(plan).flatMap((step) => (step.acceptanceCriteria || []).map((value, index) => {
    const text = String(value).trim();
    return text ? {
      id: criterionId(step.id, index, text),
      stepId: step.id,
      stepTitle: String(step.title || ""),
      stepRequired: step.required !== false,
      index,
      text
    } : null;
  }).filter(Boolean));
}

export function initializeProofMap(plan, { approvedAt } = {}) {
  const at = timestamp(approvedAt);
  return {
    version: 1,
    approvedAt: at,
    criteria: criterionSnapshots(plan).map((identity) => ({ ...identity, current: unresolved(at), history: [] }))
  };
}

function artifactsIn(run) {
  return [
    ...(run?.artifacts || []),
    ...flattenSteps(run?.plan).flatMap((step) => step.artifacts || [])
  ];
}

function stepIn(run, id) {
  return flattenSteps(run?.plan).find((step) => step.id === id);
}

function attemptChecks(attempt) {
  return attempt?.verification?.checks || attempt?.checks || null;
}

function checkIn(run, locator) {
  if (locator.scope === "final") return run?.finalChecks || run?.checkpoint?.finalChecks || run?.merge?.checks || null;
  const step = stepIn(run, locator.stepId);
  if (!step) return null;
  if (locator.scope === "attempt") return attemptChecks(step.attempts?.find((attempt) => attempt.attemptId === locator.attemptId));
  return [...(step.attempts || [])].reverse().map(attemptChecks).find(Boolean) || step.checks || null;
}

function canonicalLocator(raw) {
  if (!raw || typeof raw !== "object" || !evidenceTypeSet.has(raw.type)) return null;
  if (raw.type === "artifact" || raw.type === "media") {
    return typeof raw.artifactId === "string" && raw.artifactId
      ? { type: raw.type, artifactId: raw.artifactId }
      : { type: raw.type };
  }

  const scope = raw.scope === undefined ? (raw.attemptId ? "attempt" : "step") : raw.scope;
  if (!["step", "attempt", "final"].includes(scope)) return { type: raw.type };
  if (scope === "final") return { type: raw.type, scope };
  if (typeof raw.stepId !== "string" || !raw.stepId) return { type: raw.type, scope };
  if (scope === "attempt") {
    return typeof raw.attemptId === "string" && raw.attemptId
      ? { type: raw.type, scope, stepId: raw.stepId, attemptId: raw.attemptId }
      : { type: raw.type, scope, stepId: raw.stepId };
  }
  return { type: raw.type, scope, stepId: raw.stepId };
}

/** Resolve a typed locator to canonical evidence already owned by this run. */
export function resolveEvidence(run, raw) {
  const locator = canonicalLocator(raw);
  if (!locator) return { valid: false, reason: "unsupported_locator" };
  if (raw.type === "artifact" || raw.type === "media") {
    if (!locator.artifactId) return { valid: false, reason: "malformed_locator", locator };
    const artifact = artifactsIn(run).find((item) => item.id === locator.artifactId);
    if (!artifact || (raw.type === "media" && artifact.kind !== "visual-evidence")) return { valid: false, reason: "missing_evidence", locator };
    return { valid: true, locator, target: { id: artifact.id, kind: artifact.kind, name: artifact.name || null, path: artifact.path || null } };
  }
  if (!locator.scope || (locator.scope !== "final" && !locator.stepId) || (locator.scope === "attempt" && !locator.attemptId)) {
    return { valid: false, reason: "malformed_locator", locator };
  }
  if (raw.type === "check") {
    const check = checkIn(run, locator);
    if (!check) return { valid: false, reason: "missing_evidence", locator };
    return { valid: check.status === "passed", reason: check.status === "passed" ? null : "check_not_passed", locator, target: { status: check.status, command: check.command || null, summary: check.summary || null } };
  }
  const step = stepIn(run, locator.stepId);
  const diff = locator.scope === "attempt"
    ? step?.attempts?.find((attempt) => attempt.attemptId === locator.attemptId)?.diff
    : locator.scope === "final" ? run?.deliveredDiff || run?.integration?.diff : step?.diff;
  if (!diff || diff.available === false) return { valid: false, reason: "missing_evidence", locator };
  return { valid: true, locator, target: { reference: diff.reference || diff.path || null, files: diff.files || [] } };
}

function explanationFor(raw) {
  if (!raw?.explanation || typeof raw.explanation !== "object" || Array.isArray(raw.explanation)) return null;
  const summary = String(raw.explanation.summary || "").trim();
  if (!summary) return null;
  const details = String(raw.explanation.details || "").trim();
  return { summary, ...(details ? { details } : {}) };
}

/** Normalize untrusted worker/verifier output. Invalid claims fail closed to unresolved. */
export function normalizeProofResult(raw, run, { reportedAt } = {}) {
  const at = timestamp(reportedAt);
  if (!raw || typeof raw !== "object" || !statusSet.has(raw.status)) return unresolved(at, "The criterion report was malformed.");
  const explanation = explanationFor(raw);
  if (["failed", "blocked"].includes(raw.status) && !explanation) return unresolved(at, `The ${raw.status} result lacked a structured explanation.`);
  const resolved = (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => resolveEvidence(run, item));
  if (raw.status === "verified" && !resolved.some((item) => item.valid)) {
    return { ...unresolved(at, "Verified was claimed without resolvable run evidence."), evidence: resolved.map((item) => ({ ...item.locator, validity: "missing", reason: item.reason })) };
  }
  return {
    status: raw.status,
    explanation: explanation || { summary: raw.status === "verified" ? "Criterion verified." : "No result yet." },
    evidence: resolved.map((item) => ({ ...item.locator, validity: item.valid ? "valid" : "missing", ...(item.reason ? { reason: item.reason } : {}) })),
    evidenceValidity: raw.status === "verified" ? "valid" : resolved.some((item) => item.valid) ? "valid" : "missing",
    reportedAt: at
  };
}

function sameResult(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Apply only explicit reports. Silence never rewrites existing proof. */
export function applyProofReports(map, reports, run, { criterionIds, reportedAt } = {}) {
  const expected = new Set(criterionIds || map?.criteria?.map((item) => item.id) || []);
  const grouped = new Map();
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || typeof report.criterionId !== "string" || !expected.has(report.criterionId)) continue;
    const matches = grouped.get(report.criterionId) || [];
    matches.push(report);
    grouped.set(report.criterionId, matches);
  }
  const at = timestamp(reportedAt);
  const next = structuredClone(map);
  for (const criterion of next.criteria || []) {
    const matches = grouped.get(criterion.id);
    if (!matches) continue;
    const current = matches.length === 1
      ? normalizeProofResult(matches[0], run, { reportedAt: at })
      : unresolved(at, "Conflicting criterion reports were supplied.");
    if (!sameResult(criterion.current, current)) criterion.history.push(criterion.current);
    criterion.current = current;
  }
  return next;
}

/** Mark only affected evidence stale while retaining status and locators for audit. */
export function invalidateProof(map, criterionIds, { invalidatedAt, reason = "Affected by a correction." } = {}) {
  const selected = new Set(criterionIds || []);
  const at = timestamp(invalidatedAt);
  const next = structuredClone(map);
  for (const criterion of next.criteria || []) {
    if (!selected.has(criterion.id)) continue;
    criterion.history.push(criterion.current);
    criterion.current = { ...criterion.current, evidenceValidity: "stale", invalidatedAt: at, invalidationReason: String(reason) };
  }
  return next;
}

function blockers(criteria) {
  return criteria.flatMap((criterion) => {
    const result = criterion.current;
    if (result.status !== "verified") return [{ criterionId: criterion.id, criterion: criterion.text, code: `status_${result.status}`, message: result.explanation?.summary || "Criterion is unresolved." }];
    if (result.evidenceValidity !== "valid") return [{ criterionId: criterion.id, criterion: criterion.text, code: `evidence_${result.evidenceValidity}`, message: "Criterion evidence is not currently valid." }];
    return [];
  });
}

export function proofEligibility(proof, { stepId = null, requiredOnly = false } = {}) {
  const criteria = (proof?.criteria || []).filter((criterion) =>
    (!stepId || criterion.stepId === stepId) && (!requiredOnly || criterion.stepRequired !== false)
  );
  const reasons = blockers(criteria);
  return { eligible: reasons.length === 0, blockingReasons: reasons };
}

/** Project stored proof, or a read-only unresolved map for legacy runs, without mutating the run. */
export function projectProofMap(run) {
  const stored = run?.proofMap;
  const compatibility = !stored || !Array.isArray(stored.criteria);
  const proof = compatibility ? initializeProofMap(run?.plan || { nodes: [] }, { approvedAt: run?.planApprovedAt || run?.createdAt }) : structuredClone(stored);
  const criteria = (proof.criteria || []).map((criterion) => {
    const current = { ...criterion.current };
    if (current.evidenceValidity !== "stale" && current.evidence?.length) {
      const validity = current.evidence.map((item) => resolveEvidence(run, item));
      current.evidence = current.evidence.map((item, index) => ({ ...item, validity: validity[index].valid ? "valid" : "missing", ...(validity[index].reason ? { reason: validity[index].reason } : {}) }));
      if (current.status === "verified") current.evidenceValidity = validity.some((item) => item.valid) ? "valid" : "missing";
    }
    return { ...criterion, current };
  });
  const projected = {
    version: proof.version || 1,
    approvedAt: proof.approvedAt || null,
    compatibility,
    criteria,
    legacy: compatibility ? {
      status: run?.status || null,
      reviews: structuredClone(run?.reviews || []),
      checkpoint: structuredClone(run?.checkpoint || null),
      finalChecks: structuredClone(run?.finalChecks || run?.checkpoint?.finalChecks || null)
    } : null
  };
  return { ...projected, eligibility: proofEligibility(projected) };
}
