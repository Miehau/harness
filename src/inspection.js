import { dependencySteps, flattenSteps } from "./plan.js";
import { redactText } from "./redaction.js";
import { inFlightRunStatusSet, inFlightStepStatusSet } from "./run-status.js";

export const inspectionVersion = 1;

const failedStatuses = new Set(["failed", "needs_attention", "verification_failed"]);
const blockedStatuses = new Set(["blocked", "paused", "review_ready", "needs_input", "awaiting_approval"]);
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
