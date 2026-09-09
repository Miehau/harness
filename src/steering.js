import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { findNode, flattenSteps } from "./plan.js";
import { setStage, terminalRunStatusSet } from "./run-status.js";

export function steeringResponse(record, { reason = null, nextCondition = null } = {}) {
  const target = record && { ticketId: record.ticketId, runId: record.runId, stepId: record.stepId, attemptId: record.attemptId };
  const state = record?.state || "rejected";
  const defaults = {
    queued: "The bound worker must be active before Pi delivery can begin.",
    claimed: "Wait for the current Pi delivery claim to settle or expire.",
    withheld: "Answer the steering checkpoint before changing scope or authority.",
    failed: "Inspect the delivery audit and submit a new focused correction if appropriate.",
    delivered: "The worker can acknowledge the delivered correction in its report."
  };
  return { steerId: record?.id || null, target: target || null, state, reason: reason || record?.reason || null, nextCondition: nextCondition || defaults[state] || "No further steering action is required." };
}

export function appendSteeringRejection(run, input, outcome) {
  run.steeringRejections ||= [];
  run.steeringRejections.push({
    id: `steer-rejection-${randomUUID()}`,
    instruction: String(input.instruction ?? input.text ?? "").trim(),
    author: String(input.author || "operator").trim() || "operator",
    code: outcome.code || outcome.validation?.code || "rejected",
    reason: outcome.reason || outcome.validation?.reason || "The steering request was rejected.",
    createdAt: new Date().toISOString()
  });
  if (run.steeringRejections.length > 50) run.steeringRejections.splice(0, run.steeringRejections.length - 50);
  return run.steeringRejections.at(-1);
}

export function steeringCheckpointPending(run) {
  return run?.status === "awaiting_input" && run.checkpoint?.source === "steering" && run.checkpoint.kind === "needs_input";
}

export const STEER_MAX_LENGTH = 4000;
export const STEER_MAX_CLAIM_ATTEMPTS = 3;
export const STEER_CLAIM_TTL_MS = 30_000;
export const steeringStates = Object.freeze(["queued", "claimed", "delivered", "acknowledged", "withheld", "failed"]);

const deliveryTerminalStates = new Set(["delivered", "acknowledged", "withheld", "failed"]);
const scopeExpansion = /\b(?:ignore|bypass|override|expand|exceed)\b[^.\n]{0,50}\b(?:scope|permission|instruction|approval|constraint)|\b(?:outside|beyond)\b[^.\n]{0,30}\b(?:scope|write scope)|\b(?:sudo|administrator|root access|deploy|publish|push to|merge to)\b/i;
const vagueInstruction = /^(?:fix|change|update|improve|handle|do|continue|try|make it work|address that|fix it|do that)[.!]?$/i;
const broadScopeExpansion = /\b(?:refactor|rewrite|rework|migrate|overhaul|modify|change)\b[^.\n]{0,80}\b(?:every|all|entire|whole)\b[^.\n]{0,80}\b(?:repository|repo|codebase|project|module|modules|system)\b|\b(?:across|throughout)\b[^.\n]{0,80}\b(?:repository|repo|codebase|project|all modules)\b/i;
const orderingPolarityConflict = /\b(?:reverse|invert)\b[^.\n]{0,160}\b(?:fifo|queue|order)\b/i;
const destructiveDirective = /\b(?:delete|disable|discard|drop|eliminate|remove|retire|reverse|invert)\b|\b(?:no\s+longer|without)\b/i;
// Steers are not an alternate planning channel. Strip only directive and syntax
// words, then require every remaining requested concept to be in an explicit,
// behavioral approval. This makes the safe path an allow-list derived from the
// plan, rather than a growing list of unsafe products, verbs, or architectures.
const correspondenceStopWords = new Set([
  "a", "an", "and", "all", "also", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "this", "that", "these", "those", "to", "with", "within",
  "add", "adjust", "allow", "build", "change", "convert", "correct", "create", "delete", "develop", "disable", "discard", "drop", "edit", "eliminate", "enable", "ensure", "establish", "expose", "fix", "implement", "improve", "introduce", "invert", "launch", "make", "migrate", "modify", "preserve", "provide", "redesign", "refactor", "remove", "rename", "replace", "retire", "reverse", "revise", "rework", "rewrite", "run", "support", "switch", "update", "use", "write",
  "approved", "code", "correction", "file", "focused", "implementation", "it", "longer", "new", "no", "safely", "source", "the", "without", "worker"
]);
const architectureReference = /\b(?:architecture|architectural)\b/i;

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

