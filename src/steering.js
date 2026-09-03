import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { findNode, flattenSteps } from "./plan.js";
import { terminalRunStatusSet } from "./run-status.js";

export const STEER_MAX_LENGTH = 4000;
export const STEER_MAX_CLAIM_ATTEMPTS = 3;
export const STEER_CLAIM_TTL_MS = 30_000;
export const steeringStates = Object.freeze(["queued", "claimed", "delivered", "acknowledged", "withheld", "failed"]);

const deliveryTerminalStates = new Set(["delivered", "acknowledged", "withheld", "failed"]);
const scopeExpansion = /\b(?:ignore|bypass|override|expand|exceed)\b[^.\n]{0,50}\b(?:scope|permission|instruction|approval|constraint)|\b(?:outside|beyond)\b[^.\n]{0,30}\b(?:scope|write scope)|\b(?:sudo|administrator|root access|deploy|publish|push to|merge to)\b/i;
const vagueInstruction = /^(?:fix|change|update|improve|handle|do|continue|try|make it work|address that|fix it|do that)[.!]?$/i;

function timestamp(value = Date.now()) {
  return typeof value === "string" ? value : new Date(value).toISOString();
}

function instructionText(value) {
  if (typeof value === "string") return value.trim();
  return typeof value?.instruction === "string" ? value.instruction.trim() : typeof value?.text === "string" ? value.text.trim() : "";
}

function event(record, type, at, detail = {}) {
  const item = { type, at: timestamp(at), ...detail };
  record.events ||= [];
  record.events.push(item);
  record.updatedAt = item.at;
  return record;
}

