import { dependencySteps, flattenSteps } from "./plan.js";
import { redactText } from "./redaction.js";
import { inFlightRunStatusSet, inFlightStepStatusSet } from "./run-status.js";

export const inspectionVersion = 1;

const failedStatuses = new Set(["failed", "needs_attention", "verification_failed"]);
const blockedStatuses = new Set(["blocked", "paused", "review_ready", "needs_input", "awaiting_approval"]);
const completeStatuses = new Set(["completed", "accepted", "verified"]);

function text(value, fallback = "") {
  const line = String(value || "").split(/\r?\n/).find((item) => item.trim()) || String(fallback || "");
  return redactText(line).trim().slice(0, 240);
}

function iso(...values) {
  return values.find((value) => value && Number.isFinite(Date.parse(value))) || null;
}

function elapsed(startedAt, completedAt, now) {
  if (!startedAt) return { startedAt: null, completedAt: completedAt || null, elapsedMs: null, running: false };
  const end = completedAt || new Date(now).toISOString();
  return {
    startedAt,
    completedAt: completedAt || null,
    elapsedMs: Math.max(0, Date.parse(end) - Date.parse(startedAt)),
    running: !completedAt
  };
}

function availability(available, absent = "not_recorded", extra = {}) {
  return { state: available ? "available" : absent, ...extra };
}

function checksFor(record) {
  return record?.verification?.checks || record?.checks || null;
}

function artifactsForAttempt(run, stepId, attemptId) {
  return (run.artifacts || []).filter((artifact) => artifact.stepId === stepId && (!attemptId || artifact.attemptId === attemptId));
}

function hasFinalVisualEvidence(run) {
  // A Verify artifact is not proof for a later review: only the evidence IDs
  // attached to the active gate can complete run-level visual evidence.
  const ids = new Set(run.checkpoint?.kind === "evidence_review"
    ? run.checkpoint.evidenceArtifactIds || []
    : run.finalEvidenceArtifactIds || []);
  return ids.size > 0 && (run.artifacts || []).some((artifact) => artifact.kind === "visual-evidence" && ids.has(artifact.id));
}

function checkpointForStep(checkpoint, step) {
  return Boolean(checkpoint?.stepId && checkpoint.stepId === step?.id);
}

function attemptEvidence(run, step, attempt, active = false) {
  const artifacts = artifactsForAttempt(run, step.id, attempt.attemptId);
  const checks = checksFor(attempt);
  const reportRequired = !active;
  const checksRequired = step.permission === "write" && !active;
  const approvalRequired = step.status === "accepted";
  const artifactRequired = (step.expectedArtifacts || []).length > 0 && !active;
  const visualRequired = Boolean(step.requiresVisualEvidence) && !active;
  const reportPresent = attempt.report?.status === "completed";
  const checksPresent = checksRequired ? checks?.status === "passed" : true;
  const approvalPresent = approvalRequired ? Boolean(step.acceptedAt) : true;
  const artifactPresent = artifactRequired ? artifacts.some((item) => item.kind === "agent-output") : true;
  // Final proof is produced by Verify for the whole run, rather than copied
  // into every accepted worker attempt.
  const visualPresent = visualRequired ? artifacts.some((item) => item.kind === "visual-evidence") || hasFinalVisualEvidence(run) : true;
  const missing = [
    reportRequired && !reportPresent ? "report" : null,
    checksRequired && !checksPresent ? "checks" : null,
    approvalRequired && !approvalPresent ? "approval" : null,
    artifactRequired && !artifactPresent ? "artifact" : null,
    visualRequired && !visualPresent ? "visual_evidence" : null
  ].filter(Boolean);
  return {
    state: active ? "collecting" : missing.length ? "incomplete" : "complete",
    report: reportRequired ? (reportPresent ? "present" : "missing") : "not_yet_required",
    checks: checksRequired ? (checksPresent ? "passed" : checks ? checks.status || "failed" : "missing") : "not_required",
    approval: approvalRequired ? (approvalPresent ? "present" : "missing") : "not_required",
    artifacts: artifactRequired ? (artifactPresent ? "present" : "missing") : "not_required",
    visualEvidence: visualRequired ? (visualPresent ? "present" : "missing") : "not_required",
    missing
  };
}

