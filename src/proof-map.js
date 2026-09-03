import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { flattenSteps } from "./plan.js";

export const proofStatuses = Object.freeze(["not_yet_verified", "verified", "failed", "blocked"]);
export const evidenceTypes = Object.freeze(["check", "artifact", "media", "diff"]);
const statusSet = new Set(proofStatuses);
const evidenceTypeSet = new Set(evidenceTypes);

function timestamp(value) {
  return value || new Date().toISOString();
}

function unresolved(at, reason = "No structured criterion result was reported.") {
  return { status: "not_yet_verified", explanation: { summary: reason }, evidence: [], evidenceValidity: "missing", reportedAt: at };
}

function normalizedStatus(status) {
  return status === "unresolved" ? "not_yet_verified" : status;
}

function readableArtifact(run, artifact, { requireCanonicalPath = false } = {}) {
  // Media is opened through a file endpoint, so inline content is not usable proof.
  // Old in-memory callers may still resolve non-media artifact content without a root.
  if (!artifact?.path) return !requireCanonicalPath && Boolean(artifact?.content);
  if (!run?.proofStorageRoot) return !requireCanonicalPath && Boolean(artifact?.path);
  try {
    const path = resolve(artifact.path);
    const root = `${resolve(run.proofStorageRoot)}${sep}`;
    if (!path.startsWith(root)) return false;
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch { return false; }
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

function attemptIn(run, stepId, attemptId) {
  const step = stepIn(run, stepId);
  return step?.attempts?.find((attempt) => attempt.attemptId === attemptId)
    || [...(run?.archivedAttempts || [])].reverse().find((attempt) => attempt.stepId === stepId && attempt.attemptId === attemptId)
    || null;
}

function finalRecord(run, reviewId) {
  if (reviewId) return run?.finalCheckHistory?.[reviewId]
    || run?.reviews?.find((review) => review.reviewId === reviewId || `final-review-${review.round}` === reviewId)?.finalChecks
    || null;
  return run?.finalChecks || run?.checkpoint?.finalChecks || run?.merge?.checks || null;
}

function finalDiffRecord(run, reviewId) {
  if (reviewId) return run?.finalDiffHistory?.[reviewId]
    || run?.reviews?.find((review) => review.reviewId === reviewId || `final-review-${review.round}` === reviewId)?.diff
    || null;
  return run?.deliveredDiff || run?.integration?.diff || run?.reviews?.at(-1)?.diff || null;
}

function checkIn(run, locator) {
  if (locator.scope === "final") return finalRecord(run, locator.reviewId);
  const step = stepIn(run, locator.stepId);
  if (!step) return null;
  if (locator.scope === "attempt") return attemptChecks(attemptIn(run, locator.stepId, locator.attemptId));
  return [...(step.attempts || [])].reverse().map(attemptChecks).find(Boolean) || step.checks || null;
}

function canonicalLocator(raw, run) {
  if (!raw || typeof raw !== "object" || !evidenceTypeSet.has(raw.type)) return null;
  if (raw.type === "artifact" || raw.type === "media") {
    return typeof raw.artifactId === "string" && raw.artifactId
      ? { type: raw.type, artifactId: raw.artifactId }
      : { type: raw.type };
  }

  const scope = raw.scope === undefined ? (raw.attemptId ? "attempt" : "step") : raw.scope;
  if (!["step", "attempt", "final"].includes(scope)) return { type: raw.type };
  if (scope === "final") {
    // A review ID promises an immutable record. Legacy/current final checks without
    // a migrated history record remain deliberately unversioned and use the final
    // checkpoint instead of being bound to a merely similarly numbered review.
    const reviewId = typeof raw.reviewId === "string" && raw.reviewId
      ? raw.reviewId
      : Object.keys(run?.finalCheckHistory || {}).at(-1) || null;
    return { type: raw.type, scope, ...(reviewId ? { reviewId } : {}) };
  }
  if (typeof raw.stepId !== "string" || !raw.stepId) return { type: raw.type, scope };
  if (scope === "attempt") {
    return typeof raw.attemptId === "string" && raw.attemptId
      ? { type: raw.type, scope, stepId: raw.stepId, attemptId: raw.attemptId }
      : { type: raw.type, scope, stepId: raw.stepId };
  }
  // A step-level reference is only author shorthand. Persist the concrete attempt
  // that supplied the check/diff so later attempts cannot rewrite its meaning.
  const latest = [...(stepIn(run, raw.stepId)?.attempts || [])].reverse().find((attempt) => raw.type === "check" ? attemptChecks(attempt) : attempt?.diff);
  return latest?.attemptId
    ? { type: raw.type, scope: "attempt", stepId: raw.stepId, attemptId: latest.attemptId }
    : { type: raw.type, scope, stepId: raw.stepId };
}

/** Resolve a typed locator to canonical evidence already owned by this run. */
export function resolveEvidence(run, raw) {
  const locator = canonicalLocator(raw, run);
  if (!locator) return { valid: false, reason: "unsupported_locator" };
  if (raw.type === "artifact" || raw.type === "media") {
    if (!locator.artifactId) return { valid: false, reason: "malformed_locator", locator };
    const artifact = artifactsIn(run).find((item) => item.id === locator.artifactId);
    if (!artifact || (raw.type === "media" && artifact.kind !== "visual-evidence") || !readableArtifact(run, artifact, { requireCanonicalPath: raw.type === "media" })) return { valid: false, reason: "missing_evidence", locator };
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
    ? attemptIn(run, locator.stepId, locator.attemptId)?.diff
    : locator.scope === "final" ? finalDiffRecord(run, locator.reviewId) : step?.diff;
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
function locatorIdentity(locator) {
  if (!locator) return "";
  const { type, scope, stepId, attemptId, reviewId, artifactId } = locator;
  return JSON.stringify({ type, scope, stepId, attemptId, reviewId, artifactId });
}

function evidenceProducedAt(run, locator) {
  if (locator?.artifactId) return artifactsIn(run).find((artifact) => artifact.id === locator.artifactId)?.createdAt || null;
  if (locator?.scope === "attempt") {
    const attempt = attemptIn(run, locator.stepId, locator.attemptId);
    return attempt?.completedAt || attempt?.startedAt || null;
  }
  if (locator?.scope === "final") return run?.finalReviewHistory?.[locator.reviewId]?.createdAt
    || run?.reviews?.find((review) => review.reviewId === locator.reviewId || `final-review-${review.round}` === locator.reviewId)?.createdAt
    || null;
  return null;
}

export function normalizeProofResult(raw, run, { reportedAt, staleEvidence = [], invalidatedAt = null } = {}) {
  const at = timestamp(reportedAt);
  const status = normalizedStatus(raw?.status);
  if (!raw || typeof raw !== "object" || !statusSet.has(status)) return unresolved(at, "The criterion report was malformed.");
  const explanation = explanationFor(raw);
  if (["failed", "blocked"].includes(status) && !explanation) return unresolved(at, `The ${status} result lacked a structured explanation.`);
  const staleLocators = new Set(staleEvidence.map((item) => locatorIdentity(canonicalLocator(item, run))));
  const invalidatedAtMs = Date.parse(invalidatedAt || "");
  const resolved = (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => {
    const result = resolveEvidence(run, item);
    const producedAt = evidenceProducedAt(run, result.locator);
    const producedAtMs = Date.parse(producedAt || "");
    // Locator identities and immutable production times bind a result to fresh
    // evidence, rather than allowing an invalidated artifact to be resubmitted.
    const invalidationActive = Number.isFinite(invalidatedAtMs);
    // Once invalidated, evidence must prove it was produced afterwards. An absent
    // timestamp is not a freshness claim: accepting it would let old, differently
    // named evidence bypass the invalidation lifecycle.
    const stale = staleLocators.has(locatorIdentity(result.locator))
      || (invalidationActive && (!Number.isFinite(producedAtMs) || producedAtMs <= invalidatedAtMs));
    return stale ? { ...result, producedAt, valid: false, reason: "stale_evidence" } : { ...result, producedAt };
  });
  if (status === "verified" && !resolved.some((item) => item.valid)) {
    return { ...unresolved(at, "Verified was claimed without fresh resolvable run evidence."), evidence: resolved.map((item) => ({ ...item.locator, validity: "missing", reason: item.reason })) };
  }
  return {
    status,
    explanation: explanation || { summary: status === "verified" ? "Criterion verified." : "No result yet." },
    evidence: resolved.map((item) => ({ ...item.locator, validity: item.valid ? "valid" : "missing", ...(item.reason ? { reason: item.reason } : {}), ...(item.producedAt ? { producedAt: item.producedAt } : {}) })), 
    evidenceValidity: status === "verified" ? "valid" : resolved.some((item) => item.valid) ? "valid" : "missing",
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
    if (criterion.current?.status === "unresolved") criterion.current.status = "not_yet_verified";
    const matches = grouped.get(criterion.id);
    if (!matches) continue;
    const invalidation = criterion.invalidation;
    const current = matches.length === 1
      ? normalizeProofResult(matches[0], run, {
          reportedAt: at,
          // Invalidation outlives the replaceable current result. Otherwise one
          // rejected stale report would erase the constraint for its next retry.
          staleEvidence: invalidation?.evidence || (criterion.current?.evidenceValidity === "stale" ? criterion.current.evidence || [] : []),
          invalidatedAt: invalidation?.at || (criterion.current?.evidenceValidity === "stale" ? criterion.current.invalidatedAt : null)
        })
      : unresolved(at, "Conflicting criterion reports were supplied.");
    if (!sameResult(criterion.current, current)) criterion.history.push(criterion.current);
    criterion.current = current;
    if (current.status === "verified" && current.evidenceValidity === "valid") delete criterion.invalidation;
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
    // Keep the invalidated identities beside current so repeated rejected reports
    // cannot make them fresh simply by replacing the stale current result.
    criterion.invalidation = { at, evidence: structuredClone(criterion.current?.evidence || []) };
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
function projectedResult(run, result) {
  const projected = { ...result, status: normalizedStatus(result?.status) };
  if (!projected.evidence?.length) return projected;
  const validity = projected.evidence.map((item) => resolveEvidence(run, item));
  projected.evidence = projected.evidence.map((item, index) => ({ ...item, validity: validity[index].valid ? "valid" : "missing", ...(validity[index].reason ? { reason: validity[index].reason } : {}) }));
  // Staleness records a lifecycle decision; missing locators only disable their
  // controls and must not rewrite that audit state into an apparently fresh result.
  if (projected.status === "verified" && projected.evidenceValidity !== "stale") projected.evidenceValidity = validity.some((item) => item.valid) ? "valid" : "missing";
  return projected;
}

export function projectProofMap(run) {
  const stored = run?.proofMap;
  const compatibility = !stored || !Array.isArray(stored.criteria);
  const proof = compatibility ? initializeProofMap(run?.plan || { nodes: [] }, { approvedAt: run?.planApprovedAt || run?.createdAt }) : structuredClone(stored);
  const criteria = (proof.criteria || []).map((criterion) => {
    const current = projectedResult(run, criterion.current || {});
    return { ...criterion, current, history: (criterion.history || []).map((item) => projectedResult(run, item)) };
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
  // Compatibility runs retain their historical human gates. The unresolved display
  // is informative, while this effective eligibility is the one every client uses.
  return { ...projected, eligibility: compatibility ? { eligible: true, blockingReasons: [] } : proofEligibility(projected) };
}
