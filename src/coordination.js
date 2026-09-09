import { randomUUID } from "node:crypto";
import { frozenRoots, parseWriteScopeEntry } from "./access-policy.js";
import { dependencySteps, findNode, flattenSteps, normalizeEditedPlan, planReviewViolations } from "./plan.js";
import { initializeProofMap, invalidateProof } from "./proof-map.js";
import { inFlightStepStatusSet } from "./run-status.js";

const append = (records, record) => {
  if (records.length >= 1000) throw new Error("Coordination history limit reached; start a new run");
  records.push(record);
};
const at = () => new Date().toISOString();
const requiredText = (value, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > 12000) throw new Error(`${name} must contain 1–12000 characters`);
  return value.trim();
};
const ids = (value = []) => {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !id)) throw new Error("Step and conflict IDs must be string arrays");
  return [...new Set(value)];
};

export function ensureCoordination(run) {
  run.planRevision ||= 1;
  run.coordination ||= {};
  for (const key of ["messages", "conflicts", "decisions", "revisions"]) run.coordination[key] ||= [];
  return run.coordination;
}

export function affectedStepIds(plan, initial) {
  const affected = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of flattenSteps(plan)) {
      if (!affected.has(step.id) && dependencySteps(plan, step).some((dependency) => affected.has(dependency.id))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return [...affected];
}

export function coordinationBlockedStepIds(run) {
  const ledger = run.coordination;
  return affectedStepIds(run.plan, [
    ...(ledger?.conflicts || []).filter((item) => item.status === "open").flatMap((item) => item.stepIds),
    ...(ledger?.revisions || []).filter((item) => item.status === "proposed").flatMap((item) => item.affectedStepIds)
  ]);
}

function knownSteps(run, values) {
  const result = ids(values);
  for (const id of result) if (findNode(run.plan, id)?.type !== "step") throw new Error(`Unknown step: ${id}`);
  return result;
}

export function reportConflict(run, { summary, stepIds, proposal = "", author = "operator", attemptId = null } = {}) {
  const record = { id: `conflict-${randomUUID()}`, summary: requiredText(summary, "Conflict summary"), proposal: proposal === "" ? "" : requiredText(proposal, "Conflict proposal"), stepIds: knownSteps(run, stepIds), author, attemptId, status: "open", createdAt: at(), planRevision: run.planRevision || 1 };
  if (!record.stepIds.length) throw new Error("A conflict must identify affected steps");
  append(ensureCoordination(run).conflicts, record);
  return record;
}

export function recordCoordinationDecision(run, { summary, reason = summary, stepIds = [], conflictIds = [], author = "operator", revisionId = null } = {}) {
  const ledger = ensureCoordination(run);
  const selected = ids(conflictIds);
  for (const id of selected) if (!ledger.conflicts.some((item) => item.id === id && item.status === "open")) throw new Error(`Open conflict not found: ${id}`);
  const record = { id: `decision-${randomUUID()}`, summary: requiredText(summary, "Decision summary"), reason: requiredText(reason, "Decision rationale"), stepIds: knownSteps(run, stepIds), conflictIds: selected, author, revisionId, planRevision: run.planRevision, createdAt: at() };
  append(ledger.decisions, record);
  for (const conflict of ledger.conflicts.filter((item) => selected.includes(item.id))) Object.assign(conflict, { status: "resolved", decisionId: record.id, resolvedAt: record.createdAt });
  return record;
}

function validateScope(run, step) {
  if (step.permission !== "write") return;
  for (const raw of String(step.writeScope || "").split(",").filter((value) => value.trim())) {
    if (raw.includes("\\") || raw.includes("\0") || raw.split(/[/:]/).includes("..")) throw new Error("Write scope must not contain traversal or malformed paths");
    const entry = parseWriteScopeEntry(raw);
    if (!run.access) continue;
    const roots = frozenRoots(run.access);
    const root = entry.kind === "root" ? roots.find((item) => item.id === entry.rootId)
      : roots.filter((item) => entry.path === item.path || entry.path.startsWith(`${item.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (root?.mode === "read-only" || (!root && !(entry.kind === "absolute" && run.access.mode === "any"))) throw new Error("Write scope exceeds frozen writable roots");
  }
}

const editable = new Set(["stepId", "title", "description", "agentId", "writeScope", "dependsOn"]);
function revisedPlan(run, changes, addSteps, correctiveStepIds) {
  const plan = structuredClone(run.plan);
  if (!plan) throw new Error("An implementation plan is required");
  if (!Array.isArray(changes) || !Array.isArray(addSteps) || changes.length > 100 || addSteps.length > 100 || (!changes.length && !addSteps.length)) throw new Error("A revision must change or add steps");
  const touched = new Set();
  for (const change of changes) {
    if (!change || typeof change !== "object" || Object.keys(change).some((key) => !editable.has(key))) throw new Error("Unsupported plan revision field");
    const step = findNode(plan, change.stepId);
    if (!step || step.type !== "step") throw new Error(`Unknown step: ${change.stepId}`);
    if (touched.has(step.id)) throw new Error(`Duplicate step change: ${step.id}`);
    if (step.status === "accepted") throw new Error("Accepted steps are immutable; add a dependent corrective step instead");
    touched.add(step.id);
    for (const [key, value] of Object.entries(change)) {
      if (key === "stepId") continue;
      if (key === "dependsOn") step[key] = ids(value);
      else if (["description", "writeScope"].includes(key) && value === "") step[key] = "";
      else step[key] = requiredText(value, key);
    }
  }
  const corrected = knownSteps(run, correctiveStepIds);
  for (const id of corrected) {
    if (findNode(run.plan, id).status !== "accepted") throw new Error("Corrective steps must identify accepted work");
    if (!addSteps.some((step) => step.dependsOn?.includes(id))) throw new Error(`Correction must add a step depending on ${id}`);
  }
  const known = new Set([...(plan.nodes || []).map((node) => node.id), ...flattenSteps(plan).map((step) => step.id)]);
  for (const raw of addSteps) {
    if (!raw || typeof raw !== "object" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id || "") || known.has(raw.id)) throw new Error("New step IDs must be unique lowercase words separated by hyphens");
    if (raw.children || (raw.type && raw.type !== "step")) throw new Error("Revisions add individual steps only");
    if (["status", "attempts", "artifacts", "diff", "sessionFile", "vcsChange", "attachments", "supervisorReview", "lastError"].some((key) => key in raw)) throw new Error("New steps cannot supply execution state");
    known.add(raw.id);
    touched.add(raw.id);
    plan.nodes.push(structuredClone(raw));
  }
  const normalized = normalizeEditedPlan(plan);
  for (const id of touched) validateScope(run, findNode(normalized, id));
  const violations = planReviewViolations({ nodes: addSteps.map((step) => findNode(normalized, step.id)) });
  if (violations.length) throw new Error(violations.join("\n"));
  // Use normalization for new assignments only: existing steps carry runtime fields it deliberately omits.
  for (const raw of addSteps) plan.nodes[plan.nodes.findIndex((step) => step.id === raw.id)] = findNode(normalized, raw.id);
  const affected = affectedStepIds(plan, [...touched]);
  if (affected.some((id) => findNode(run.plan, id)?.status === "accepted")) throw new Error("This revision would invalidate accepted dependent work; add corrective steps instead");
  return { plan, affected, corrected };
}

export function proposePlanRevision(run, { reason, changes = [], addSteps = [], correctiveStepIds = [], conflictIds = [], author = "operator" } = {}) {
  const rationale = requiredText(reason, "Revision reason");
  const { plan, affected, corrected } = revisedPlan(run, changes, addSteps, correctiveStepIds);
  const ledger = ensureCoordination(run);
  const conflicts = ids(conflictIds);
  for (const id of conflicts) if (!ledger.conflicts.some((item) => item.id === id && item.status === "open")) throw new Error(`Open conflict not found: ${id}`);
  const revision = { id: `revision-${randomUUID()}`, status: "proposed", baseRevision: run.planRevision, reason: rationale, author, changes: structuredClone(changes), addSteps: structuredClone(addSteps), correctiveStepIds: corrected, conflictIds: conflicts, affectedStepIds: affected, before: structuredClone(run.plan), after: plan, createdAt: at() };
  append(ledger.revisions, revision);
  return revision;
}

export function acceptPlanRevision(run, revisionId, { author = "operator" } = {}) {
  if (author !== "operator") throw new Error("Plan revisions require operator approval");
  const ledger = ensureCoordination(run);
  const revision = ledger.revisions.find((item) => item.id === revisionId);
  if (revision?.status !== "proposed") throw new Error("Pending revision not found");
  if (revision.baseRevision !== run.planRevision) throw new Error("Plan revision is stale; propose it again against the current plan");
  const { plan, affected, corrected } = revisedPlan(run, revision.changes, revision.addSteps, revision.correctiveStepIds);
  for (const id of revision.conflictIds) if (!ledger.conflicts.some((item) => item.id === id && item.status === "open")) throw new Error(`Open conflict not found: ${id}`);
  for (const id of affected) {
    const step = findNode(run.plan, id);
    if (run.activeRuns?.[id] || inFlightStepStatusSet.has(step?.status) || step?.activeAttempt?.status === "active") throw new Error(`Stop affected worker before applying revision: ${id}`);
  }
  if (ledger.decisions.length >= 1000) throw new Error("Coordination history limit reached; start a new run");
  const decidedAt = at();
  const beforeWork = affected.map((id) => findNode(run.plan, id)).filter(Boolean).map((step) => structuredClone(step));
  for (const id of affected) {
    const step = findNode(plan, id);
    step.status = "ready";
    step.prompt = "";
    step.planRevision = run.planRevision + 1;
    step.coordinationRestart = true;
    for (const key of ["workspace", "baseTree", "baseTrees", "baseProofRoots", "pendingVerification", "diff", "checks", "verification", "vcsChange", "workspaceCommit", "workspaceCommits", "repositoryVcs", "repositoryDiffs", "acceptedRepositories", "reviewMap", "reviewNotes", "reviewNotesArtifact", "reviewBudgetResult", "commit", "commitMessage", "acceptedAt", "verificationWaivers"]) delete step[key];
    step.sessionFile = null;
    step.supervisorReview = null;
    step.lastError = null;
    if (step.activeAttempt) step.activeAttempt = { ...step.activeAttempt, status: "superseded", supersededAt: decidedAt };
  }
  const invalid = new Set([...affected, ...corrected]);
  if (run.proofMap) {
    const known = new Set(run.proofMap.criteria.map((criterion) => criterion.id));
    const added = initializeProofMap(plan, { approvedAt: decidedAt }).criteria.filter((criterion) => !known.has(criterion.id));
    run.proofMap = { ...run.proofMap, criteria: [...run.proofMap.criteria, ...added] };
  } else run.proofMap = initializeProofMap(plan, { approvedAt: decidedAt });
  if (run.proofMap) run.proofMap = invalidateProof(run.proofMap, (run.proofMap.criteria || []).filter((item) => invalid.has(item.stepId)).map((item) => item.id), { invalidatedAt: decidedAt, reason: revision.reason });
  run.plan = plan;
  run.planRevision++;
  for (const pending of ledger.revisions) {
    if (pending.id !== revisionId && pending.status === "proposed" && pending.baseRevision < run.planRevision) Object.assign(pending, { status: "superseded", decidedAt, supersededBy: revisionId });
  }
  Object.assign(revision, { status: "accepted", revision: run.planRevision, decidedAt, decidedBy: author, beforeWork, disposition: "restart" });
  recordCoordinationDecision(run, { summary: revision.reason, stepIds: [...affected, ...corrected], conflictIds: revision.conflictIds, author, revisionId });
  return revision;
}

export function rejectPlanRevision(run, revisionId, { reason, author = "operator" } = {}) {
  const revision = ensureCoordination(run).revisions.find((item) => item.id === revisionId);
  if (revision?.status !== "proposed") throw new Error("Pending revision not found");
  Object.assign(revision, { status: "rejected", rejectionReason: requiredText(reason, "Rejection reason"), decidedAt: at(), decidedBy: author });
  return revision;
}

function scopeEntries(scope) {
  return String(scope || "").split(",").map(parseWriteScopeEntry).filter(Boolean).map((entry) => {
    const path = entry.path ?? entry.relativePath;
    // ponytail: unknown glob suffixes reserve their parent directory; use glob intersection only if this limits concurrency.
    const prefix = /[*?[{]/.test(path) ? path.slice(0, path.search(/[*?[{]/)).replace(/[^/]*$/, "").replace(/\/$/, "") : path.replace(/\/$/, "");
    return { ...entry, prefix: prefix === "." ? "" : prefix };
  });
}

export function writeScopesOverlap(left, right) {
  return scopeEntries(left).some((a) => scopeEntries(right).some((b) => {
    if (a.kind !== b.kind) return true; // Absolute scopes may alias a repository-qualified scope.
    if (a.kind === "root" && a.rootId !== b.rootId) return false;
    return !a.prefix || !b.prefix || a.prefix === b.prefix || a.prefix.startsWith(`${b.prefix}/`) || b.prefix.startsWith(`${a.prefix}/`);
  }));
}