function blockerType({ run, stage, step, attempt, evidence }) {
  const values = [attempt?.error, step?.lastError, run?.lastError, stage?.summary, run?.checkpoint?.title, run?.checkpoint?.prompt]
    .filter(Boolean).join(" ").toLowerCase();
  const checks = checksFor(attempt) || run?.checkpoint?.finalChecks || run?.merge?.checks;
  if (attempt?.violations?.length || /outside (?:permission|write scope)|scope violation/.test(values)) return "scope";
  if (checks?.status === "failed" || evidence?.missing?.includes("final_checks") || /repository check|deterministic check|\btests? failed\b|\bci failed\b/.test(values)) return "repository-check";
  if (run?.checkpoint?.kind === "evidence_review" || evidence?.missing?.some((item) => ["visual_evidence", "handoff_artifact", "integration"].includes(item)) || /visual evidence|final proof/.test(values)) return "evidence";
  if (/preview|port bind|eaddrinuse/.test(values)) return "preview";
  if (run?.merge?.status === "failed" || /merge conflict|merge queue|rebas/.test(values)) return "merge";
  if (/provider|model request|rate limit|quota|authentication|api key|timeout/.test(values)) return "provider";
  if ([attempt?.status, step?.status, run?.status].includes("cancelled")) return "cancellation";
  if ([attempt?.status, step?.status, run?.status].some((status) => ["interrupted", "paused"].includes(status))) return "interruption";
  return "review";
}

function primaryBlocker({ run, stage = null, step = null, attempt = null, evidence = null }) {
  const status = attempt?.status || step?.status || stage?.status || run.status;
  const checkpointApplies = checkpointForStep(run.checkpoint, step);
  const blocked = failedStatuses.has(status) || blockedStatuses.has(status) || ["cancelled", "interrupted"].includes(status)
    || (checkpointApplies && ["needs_attention", "review_blocked", "evidence_review"].includes(run.checkpoint.kind));
  if (!blocked && evidence?.state !== "incomplete") return null;
  const summary = text(attempt?.error || step?.lastError || (checkpointApplies && (run.checkpoint.title || run.checkpoint.prompt)) || stage?.summary || run.lastError,
    evidence?.missing?.length ? `Missing required ${evidence.missing.join(", ")}` : "Review is required before work can continue");
  return {
    type: blockerType({ run, stage, step, attempt, evidence }),
    summary,
    source: attempt ? "attempt" : step ? "worker" : stage ? "stage" : "run"
  };
}

function lifecycle(status, evidence = null) {
  if (inFlightRunStatusSet.has(status) || inFlightStepStatusSet.has(status) || status === "active") return "active";
  if (["cancelled"].includes(status)) return "cancelled";
  if (["interrupted", "paused"].includes(status)) return "interrupted";
  if (failedStatuses.has(status)) return "failed";
  if (blockedStatuses.has(status)) return "blocked";
  if (completeStatuses.has(status)) return evidence?.state === "incomplete" ? "incomplete" : "completed";
  return "queued";
}

function nextAction(run, { stage, step } = {}) {
  const checkpoint = run.checkpoint;
  // Plan and requirements approval gates apply to the whole run, including
  // queued workers. Evidence review remains run-level without becoming every
  // worker's blocker or action.
  if (checkpoint && !checkpoint.stepId && ["requirements_review", "awaiting_approval"].includes(checkpoint.kind)) {
    return { kind: "approve", label: text(checkpoint.title, "Approve to continue") };
  }
  if (checkpoint && ((!step && !stage) || checkpointForStep(checkpoint, step))) {
    if (checkpoint.kind === "step_review") return { kind: "review_step", label: "Accept the step or request changes" };
    if (checkpoint.kind === "evidence_review") return { kind: "review_evidence", label: "Approve final proof or request changes" };
    if (["requirements_review", "awaiting_approval"].includes(checkpoint.kind)) return { kind: "approve", label: text(checkpoint.title, "Approve to continue") };
    return { kind: "respond", label: text(checkpoint.title, "Respond to continue") };
  }
  const status = step?.status || stage?.status || run.status;
  if (["failed", "needs_attention", "interrupted", "paused", "cancelled"].includes(status)) return { kind: "resume", label: "Resume or restart the interrupted work" };
  if (status === "review_ready") return { kind: "review_step", label: "Accept the step or request changes" };
  if (status === "ready") return { kind: "start", label: "Run when dependencies are complete" };
  if (lifecycle(status) === "active") return { kind: "wait", label: "Wait for the current activity" };
  return { kind: "none", label: "No action available" };
}

