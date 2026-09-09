import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { redactRecord, redactText, retainDurableRecord } from "./redaction.js";
import { beginJjChange, snapshotJjChange, acceptJjChange } from "./jj.js";
import { cherryPickCommit, commitWorkspace, diffRepositoryTrees, filesOutsideWriteScope, gitRepositoriesForStep, mergeRepositoryDiff, snapshotRepositoryTrees } from "./worktrees.js";
import { aggregateProofDiffs, snapshotTree, labelRepositoryDiffs, labeledProofRootDiffs, normalizeReviewNotes, snapshotProofRootMap } from "./git.js";
import { flattenSteps, blockingReasons, dependencyArtifacts, dependencySteps, diffReviewBudget, findNode, reviewBudgetRequiresRollback } from "./plan.js";
import { workerWriteScope } from "./pi-prompts.js";
import { actionableFindings, correctionPauseReason, interruptedStepFeedback, materializeActiveAttempt, nextAttemptId, nextCorrectionRound, providerWaitCheckpoint, selectWorkerSession, shouldPauseCorrection, supervisorReviewCheckpoint, verificationFocusFindings, workerReportCheckpoint } from "./execution.js";
import { applyStepProof, projectProofMap, invalidateProof, proofGate, proofGateError, stepCriterionIds } from "./proof-map.js";
import { setStage } from "./run-status.js";
import { findingsFingerprint, humanProofFindings } from "./review-findings.js";
import { acknowledgeSteering, failSteering, steeringCheckpointPending, targetMatches } from "./steering.js";
import { coordinationBlockedSteps } from "./coordination-service.js";

export function createStepRunner({ state, runtime, worker, checks, proof, artifacts, activity, steering, lifecycle, coordination }) {
  const { run: runContainedWorker, verifyStep, reviewWorkerReport, generateCommitMessage, evidenceImages } = worker;
  const { runChanged: runChangedRepositoryChecks, repositoryCheckReview } = checks;
  const { snapshot: persistProofSnapshot } = proof;
  const { hydrate: hydrateArtifacts, persist: persistArtifact, text: artifactText, dataDir } = artifacts;
  const { capture: captureStepActivity } = activity;
  const { drain: drainSteering, clear: clearSteeringDrain } = steering;
  const { mirrorCheckpoint } = lifecycle;
  const ticketRun = (source, id) => {
    const run = source.ticketRuns[id];
    if (!run) throw new Error("Ticket run not found");
    return run;
  };
  const readRun = (ticketId) => ticketRun(state.read(), ticketId);
  const update = state.update;
  const activeSteps = runtime.activeSteps;
  const currentAttempt = (run, { runId, stepId, workerRunId, attemptId }) =>
    run?.runId === runId
    && run?.activeRuns?.[stepId]?.runId === workerRunId
    && run.activeRuns[stepId]?.attemptId === attemptId;
  const findForkSession = (plan, step) =>
    [...dependencySteps(plan, step)].reverse().find((dependency) => dependency.sessionFile)?.sessionFile || null;
  function saveStepSession(ticketId, stepId, ticketRunId, workerRunId) {
    return async (sessionFile) => {
      if (!sessionFile) return;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run?.runId !== ticketRunId) return;
        const step = findNode(run.plan, stepId);
        const active = run.activeRuns?.[stepId];
        if (active?.runId !== workerRunId) return;
        if (step) step.sessionFile = sessionFile;
        active.sessionFile = sessionFile;
      }, { publish: false });
    };
  }