function approvedSteeringSources(step) {
  const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
  // Titles and IDs identify planning records but do not specify an approved
  // behavior. Delivery must instead trace to the detailed context or an explicit
  // requirement, capability, delta, or acceptance criterion.
  return [
    step?.description, step?.productContext, ...list(step?.acceptanceCriteria),
    ...list(step?.requirements), ...list(step?.capabilities), ...list(step?.deltas)
  ].filter(Boolean).map((value) => String(value));
}

function correspondenceTerms(text) {
  let withoutPaths = text.toLowerCase();
  for (const path of mentionedFilePaths(text)) withoutPaths = withoutPaths.replaceAll(path.toLowerCase(), " ");
  return [...new Set(withoutPaths.match(/[a-z0-9][a-z0-9-]*/g)?.filter((term) => term.length > 1 && !correspondenceStopWords.has(term)) || [])];
}

function approvedCorrespondence(requested, source) {
  if (requested.length < 2) return false;
  const terms = source.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || [];
  const positions = requested.map((term) => terms.indexOf(term));
  if (positions.some((position) => position < 0)) return false;
  // A bag of words assembled from unrelated criteria is not approval for a new
  // capability. Require the requested concepts to appear together in one approved
  // statement, with an ordered three-term behavior phrase where applicable.
  const span = Math.max(...positions) - Math.min(...positions) + 1;
  if (span > requested.length + 2) return false;
  if (requested.length < 3) return true;
  return requested.slice(0, -2).some((_, index) => {
    const phrase = requested.slice(index, index + 3);
    return terms.some((_, termIndex) => phrase.every((term, offset) => terms[termIndex + offset] === term));
  });
}

function sourceAuthorizesDestructiveChange(requested, source) {
  return source.split(/[.!?;]/).some((statement) =>
    destructiveDirective.test(statement) && approvedCorrespondence(requested, statement)
  );
}

