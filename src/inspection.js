import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { storedProjectPolicy } from "./access-policy.js";
import { artifactPathForOpen, visualEvidenceMedia } from "./artifacts.js";
import { retainedUsage } from "./activity.js";
import { dependencySteps, findNode, flattenSteps } from "./plan.js";
import { coordinationBlockedStepIds, writeScopesOverlap } from "./coordination.js";
import { dashboardModelProviders } from "./profiles.js";
import { enrichReviewPacket } from "./pi-prompts.js";
import { projectProofMap } from "./proof-map.js";
import {
  boundedText,
  redactRecord,
  redactText,
  safeArtifactMetadata,
} from "./redaction.js";
import { compactReviewPacket } from "./review-packet.js";
import { reviewFindingLedger } from "./review-findings.js";
import {
  inFlightRunStatusSet,
  inFlightStepStatusSet,
  normalizeRunCleanup,
} from "./run-status.js";

export const inspectionVersion = 1;
const runFile = promisify(execFile);

const failedStatuses = new Set([
  "failed",
  "needs_attention",
  "verification_failed",
]);
const blockedStatuses = new Set([
  "blocked",
  "paused",
  "review_ready",
  "needs_input",
  "awaiting_approval",
]);
const completeStatuses = new Set(["completed", "accepted", "verified"]);

function configuredAllowPaths(run) {
  const extras = run?.access?.extraRoots || [];
  const extraRepos = (run?.repositories || []).filter((repo) => (repo.id || "primary") !== "primary");
  if (!extras.length && !extraRepos.length) return [];
  const paths = [];
  const add = (value) => {
    if (value && !paths.includes(value)) paths.push(value);
  };
  add(run?.access?.primary?.displayPath);
  for (const root of extras) add(root.displayPath);
  for (const repo of run?.repositories || []) add(repo.displayPath);
  return paths;
}

function text(value, fallback = "", allowPaths = []) {
  const line = String(value || "").split(/\r?\n/).find((item) => item.trim()) || String(fallback || "");
  return redactText(line, { allowPaths }).trim().slice(0, 240);
}

function identityText(value, run, fallback = "") {
  return text(value, fallback, configuredAllowPaths(run));
}

function repositoryIdentities(run) {
  const seen = new Set();
  const identities = [];
  const add = (repo) => {
    const repositoryId = repo?.repositoryId || repo?.id || "primary";
    if (seen.has(repositoryId)) return;
    seen.add(repositoryId);
    identities.push({
      repositoryId,
      displayPath: identityText(repo.displayPath || repo.sourceCwd || repo.path || repositoryId, run, repositoryId),
      kind: repo.kind || repo.evidenceKind || (repositoryId === "primary" ? "primary" : "extra")
    });
  };
  add({ id: "primary", displayPath: run?.access?.primary?.displayPath || run?.workspace?.displayPath || run?.workspace?.sourceCwd, kind: "primary" });
  for (const repo of run?.repositories || []) add(repo);
  for (const root of run?.access?.extraRoots || []) {
    if (root.mode === "read/write") add({ id: root.id, displayPath: root.displayPath, kind: "nongit" });
  }
  return identities;
}

function labeledDiffRecords(run, step, attempt) {
  return attempt?.diff?.repositories
    || attempt?.aggregateDiff?.repositories
    || step?.diff?.repositories
    || [];
}

function labeledCheckRecords(attempt, step) {
  const checks = checksFor(attempt) || step?.checks;
  return checks?.repositories || (checks ? [{ ...checks, repositoryId: checks.repositoryId || "primary" }] : []);
}

function repositoryResourceStates(run, step, attempt) {
  const identities = repositoryIdentities(run);
  const diffs = labeledDiffRecords(run, step, attempt);
  const checks = labeledCheckRecords(attempt, step);
  const changed = new Set([
    ...Object.entries(step?.repositoryDiffs || {}).filter(([, diff]) => (diff?.files || []).length).map(([id]) => id),
    ...diffs.filter((diff) => (diff.files || []).length || diff.available).map((diff) => diff.repositoryId)
  ]);
  return identities.map((identity) => {
    const diff = diffs.find((item) => item.repositoryId === identity.repositoryId);
    const check = checks.find((item) => (item.repositoryId || "primary") === identity.repositoryId);
    const diffPresent = Boolean(diff?.available || diff?.files?.length || diff?.patch);
    const diffState = diffPresent ? "available" : changed.has(identity.repositoryId) ? "missing" : "not_recorded";
    return {
      ...identity,
      diff: {
        state: diffState,
        fileCount: diff?.files?.length || 0,
        error: diff?.error || null
      },
      checks: {
        state: check ? "available" : changed.has(identity.repositoryId) && step?.permission === "write" ? "missing" : "not_recorded",
        status: check?.status || null
      }
    };
  });
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
  const visualDeferred = visualRequired && !visualPresent && step.status === "accepted"
    && run.status !== "completed" && run.stages?.find(stage => stage.id === "verify")?.status !== "completed";
  const labeled = !active ? repositoryResourceStates(run, step, attempt) : [];
  const missing = [
    reportRequired && !reportPresent ? "report" : null,
    checksRequired && !checksPresent ? "checks" : null,
    approvalRequired && !approvalPresent ? "approval" : null,
    artifactRequired && !artifactPresent ? "artifact" : null,
    visualRequired && !visualPresent && !visualDeferred ? "visual_evidence" : null,
    ...labeled.filter((item) => item.diff.state === "missing").map((item) => `diff:${item.repositoryId}`),
    ...labeled.filter((item) => item.checks.state === "missing").map((item) => `checks:${item.repositoryId}`)
  ].filter(Boolean);
  return {
    state: active ? "collecting" : missing.length ? "incomplete" : "complete",
    report: reportRequired ? (reportPresent ? "present" : "missing") : "not_yet_required",
    checks: checksRequired ? (checksPresent ? "passed" : checks ? checks.status || "failed" : "missing") : "not_required",
    approval: approvalRequired ? (approvalPresent ? "present" : "missing") : "not_required",
    artifacts: artifactRequired ? (artifactPresent ? "present" : "missing") : "not_required",
    visualEvidence: visualRequired ? (visualPresent ? "present" : visualDeferred ? "pending_final_verification" : "missing") : "not_required",
    missing
  };
}