async function executeStep(ticketId, stepId, { feedback = "", signal } = {}) {
  const key = `${ticketId}:${stepId}`;
  if (activeSteps.has(key)) return activeSteps.get(key);
  const controller = new AbortController();
  const parentSignal = signal;
  signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  runtime.stepControllers ||= new Map();
  runtime.stepControllers.set(key, controller);
  let ownedIdentity = null;
  let activeActivity = null;
  const work = (async () => {
    signal?.throwIfAborted();
    const beforeState = state.read();
    const run = ticketRun(beforeState, ticketId);
    const ownsRun = () => !signal?.aborted && state.read().ticketRuns?.[ticketId]?.runId === run.runId;
    const step = findNode(run.plan, stepId);
    const correction = Boolean(feedback);
    if (!step || coordinationBlockedSteps(run).has(stepId) || (!correction && blockingReasons(run.plan, step).length) || (!correction && !["ready", "interrupted", "needs_input", "awaiting_approval"].includes(step.status))) return;
    let attemptEvidence = null;
    try {
      const stepCwd = step.workspace?.cwd || run.workspace.cwd;
      const repos = gitRepositoriesForStep(run, step);
      let vcsChange = null;
      const repositoryVcs = { ...(step.repositoryVcs || {}) };
      if (run.workspace.vcs === "jj" && step.permission === "write" && !step.workspace?.isolated) {
        for (const repo of repos) {
          const id = repo.id || "primary";
          const previous = id === "primary" ? step.vcsChange : step.repositoryVcs?.[id];
          const change = await beginJjChange(repo.cwd, { changeId: previous?.changeId, title: step.title });
          if (id === "primary") vcsChange = change;
          else repositoryVcs[id] = change;
        }
        if (!ownsRun()) return;
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (current?.runId !== run.runId || signal?.aborted) return;
          const target = findNode(current.plan, stepId);
          if (!target) return;
          if (vcsChange) target.vcsChange = vcsChange;
          if (Object.keys(repositoryVcs).length) target.repositoryVcs = repositoryVcs;
        });
      }
      let beforeTrees = await snapshotRepositoryTrees(repos);
      let beforeTree = beforeTrees.primary || await snapshotTree(stepCwd);
      if (beforeTree) beforeTrees.primary ||= beforeTree;
      const beforeProofRoots = await snapshotProofRootMap(run, step);
      const stepBaseTree = step.baseTree || beforeTree;
      const stepBaseTrees = step.baseTrees || { ...beforeTrees };
      const stepBaseProofRoots = step.baseProofRoots || beforeProofRoots;
      if (!ownsRun()) return;
      await update((state) => {
        const current = state.ticketRuns[ticketId];
        if (current?.runId !== run.runId || signal?.aborted) return;
        const target = findNode(current.plan, stepId);
        if (!target) return;
        target.baseTree ||= stepBaseTree;
        target.baseTrees ||= stepBaseTrees;
        target.baseProofRoots ||= stepBaseProofRoots;
        current.baselineProofRoots ||= beforeProofRoots;
      });
      if (step.baseTree && beforeTree) {
        const existingDiffs = await diffRepositoryTrees(repos, stepBaseTrees, beforeTrees);
        const existingDiff = mergeRepositoryDiff(repos, existingDiffs);
        const existingBudget = diffReviewBudget(step, existingDiff);
        if (reviewBudgetRequiresRollback(existingBudget)) {
          throw new Error(`Review budget approval required; worktree preserved: ${existingBudget.reasons.join("; ")}. Approve a bounded budget with scope-add before resuming.`);
        }
      }
      let nextFeedback = feedback;
      // A completed worker and its checks survive a reviewer interruption. Reuse
      // them only while the worktree is unchanged and no correction was requested.
      let pendingVerification = !nextFeedback && step.pendingVerification?.afterTree === beforeTree
        && isDeepStrictEqual(step.pendingVerification.afterTrees || { primary: step.pendingVerification.afterTree }, beforeTrees)
        && isDeepStrictEqual(step.pendingVerification.afterProofRoots || {}, beforeProofRoots)
        ? step.pendingVerification : null;
      if (step.pendingVerification && !pendingVerification) {
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (current?.runId !== run.runId || signal?.aborted) return;
          const target = findNode(current.plan, stepId);
          if (target) delete target.pendingVerification;
        });
      }
      const priorVerification = [...(step.attempts || [])].reverse().find((attempt) => attempt.verification)?.verification || {};
      if (!nextFeedback && !pendingVerification && step.status === "interrupted") nextFeedback = interruptedStepFeedback(step);
      let previousFindings = pendingVerification?.previousFindings || actionableFindings([priorVerification]);
      let previousFingerprint = findingsFingerprint(previousFindings);
      for (let round = pendingVerification?.round || nextCorrectionRound(step); ; round++) {
        signal?.throwIfAborted();
        const latest = readRun(ticketId);
        if (latest.runId !== run.runId) return;
        const currentStep = findNode(latest.plan, stepId);
        const workerRunId = randomUUID();
        const startedAt = new Date().toISOString();
        const reusableAttempt = currentStep.status === "interrupted" && currentStep.activeAttempt?.id && currentStep.activeAttempt.status === "interrupted";
        const attemptId = reusableAttempt ? currentStep.activeAttempt.id : nextAttemptId(currentStep);
        attemptEvidence = { runId: workerRunId, attemptId, startedAt, feedback: nextFeedback || null };
        const contextArtifacts = await hydrateArtifacts([
          ...latest.artifacts.filter((artifact) => ["feature-brief", "architecture"].includes(artifact.kind)),
          ...dependencyArtifacts(latest.plan, currentStep)
        ], dataDir);
        if (signal?.aborted || readRun(ticketId).runId !== run.runId) return;
        let started = false;
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (signal?.aborted || current?.runId !== run.runId) return;
          const target = findNode(current.plan, stepId);
          if (!target) return;
          if (!ownedIdentity && coordinationBlockedSteps(current).has(stepId)) return;
          const reuse = target.status === "interrupted" && target.activeAttempt?.id === attemptId && target.activeAttempt.status === "interrupted";
          target.activeAttempt = {
            ...(reuse ? target.activeAttempt : {}), id: attemptId, status: "active",
            planRevision: current.planRevision || 1,
            startedAt: target.activeAttempt?.startedAt || startedAt, resumedAt: reuse ? startedAt : null, workerRunId
          };
          const sequence = Number(String(attemptId).match(/^attempt-(\d+)$/)?.[1]) || Number(target.attemptSequence) || 0;
          target.attemptSequence = Math.max(Number(target.attemptSequence) || 0, sequence);
          target.status = pendingVerification ? "verifying" : nextFeedback ? "fixing" : "running";
          target.lastError = null;
          current.status = target.status;
          current.activeRuns[stepId] = { runId: workerRunId, attemptId, planRevision: current.planRevision || 1, startedAt, lastEventAt: startedAt, lastEvent: nextFeedback ? "Starting focused fix" : "Starting Pi worker", warning: false, piSessionState: "starting" };
          setStage(current, "implement", "active", `${nextFeedback ? "Fixing" : "Implementing"} ${target.title}`);
          started = true;
        });
        if (!started) return;
        ownedIdentity = { runId: run.runId, stepId, workerRunId, attemptId };
        const activity = captureStepActivity(ticketId, stepId, workerRunId);
        activeActivity = activity;
        const cwd = currentStep.workspace?.cwd || latest.workspace.cwd;
        const attemptRepos = gitRepositoriesForStep(latest, currentStep);
        const attemptBaseTrees = pendingVerification?.attemptBaseTrees || await snapshotRepositoryTrees(attemptRepos);
        const attemptBaseTree = pendingVerification?.attemptBaseTree || attemptBaseTrees.primary || await snapshotTree(cwd);
        const sessionChoice = selectWorkerSession(currentStep, {
          forkSessionFile: findForkSession(latest.plan, currentStep),
          feedback: nextFeedback
        });