function normalizeScopePath(value) {
  const withoutGlob = String(value).trim().replace(/\/\*\*?$/, "");
  const normalized = posix.normalize(withoutGlob.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function mentionedFilePaths(text) {
  const patterns = [
    /(?:^|[\s("'`])((?:\/|\.{1,2}\/)[\w@+.-]+(?:\/[\w@+.-]+)*)(?=$|[\s,.;:!?)}\]"'`])/g,
    /(?:^|[\s("'`])((?:[\w@+.-]+\/)+[\w@+.-]+)(?=$|[\s,.;:!?)}\]"'`])/g,
    /(?:^|[\s("'`])((?:\.[\w@+-]+|[\w@+-][\w@+.-]*\.[a-z0-9]+|README(?:\.[\w.-]+)?|LICENSE(?:\.[\w.-]+)?|Makefile|Dockerfile|Containerfile|Procfile|Gemfile|Rakefile|Vagrantfile|Jenkinsfile))(?=$|[\s,.;:!?)}\]"'`])/gi
  ];
  return [...new Set(patterns.flatMap((pattern) => [...text.matchAll(pattern)]
    .map((match) => normalizeScopePath(match[1].replace(/\.$/, "")))))];
}

export function createSteeringLedger(raw = {}) {
  return {
    nextSequence: Math.max(1, Number(raw?.nextSequence) || 1),
    records: Array.isArray(raw?.records) ? raw.records : []
  };
}

export function ensureSteeringLedger(run) {
  run.steering = createSteeringLedger(run.steering);
  const highest = run.steering.records.reduce((maximum, record) => Math.max(maximum, Number(record.sequence) || 0), 0);
  run.steering.nextSequence = Math.max(run.steering.nextSequence, highest + 1);
  return run.steering;
}

export function validateSteeringInstruction(value, { step = null, maxLength = STEER_MAX_LENGTH } = {}) {
  const text = instructionText(value);
  if (!text) return { ok: false, disposition: "rejected", code: "instruction_required", reason: "A steering instruction is required." };
  if (text.length > maxLength) return { ok: false, disposition: "rejected", code: "instruction_too_long", reason: `A steering instruction cannot exceed ${maxLength} characters.` };
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { ok: false, disposition: "rejected", code: "malformed_instruction", reason: "The steering instruction contains unsupported control characters." };
  if (scopeExpansion.test(text)) return { ok: false, disposition: "escalated", code: "authority_expansion", reason: "The instruction appears to expand authority or approved scope." };

  const listActions = text.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)).length;
  const actionPattern = /\b(?:add|change|create|delete|fix|implement|remove|rename|replace|run|update|write)\b/gi;
  const actionCount = text.match(actionPattern)?.length || 0;
  const sentenceActions = text.split(/[.!?](?:\s+|$)/).filter((part) => /\b(?:add|change|create|delete|fix|implement|remove|rename|replace|run|update|write)\b/i.test(part));
  if (listActions > 1 || sentenceActions.length > 1 || actionCount > 1 || /\b(?:and then|then also|separately|in addition)\b/i.test(text)) {
    return { ok: false, disposition: "escalated", code: "multiple_actions", reason: "Steering accepts one focused correction at a time." };
  }
  if (text.length < 8 || vagueInstruction.test(text)) return { ok: false, disposition: "escalated", code: "ambiguous_instruction", reason: "The instruction is too ambiguous to deliver safely." };

  const approvedFiles = [...(step?.expectedFiles || []), ...String(step?.writeScope || "").split(",")]
    .map(normalizeScopePath).filter(Boolean);
  const mentionedPaths = mentionedFilePaths(text);
  if (step?.permission !== "write" && /\b(?:edit|write|modify|delete|create|rename|replace)\b/i.test(text)) {
    return { ok: false, disposition: "escalated", code: "permission_expansion", reason: "The instruction requests writes from a non-writing step." };
  }
  if (approvedFiles.length && mentionedPaths.some((path) => !approvedFiles.some((scope) => path === scope || path.startsWith(`${scope}/`)))) {
    return { ok: false, disposition: "escalated", code: "scope_expansion", reason: "The instruction names a path outside the approved step scope." };
  }
  return { ok: true, disposition: "accepted", code: null, reason: null, text };
}

export function activeAttemptForStep(step, activeRun = null) {
  const id = activeRun?.attemptId || step?.activeAttempt?.id || null;
  return id ? { id, ...(step?.activeAttempt || {}), ...(activeRun || {}) } : null;
}

export function resolveSteeringTarget(run, { stepId = null } = {}) {
  const permanentlyTerminal = new Set(["completed", "failed", "needs_attention", "cancelled"]);
  if (!run || permanentlyTerminal.has(run.status)) {
    return { ok: false, code: "target_not_active", terminal: true, reason: "This ticket run is terminal; start or resume the appropriate run before steering it." };
  }
  const paused = run.status === "paused";
  if (!paused && !["running", "fixing", "verifying", "reviewing"].includes(run.status)) {
    return { ok: false, code: "target_not_active", reason: "The ticket run has no active worker target." };
  }
  const activeEntries = paused
    ? flattenSteps(run.plan).filter((step) => step.status === "interrupted" && step.activeAttempt?.status === "interrupted" && (!stepId || step.id === stepId)).map((step) => [step.id, null])
    : Object.entries(run.activeRuns || {}).filter(([id, active]) => active && (!stepId || id === stepId));
  if (activeEntries.length !== 1) return { ok: false, code: activeEntries.length ? "ambiguous_target" : "target_not_active", reason: activeEntries.length ? "Select exactly one resumable step." : "The selected step is not active." };
  const [resolvedStepId, active] = activeEntries[0];
  const step = findNode(run.plan, resolvedStepId);
  const attempt = activeAttemptForStep(step, active);
  if (!step || !attempt?.id || (paused ? step.status !== "interrupted" : !["running", "fixing"].includes(step.status))) return { ok: false, code: "attempt_not_active", reason: "The active step has no durable logical attempt." };
  return { ok: true, target: { ticketId: run.id, runId: run.runId, stepId: resolvedStepId, attemptId: attempt.id }, paused };
}

export function submitSteering(run, value, { author = "operator", stepId = null, now = Date.now(), idFactory = randomUUID } = {}) {
  const target = resolveSteeringTarget(run, { stepId });
  if (!target.ok) return { accepted: false, ...target };
  const step = findNode(run.plan, target.target.stepId);
  const validation = validateSteeringInstruction(value, { step });
  if (validation.disposition === "rejected") return { accepted: false, ...validation };

  const ledger = ensureSteeringLedger(run);
  const at = timestamp(now);
  const state = validation.ok ? "queued" : "withheld";
  const record = {
    id: `steer-${idFactory()}`,
    instruction: instructionText(value),
    author: String(value?.author || author || "operator").trim() || "operator",
    ...target.target,
    sequence: ledger.nextSequence++,
    state,
    reason: validation.reason,
    reasonCode: validation.code,
    createdAt: at,
    updatedAt: at,
    claim: { attempts: 0, maxAttempts: STEER_MAX_CLAIM_ATTEMPTS, claimId: null, claimedAt: null, expiresAt: null },
    events: []
  };
  event(record, state === "queued" ? "accepted" : "withheld", at, validation.reason ? { reason: validation.reason, code: validation.code } : {});
  ledger.records.push(record);
  return { accepted: validation.ok, escalated: !validation.ok, paused: Boolean(target.paused), record, validation };
}

export function targetMatches(run, record) {
  if (!run || run.id !== record.ticketId || run.runId !== record.runId) return false;
  const step = findNode(run.plan, record.stepId);
  const active = run.activeRuns?.[record.stepId];
  return !terminalRunStatusSet.has(run.status)
    && ["running", "fixing"].includes(step?.status)
    && activeAttemptForStep(step, active)?.id === record.attemptId;
}

export function recoverSteeringClaims(run, { now = Date.now() } = {}) {
  const ledger = ensureSteeringLedger(run);
  const current = new Date(timestamp(now)).getTime();
  for (const record of ledger.records) {
    if (record.state !== "claimed" || !record.claim?.expiresAt || Date.parse(record.claim.expiresAt) > current) continue;
    if ((record.claim.attempts || 0) >= (record.claim.maxAttempts || STEER_MAX_CLAIM_ATTEMPTS)) {
      record.state = "failed";
      record.reasonCode = "claim_attempts_exhausted";
      record.reason = "Delivery claim retry limit was exhausted.";
      event(record, "failed", now, { reason: record.reason, code: record.reasonCode });
    } else {
      record.state = "queued";
      Object.assign(record.claim, { claimId: null, claimedAt: null, expiresAt: null });
      event(record, "claim_expired", now, { attempts: record.claim.attempts });
    }
  }
  return ledger.records;
}

export function claimNextSteering(run, target, { now = Date.now(), ttlMs = STEER_CLAIM_TTL_MS, idFactory = randomUUID } = {}) {
  recoverSteeringClaims(run, { now });
  const records = ensureSteeringLedger(run).records
    .filter((record) => record.runId === target.runId && record.stepId === target.stepId && record.attemptId === target.attemptId)
    .sort((left, right) => left.sequence - right.sequence);
  const firstPending = records.find((record) => !deliveryTerminalStates.has(record.state));
  if (!firstPending || firstPending.state !== "queued") return null;
  if (!targetMatches(run, firstPending)) {
    firstPending.state = "failed";
    firstPending.reasonCode = "target_replaced";
    firstPending.reason = "The bound worker attempt is no longer active.";
    event(firstPending, "failed", now, { reason: firstPending.reason, code: firstPending.reasonCode });
    return null;
  }
  firstPending.state = "claimed";
  firstPending.claim ||= { attempts: 0, maxAttempts: STEER_MAX_CLAIM_ATTEMPTS };
  firstPending.claim.attempts = (firstPending.claim.attempts || 0) + 1;
  firstPending.claim.claimId = `claim-${idFactory()}`;
  firstPending.claim.claimedAt = timestamp(now);
  firstPending.claim.expiresAt = timestamp(new Date(timestamp(now)).getTime() + ttlMs);
  event(firstPending, "claimed", now, { claimId: firstPending.claim.claimId, attempt: firstPending.claim.attempts });
  return firstPending;
}

export function releaseSteeringClaim(run, steerId, claimId, { now = Date.now(), reason = "Pi session was not active yet." } = {}) {
  const record = claimedRecord(run, steerId, claimId);
  if (!record) return null;
  // No session.steer() call was possible, so this is not an uncertain delivery retry.
  // Restore the claim budget before the same active attempt drains it at a safe boundary.
  record.state = "queued";
  record.claim.attempts = Math.max(0, (record.claim.attempts || 0) - 1);
  Object.assign(record.claim, { claimId: null, claimedAt: null, expiresAt: null });
  event(record, "session_unavailable", now, { reason });
  return record;
}

function claimedRecord(run, steerId, claimId) {
  const record = ensureSteeringLedger(run).records.find((item) => item.id === steerId);
  return record?.state === "claimed" && record.claim?.claimId === claimId ? record : null;
}

export function markSteeringDelivered(run, steerId, claimId, { now = Date.now(), evidence = null } = {}) {
  const record = claimedRecord(run, steerId, claimId);
  if (!record) return null;
  record.state = "delivered";
  record.deliveredAt = timestamp(now);
  record.deliveryEvidence = evidence;
  event(record, "delivered", now, evidence ? { evidence } : {});
  return record;
}

export function acknowledgeSteering(run, steerId, { now = Date.now(), evidence = null } = {}) {
  const record = ensureSteeringLedger(run).records.find((item) => item.id === steerId);
  if (!record || !["delivered", "acknowledged"].includes(record.state)) return null;
  record.state = "acknowledged";
  record.acknowledgedAt ||= timestamp(now);
  record.acknowledgmentEvidence ||= evidence;
  if (!record.events.some((item) => item.type === "acknowledged")) event(record, "acknowledged", now, evidence ? { evidence } : {});
  return record;
}

export function failSteering(run, steerId, { now = Date.now(), reason = "Steering delivery failed.", code = "delivery_failed" } = {}) {
  const record = ensureSteeringLedger(run).records.find((item) => item.id === steerId);
  if (!record || deliveryTerminalStates.has(record.state)) return null;
  record.state = "failed";
  record.reason = reason;
  record.reasonCode = code;
  event(record, "failed", now, { reason, code });
  return record;
}

export function beginStepAttempt(run, stepId, { workerRunId = randomUUID(), now = Date.now(), idFactory = randomUUID, resume = false } = {}) {
  const step = findNode(run.plan, stepId);
  if (!step) throw new Error("Step not found");
  const reusable = (resume || step.status === "interrupted") && step.activeAttempt?.id && step.activeAttempt.status === "interrupted";
  const attempt = reusable ? step.activeAttempt : { id: `attempt-${idFactory()}`, createdAt: timestamp(now) };
  Object.assign(attempt, { status: "active", startedAt: attempt.startedAt || timestamp(now), resumedAt: reusable ? timestamp(now) : null, workerRunId });
  step.activeAttempt = attempt;
  run.activeRuns ||= {};
  run.activeRuns[stepId] = { ...(run.activeRuns[stepId] || {}), runId: workerRunId, attemptId: attempt.id, startedAt: timestamp(now) };
  return attempt;
}

export function preserveAttemptMetadata(run, { now = Date.now() } = {}) {
  for (const step of flattenSteps(run?.plan)) {
    const active = run.activeRuns?.[step.id];
    const resumable = ["running", "fixing", "interrupted"].includes(step.status)
      && ["active", "interrupted"].includes(step.activeAttempt?.status);
    if (!active && !resumable) continue;
    const id = active?.attemptId || step.activeAttempt?.id || `legacy-attempt-${(step.attempts?.length || 0) + 1}`;
    step.activeAttempt = {
      ...(step.activeAttempt || {}), id, workerRunId: null, status: "interrupted",
      interruptedAt: step.activeAttempt?.interruptedAt || timestamp(now), startedAt: step.activeAttempt?.startedAt || active?.startedAt || null
    };
  }
  return run;
}