function attemptResources(run, step, attempt, active) {
  const artifacts = artifactsForAttempt(run, step.id, attempt.attemptId);
  const checks = checksFor(attempt);
  const diff = attempt.diff;
  const activityCount = (attempt.events?.length || 0) + (attempt.activityGroups?.length || attempt.activity?.groups?.length || 0);
  const observedActivity = activityCount || (attempt.activity?.lastEvent || attempt.lastEvent || attempt.activity?.lastEventAt || attempt.lastEventAt ? 1 : 0);
  // Snapshots retain the prompt independently of whether their worker is still
  // live, so resource availability must not regress when a run is restarted.
  const retainedPrompt = Boolean(attempt.prompt || attempt.prompts?.length || attempt.activity?.prompts?.length);
  return {
    prompt: availability(artifacts.some((item) => item.kind === "agent-prompt") || retainedPrompt, active ? "not_yet_available" : "not_retained"),
    activity: availability(observedActivity > 0, active ? "not_yet_available" : "not_retained", { count: observedActivity }),
    output: availability(Boolean(attempt.report || attempt.rawOutput || attempt.activity?.rawOutput) || artifacts.some((item) => item.kind === "agent-output"), active ? "not_yet_available" : "not_retained"),
    artifacts: availability(artifacts.length > 0, active ? "not_yet_available" : "not_recorded", { count: artifacts.length }),
    diff: availability(Boolean(diff?.available || diff?.files?.length || diff?.patch), step.permission === "write" ? (active ? "not_yet_available" : "not_recorded") : "not_applicable", { fileCount: diff?.files?.length || 0 }),
    checks: availability(Boolean(checks), step.permission === "write" ? (active ? "not_yet_available" : "not_recorded") : "not_applicable", { status: checks?.status || null }),
    trace: availability(Boolean(attempt.sessionFile), active ? "not_yet_available" : "not_retained")
  };
}

function projectAttempt(run, step, attempt, index, now, active = false) {
  const attemptId = attempt.attemptId || (active ? `active-${attempt.runId || "current"}` : `attempt-${index + 1}`);
  const saved = { ...attempt, attemptId };
  const evidence = attemptEvidence(run, step, saved, active);
  const status = active ? (step.status || "running") : (attempt.status || "unknown");
  const blocker = primaryBlocker({ run, step, attempt: saved, evidence });
  return {
    id: `attempt:${step.id}:${attemptId}`,
    attemptId,
    runId: attempt.runId || null,
    workerId: `worker:${step.id}`,
    stageId: `stage:${step.stageId || "implement"}`,
    status,
    lifecycle: active ? "active" : lifecycle(status, evidence),
    timing: elapsed(attempt.startedAt || attempt.activity?.startedAt, attempt.completedAt, now),
    latestAction: text(attempt.activity?.lastEvent || attempt.lastEvent || attempt.activityGroups?.at(-1)?.title || attempt.events?.at(-1)?.label, active ? "Worker started" : "Attempt recorded"),
    latestActionAt: iso(attempt.activity?.lastEventAt, attempt.lastEventAt, attempt.events?.at(-1)?.at, attempt.startedAt),
    terminationReason: text(attempt.termination?.reason || attempt.terminationReason) || null,
    terminationAt: iso(attempt.termination?.at, attempt.completedAt),
    failureKind: text(attempt.failure?.kind || attempt.failureKind) || null,
    failurePhase: text(attempt.failure?.phase || attempt.failurePhase) || null,
    evidence,
    blocker,
    resources: attemptResources(run, step, saved, active)
  };
}