const result = pendingVerification?.result || await runContainedWorker({
          ticketId, stepId, attemptId, executionId: workerRunId,
          coordination: coordination?.forWorker({ ticketId, runId: latest.runId, stepId, attemptId }),
          cwd, plan: latest.plan, step: currentStep, artifacts: contextArtifacts, proofMap: projectProofMap(latest), images: [],
          ...sessionChoice,
          feedback: nextFeedback, runId: latest.runId,
          repositories: gitRepositoriesForStep(latest, currentStep),
          profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation,
          onEvent: activity.onEvent,
          onSessionFile: saveStepSession(ticketId, stepId, run.runId, workerRunId),
          onSessionActive: async (target) => {
            await update((state) => {
              const current = state.ticketRuns[ticketId];
              const active = current.activeRuns?.[target.stepId];
              if (active?.attemptId === target.attemptId && targetMatches(current, target)) active.piSessionState = "active";
            });
            await drainSteering(ticketId, target);
          },
          onSessionInactive: async (target) => {
            if (!target) return;
            clearSteeringDrain(target);
            // Mark the exact live handle unavailable before an operator can submit
            // another steer during verification or result persistence.
            await update((state) => {
              const current = state.ticketRuns[ticketId];
              if (current?.runId !== target.runId) return;
              const active = current.activeRuns?.[target.stepId];
              if (active?.runId === workerRunId && active.attemptId === target.attemptId) active.piSessionState = "unavailable";
            });
            // Pausing intentionally retains this logical attempt and its queued work.
            // Every other session end makes its bound target terminal for steering.
            if (signal?.aborted && /run paused/i.test(String(signal.reason?.message || signal.reason || ""))) return;
            await update((state) => {
              const current = state.ticketRuns[ticketId];
              if (current?.runId !== target.runId) return;
              for (const record of current.steering?.records || []) {
                if (!["queued", "claimed"].includes(record.state) || record.runId !== target.runId || record.stepId !== target.stepId || record.attemptId !== target.attemptId) continue;
                failSteering(current, record.id, {
                  code: "target_replaced",
                  reason: "The bound Pi worker session ended before this steering delivery settled."
                });
              }
            });
          },
          onSteering: (delivery) => activity.onEvent({
            type: "steering_delivery", label: `Pi accepted steering ${delivery.steerId}`,
            steerId: delivery.steerId, instruction: delivery.instruction, acceptedAt: delivery.acceptedAt
          }),
          attemptId,
          signal
        });
        Object.assign(attemptEvidence, { report: result.report, rawOutput: result.rawOutput || "", sessionFile: result.sessionFile || null });
        signal?.throwIfAborted();
        const report = redactRecord(result.report);
        const acknowledgedSteerIds = [...new Set((report.acknowledgedSteerIds || []).map(String).filter(Boolean))];
        if (acknowledgedSteerIds.length) await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
          for (const steerId of acknowledgedSteerIds) {
            const record = current.steering?.records?.find((item) => item.id === steerId);
            if (!record || record.runId !== current.runId || record.stepId !== stepId || record.attemptId !== attemptId) continue;
            acknowledgeSteering(current, steerId, {
              evidence: { source: "worker_report", workerRunId, summary: report.summary, acknowledgedSteerIds }
            });
          }
        });
        const workerTrees = pendingVerification?.workerTrees || await snapshotRepositoryTrees(attemptRepos);
        const workerTree = pendingVerification?.workerTree || workerTrees.primary || await snapshotTree(cwd);
        const workerProofRoots = pendingVerification?.workerProofRoots || await snapshotProofRootMap(latest, currentStep);
        const attemptDiffs = await diffRepositoryTrees(attemptRepos, attemptBaseTrees, workerTrees);
        let checks = pendingVerification?.checks || { status: "skipped", command: null, summary: "No repository changes require a deterministic check.", output: "", repositories: [], failedRepositories: [] };
        if (!pendingVerification && currentStep.permission === "write" && report.status === "completed") {
          activity.onEvent({ type: "phase", label: "Running repository checks" });
          checks = await runChangedRepositoryChecks({
            ticketId, previewId: `${ticketId}:${stepId}`, cwd, signal,
            required: currentStep.requiresVisualEvidence, requiredVideo: currentStep.requiresVideoEvidence, stepId,
            repositories: attemptRepos, diffs: attemptDiffs, writeScope: workerWriteScope(currentStep)
          });
        }
        attemptEvidence.checks = checks;
        signal?.throwIfAborted();
        if (latest.workspace.vcs === "jj" && currentStep.permission === "write" && !currentStep.workspace?.isolated) {
          vcsChange = await snapshotJjChange(cwd);
          for (const repo of attemptRepos.filter((item) => (item.id || "primary") !== "primary")) {
            repositoryVcs[repo.id] = await snapshotJjChange(repo.cwd);
          }
        }
        const afterTrees = await snapshotRepositoryTrees(attemptRepos);
        const afterTree = afterTrees.primary || await snapshotTree(cwd);
        const afterProofRoots = await snapshotProofRootMap(readRun(ticketId), currentStep);
        const repositoryDiffs = await diffRepositoryTrees(attemptRepos, stepBaseTrees, afterTrees);
        const proofDiffs = [
          ...labelRepositoryDiffs(attemptRepos, repositoryDiffs),
          ...labeledProofRootDiffs(latest, currentStep, stepBaseProofRoots, afterProofRoots)
        ];
        const diff = aggregateProofDiffs(proofDiffs);
        const attemptProofDiffs = [
          ...labelRepositoryDiffs(attemptRepos, attemptDiffs),
          ...labeledProofRootDiffs(latest, currentStep, beforeProofRoots, workerProofRoots)
        ];
        const attemptDiff = aggregateProofDiffs(attemptProofDiffs);
        const checkDiffs = await diffRepositoryTrees(attemptRepos, workerTrees, afterTrees);
        const checkDiff = aggregateProofDiffs(labelRepositoryDiffs(attemptRepos, checkDiffs));
        const reviewNotes = normalizeReviewNotes(result.reviewNotes, diff, currentStep.reviewNotes);
        const reviewBudget = diffReviewBudget(currentStep, diff);
        const runawayDiff = reviewBudgetRequiresRollback(reviewBudget);
        const violations = currentStep.permission !== "write"
          ? attemptDiff.files
          : attemptRepos.flatMap((repo) => filesOutsideWriteScope(repo, attemptDiffs[repo.id || "primary"]?.files || [], workerWriteScope(currentStep)));
        const artifactInput = { runId: latest.runId, stageId: "implement", stepId, attemptId };
        const reviewNotesArtifact = reviewNotes.length ? await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "review-notes.json", content: JSON.stringify(reviewNotes, null, 2), kind: "review-notes" }) : null;
        const artifacts = [
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: currentStep.expectedArtifacts[0] || `${currentStep.id}-result.md`, content: result.output, kind: "agent-output" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "prompt.md", content: result.prompt, kind: "agent-prompt" }),
          await persistArtifact(dataDir, latest.ticket, { ...artifactInput, name: "context.json", content: JSON.stringify({ profile: latest.stageProfiles[currentStep.role] || latest.stageProfiles.implementation, contextPolicy: currentStep.contextPolicy, permission: currentStep.permission, writeScope: currentStep.writeScope, skills: currentStep.skills, references: currentStep.references, requirementIds: currentStep.requirementIds, capabilityIds: currentStep.capabilityIds, deltaIds: currentStep.deltaIds, productContext: currentStep.productContext, artifacts: contextArtifacts.map(({ id, name, path }) => ({ id, name, path })) }, null, 2), kind: "context-manifest" })
        ];
        Object.assign(attemptEvidence, { diff: attemptDiff, checkDiff, aggregateDiff: diff, reviewNotes, reviewBudgetResult: reviewBudget, violations, vcsChange, artifacts });
        const workerGate = workerReportCheckpoint(currentStep, report);
        if (steeringCheckpointPending(readRun(ticketId))) {
          const attemptActivity = activity.snapshot();
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
            if (!steeringCheckpointPending(current)) return;
            const target = findNode(current.plan, stepId);
            target.status = "needs_input";
            target.diff = diff;
            target.reviewNotes = reviewNotes;
            target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
            target.reviewBudgetResult = reviewBudget;
            if (vcsChange) target.vcsChange = vcsChange;
            if (Object.keys(repositoryVcs).length) target.repositoryVcs = repositoryVcs;
            target.repositoryDiffs = repositoryDiffs;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            materializeActiveAttempt(target, current.activeRuns[stepId] || { runId: workerRunId, attemptId, startedAt }, {
              status: "needs_input", reason: "steering_checkpoint", phase: "worker_execution",
              activity: attemptActivity, rawOutput: result.rawOutput, report, verification: { checks }, violations,
              feedback: nextFeedback || null, diff: attemptDiff, vcsChange,
              artifactRefs: artifacts.map(({ id, kind, name }) => ({ id, kind, name }))
            });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            setStage(current, "implement", "blocked", current.checkpoint.title);
          });
          await mirrorCheckpoint(ticketId);
          return;
        }
        // Size is a review decision, not evidence of invalid code. Preserve the
        // worker output while blocking further work until the budget is approved.
        if (violations.length || runawayDiff || (report.status !== "completed" && !workerGate)) {
          const error = redactText(violations.length
            ? `Changes outside permission or write scope: ${violations.join(", ")}`
            : runawayDiff
              ? `Review budget approval required; worktree preserved: ${reviewBudget.reasons.join("; ")}`
              : (report.request || report.summary || "Worker needs attention"));
          const attemptActivity = activity.snapshot();
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
            const target = findNode(current.plan, stepId);
            target.status = "needs_attention";
            target.checks = checks;
            target.diff = diff;
            target.reviewNotes = reviewNotes;
            target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
            target.reviewBudgetResult = reviewBudget;
            if (vcsChange) target.vcsChange = vcsChange;
            if (Object.keys(repositoryVcs).length) target.repositoryVcs = repositoryVcs;
            target.repositoryDiffs = repositoryDiffs;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            target.lastError = error;
materializeActiveAttempt(target, current.activeRuns[stepId] || { runId: workerRunId, attemptId, startedAt }, {
              status: "needs_attention", reason: "worker_report_or_scope_failure", error, phase: "worker_execution",
              activity: attemptActivity, rawOutput: result.rawOutput, report, verification: { checks }, violations,
              feedback: nextFeedback || null, diff: attemptDiff, vcsChange,
              artifactRefs: artifacts.map(({ id, kind, name }) => ({ id, kind, name }))
            });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            current.status = "needs_attention";
            current.lastError = error;
            current.checkpoint = { id: randomUUID(), kind: "needs_attention", source: "execution", stepId, title: runawayDiff ? "Review budget approval required" : "Worker needs attention", prompt: error, createdAt: new Date().toISOString(), questions: [] };
            setStage(current, "implement", "blocked", error);
          });
          await persistProofSnapshot(ticketId, { stageId: "implement", stepId, attemptId, name: "proof-map-worker.json" });
          return;
        }
        if (workerGate) {
          const attemptActivity = activity.snapshot();
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
            const target = findNode(current.plan, stepId);
            target.status = workerGate.kind;
            target.checks = checks;
            target.diff = diff;
            target.reviewNotes = reviewNotes;
            target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
            target.reviewBudgetResult = reviewBudget;
            if (vcsChange) target.vcsChange = vcsChange;
            if (Object.keys(repositoryVcs).length) target.repositoryVcs = repositoryVcs;
            target.repositoryDiffs = repositoryDiffs;
            target.sessionFile = result.sessionFile;
            target.artifacts = [artifacts[0]];
            target.lastError = null;
materializeActiveAttempt(target, current.activeRuns[stepId] || { runId: workerRunId, attemptId, startedAt }, {
              status: workerGate.kind, reason: "worker_checkpoint", phase: "worker_execution",
              activity: attemptActivity, rawOutput: result.rawOutput, report, verification: { checks }, violations,
              feedback: nextFeedback || null, diff: attemptDiff, vcsChange,
              artifactRefs: artifacts.map(({ id, kind, name }) => ({ id, kind, name }))
            });
            current.artifacts.push(...artifacts);
            delete current.activeRuns[stepId];
            current.status = workerGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...workerGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", workerGate.title);
          });
          await persistProofSnapshot(ticketId, { stageId: "implement", stepId, attemptId, name: "proof-map-worker.json" });
          await mirrorCheckpoint(ticketId);
          return;
        }
        const focusFindings = pendingVerification?.focusFindings
          ?? (feedback ? [...humanProofFindings(feedback), ...previousFindings]
            : verificationFocusFindings(previousFindings.length ? nextFeedback : "", previousFindings));
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
          const target = findNode(current.plan, stepId);
          target.status = "verifying";
          target.pendingVerification = {
            // Preserve operator corrections too, so a resumed review stays focused.
            afterTree, afterTrees, afterProofRoots, attemptBaseTree, attemptBaseTrees, workerTree, workerTrees, workerProofRoots, checks, round, previousFindings, focusFindings,
            result: { report, output: result.output, prompt: result.prompt, rawOutput: result.rawOutput, sessionFile: result.sessionFile, reviewNotes: result.reviewNotes }
          };
          current.status = "verifying";
          current.activeRuns[stepId].lastEvent = `Fresh verification round ${round}`;
          current.activeRuns[stepId].lastEventAt = new Date().toISOString();
          current.activeRuns[stepId].warning = false;
          setStage(current, "implement", "active", `Fresh verification: ${currentStep.title}`);
        });