function blockerType({ run, stage, step, attempt, evidence }) {
  const values = [attempt?.error, step?.lastError, run?.lastError, stage?.summary, run?.checkpoint?.title, run?.checkpoint?.prompt]
    .filter(Boolean).join(" ").toLowerCase();
  const checks = checksFor(attempt) || run?.checkpoint?.finalChecks || run?.merge?.checks;
  if (attempt?.violations?.length || /outside (?:permission|write scope)|scope violation/.test(values)) return "scope";
  if (checks?.status === "failed" || checks?.failedRepositories?.length || evidence?.missing?.includes("final_checks") || /repository check|deterministic check|\btests? failed\b|\bci failed\b/.test(values)) return "repository-check";
  if (run?.checkpoint?.kind === "evidence_review" || evidence?.missing?.some((item) => ["visual_evidence", "handoff_artifact", "integration"].includes(item)) || /visual evidence|final proof/.test(values)) return "evidence";
  if (/preview|port bind|eaddrinuse/.test(values)) return "preview";
  if (run?.merge?.status === "failed" || /merge conflict|merge queue|rebas/.test(values)) return "merge";
  if (/provider|model request|rate limit|quota|authentication|api key|timeout/.test(values)) return "provider";
  if ([attempt?.status, step?.status, run?.status].includes("cancelled")) return "cancellation";
  if ([attempt?.status, step?.status, run?.status].some((status) => ["interrupted", "paused"].includes(status))) return "interruption";
  return "review";
}

function failedCheckSummary(attempt, step) {
  const checks = checksFor(attempt) || step?.checks;
  const failed = checks?.failedRepositories || [];
  if (!failed.length && checks?.status !== "failed") return "";
  if (!failed.length) return checks.summary || "Repository check failed";
  return `Repository check failed in ${failed.map((item) => item.displayPath || item.repositoryId).join(", ")}`;
}