function projectWorker(run, step, attempts) {
  const latest = attempts.at(-1) || null;
  const claimsCompletion = completeStatuses.has(step.status);
  const evidence = latest?.evidence || (claimsCompletion
    ? { state: "incomplete", missing: ["attempt"] }
    : { state: "not_started", missing: [] });
  const blocker = latest?.blocker || primaryBlocker({ run, step, attempt: null, evidence: claimsCompletion ? evidence : null });
  return {
    id: `worker:${step.id}`,
    stepId: step.id,
    stageId: `stage:${step.stageId || "implement"}`,
    title: text(step.title, "Untitled worker"),
    purpose: text(step.description || step.prompt, step.title),
    role: step.role || "implementation",
    profile: run.stageProfiles?.[step.role] ? { id: step.role, model: run.stageProfiles[step.role].model || null } : { id: step.role || "implementation", model: null },
    status: step.status,
    lifecycle: lifecycle(step.status, completeStatuses.has(step.status) ? evidence : null),
    required: step.required !== false,
    dependencies: dependencySteps(run.plan, step).map((item) => ({ workerId: `worker:${item.id}`, status: item.status, satisfied: item.status === "accepted" })),
    writeScope: step.permission === "write" ? text(step.writeScope, "not specified") : "not applicable",
    criteria: (step.acceptanceCriteria || []).map((item) => text(item)).filter(Boolean),
    attemptIds: attempts.map((attempt) => attempt.id),
    latestAction: latest?.latestAction || "Not started",
    evidence,
    blocker,
    nextAction: nextAction(run, { step })
  };
}

function projectStage(run, stage, workers, now) {
  const activity = stage.activity || {};
  const workerEvidence = workers.filter((worker) => worker.required).map((worker) => worker.evidence.state);
  const evidence = workerEvidence.length
    ? { state: workerEvidence.every((state) => state === "complete") ? "complete" : workerEvidence.some((state) => state === "incomplete") ? "incomplete" : "collecting" }
    : { state: stage.status === "completed" ? "complete" : activity.startedAt ? "collecting" : "not_started" };
  const blocker = primaryBlocker({ run, stage, evidence: stage.status === "completed" ? evidence : null });
  return {
    id: `stage:${stage.id}`,
    stageId: stage.id,
    title: text(stage.title, "Untitled stage"),
    purpose: text(stage.summary, stage.title),
    status: stage.status,
    lifecycle: lifecycle(stage.status, evidence),
    timing: elapsed(activity.startedAt || stage.updatedAt, activity.completedAt || (stage.status === "completed" ? stage.updatedAt : null), now),
    latestAction: text(activity.lastEvent || stage.summary, stage.status === "pending" ? "Not started" : stage.title),
    workerIds: workers.map((worker) => worker.id),
    evidence,
    blocker,
    resources: {
      activity: availability(Boolean(activity.events?.length || activity.groups?.length), activity.startedAt ? "not_retained" : "not_started"),
      artifacts: availability((run.artifacts || []).some((artifact) => artifact.stageId === stage.id), "not_recorded")
    },
    nextAction: nextAction(run, { stage })
  };
}

function completionEvidence(run, workers) {
  if (run.status !== "completed") return { state: "collecting", missing: [] };
  const requiredWorkers = workers.filter((worker) => worker.required);
  const finalChecks = run.reviews?.at(-1)?.reviews?.find((review) => review.role === "deterministic")?.checks;
  const visualRequired = flattenSteps(run.plan).some((step) => step.requiresVisualEvidence);
  const missing = [
    requiredWorkers.some((worker) => worker.lifecycle !== "completed") ? "worker_evidence" : null,
    !finalChecks || finalChecks.status !== "passed" ? "final_checks" : null,
    !run.integration ? "integration" : null,
    !(run.artifacts || []).some((artifact) => artifact.kind === "handoff") ? "handoff_artifact" : null,
    visualRequired && !hasFinalVisualEvidence(run) ? "visual_evidence" : null
  ].filter(Boolean);
  return { state: missing.length ? "incomplete" : "complete", missing };
}