const design = await artifactText([...latest.artifacts].reverse().find((artifact) => artifact.kind === "architecture"));
        activity.onEvent({ type: "phase", label: `Verifying ${currentStep.title}` });
        const deterministicReview = repositoryCheckReview(checks);
        const verification = deterministicReview.findings.length ? {
          summary: deterministicReview.summary,
          findings: deterministicReview.findings,
          rawOutput: checks.output,
          sessionFile: null,
          checks
        } : {
          ...(await verifyStep({
            cwd, ticket: latest.ticket, plan: latest.plan, step: currentStep,
            access: latest.access,
            design, diff, output: result.output, checks,
            proofMap: projectProofMap(readRun(ticketId)),
            artifacts: await hydrateArtifacts(readRun(ticketId).artifacts.filter((artifact) => artifact.kind !== "visual-evidence" || (checks.evidence || []).some((item) => item.path === artifact.path)), dataDir),
            runId: latest.runId, round,
            focusFindings,
            images: await evidenceImages(checks.evidence),
            profile: latest.stageProfiles.verification,
            onEvent: activity.onEvent,
            signal
          })),
          checks
        };
        signal?.throwIfAborted();
        const verificationArtifact = await persistArtifact(dataDir, latest.ticket, {
          runId: latest.runId, stageId: "verify", stepId, attemptId, name: "verification.json",
          content: JSON.stringify(verification, null, 2), kind: "step-verification"
        });
        const findings = actionableFindings([verification]);
        let commitMessage = null;
        let supervisorReview = null;
        if (!findings.length && latest.sessionFile) {
          try {
            activity.onEvent({ type: "phase", label: "Supervisor reviewing worker report" });
            supervisorReview = retainDurableRecord(await reviewWorkerReport({
              cwd: latest.workspace.cwd, sessionFile: latest.sessionFile, sessionKey: `${latest.ticket.id}-${latest.runId}`,
              step: currentStep, report, diff,
              profile: latest.stageProfiles.architecture,
              onEvent: activity.onEvent,
              signal
            }));
          } catch (error) {
            if (signal?.aborted) throw error;
            supervisorReview = { reply: redactText(error.message), checkpoints: [], error: redactText(error.message) };
          }
        }
        const supervisorGate = supervisorReviewCheckpoint(currentStep, supervisorReview);
        if (!findings.length && !supervisorGate) {
          activity.onEvent({ type: "phase", label: "Drafting the requirement-linked commit" });
          commitMessage = await generateCommitMessage({
            cwd, ticket: latest.ticket, step: currentStep, diff, runId: latest.runId,
            profile: latest.stageProfiles.commit, signal
          });
        }
        const attemptActivity = activity.snapshot();
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (!currentAttempt(current, { runId: run.runId, stepId, workerRunId, attemptId })) return;
          const target = findNode(current.plan, stepId);
          target.checks = checks;
          target.diff = diff;
          target.reviewNotes = reviewNotes;
          target.reviewNotesArtifact = reviewNotesArtifact ? { id: reviewNotesArtifact.id, name: reviewNotesArtifact.name, path: reviewNotesArtifact.path, createdAt: reviewNotesArtifact.createdAt } : null;
          target.reviewBudgetResult = reviewBudget;
          if (vcsChange) target.vcsChange = vcsChange;
          if (Object.keys(repositoryVcs).length) target.repositoryVcs = repositoryVcs;
          target.repositoryDiffs = repositoryDiffs;
          target.sessionFile = result.sessionFile;
          if (supervisorReview) target.supervisorReview = { reply: supervisorReview.reply, error: supervisorReview.error || null, at: new Date().toISOString() };
          target.artifacts = [artifacts[0], verificationArtifact];