function unapprovedChange(text, step, { mentionedPaths = [], approvedFiles = [] } = {}) {
  const requested = correspondenceTerms(text);
  // A scoped path identifies where to work, not what correction to make. The one
  // exception is the established CLI shorthand "focused correction": it is a
  // bounded edit only when it names an approved file. Pronoun-only directives
  // still create the normal needs-input checkpoint.
  if (!requested.length) {
    const focusedCorrection = /\bfocused\s+correction\b/i.test(text);
    const pathsAreApproved = mentionedPaths.length === 1 && approvedFiles.some((scope) =>
      mentionedPaths[0] === scope || mentionedPaths[0].startsWith(`${scope}/`)
    );
    if (focusedCorrection && pathsAreApproved) return null;
    return {
      code: "ambiguous_instruction",
      reason: "The instruction does not identify an approved behavior; clarify the concrete correction before delivery."
    };
  }
  if (requested.length < 2) {
    return {
      code: "ambiguous_instruction",
      reason: "The instruction does not identify enough approved behavior to be a concrete correction; clarify it before delivery."
    };
  }
  const matchingSources = approvedSteeringSources(step).filter((source) => approvedCorrespondence(requested, source));
  if (matchingSources.length) {
    // Approved behavior is protected by default. A destructive or polarity-changing
    // directive needs its own local approval, not merely a term overlap with the
    // behavior it would remove.
    if (destructiveDirective.test(text) && !matchingSources.some((source) => sourceAuthorizesDestructiveChange(requested, source))) {
      return {
        code: "conflicting_instruction",
        reason: "The instruction removes or reverses approved behavior without an explicit approved destructive change."
      };
    }
    return null;
  }
  return {
    code: architectureReference.test(text) ? "architecture_expansion" : "requirement_expansion",
    reason: "The instruction names behavior or architecture not approved for this step; clarify it as a plan change before delivery."
  };
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
  // An explicit path violation is more actionable than a generic capability term
  // (for example, package.json must remain a scope expansion, not a requirement one).
  if (approvedFiles.length && mentionedPaths.some((path) => !approvedFiles.some((scope) => path === scope || path.startsWith(`${scope}/`)))) {
    return { ok: false, disposition: "escalated", code: "scope_expansion", reason: "The instruction names a path outside the approved step scope." };
  }
  if (broadScopeExpansion.test(text)) {
    return { ok: false, disposition: "escalated", code: "scope_expansion", reason: "The instruction expands beyond one safely bounded step correction." };
  }
  if (orderingPolarityConflict.test(text)) {
    return { ok: false, disposition: "escalated", code: "conflicting_instruction", reason: "The instruction conflicts with the approved FIFO steering order." };
  }
  const expansion = unapprovedChange(text, step, { mentionedPaths, approvedFiles });
  if (expansion) return { ok: false, disposition: "escalated", ...expansion };
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
  if (!paused && active?.piSessionState === "unavailable") {
    return { ok: false, code: "worker_unavailable", reason: "The bound worker session is no longer available; wait for its outcome or resume an interrupted attempt before steering." };
  }
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

export function createSteeringService({
  readState,
  update,
  runtime,
  harness,
  mirrorCheckpoint = async () => {}
}) {
  const runFor = (ticketId) => {
    const run = readState().ticketRuns?.[ticketId];
    if (!run) throw new Error("Ticket run not found");
    return run;
  };
  const keyFor = (target) => `${target.ticketId}\0${target.runId}\0${target.stepId}\0${target.attemptId}`;
  const clearDrain = (target) => {
    const key = keyFor(target);
    const timer = runtime.steeringDrainTimers.get(key);
    if (timer) clearTimeout(timer);
    runtime.steeringDrainTimers.delete(key);
  };

  async function deliver(ticketId, steerId) {
    if (typeof harness.steer !== "function") return runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
    let claim = null;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      const record = run?.steering?.records?.find((item) => item.id === steerId);
      if (record?.state === "queued") claim = claimNextSteering(run, record);
    });
    if (!claim) return runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
    let deliverable = false;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (!targetMatches(run, claim)) return failSteering(run, claim.id, { code: "target_replaced", reason: "The bound worker attempt changed before Pi accepted this correction." });
      deliverable = true;
    });
    if (!deliverable) return runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
    try {
      const evidence = await harness.steer({
        ticketId: claim.ticketId,
        runId: claim.runId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        steerId: claim.id,
        instruction: `[agent-plan-steer:${claim.id}]\n${claim.instruction}`
      });
      let delivered = null;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (!targetMatches(run, claim)) {
          failSteering(run, claim.id, { code: "target_replaced", reason: "The bound worker attempt changed before Pi accepted this correction." });
          return;
        }
        if (run.activeRuns?.[claim.stepId]?.piSessionState !== "active") {
          failSteering(run, claim.id, { code: "target_replaced", reason: "The bound Pi worker session ended before this correction could be recorded as delivered." });
          return;
        }
        delivered = markSteeringDelivered(run, claim.id, claim.claim.claimId, { evidence: evidence || { queuedBy: "pi" } });
      });
      if (delivered) await drain(ticketId, claim);
      return delivered || runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
    } catch (error) {
      if (error?.code === "steering_session_unavailable") {
        let requeued = null;
        await update((state) => {
          const run = state.ticketRuns[ticketId];
          if (run.activeRuns?.[claim.stepId]?.piSessionState === "starting" && targetMatches(run, claim)) requeued = releaseSteeringClaim(run, claim.id, claim.claim.claimId, { reason: error.message });
        });
        return requeued || runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
      }
      schedule(ticketId, claim);
      return runFor(ticketId).steering.records.find((record) => record.id === steerId) || null;
    }
  }

  async function drain(ticketId, target) {
    let next = null;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      recoverSteeringClaims(run);
      next = run.steering.records.find((record) => record.state === "queued" && record.runId === target.runId && record.stepId === target.stepId && record.attemptId === target.attemptId);
    });
    if (next) await deliver(ticketId, next.id);
    schedule(ticketId, target);
  }

  function schedule(ticketId, target) {
    clearDrain(target);
    const run = readState().ticketRuns?.[ticketId];
    const active = run?.activeRuns?.[target.stepId];
    if (active?.piSessionState !== "active" || !targetMatches(run, target)) return;
    const claim = run.steering?.records
      ?.filter((record) =>
        record.state === "claimed"
        && record.runId === target.runId
        && record.stepId === target.stepId
        && record.attemptId === target.attemptId
      )
      .sort((left, right) => left.sequence - right.sequence)[0];
    const expiresAt = Date.parse(claim?.claim?.expiresAt || "");
    if (!Number.isFinite(expiresAt)) return;
    const key = keyFor(target);
    const timer = setTimeout(() => {
      runtime.steeringDrainTimers.delete(key);
      (async () => {
        const current = readState().ticketRuns?.[ticketId];
        if (!targetMatches(current, target) || current.activeRuns?.[target.stepId]?.piSessionState !== "active") {
          await update((state) => {
            const run = state.ticketRuns[ticketId];
            for (const record of run?.steering?.records || []) {
              if (record.state !== "claimed"
                || record.runId !== target.runId
                || record.stepId !== target.stepId
                || record.attemptId !== target.attemptId) continue;
              failSteering(run, record.id, {
                code: "target_replaced",
                reason: "The bound worker attempt ended or was replaced before the delivery claim expired."
              });
            }
          });
          return;
        }
        await drain(ticketId, target);
      })().catch(() => {});
    }, Math.max(0, expiresAt - Date.now()) + 1);
    timer.unref?.();
    runtime.steeringDrainTimers.set(key, timer);
  }

  async function submit(ticketId, input) {
    let outcome;
    await update((state) => {
      const run = state.ticketRuns?.[ticketId];
      if (!run) throw new Error("Ticket run not found");
      outcome = submitSteering(run, input, {
        author: input.author || "operator",
        stepId: String(input.stepId || "").trim() || null
      });
      if (!outcome.record) appendSteeringRejection(run, input, outcome);
      if (outcome.escalated) {
        run.status = "awaiting_input";
        run.checkpoint = {
          id: randomUUID(),
          kind: "needs_input",
          title: "Steering requires clarification",
          prompt: outcome.validation.reason + "\n\nInstruction:\n" + outcome.record.instruction,
          questions: [outcome.validation.reason],
          stepId: outcome.record.stepId,
          source: "steering",
          steerId: outcome.record.id,
          createdAt: new Date().toISOString()
        };
        setStage(run, "implement", "blocked", outcome.validation.reason);
      }
    });
    if (!outcome.record) {
      return steeringResponse(null, {
        reason: outcome.reason || outcome.validation?.reason,
        nextCondition: outcome.terminal
          ? "Start a new run or resume a non-terminal run before submitting steering."
          : outcome.code === "worker_unavailable"
            ? "Wait for the worker outcome or resume its interrupted attempt before submitting steering."
            : "Submit one concrete, safely scoped correction to an active worker."
      });
    }
    if (outcome.escalated) {
      await mirrorCheckpoint(ticketId);
      return steeringResponse(outcome.record);
    }
    let record = outcome.record;
    if (!outcome.paused) {
      await deliver(ticketId, outcome.record.id);
      record = runFor(ticketId).steering.records.find((item) => item.id === outcome.record.id) || outcome.record;
    }
    return steeringResponse(record, outcome.paused
      ? { nextCondition: "Resume this paused run manually; the correction remains queued for its saved attempt." }
      : {});
  }

  return { clearDrain, schedule, drain, deliver, submit };
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