function primaryBlocker({ run, stage = null, step = null, attempt = null, evidence = null }) {
  const status = attempt?.status || step?.status || stage?.status || run.status;
  const checkpointApplies = checkpointForStep(run.checkpoint, step);
  const blocked = failedStatuses.has(status) || blockedStatuses.has(status) || ["cancelled", "interrupted"].includes(status)
    || (checkpointApplies && ["needs_attention", "review_blocked", "evidence_review"].includes(run.checkpoint.kind));
  if (!blocked && evidence?.state !== "incomplete") return null;
  const checkSummary = failedCheckSummary(attempt, step);
  const failedRepos = (checksFor(attempt) || step?.checks)?.failedRepositories || [];
  const summary = text(
    failedRepos.length ? checkSummary : (attempt?.error || step?.lastError || checkSummary || (checkpointApplies && (run.checkpoint.title || run.checkpoint.prompt)) || stage?.summary || run.lastError),
    evidence?.missing?.length ? `Missing required ${evidence.missing.join(", ")}` : "Review is required before work can continue", configuredAllowPaths(run));
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
    diff: availability(Boolean(diff?.available || diff?.files?.length || diff?.patch), step.permission === "write" ? (active ? "not_yet_available" : "not_recorded") : "not_applicable", {
      fileCount: diff?.files?.length || 0,
      error: diff?.error || null,
      repositories: repositoryResourceStates(run, step, attempt).map((item) => ({ repositoryId: item.repositoryId, displayPath: item.displayPath, kind: item.kind, ...item.diff }))
    }),
    checks: availability(Boolean(checks), step.permission === "write" ? (active ? "not_yet_available" : "not_recorded") : "not_applicable", {
      status: checks?.status || null,
      failedRepositories: checks?.failedRepositories || [],
      repositories: repositoryResourceStates(run, step, attempt).map((item) => ({ repositoryId: item.repositoryId, displayPath: item.displayPath, kind: item.kind, ...item.checks }))
    }),
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
    repositories: repositoryResourceStates(run, step, saved),
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

function legacyTimelineFields(run, focus) {
  const stageId = focus.stageId?.replace(/^stage:/, "") || null;
  const stepId = focus.workerId?.replace(/^worker:/, "") || null;
  const stage = (run.stages || []).find((item) => item.id === stageId) || null;
  const step = flattenSteps(run.plan).find((item) => item.id === stepId) || null;
  const active = step && run.activeRuns?.[step.id];
  const attemptId = focus.attemptId?.split(":").slice(2).join(":") || null;
  const activeAttemptId = active && (active.attemptId || `active-${active.runId || step.id}`);
  const attempt = activeAttemptId === attemptId ? active : (step?.attempts || []).find((item, index) => (item.attemptId || `attempt-${index + 1}`) === attemptId) || null;
  const sourceEvents = attempt?.events || attempt?.activity?.events || stage?.activity?.events || [];
  const events = sourceEvents.map((event) => ({
    type: event.type || "activity", tool: event.tool || null,
    title: text(event.label || event.title || event.tool, "Activity"),
    at: iso(event.at), isError: Boolean(event.isError)
  }));
  return {
    stepId, stepStatus: step?.status || null, stageId, stageStatus: stage?.status || null,
    ...(events.length ? { events } : {})
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
  const checkpointWorker = run.checkpoint?.stepId && workers.find((worker) => worker.stepId === run.checkpoint.stepId);
  if (checkpointWorker) return { stageId: checkpointWorker.stageId, workerId: checkpointWorker.id, attemptId: checkpointWorker.attemptIds.at(-1) || null, reason: "actionable" };
  // A paused stage is the current operator checkpoint; do not replace it with
  // incomplete evidence retained by an earlier completed worker.
  const pausedStage = stages.find((stage) => stage.status === "paused");
  if (pausedStage) return { stageId: pausedStage.id, workerId: null, attemptId: null, reason: "actionable" };
  const blockedWorker = workers.find((worker) => worker.blocker && ["blocked", "failed", "incomplete", "interrupted", "cancelled"].includes(worker.lifecycle));
  // A terminal worker is more actionable than its containing blocked stage:
  // this retains the immutable attempt selection after cancellation.
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
    const archived = (run.archivedAttempts || []).filter((attempt) => attempt.stepId === step.id);
    const projected = [...archived, ...(step.attempts || [])].map((attempt, index) => projectAttempt(run, step, attempt, index, now));
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
    repositories: repositoryIdentities(run),
    focus,
    stages,
    workers,
    attempts,
    blockers,
    nextAction: nextAction(run),
    // Retain the former CLI focus fields as a shallow compatibility view. The
    // dashboard and CLI still share the canonical stage/worker/attempt graph.
    ...legacyTimelineFields(run, focus)
  };
}

export function inspectionFocus(run, options) {
  const projection = projectInspection(run, options);
  return projection ? { version: projection.version, ...projection.focus } : null;
}

export function createInspectionService({ artifactContent, sessionTrace }) {
  if (typeof artifactContent !== "function")
    throw new TypeError("artifactContent is required");
  if (typeof sessionTrace !== "function")
    throw new TypeError("sessionTrace is required");

  function runForIdentity(state, ticketId, runId) {
    const current = state.ticketRuns?.[ticketId];
    if (current?.runId === runId) return current;
    const retained = Object.values(state.retainedRuns || {}).find(
      (run) => run.id === ticketId && run.runId === runId,
    );
    if (retained) return retained;
    throw new Error("Run not found");
  }

  function artifactForIdentity(state, ticketId, runId, artifactId) {
    const run = runId
      ? runForIdentity(state, ticketId, runId)
      : state.ticketRuns?.[ticketId];
    if (!run) throw new Error("Ticket run not found");
    const artifact = (run.artifacts || []).find(
      (item) => item.id === artifactId,
    );
    if (!artifact) throw new Error("Artifact not found");
    return { run, artifact };
  }

  function inspectionHistories(state, ticketId) {
    const current = state.ticketRuns?.[ticketId];
    const histories = [
      ...(current ? [{ run: current, archived: false }] : []),
      ...Object.values(state.retainedRuns || {})
        .filter((run) => run.id === ticketId)
        .map((run) => ({ run, archived: true })),
    ];
    if (!histories.length) throw new Error("Ticket run not found");
    return histories
      .sort(
        (left, right) =>
          Number(left.archived) - Number(right.archived) ||
          String(right.run.createdAt || "").localeCompare(
            String(left.run.createdAt || ""),
          ) ||
          String(right.run.runId || "").localeCompare(
            String(left.run.runId || ""),
          ),
      )
      .map(({ run, archived }) => ({
        ...compactRun(run, state.revision),
        archived,
        createdAt: run.createdAt || null,
        completedAt: run.completedAt || null,
        attemptCount: flattenSteps(run.plan).reduce(
          (count, step) => count + (step.attempts?.length || 0),
          0,
        ),
      }));
  }

  async function promptsForStage(run, stage) {
    const prompts = [];
    const seen = new Set();
    let retainedTraces = 0;
    let availableTraces = 0;
    const add = ({ prompt, content, at, actor, title, status }) => {
      const value = boundedText(prompt || content || "", 16000).value.trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      prompts.push({
        prompt: value,
        at: at || null,
        title: title || actor || stage.title,
        status: status || stage.status,
      });
    };
    for (const prompt of stage.activity?.prompts || []) add(prompt);
    const trace = async (
      sessionFile,
      meta = {},
      bounds = {},
      tolerateUnavailable = false,
    ) => {
      if (!sessionFile) return;
      retainedTraces++;
      try {
        const saved = await sessionTrace(sessionFile, bounds);
        availableTraces++;
        for (const prompt of saved.prompts ||
          (saved.prompt ? [{ prompt: saved.prompt }] : []))
          add({ ...prompt, ...meta });
      } catch (error) {
        // Persisted review handles can outlive their local session files.
        if (!tolerateUnavailable) throw error;
      }
    };
    const bounds = {
      after: stage.activity?.startedAt,
      before: stage.activity?.completedAt,
    };
    if (stage.id === "requirements")
      await trace(run.requirementsSessionFile, {}, bounds);
    if (["explore", "design"].includes(stage.id))
      await trace(run.sessionFile, {}, bounds);
    if (stage.id === "implement") {
      for (const step of flattenSteps(run.plan).filter(
        (item) => (item.stageId || "implement") === stage.id,
      )) {
        await trace(step.sessionFile, {
          title: step.title,
          status: step.status,
        });
      }
    }
    if (stage.id === "verify") {
      for (const review of run.reviews || [])
        for (const item of review.reviews || []) {
          await trace(
            item.sessionFile,
            {
              title: `${item.role} review · round ${review.round}`,
              status: "completed",
            },
            bounds,
            true,
          );
        }
    }
    return {
      prompts: prompts.sort((left, right) =>
        String(left.at || "").localeCompare(String(right.at || "")),
      ),
      trace: {
        state: !retainedTraces
          ? "not_retained"
          : availableTraces
            ? availableTraces === retainedTraces
              ? "available"
              : "partially_available"
            : "unavailable",
        retained: retainedTraces,
        available: availableTraces,
      },
    };
  }

  function fallback(artifact) {
    return artifact ? { artifact: safeArtifactMetadata(artifact) } : {};
  }

  function textDetail(saved, limit, unavailable, artifact = null) {
    const content = typeof saved === "string" ? saved : saved?.content;
    if (content == null || content === "")
      return { state: unavailable, ...fallback(artifact) };
    const bounded = boundedText(content, limit);
    const truncated = bounded.truncated || Boolean(saved?.truncated);
    const total = Math.max(bounded.total, Number(saved?.total) || 0);
    return {
      state: truncated ? "truncated" : "available",
      content: bounded.value,
      returned: bounded.value.length,
      total,
      ...(truncated ? fallback(artifact) : {}),
    };
  }

  function detailActivityEvent(event = {}) {
    const item = redactRecord({
      type: event.type || "activity",
      tool: event.tool || null,
      callId: event.callId || null,
      label: boundedText(event.label, 240).value,
      at: event.at || null,
      actor: boundedText(event.actor, 120).value || null,
      isError: Boolean(event.isError),
    });
    if (item.type === "thinking") return item;
    if (item.type === "usage")
      return {
        ...item,
        ...Object.fromEntries(
          ["input", "output", "cacheRead", "cacheWrite"].map((key) => [
            key,
            Number(event[key]) || 0,
          ]),
        ),
      };
    if (event.type === "reasoning_summary")
      return { ...item, detail: boundedText(event.detail, 1000).value };
    for (const key of ["args", "detail", "result"])
      if (event[key] != null) item[key] = boundedText(event[key], 2000).value;
    return item;
  }

  async function attemptDetails(run, step, attempt, { active = false } = {}) {
    const artifacts = (run.artifacts || []).filter(
      (artifact) =>
        artifact.stepId === step.id && artifact.attemptId === attempt.attemptId,
    );
    const byKind = (kind) =>
      artifacts.find((artifact) => artifact.kind === kind) || null;
    const promptArtifact = byKind("agent-prompt");
    const outputArtifact = byKind("agent-output");
    const diffArtifact = byKind("git-attempt-diff") || byKind("git-diff");
    const verificationArtifact = byKind("step-verification");
    const savedPrompt = (content, truncated = false, total = 0) =>
      content
        ? {
            content: redactText(content),
            truncated: Boolean(truncated),
            total: Number(total) || 0,
          }
        : null;
    const lastPrompt =
      attempt.prompts?.at(-1) || attempt.activity?.prompts?.at(-1);
    const prompt =
      (await artifactContent(promptArtifact, 16000)) ||
      savedPrompt(
        typeof attempt.prompt === "string"
          ? attempt.prompt
          : attempt.prompt?.content,
        attempt.promptTruncated ?? attempt.prompt?.truncated,
        attempt.promptTotal ?? attempt.prompt?.total,
      ) ||
      savedPrompt(
        lastPrompt?.content || lastPrompt?.prompt,
        lastPrompt?.truncated,
        lastPrompt?.total,
      );
    let activity = attempt.events || attempt.activity?.events || [];
    const rawOutput = redactText(
      attempt.rawOutput || attempt.activity?.rawOutput || "",
    );
    let output = (await artifactContent(outputArtifact, 20000)) || rawOutput;
    const artifactItems = await Promise.all(
      artifacts.map(async (artifact) => {
        const content = await artifactContent(artifact, 12000);
        return {
          ...safeArtifactMetadata(artifact),
          ...textDetail(content, 12000, "not_retained", artifact),
        };
      }),
    );
    const traceFile = attempt.sessionFile || null;
    let trace = null;
    if (traceFile) {
      try {
        trace = redactRecord(
          await sessionTrace(traceFile, {
            after: attempt.startedAt,
            before: attempt.completedAt,
          }),
        );
      } catch {
        trace = null;
      }
    }
    output ||=
      trace?.rawOutput ||
      (attempt.report
        ? redactText(JSON.stringify(attempt.report, null, 2))
        : "");
    if (!activity.length) activity = trace?.events || [];
    const activityItems = activity.slice(-100).map(detailActivityEvent);
    const traceOutput = trace && boundedText(trace.rawOutput || "", 20000);
    const tracePrompts = trace?.prompts || [];
    const traceEvents = trace?.events || [];
    const traceContent = trace && {
      prompts: tracePrompts.slice(-20).map((item) => ({
        prompt: boundedText(item.prompt, 4000).value,
        at: item.at || null,
      })),
      events: traceEvents.slice(-100).map(detailActivityEvent),
      rawOutput: traceOutput.value,
    };
    const traceTruncated = Boolean(
      traceContent &&
      (traceOutput.truncated ||
        tracePrompts.length > 20 ||
        traceEvents.length > 100),
    );
    const traceState = traceContent
      ? traceTruncated
        ? "truncated"
        : "available"
      : "unavailable";
    const diff = redactRecord(
      run.attemptDiffHistory?.[step.id]?.[attempt.attemptId] ||
        attempt.diff ||
        {},
    );
    const checks = redactRecord(
      attempt.verification?.checks || attempt.checks || {},
    );
    const checkOutput = boundedText(checks.output || "", 16000);
    const terminationReason =
      boundedText(
        redactText(
          attempt.termination?.reason || attempt.terminationReason || "",
        ),
        240,
      ).value || null;
    const terminationAt =
      attempt.termination?.at || attempt.completedAt || null;
    const failureKind =
      boundedText(
        redactText(attempt.failure?.kind || attempt.failureKind || ""),
        120,
      ).value || null;
    const failurePhase =
      boundedText(
        redactText(attempt.failure?.phase || attempt.failurePhase || ""),
        120,
      ).value || null;
    const failureMessage =
      boundedText(
        redactText(attempt.failure?.message || attempt.error || ""),
        1000,
      ).value || null;
    return {
      ticketId: run.id,
      runId: run.runId,
      stepId: step.id,
      attemptId: attempt.attemptId,
      terminationReason,
      termination:
        terminationReason || terminationAt
          ? { reason: terminationReason, at: terminationAt }
          : null,
      failureKind,
      failurePhase,
      failure:
        failureKind || failurePhase || failureMessage
          ? { kind: failureKind, phase: failurePhase, message: failureMessage }
          : null,
      prompt: textDetail(
        prompt,
        16000,
        active ? "not_yet_available" : "not_retained",
        promptArtifact,
      ),
      activity: {
        state:
          Math.max(activity.length, Number(attempt.eventsTotal) || 0) > 100
            ? "truncated"
            : activity.length
              ? "available"
              : active
                ? "not_yet_available"
                : "not_retained",
        items: activityItems,
        returned: activityItems.length,
        total: Math.max(activity.length, Number(attempt.eventsTotal) || 0),
      },
      output: textDetail(
        output,
        20000,
        active
          ? "not_yet_available"
          : outputArtifact
            ? "unavailable"
            : "not_retained",
        outputArtifact,
      ),
      artifacts: {
        state: artifactItems.length ? "available" : "not_retained",
        items: artifactItems,
        count: artifactItems.length,
      },
      diff: diff.patch
        ? {
            state: boundedText(diff.patch, 20000).state,
            files: diff.files || [],
            stat: diff.stat || "",
            content: boundedText(diff.patch, 20000).value,
            ...(diff.patch.length > 20000 ? fallback(diffArtifact) : {}),
          }
        : {
            state: diffArtifact ? "unavailable" : "not_retained",
            ...fallback(diffArtifact),
          },
      checks: Object.keys(checks).length
        ? {
            state: checkOutput.state,
            status: checks.status || null,
            command: checks.command || null,
            summary: checks.summary || "",
            output: checkOutput.value,
            returned: checkOutput.value.length,
            total: checkOutput.total,
            ...(checkOutput.truncated ? fallback(verificationArtifact) : {}),
          }
        : { state: "not_retained" },
      trace: traceContent
        ? {
            state: traceState,
            content: traceContent,
            returned: {
              prompts: traceContent.prompts.length,
              events: traceContent.events.length,
              output: traceOutput.value.length,
            },
            total: {
              prompts: tracePrompts.length,
              events: traceEvents.length,
              output: traceOutput.total,
            },
          }
        : { state: traceFile ? "unavailable" : "not_retained" },
    };
  }

  return {
    artifactForIdentity,
    attemptDetails,
    detailActivityEvent,
    inspectionHistories,
    promptsForStage,
    runForIdentity,
    textDetail,
  };
}

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

function archivedAttempt(run, stepId, attemptId) {
  return (
    [...(run.archivedAttempts || [])]
      .reverse()
      .find(
        (attempt) =>
          attempt.stepId === stepId && attempt.attemptId === attemptId,
      ) || null
  );
}

function checkOutput(
  run,
  { scope = "step", stepId = null, attemptId = null, reviewId = null } = {},
) {
  if (scope === "final")
    return reviewId
      ? run.finalCheckHistory?.[reviewId] ||
          run.reviews?.find(
            (review) =>
              review.reviewId === reviewId ||
              `final-review-${review.round}` === reviewId,
          )?.finalChecks ||
          null
      : run.finalChecks ||
          run.checkpoint?.finalChecks ||
          run.reviews
            ?.at(-1)
            ?.reviews?.find((review) => review.role === "deterministic")
            ?.checks ||
          null;
  if (!stepId) throw new Error("Step check output requires a step ID");
  const step = findNode(run.plan, stepId);
  if (!step) throw new Error("Step not found");
  if (scope === "attempt") {
    if (!attemptId)
      throw new Error("Attempt check output requires an attempt ID");
    const attempt =
      (step.attempts || []).find((item) => item.attemptId === attemptId) ||
      archivedAttempt(run, stepId, attemptId);
    return attempt?.verification?.checks || attempt?.checks || null;
  }
  if (scope !== "step") throw new Error("Unknown check-output scope");
  return (
    [...(step.attempts || [])]
      .reverse()
      .map((attempt) => attempt.verification?.checks || attempt.checks)
      .find(Boolean) ||
    step.checks ||
    null
  );
}

export function createRouteInspectionService({
  state,
  details,
  artifactContent,
  harness,
  dataDir,
  trackers,
  events,
  openImpl = runFile,
} = {}) {
  if (
    !state?.read ||
    !details ||
    typeof artifactContent !== "function" ||
    !harness
  )
    throw new TypeError(
      "Route inspection requires state, details, artifact reads, and harness",
    );
  const read = state.read;
  const current = (ticketId) => ticketRun(read(), ticketId);
  const identity = (ticketId, runId = null) =>
    runId ? details.runForIdentity(read(), ticketId, runId) : current(ticketId);

  return {
    state: () => publicState(read()),
    ticketRun(ticketId, { detail = false } = {}) {
      const snapshot = read();
      const run = ticketRun(snapshot, ticketId);
      return detail ? publicRun(run) : compactRun(run, snapshot.revision);
    },
    checkOutput(ticketId, options) {
      const checks = checkOutput(current(ticketId), options);
      if (!checks) throw new Error("Check output not found");
      return checks;
    },
    reviewPacket(ticketId) {
      const run = current(ticketId);
      const latest = run.reviews?.at(-1);
      const checks =
        latest?.reviews?.find((review) => review.role === "deterministic")
          ?.checks ||
        run.finalChecks ||
        {};
      const diff =
        [
          run.deliveredDiff,
          latest?.diff,
          ...flattenSteps(run.plan).flatMap((step) => [
            step.diff,
            ...[...(step.attempts || [])]
              .reverse()
              .map((attempt) => attempt.diff),
          ]),
        ].find(
          (item) =>
            item &&
            (item.patch || item.repositories?.length || item.files?.length),
        ) || {};
      return enrichReviewPacket(
        compactReviewPacket({
          ticket: run.ticket,
          plan: run.plan,
          artifacts: run.artifacts,
          diff,
          checks,
          proofMap: projectProofMap(run),
        }),
        { diff, checks },
      );
    },
    ticketInspection(ticketId) {
      const snapshot = read();
      return projectInspection(ticketRun(snapshot, ticketId), {
        revision: snapshot.revision,
      });
    },
    runHistories(ticketId) {
      const snapshot = read();
      return {
        ticketId,
        revision: snapshot.revision,
        runs: details.inspectionHistories(snapshot, ticketId),
      };
    },
    runInspection(ticketId, runId) {
      const snapshot = read();
      return projectInspection(
        details.runForIdentity(snapshot, ticketId, runId),
        { revision: snapshot.revision },
      );
    },
    async models() {
      const catalog = await harness.models();
      const models = catalog.filter((model) =>
        dashboardModelProviders.includes(model.provider),
      );
      const selected = models.length ? models : catalog;
      const providers = [
        ...new Set(selected.map((model) => model.provider).filter(Boolean)),
      ];
      return {
        models: selected,
        ...(providers.length === 1
          ? { provider: providers[0] }
          : providers.length
            ? { providers }
            : {}),
      };
    },
    async skills(ticketId = read().selectedTicketId) {
      const snapshot = read();
      const run = ticketId ? snapshot.ticketRuns?.[ticketId] : null;
      return {
        skills: await harness.listSkills({
          cwd: run?.workspace?.cwd || snapshot.workspace.cwd,
          sessionFile: run?.sessionFile || null,
          sessionKey: run ? `${run.ticket.id}-${run.runId}` : undefined,
          access: run?.access || null,
        }),
        skillName: run?.workflow?.skillName || null,
      };
    },
    async ticketSkills(ticketId) {
      const run = current(ticketId);
      const snapshot = read();
      return {
        skills: await harness.listSkills({
          cwd: run.workspace?.cwd || snapshot.workspace.cwd,
          sessionFile: run.sessionFile || null,
          sessionKey: `${run.ticket.id}-${run.runId}`,
          access: run.access || null,
        }),
        skillName: run.workflow?.skillName || null,
      };
    },
    async openArtifact({ ticketId, runId, artifactId }) {
      if (process.platform !== "darwin")
        throw new Error(
          "Opening artifacts in their default application currently requires macOS",
        );
      const { run } = details.artifactForIdentity(
        read(),
        ticketId,
        runId,
        artifactId,
      );
      const path = artifactPathForOpen(run.artifacts, artifactId, dataDir);
      if (!(path && (await stat(path).catch(() => null))?.isFile()))
        throw new Error("Artifact file not found");
      await openImpl("open", [path]);
    },
    async attemptDetail({ ticketId, runId, stepId, attemptId }) {
      const run = details.runForIdentity(read(), ticketId, runId);
      const step = findNode(run.plan, stepId);
      const retained = step?.attempts?.find(
        (item, index) =>
          (item.attemptId || `attempt-${index + 1}`) === attemptId,
      );
      const active = run.activeRuns?.[step?.id];
      const activeAttempt =
        active &&
        (active.attemptId || `active-${active.runId || step.id}`) === attemptId
          ? { ...active, attemptId }
          : null;
      const attempt = retained
        ? { ...retained, attemptId: retained.attemptId || attemptId }
        : archivedAttempt(run, step?.id, attemptId) || activeAttempt;
      if (!attempt) throw new Error("Attempt not found");
      return details.attemptDetails(run, step, attempt, {
        active: Boolean(activeAttempt),
      });
    },
    async artifactMedia({ ticketId, runId, artifactId }) {
      const { run, artifact } = details.artifactForIdentity(
        read(),
        ticketId,
        runId,
        artifactId,
      );
      const path = artifactPathForOpen(run.artifacts, artifactId, dataDir);
      const media =
        artifact.kind === "visual-evidence" &&
        visualEvidenceMedia(artifact.name || path);
      if (!path || !media) throw new Error("Visual evidence not found");
      return { mediaType: media.mediaType, content: await readFile(path) };
    },
    async uiProposalPreview({ ticketId, runId, artifactId }) {
      const { run, artifact } = details.artifactForIdentity(read(), ticketId, runId, artifactId);
      const path = artifactPathForOpen(run.artifacts, artifactId, dataDir);
      if (!path || artifact.kind !== "ui-proposal") throw new Error("UI proposal not found");
      return readFile(path, "utf8");
    },
    async artifactContent({ ticketId, runId, artifactId }) {
      const { artifact } = details.artifactForIdentity(
        read(),
        ticketId,
        runId,
        artifactId,
      );
      return {
        artifact: safeArtifactMetadata(artifact),
        ...details.textDetail(
          await artifactContent(artifact, 20000),
          20000,
          "not_retained",
          artifact,
        ),
      };
    },
    artifact({ ticketId, runId, artifactId }) {
      return safeArtifactMetadata(
        details.artifactForIdentity(read(), ticketId, runId, artifactId)
          .artifact,
      );
    },
    async sessionTrace(ticketId, stepId) {
      const step = findNode(current(ticketId).plan, stepId);
      if (!step) throw new Error("Step not found");
      const trace = redactRecord(await harness.sessionTrace(step.sessionFile));
      const output = boundedText(trace.rawOutput || "", 20000);
      return {
        state: output.state,
        content: {
          prompts: (trace.prompts || []).slice(-20).map((item) => ({
            prompt: boundedText(item.prompt, 4000).value,
            at: item.at || null,
          })),
          events: (trace.events || [])
            .slice(-100)
            .map(details.detailActivityEvent),
          rawOutput: output.value,
        },
      };
    },
    steering(ticketId) {
      const run = current(ticketId);
      return {
        records: run.steering?.records || [],
        rejections: run.steeringRejections || [],
      };
    },
    stageOutput(ticketId, runId, stageId) {
      const stage = identity(ticketId, runId).stages.find(
        (item) => item.id === stageId,
      );
      if (!stage) throw new Error("Stage not found");
      const output = redactText(stage.activity?.rawOutput || "");
      return {
        state: output ? "available" : "not_retained",
        content: output.slice(-100000),
        retainedTail: true,
      };
    },
    stagePrompts({ ticketId, runId, stageId }) {
      const run = identity(ticketId, runId);
      const stage = run.stages.find((item) => item.id === stageId);
      if (!stage) throw new Error("Stage not found");
      return details.promptsForStage(run, stage);
    },
    operatorPreview(ticketId) {
      return current(ticketId).previews?.[`${ticketId}:operator`] || null;
    },
    ticketSources: () => trackers.refresh(),
    events: (request, response) =>
      events.subscribe(request, response, publicState(read())),
  };
}

function compactActivityEvent(event = {}) {
  return redactRecord({
    type: event.type || "activity", tool: event.tool || null, label: boundedText(event.label, 240).value,
    ...(event.type === "usage" ? { input: event.input, output: event.output, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite } : {}),
    at: event.at || null, isError: Boolean(event.isError), ...(event.actor ? { actor: boundedText(event.actor, 120).value } : {})
  });
}

function publicAttempt(attempt) {
  const clone = structuredClone(attempt);
  clone.usage = retainedUsage(attempt);
  for (const key of ["rawOutput", "activityGroups", "sessionFile", "prompt", "artifactRefs"]) delete clone[key];
  if (Array.isArray(clone.events)) clone.events = clone.events.slice(-20)
    // Short tool-end payloads duplicate durable activity without adding a
    // supervision signal. Keep only oversized payloads, explicitly bounded.
    .filter((event) => event.type !== "tool_end" || String(event.output || "").length > 2000)
    .map((event) => {
      const compact = compactActivityEvent(event);
      if (event.type === "tool_end" && typeof event.output === "string") {
        const output = boundedText(event.output, 2000);
        compact.output = output.truncated ? `${output.value}\n… output truncated for public state` : output.value;
      }
      return compact;
    });
  if (clone.report) clone.report = redactRecord({ status: clone.report.status, summary: boundedText(clone.report.summary, 240).value, request: boundedText(clone.report.request, 240).value });
  if (typeof clone.feedback === "string" && clone.feedback.length > 1000) clone.feedback = `${clone.feedback.slice(0, 1000)}\n… feedback truncated for public state`;
  if (clone.checks) clone.checks = publicChecks(clone.checks);
  if (clone.verification) clone.verification = redactRecord({ summary: boundedText(clone.verification.summary, 240).value, findings: clone.verification.findings });
  if (clone.diff) clone.diff = redactRecord({ available: clone.diff.available, files: clone.diff.files, stat: boundedText(clone.diff.stat, 1000).value });
  if (clone.checkDiff) clone.checkDiff = redactRecord({ available: clone.checkDiff.available, files: clone.checkDiff.files, stat: boundedText(clone.checkDiff.stat, 1000).value });
  if (clone.aggregateDiff) clone.aggregateDiff = redactRecord({ available: clone.aggregateDiff.available, files: clone.aggregateDiff.files, stat: boundedText(clone.aggregateDiff.stat, 1000).value });
  return redactRecord(clone);
}

function removePrivateLocations(value) {
  if (Array.isArray(value)) return value.map(removePrivateLocations);
  if (!value || typeof value !== "object") return value;
  for (const [key, item] of Object.entries(value)) {
    if (["path", "cwd", "sourceCwd", "sessionFile", "requirementsSessionFile", "productContextPath", "fixturePath"].includes(key)) delete value[key];
    else value[key] = removePrivateLocations(item);
  }
  return value;
}

function ownerWorkspaceDisplayPath(workspace) {
  if (!workspace || typeof workspace !== "object") return "";
  return workspace.displayPath || workspace.cwd || "";
}

function publicAccessPolicy(state) {
  const cwd = state?.workspace?.cwd;
  const policies = state?.projectPolicies;
  let key = cwd;
  if (cwd && policies && typeof policies === "object" && !Array.isArray(policies) && !Object.hasOwn(policies, cwd)) {
    try { key = realpathSync(cwd); } catch {}
  }
  const stored = storedProjectPolicy(state, key);
  return {
    mode: stored.mode === "any" ? "any" : "restricted",
    extraRoots: stored.extraRoots.map((root) => ({
      displayPath: root.displayPath || root.path || "",
      mode: root.mode === "read/write" ? "read/write" : "read-only"
    }))
  };
}

function publicWorkflow(workflow) {
  if (!workflow) return workflow;
  return redactRecord({
    skillName: workflow.skillName || null,
    status: workflow.status || "idle",
    stages: (workflow.stages || []).map((stage) => ({ id: stage.id, status: stage.status, title: boundedText(stage.title, 240).value, summary: boundedText(stage.summary, 240).value, createdAt: stage.createdAt || null, updatedAt: stage.updatedAt || null })),
    checkpoints: (workflow.checkpoints || []).map(publicCheckpoint)
  });
}

function publicCheckpoint(checkpoint) {
  if (!checkpoint) return checkpoint;
  const { prompt, productContext, finalChecks, media, questions, ...rest } = checkpoint;
  return redactRecord({ ...rest,
    title: boundedText(rest.title, 240).value,
    questions: (questions || []).map((question) => boundedText(question, 240).value),
    ...(finalChecks ? { finalChecks: { status: finalChecks.status, command: finalChecks.command || null, summary: boundedText(finalChecks.summary, 240).value } } : {}),
    ...(media ? { media: media.map(safeArtifactMetadata) } : {})
  });
}

function publicEvent(event, detailed) {
  const clone = { ...event };
  for (const key of ["args", "output", "result", "detail"]) {
    if (typeof clone[key] !== "string") continue;
    if (!detailed) delete clone[key];
    else if (clone[key].length > 2000) clone[key] = `${clone[key].slice(0, 2000)}\n… output truncated; open the saved session for full detail`;
  }
  return clone;
}

function publicActivity(activity, detailed = true) {
  if (!activity) return activity;
  const clone = { ...activity, events: (activity.events || []).map((event) => publicEvent(event, detailed)) };
  delete clone.prompts;
  delete clone.rawOutput;
  delete clone.groups;
  return clone;
}

function diffSummary(diff) {
  if (!diff) return diff;
  const { patch, ...summary } = diff;
  return summary;
}

function publicChecks(checks) {
  if (!checks) return checks;
  const { output, ...summary } = checks;
  return summary;
}

export function publicCoordination(run) {
  const ledger = structuredClone(run?.coordination || { messages: [], conflicts: [], decisions: [], revisions: [] });
  const stepSummary = (step) => ({ id: step.id, type: "step", title: step.title, description: step.description, agentId: step.agentId, permission: step.permission, writeScope: step.writeScope, dependsOn: step.dependsOn, acceptanceCriteria: step.acceptanceCriteria, status: step.status });
  const planSummary = (plan) => plan && ({ title: plan.title, nodes: (plan.nodes || []).map((node) => node.type === "group" ? { id: node.id, type: "group", title: node.title, children: node.children.map(stepSummary) } : stepSummary(node)) });
  for (const revision of ledger.revisions || []) {
    revision.before = planSummary(revision.before);
    revision.after = planSummary(revision.after);
    if (revision.beforeWork) revision.beforeWork = revision.beforeWork.map((step) => ({ ...stepSummary(step), attempts: (step.attempts || []).map((attempt) => ({ attemptId: attempt.attemptId, planRevision: attempt.planRevision, status: attempt.status })), diff: step.diff && { files: step.diff.files, stat: step.diff.stat }, artifacts: (step.artifacts || []).map(safeArtifactMetadata) }));
    if (revision.workPreparation) revision.workPreparation = { status: revision.workPreparation.status, createdAt: revision.workPreparation.createdAt, preparedAt: revision.workPreparation.preparedAt, repositories: revision.workPreparation.repositories.map((record) => ({ stepIds: record.stepIds, isolated: record.isolated, files: record.files, artifact: safeArtifactMetadata(record.artifact) })) };
  }
  return removePrivateLocations(redactRecord(ledger));
}

export function publicRun(run) {
  if (!run) return run;
  const clone = structuredClone(run);
  clone.inspectionFocus = inspectionFocus(run);
  clone.reviewFindings = reviewFindingLedger(run.reviews);
  clone.coordination = publicCoordination(run);
  clone.planRevision = run.planRevision || 1;
  clone.checkpoint = publicCheckpoint(clone.checkpoint);
  clone.workflow = publicWorkflow(clone.workflow);
  clone.lastError = boundedText(clone.lastError, 1000).value || null;
  if (Array.isArray(clone.artifacts))
    clone.artifacts = clone.artifacts.map(safeArtifactMetadata);
  for (const stage of clone.stages || [])
    if (stage.activity) {
      stage.activity.usage = retainedUsage(stage.activity);
      delete stage.activity.prompts;
      if (Array.isArray(stage.activity.events))
        stage.activity.events = stage.activity.events
          .slice(-20)
          .map(compactActivityEvent);
      delete stage.activity.groups;
      delete stage.activity.rawOutput;
    }
  clone.proofMap = projectProofMap(run);
  const coordinationBlocked = new Set(coordinationBlockedStepIds(run));
  for (const step of flattenSteps(clone.plan)) {
    if (coordinationBlocked.has(step.id)) step.blockedReason = "Waiting for a coordination decision or plan adjustment.";
    else if (["ready", "interrupted"].includes(step.status)) {
      const overlap = flattenSteps(run.plan).find((other) => other.id !== step.id && run.activeRuns?.[other.id] && step.permission === "write" && other.permission === "write" && writeScopesOverlap(step.writeScope, other.writeScope));
      if (overlap) step.blockedReason = `Waiting for ${overlap.title}: overlapping write scope.`;
    }
    delete step.prompt;
    delete step.productContext;
    if (Array.isArray(step.artifacts))
      step.artifacts = step.artifacts.map(safeArtifactMetadata);
    if (Array.isArray(step.attempts))
      step.attempts = step.attempts.map(publicAttempt);
    if (step.diff)
      step.diff = redactRecord({
        available: step.diff.available,
        files: step.diff.files,
        stat: boundedText(step.diff.stat, 1000).value,
      });
    delete step.sessionFile;
  }
  if (Array.isArray(clone.reviews))
    clone.reviews = clone.reviews.map((review) => ({
      round: review.round,
      createdAt: review.createdAt,
      actionableFindings: redactRecord(review.actionableFindings || []),
      diff: diffSummary(review.diff),
      reviews: (review.reviews || []).map((item) => ({
        role: item.role,
        summary: boundedText(item.summary, 240).value,
        checks: item.checks && {
          status: item.checks.status,
          command: item.checks.command || null,
          summary: boundedText(item.checks.summary, 240).value,
        },
      })),
      ...(review.fix
        ? {
            fix: {
              ...(review.fix.diff
                ? { diff: diffSummary(review.fix.diff) }
                : {}),
              ...(review.fix.artifact
                ? (() => {
                    const { bodySummary, path, content, ...artifact } =
                      review.fix.artifact;
                    return { artifact: redactRecord(artifact) };
                  })()
                : {}),
            },
          }
        : {}),
    }));
  if (clone.deliveredDiff)
    clone.deliveredDiff = redactRecord({
      available: clone.deliveredDiff.available,
      files: clone.deliveredDiff.files,
      stat: boundedText(clone.deliveredDiff.stat, 1000).value,
    });
  if (clone.integration?.diff)
    clone.integration.diff = redactRecord({
      available: clone.integration.diff.available,
      files: clone.integration.diff.files,
      stat: boundedText(clone.integration.diff.stat, 1000).value,
    });
  for (const stage of clone.stages || [])
    if (stage.diff)
      stage.diff = redactRecord({
        available: stage.diff.available,
        files: stage.diff.files,
        stat: boundedText(stage.diff.stat, 1000).value,
      });
  for (const active of Object.values(clone.activeRuns || {})) {
    delete active.prompt;
    delete active.sessionFile;
    if (active.activity) {
      active.activity.usage = retainedUsage(active.activity);
      delete active.activity.prompts;
      if (Array.isArray(active.activity.events))
        active.activity.events = active.activity.events
          .slice(-20)
          .map(compactActivityEvent);
      delete active.activity.groups;
      delete active.activity.rawOutput;
    }
  }
  return redactRecord(removePrivateLocations(clone));
}

export function publicState(state) {
  if (!state) return state;
  const clone = structuredClone(state);
  const accessPolicy = publicAccessPolicy(state);
  const workspaceDisplayPath = ownerWorkspaceDisplayPath(clone.workspace);
  for (const [id, run] of Object.entries(clone.ticketRuns || {})) {
    clone.ticketRuns[id] = id === clone.selectedTicketId ? publicRun(run) : compactRun(run, clone.revision);
  }
  for (const [id, run] of Object.entries(clone.retainedRuns || {})) clone.retainedRuns[id] = compactRun(run, clone.revision);
  delete clone.projectPolicies;
  clone.accessPolicy = accessPolicy;
  if (clone.workspace && typeof clone.workspace === "object") clone.workspace.displayPath = workspaceDisplayPath;
  return removePrivateLocations(clone);
}

export function publicPreviewState(state, ticketId) {
  const run = state?.ticketRuns?.[ticketId];
  return publicState({
    version: state?.version,
    revision: state?.revision,
    workspace: state?.workspace,
    settings: state?.settings,
    stageProfiles: state?.stageProfiles,
    selectedTicketId: ticketId,
    ticketRuns: run ? { [ticketId]: run } : {},
    retainedRuns: {},
    notice: state?.notice || null
  });
}

export function compactRun(run, revision = null) {
  return {
    id: run?.id || null,
    runId: run?.runId || null,
    ticket: run?.ticket ? {
      id: run.ticket.id,
      identifier: run.ticket.identifier,
      title: run.ticket.title,
      source: run.ticket.source || null,
      provider: run.ticket.provider || null,
      state: run.ticket.state ? { id: run.ticket.state.id, name: run.ticket.state.name, type: run.ticket.state.type } : null
    } : null,
    status: run?.status || null,
    checkpoint: publicCheckpoint(run?.checkpoint),
    uiProposal: run?.uiProposal || null,
    uiImpact: run?.plan?.uiImpact || run?.uiImpactProvisional || null,
    lastError: boundedText(run?.lastError, 1000).value || null,
    workflow: publicWorkflow(run?.workflow),
    steering: run?.steering || { nextSequence: 1, records: [] },
    steeringRejections: run?.steeringRejections || [],
    coordination: publicCoordination(run),
    planRevision: run?.planRevision || 1,
    proofMap: projectProofMap(run),
    cleanup: normalizeRunCleanup(run?.cleanup),
    revision
  };
}