materializeActiveAttempt(target, current.activeRuns[stepId] || { runId: workerRunId, attemptId, startedAt }, {
            status: findings.length ? "verification_failed" : "verified", reason: findings.length ? "verification_findings" : "verification_complete", phase: "verification",
            activity: attemptActivity, rawOutput: result.rawOutput, report, verification, violations,
            feedback: nextFeedback || null, diff: attemptDiff, checkDiff, aggregateDiff: diff, vcsChange, reviewNotes, reviewBudgetResult: reviewBudget,
            artifactRefs: [...artifacts, verificationArtifact].map(({ id, kind, name }) => ({ id, kind, name }))
          });
          current.artifacts.push(...artifacts, verificationArtifact);
          applyStepProof(current, stepId, verification.criterionResults, checks.evidence);
          delete target.pendingVerification;
          delete current.activeRuns[stepId];
        });
        pendingVerification = null;
        await persistProofSnapshot(ticketId, { stageId: "verify", stepId, attemptId, name: "proof-map-verification.json" });
        if (supervisorGate && !findings.length) {
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            const target = findNode(current.plan, stepId);
            target.status = supervisorGate.kind;
            current.status = supervisorGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...supervisorGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", supervisorGate.title);
          });
          await mirrorCheckpoint(ticketId);
          return;
        }
        if (!findings.length) {
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            const target = findNode(current.plan, stepId);
            target.status = "review_ready";
            target.commitMessage = commitMessage;
            if (target.reviewBudgetResult?.exceeded) current.auto = false;
            current.status = "awaiting_step_review";
            current.checkpoint = { id: randomUUID(), kind: "step_review", stepId, title: `${target.reviewBudgetResult?.exceeded ? "Oversized review required" : "Review"}: ${target.title}`, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", target.reviewBudgetResult?.exceeded ? target.reviewBudgetResult.reasons.join("; ") : `${target.title} is verified and awaiting your review`);
          });
          return;
        }
        const decision = shouldPauseCorrection({ round, findings, previousFingerprint });
        if (decision.pause) {
          const pauseReason = correctionPauseReason(decision.reason, findings);
          await update((state) => {
            const current = state.ticketRuns[ticketId];
            const target = findNode(current.plan, stepId);
            target.status = "needs_attention";
            target.lastError = pauseReason;
            current.status = "needs_attention";
            current.lastError = pauseReason;
            current.checkpoint = {
              id: randomUUID(), kind: "needs_attention", title: "Correction stalled",
              prompt: pauseReason, stepId, source: "verification", createdAt: new Date().toISOString()
            };
            setStage(current, "implement", "blocked", pauseReason);
          });
          return;
        }
        // The next correction may change any criterion on this step. Invalidate all
        // of them so an omitted follow-up report cannot retain pre-fix proof.
        await update((state) => {
          const current = state.ticketRuns[ticketId];
          if (current.proofMap) current.proofMap = invalidateProof(current.proofMap, stepCriterionIds(current, stepId), { reason: "Automatic correction after verification findings." });
        });
        await persistProofSnapshot(ticketId, { stageId: "implement", stepId, attemptId, name: "proof-map-automatic-correction.json" });
        previousFingerprint = decision.fingerprint;
        previousFindings = findings;
        nextFeedback = `Fresh verification found these actionable issues. Fix them with the smallest focused change, then run deterministic checks:\n\n${JSON.stringify(findings, null, 2)}`;
      }
    } catch (error) {
      if (signal?.aborted) return;
      const providerWait = providerWaitCheckpoint(error);
      await update((state) => {
        const current = state.ticketRuns[ticketId];
        if (current?.runId !== run.runId) return;
        const failed = findNode(current.plan, stepId);
        if (!failed) return;
        const active = current.activeRuns[stepId] || {};
        const activity = active.activity || {};
        const preserveSteeringCheckpoint = steeringCheckpointPending(current);
        const failedAt = new Date().toISOString();
        // A worker failure belongs to the logical attempt that accepted steering;
        // never invent a sequential ID that would orphan its delivery ledger.
        const attemptId = active.attemptId || failed.activeAttempt?.id;
        if (attemptId) failed.activeAttempt = {
          ...(failed.activeAttempt || {}), id: attemptId,
          status: preserveSteeringCheckpoint || providerWait ? "interrupted" : "failed",
          workerRunId: null,
          startedAt: failed.activeAttempt?.startedAt || active.startedAt || null,
          ...(providerWait ? { interruptedAt: failedAt } : { failedAt })
        };
        // A post-completion transition can fail after its active record was removed;
        // only materialize when there is still a mutable worker to snapshot.
        if (active.runId) materializeActiveAttempt(failed, active, {
          status: preserveSteeringCheckpoint ? "needs_input" : providerWait ? "interrupted" : "failed",
          reason: preserveSteeringCheckpoint ? "steering_checkpoint_worker_failure" : "worker_failure",
          error: error.message, phase: "worker_execution", activity, rawOutput: attemptEvidence?.rawOutput || "", report: attemptEvidence?.report,
          ...(attemptEvidence?.checks ? { checks: attemptEvidence.checks, verification: { checks: attemptEvidence.checks } } : {}),
          ...(attemptEvidence?.diff ? { diff: attemptEvidence.diff } : {}),
          ...(attemptEvidence?.checkDiff ? { checkDiff: attemptEvidence.checkDiff } : {}),
          ...(attemptEvidence?.aggregateDiff ? { aggregateDiff: attemptEvidence.aggregateDiff } : {}),
          ...(attemptEvidence?.reviewNotes ? { reviewNotes: attemptEvidence.reviewNotes } : {}),
          ...(attemptEvidence?.reviewBudgetResult ? { reviewBudgetResult: attemptEvidence.reviewBudgetResult } : {}),
          ...(attemptEvidence?.artifacts ? { artifactRefs: attemptEvidence.artifacts.map(({ id, kind, name }) => ({ id, kind, name })) } : {})
        });
        if (attemptEvidence?.aggregateDiff) failed.diff = attemptEvidence.aggregateDiff;
        if (attemptEvidence?.reviewNotes) failed.reviewNotes = attemptEvidence.reviewNotes;
        failed.status = preserveSteeringCheckpoint ? "needs_input" : providerWait ? "interrupted" : "failed";
        failed.lastError = redactText(error.message);
        delete current.activeRuns[stepId];
        if (preserveSteeringCheckpoint) {
          // The withheld instruction is an operator decision that remains valid
          // even when its bound worker fails before the decision is answered.
          setStage(current, "implement", "blocked", current.checkpoint.title);
        } else {
          current.status = providerWait ? "paused" : "needs_attention";
          current.lastError = redactText(error.message);
          current.checkpoint = { id: randomUUID(), ...(providerWait || { kind: "needs_attention", title: `Step failed: ${failed.title}`, prompt: redactText(error.message) }), stepId, source: "execution", createdAt: new Date().toISOString() };
          setStage(current, "implement", providerWait ? "paused" : "blocked", redactText(error.message));
        }
      });
    }
  })().finally(async () => {
    // Cancellation and shutdown await this worker promise. Flush the coalesced
    // activity write before either lifecycle path snapshots and clears activeRuns.
    await activeActivity?.flush();
    if (controller.signal.aborted && !parentSignal?.aborted) await update((state) => {
      const current = state.ticketRuns[ticketId];
      const active = current?.activeRuns?.[stepId];
      const target = findNode(current?.plan, stepId);
      if (!active || !target || !ownedIdentity || !currentAttempt(current, ownedIdentity)) return;
      materializeActiveAttempt(target, active, { status: "interrupted", reason: "coordination_pause", phase: "coordination" });
      target.status = "interrupted";
      if (target.activeAttempt) target.activeAttempt.status = "interrupted";
      delete current.activeRuns[stepId];
    });
    if (runtime.stepControllers.get(key) === controller) runtime.stepControllers.delete(key);
    if (activeSteps.get(key) === work) activeSteps.delete(key);
  });
  activeSteps.set(key, work);
  return work;
}