function focusFor(run, stages, workers, attempts) {
  // A run-level proof gate is actionable at Verify, not at every completed
  // worker or at the blocked Handoff stage that follows it.
  if (run.checkpoint?.kind === "evidence_review" && !run.checkpoint.stepId) {
    const verify = stages.find((stage) => stage.stageId === "verify");
    if (verify) return { stageId: verify.id, workerId: null, attemptId: null, reason: "final_proof" };
  }
  const activeAttempt = attempts.find((attempt) => attempt.lifecycle === "active");
  if (activeAttempt) return { stageId: activeAttempt.stageId, workerId: activeAttempt.workerId, attemptId: activeAttempt.id, reason: "active" };
  const activeWorker = workers.find((worker) => worker.lifecycle === "active");
  if (activeWorker) return { stageId: activeWorker.stageId, workerId: activeWorker.id, attemptId: activeWorker.attemptIds.at(-1) || null, reason: "active" };
  const activeStage = stages.find((stage) => stage.lifecycle === "active");
  if (activeStage) return { stageId: activeStage.id, workerId: null, attemptId: null, reason: "active" };
  const blockedWorker = workers.find((worker) => worker.blocker && ["blocked", "failed", "incomplete", "interrupted", "cancelled"].includes(worker.lifecycle));
  if (blockedWorker) return { stageId: blockedWorker.stageId, workerId: blockedWorker.id, attemptId: blockedWorker.attemptIds.at(-1) || null, reason: "actionable" };
  const blockedStage = stages.find((stage) => stage.blocker);
  if (blockedStage) return { stageId: blockedStage.id, workerId: null, attemptId: null, reason: "actionable" };
  const completed = [...attempts].filter((item) => item.lifecycle === "completed").sort((a, b) => String(b.timing.completedAt || "").localeCompare(String(a.timing.completedAt || "")))[0];
  if (completed) return { stageId: completed.stageId, workerId: completed.workerId, attemptId: completed.id, reason: "latest_completion" };
  const stage = [...stages].reverse().find((item) => item.lifecycle === "completed") || stages[0] || null;
  return { stageId: stage?.id || null, workerId: null, attemptId: null, reason: stage ? "latest_completion" : "empty" };
}

export function projectInspection(run, { now = Date.now(), revision = null } = {}) {
  if (!run) return null;
  const attempts = [];
  const workers = [];
  for (const step of flattenSteps(run.plan)) {
    const projected = (step.attempts || []).map((attempt, index) => projectAttempt(run, step, attempt, index, now));
    const active = run.activeRuns?.[step.id];
    if (active && !projected.some((attempt) => attempt.runId && attempt.runId === active.runId && attempt.timing.completedAt === null)) {
      projected.push(projectAttempt(run, step, { ...active, attemptId: active.attemptId || `active-${active.runId || step.id}` }, projected.length, now, true));
    }
    attempts.push(...projected);
    workers.push(projectWorker(run, step, projected));
  }
  const stages = (run.stages || []).map((stage) => projectStage(run, stage, workers.filter((worker) => worker.stageId === `stage:${stage.id}`), now));
  const focus = focusFor(run, stages, workers, attempts);
  const evidence = completionEvidence(run, workers);
  const runBlocker = evidence.state === "incomplete" ? primaryBlocker({ run, evidence }) : null;
  const blockers = [runBlocker, ...workers.map((worker) => worker.blocker), ...stages.map((stage) => stage.blocker)].filter(Boolean)
    .filter((item, index, all) => all.findIndex((other) => other.type === item.type && other.summary === item.summary) === index);
  return {
    version: inspectionVersion,
    ticketId: run.id || run.ticket?.id || null,
    runId: run.runId || null,
    revision,
    status: run.status || null,
    lifecycle: lifecycle(run.status, evidence),
    evidence,
    focus,
    stages,
    workers,
    attempts,
    blockers,
    nextAction: nextAction(run)
  };
}

export function inspectionFocus(run, options) {
  const projection = projectInspection(run, options);
  return projection ? { version: projection.version, ...projection.focus } : null;
}