function acceptStep(ticketId, stepId) {
  runtime.stepAcceptances ||= new Map();
  const key = `${ticketId}:${stepId}`;
  if (runtime.stepAcceptances.has(key)) return runtime.stepAcceptances.get(key);
  const work = acceptStepWork(ticketId, stepId).finally(() => {
    if (runtime.stepAcceptances.get(key) === work) runtime.stepAcceptances.delete(key);
  });
  runtime.stepAcceptances.set(key, work);
  return work;
}

async function acceptStepWork(ticketId, stepId) {
  const current = readRun(ticketId);
  const step = findNode(current.plan, stepId);
  if (coordinationBlockedSteps(current).has(stepId)) throw new Error("Resolve the coordination conflict or plan revision before accepting this step");
  if (!step || step.status !== "review_ready") throw new Error("This step is not ready for review");
  const eligibility = proofGate(current, { stepId });
  if (!eligibility.eligible) throw new Error(proofGateError(eligibility));
  const message = step.commitMessage || `feat: ${step.title}\n\nWhy: ${step.description || step.title}\nRequirement: ${step.requirementIds.join(", ") || step.acceptanceCriteria.join("; ") || "Complete the approved execution-plan slice"}`;
  let commit;
  let vcsChange = step.vcsChange || null;
  const noChanges = step.diff?.available && step.diff.files?.length === 0;
  const repos = gitRepositoriesForStep(current, step);
  const persistAcceptance = (patch) => update((state) => {
    const target = findNode(state.ticketRuns[ticketId].plan, stepId);
    if (patch.workspaceCommit !== undefined) target.workspaceCommit = patch.workspaceCommit;
    if (patch.vcsChange) target.vcsChange = patch.vcsChange;
    if (patch.commit) target.commit = patch.commit;
    if (patch.workspaceCommits) target.workspaceCommits = { ...(target.workspaceCommits || {}), ...patch.workspaceCommits };
    if (patch.acceptedRepositories) target.acceptedRepositories = { ...(target.acceptedRepositories || {}), ...patch.acceptedRepositories };
    if (patch.repositoryVcs) target.repositoryVcs = { ...(target.repositoryVcs || {}), ...patch.repositoryVcs };
  }, { publish: false });
  const liveStep = () => findNode(readRun(ticketId).plan, stepId);
  if (!noChanges && current.workspace.vcs === "jj" && step.permission === "write" && !step.workspace?.isolated) {
    for (const repo of repos) {
      const id = repo.id || "primary";
      const already = liveStep().acceptedRepositories?.[id];
      if (already?.commit) {
        if (id === "primary") {
          commit = already.commit;
          vcsChange = already.vcsChange || vcsChange;
        }
        continue;
      }
      const previous = id === "primary" ? (liveStep().vcsChange || vcsChange) : liveStep().repositoryVcs?.[id];
      if (!previous?.changeId) throw new Error(id === "primary" ? "The editable Jujutsu change is missing for this step" : `The editable Jujutsu change is missing for ${repo.displayPath || repo.id}`);
      const acceptedChange = await acceptJjChange(repo.cwd, { changeId: previous.changeId, message, bookmark: repo.branch });
      const record = { commit: acceptedChange.commitId, vcsChange: acceptedChange };
      await persistAcceptance({
        acceptedRepositories: { [id]: record },
        ...(id === "primary" ? { vcsChange: acceptedChange, commit: acceptedChange.commitId } : { repositoryVcs: { [id]: acceptedChange } })
      });
      if (id === "primary") {
        vcsChange = acceptedChange;
        commit = acceptedChange.commitId;
      }
    }
  } else if (!noChanges && step.workspace?.isolated) {
    for (const repo of repos) {
      const id = repo.id || "primary";
      const latest = liveStep();
      if (latest.acceptedRepositories?.[id]?.commit) {
        if (id === "primary") commit = latest.acceptedRepositories[id].commit;
        continue;
      }
      let workspaceCommit = latest.workspaceCommits?.[id] || (id === "primary" ? latest.workspaceCommit : repo.workspaceCommit);
      if (!workspaceCommit) {
        workspaceCommit = await commitWorkspace(repo.cwd, message);
        await persistAcceptance({
          workspaceCommits: { [id]: workspaceCommit },
          ...(id === "primary" ? { workspaceCommit } : {})
        });
      }
      const targetCwd = id === "primary"
        ? current.workspace.cwd
        : (current.repositories || []).find((item) => item.id === id)?.cwd;
      let accepted = workspaceCommit;
      if (workspaceCommit && targetCwd && resolve(targetCwd) !== resolve(repo.cwd)) {
        accepted = await cherryPickCommit(targetCwd, workspaceCommit);
      }
      await persistAcceptance({ acceptedRepositories: { [id]: { commit: accepted || null } } });
      if (id === "primary") commit = accepted;
    }
  } else if (!noChanges) {
    for (const repo of repos) {
      const id = repo.id || "primary";
      const already = liveStep().acceptedRepositories?.[id];
      if (already && Object.hasOwn(already, "commit")) {
        if (id === "primary") commit = already.commit;
        continue;
      }
      const accepted = await commitWorkspace(repo.cwd, message);
      await persistAcceptance({
        acceptedRepositories: { [id]: { commit: accepted || null } },
        ...(id === "primary" && accepted ? { commit: accepted } : {})
      });
      if (id === "primary") commit = accepted;
    }
  }
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    const accepted = findNode(run.plan, stepId);
    accepted.status = "accepted";
    accepted.acceptedAt = new Date().toISOString();
    if (commit) accepted.commit = commit;
    if (vcsChange) accepted.vcsChange = vcsChange;
    run.status = "running";
    run.checkpoint = null;
  });
}


 return { executeStep, acceptStep };
}
