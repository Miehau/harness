import { randomUUID } from "node:crypto";
import { cleanupLegacyReviewArtifacts, hydrateArtifact, persistArtifact } from "./artifacts.js";
import { aggregateProofDiffs, diffFileSnapshots, diffTrees, extraProofRoots, labelDiff, labelRepositoryDiffs, labeledProofRootDiffs, repositoryBaselines, snapshotProofPath, snapshotProofRootMap, snapshotTree } from "./git.js";
import { commitWorkspace, diffRepositoryTrees, gitRepositoriesForStep, snapshotRepositoryTrees } from "./worktrees.js";
import { flattenSteps } from "./plan.js";
import { actionableFindings, correctionPauseReason, correctionWindowRound, executionFailure, finalReviewFixFeedback, finalReviewFixStep, finalReviewSequence, humanProofFindings, pendingReviewAttempt, pendingReviewFix, recoverableCleanReview, refreshedReviewFindings, reviewFixConstraints, reviewFixImages, reviewScopeExpanded, shouldPauseCorrection, storedFindingsFingerprint, unaddressedReviewClusters, unresolvedReviewFindings } from "./execution.js";
import { applyIndependentProofReports, applyProofReports, invalidateProof, projectProofMap, proofGate, proofGateError } from "./proof-map.js";
import { retainReviewRecord } from "./redaction.js";
import { setStage } from "./run-status.js";
import { findingsFingerprint } from "./review-findings.js";
import { assertProofRevision, captureProofRevision } from "./proof-revision.js";
import { planRequiresVisualEvidence, verifyStageEvidenceError } from "./visual-evidence.js";

export function createFinalReviewRunner({ state, checks, worker, activity, artifacts, proof }) {
  const { runChanged: runChangedRepositoryChecks, repositoryCheckReview } = checks;
  const { run: runContainedWorker, updateProductContext, evidenceImages, reviewTicket } = worker;
  const { capture: captureStageActivity } = activity;
  const { dataDir, hydrate: hydrateArtifacts } = artifacts;
  const { snapshot: persistProofSnapshot } = proof;
  const readRun = (ticketId) => { const run = state.read().ticketRuns[ticketId]; if (!run) throw new Error("Ticket run not found"); return run; };
  const update = state.update;
  const ownedRun = (ticketId, runId, signal) => {
    const run = state.read().ticketRuns[ticketId];
    return !signal?.aborted && run?.runId === runId ? run : null;
  };
  const reviewOutcome = (ticketId, signal) => ({ kind: signal?.aborted ? "aborted" : "superseded", ticketId });
async function applyFinalReviewFix({ ticketId, round, findings, sessionFile = null, restartFeedback = "", reviewImages, verificationBaseTree, activity, signal, rootCauseClusters = [] }) {
  const current = readRun(ticketId);
  const fixArtifactName = `review-fixes-round-${round}.md`;
  const fixStep = finalReviewFixStep(round, findings, rootCauseClusters, restartFeedback);
  const review = (current.reviews || []).find((item) => item.round === round) || current.reviews?.at(-1);
  const reviewId = review?.reviewId;
  const fixerId = randomUUID();
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    const target = run?.runId === current.runId && run.reviews?.find((item) => item.round === round && item.reviewId === reviewId);
    if (!target) return;
    target.fix = { ...target.fix, fixerId, rootCauseClusters, startedAt: new Date().toISOString() };
    run.status = "fixing";
    Object.assign(setStage(run, "verify", "active", `Fixing ${findings.length} actionable review finding${findings.length === 1 ? "" : "s"} · round ${round}`), { activity: activity.snapshot() });
  });
  const beforeFix = await snapshotTree(current.workspace.cwd);
  const checks = review?.finalChecks || review?.reviews?.find((item) => item.role === "deterministic")?.checks || current.finalChecks || {};
  const evidencePaths = new Set((checks.evidence || []).map((item) => item.path));
  const repositories = gitRepositoriesForStep(current);
  const beforeFixTrees = await snapshotRepositoryTrees(repositories);
  const beforeFixProofRoots = await snapshotProofRootMap(current, null);
  const reviewContext = {
    ticket: current.ticket,
    plan: current.plan,
    artifacts: await hydrateArtifacts(current.artifacts.filter((artifact) => [
      "requirements", "feature-brief", "product-context-snapshot", "implementation-delta", "architecture",
      "agent-output", "step-verification", "product-context-update", "visual-evidence"
    ].includes(artifact.kind) && (artifact.kind !== "visual-evidence" || evidencePaths.has(artifact.path))), dataDir),
    diff: aggregateProofDiffs([
      ...labelRepositoryDiffs(repositories, await diffRepositoryTrees(repositories, repositoryBaselines(current, repositories), beforeFixTrees)),
      ...labeledProofRootDiffs(current, null, current.baselineProofRoots || beforeFixProofRoots, beforeFixProofRoots)
    ]),
    checks,
    proofMap: projectProofMap(current),
    focusFindings: findings,
    operatorFeedback: restartFeedback
  };
  const result = await runContainedWorker({
    ticketId, stepId: fixStep.id,
    cwd: current.workspace.cwd, plan: current.plan, step: fixStep, artifacts: [], proofMap: projectProofMap(current),
    reviewContext,
    images: reviewFixImages(sessionFile, findings, reviewImages), forkSessionFile: null, resumeSessionFile: sessionFile,
    feedback: sessionFile ? finalReviewFixFeedback(findings) : "", runId: current.runId,
    profile: current.stageProfiles.implementation,
    onEvent: (event) => activity.onEvent(event, "review fixer"),
    onSessionFile: (nextSessionFile) => update((state) => {
      const run = state.ticketRuns[ticketId];
      const target = !signal?.aborted && run?.runId === current.runId && run.reviews?.find((item) => item.round === round && item.reviewId === reviewId && item.fix?.fixerId === fixerId);
      if (!target) return;
      target.fix = { ...target.fix, sessionFile: nextSessionFile, rootCauseClusters, startedAt: target.fix?.startedAt || new Date().toISOString() };
    }),
    signal
  });
  signal?.throwIfAborted();
  const afterFix = await snapshotTree(current.workspace.cwd);
  const fixDiff = await diffTrees(current.workspace.cwd, beforeFix, afterFix);
  const verificationDiffAfterFix = await diffTrees(current.workspace.cwd, verificationBaseTree, afterFix);
  if (result.report.status !== "completed") {
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      const review = !signal?.aborted && run?.runId === current.runId && run.reviews?.find((item) => item.round === round && item.reviewId === reviewId && item.fix?.fixerId === fixerId);
      if (!review) return;
      Object.assign(setStage(run, "verify", "blocked", result.report.request || result.report.summary || "Review fixer needs attention"), { diff: verificationDiffAfterFix });
      review.fix = { ...review.fix, report: result.report, diff: fixDiff, rootCauseClusters, sessionFile: result.sessionFile || review.fix?.sessionFile || sessionFile, createdAt: new Date().toISOString() };
      run.status = "needs_attention";
      run.checkpoint = { id: randomUUID(), kind: "review_blocked", title: "Review fixer needs attention", findings, createdAt: new Date().toISOString() };
    });
    return false;
  }
  const fixArtifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: fixArtifactName, content: result.output, stageId: `review-round-${round}`, kind: "review-fix"
  });
  let adopted = false;
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    const review = !signal?.aborted && run?.runId === current.runId && run.reviews?.find((item) => item.round === round && item.reviewId === reviewId && item.fix?.fixerId === fixerId);
    if (!review) return;
    adopted = true;
    run.artifacts.push(fixArtifact);
    review.fix = { ...review.fix, report: result.report, diff: fixDiff, artifact: fixArtifact, rootCauseClusters, sessionFile: result.sessionFile || review.fix?.sessionFile || sessionFile };
    run.status = "reviewing";
    Object.assign(setStage(run, "verify", "active", `Review round ${round + 1} follows focused fixes`), { activity: activity.snapshot(), diff: verificationDiffAfterFix });
  });
  return adopted;
}

async function completeCleanReview({ ticketId, current, round, checks, diff, activity, signal, proofRevision = null }) {
  const runId = current.runId;
  let latest = ownedRun(ticketId, runId, signal);
  if (!latest) return reviewOutcome(ticketId, signal);
  const eligibility = proofGate(latest);
  if (!eligibility.eligible) throw new Error(proofGateError(eligibility));
  if (planRequiresVisualEvidence(current.plan)) {
    const blocked = verifyStageEvidenceError({
      ...current,
      ticket: current.ticket,
      runId: current.runId,
      plan: current.plan,
      artifacts: (readRun(ticketId).artifacts || [])
    }, { media: checks.evidence });
    if (blocked) throw new Error(blocked);
  }
  await commitWorkspace(current.workspace.cwd, `fix: resolve independent review findings\n\nWhy: The accepted ticket must pass the final combined review.\nRequirement: ${flattenSteps(current.plan).flatMap((step) => step.requirementIds).filter((id, index, all) => all.indexOf(id) === index).join(", ") || "Complete every approved ticket requirement"}`);
  latest = ownedRun(ticketId, runId, signal);
  if (!latest) return reviewOutcome(ticketId, signal);
  let contextArtifact = null;
  let contextContent = null;
  let handoffActivity = null;
  if (current.ticket.source !== "local") {
    const currentContextArtifact = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
    const currentContext = currentContextArtifact ? (await hydrateArtifact(currentContextArtifact, dataDir)).content : "";
    const contextArtifacts = await hydrateArtifacts(current.artifacts.filter((artifact) => ["requirements", "implementation-delta", "architecture", "agent-output", "step-verification"].includes(artifact.kind) || artifact.id === current.uiProposal?.artifactId), dataDir);
    handoffActivity = captureStageActivity(ticketId, "handoff", current.runId);
    contextContent = await updateProductContext({
      cwd: current.workspace.cwd, ticket: current.ticket, currentContext,
      artifacts: contextArtifacts,
      diff, runId: current.runId, profile: current.stageProfiles.handoff, onEvent: handoffActivity.onEvent, signal
    });
    signal?.throwIfAborted();
    if (!contextContent.trim()) throw new Error("Product context update was empty");
    if (!ownedRun(ticketId, runId, signal)) return reviewOutcome(ticketId, signal);
    contextArtifact = await persistArtifact(dataDir, current.ticket, {
      runId: current.runId, name: "product-context-update.md", content: contextContent,
      stageId: "handoff", kind: "product-context-update"
    });
  }
  const finalEvidencePaths = new Set((checks.evidence || []).map((item) => item.path));
  latest = ownedRun(ticketId, runId, signal);
  if (!latest) return reviewOutcome(ticketId, signal);
  const media = (latest.artifacts || [])
    .filter((artifact) => artifact.kind === "visual-evidence" && finalEvidencePaths.has(artifact.path))
    .map(({ id, name, path, summary, mediaType, mediaKind, stageId, stepId, boundTicketId, boundRunId }) => ({
      id, name, path, summary, mediaType, mediaKind, stageId, stepId, boundTicketId, boundRunId
    }));
  const finalChecks = {
    status: checks.status, command: checks.command || null, summary: checks.summary || "", durationMs: checks.durationMs || null,
    evidence: (checks.evidence || []).map(({ name, path, viewport, url }) => ({ name, path, viewport, url }))
  };
  const videoRequired = flattenSteps(current.plan).some((step) => step.requiresVideoEvidence);
  if (proofRevision) await assertProofRevision(latest, proofRevision);
  if (!ownedRun(ticketId, runId, signal)) return reviewOutcome(ticketId, signal);
  if (current.ticket.source === "local") {
    let adopted = false;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (signal?.aborted || run?.runId !== runId) return;
      adopted = true;
      setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
      setStage(run, "handoff", "blocked", "Review final proof before integration");
      run.status = "awaiting_evidence_review";
      run.finalProofRevision = proofRevision;
      run.checkpoint = {
        id: randomUUID(), kind: "evidence_review", title: "Review final proof before integration",
        prompt: finalChecks.summary, finalChecks: { ...finalChecks, proofRevision }, proofRevision,
        media, evidenceArtifactIds: media.map((artifact) => artifact.id), videoRequired, createdAt: new Date().toISOString()
      };
    });
    return adopted ? { kind: "awaiting_evidence_review" } : reviewOutcome(ticketId, signal);
  }
  let adopted = false;
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    if (signal?.aborted || run?.runId !== runId) return;
    adopted = true;
    run.artifacts.push(contextArtifact);
    setStage(run, "verify", "completed", `Clean after ${round} independent review round${round === 1 ? "" : "s"}`).activity = activity.snapshot();
    setStage(run, "handoff", "blocked", "Review final proof before remote merge").activity = handoffActivity.snapshot();
    run.status = "awaiting_evidence_review";
    run.finalProofRevision = proofRevision;
    run.checkpoint = {
      id: randomUUID(), kind: "evidence_review", title: "Review final proof before remote merge",
      prompt: finalChecks.summary, finalChecks: { ...finalChecks, proofRevision }, proofRevision,
      media, evidenceArtifactIds: media.map((artifact) => artifact.id), videoRequired, productContext: contextContent, createdAt: new Date().toISOString()
    };
  });
  return adopted ? { kind: "awaiting_evidence_review" } : reviewOutcome(ticketId, signal);
}

async function finalReviewLoop(ticketId, signal) {
  signal?.throwIfAborted();
  const started = readRun(ticketId);
  const runId = started.runId;
  const removedReviewArtifacts = await cleanupLegacyReviewArtifacts(started.workspace.cwd);
  if (!ownedRun(ticketId, runId, signal)) return reviewOutcome(ticketId, signal);
  const activity = captureStageActivity(ticketId, "verify", started.runId);
  const implementationRepos = gitRepositoriesForStep(started);
  const implementationTrees = await snapshotRepositoryTrees(implementationRepos);
  const implementationTree = implementationTrees.primary || implementationTrees[implementationRepos[0]?.id || "primary"];
  const implementationDiffs = await diffRepositoryTrees(implementationRepos, repositoryBaselines(started, implementationRepos), implementationTrees);
  const implementationProofRoots = await snapshotProofRootMap(started, null);
  const implementationDiff = aggregateProofDiffs([
    ...labelRepositoryDiffs(implementationRepos, implementationDiffs),
    ...labeledProofRootDiffs(started, null, started.baselineProofRoots || implementationProofRoots, implementationProofRoots)
  ]);
  const verificationBaseTree = started.stages.find((stage) => stage.id === "verify")?.baseTree || implementationTree;
  let initialAdopted = false;
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    if (signal?.aborted || run?.runId !== runId) return;
    initialAdopted = true;
    Object.assign(setStage(run, "implement", "completed", `${flattenSteps(run.plan).length} implementation slices accepted`), { diff: implementationDiff });
    Object.assign(setStage(run, "verify", "active", "Independent reviewers are inspecting the combined implementation"), { baseTree: verificationBaseTree });
    run.status = "reviewing";
    run.checkpoint = null;
    run.reviews ||= [];
    if (removedReviewArtifacts.length) (run.harnessMigrations ||= []).push({
      at: new Date().toISOString(), kind: "legacy-review-artifact-cleanup", files: removedReviewArtifacts
    });
    const latestReview = run.reviews.at(-1);
    if (latestReview) {
      const previous = latestReview.actionableFindings || [];
      const refreshed = refreshedReviewFindings(latestReview);
      if (storedFindingsFingerprint(refreshed) !== storedFindingsFingerprint(previous)) {
        latestReview.actionableFindings = refreshed;
        latestReview.findingsRefreshedAt = new Date().toISOString();
        if (latestReview.fix?.report?.status === "completed" && reviewScopeExpanded(previous, refreshed)) delete latestReview.fix.report;
      }
    }
  });
  if (!initialAdopted) return reviewOutcome(ticketId, signal);
  const refreshedRun = readRun(ticketId);
  const cleanReview = recoverableCleanReview(refreshedRun);
  if (cleanReview && proofGate(refreshedRun).eligible && (!refreshedRun.proofRevisionVersion || cleanReview.proofRevision)) {
    if (cleanReview.proofRevision) await assertProofRevision(refreshedRun, cleanReview.proofRevision);
    const current = ownedRun(ticketId, runId, signal);
    if (!current) return reviewOutcome(ticketId, signal);
    return completeCleanReview({ ticketId, current, ...cleanReview, activity, signal, proofRevision: cleanReview.proofRevision || null });
  }
  const pendingFix = pendingReviewFix(refreshedRun.reviews);
  if (pendingFix) {
    const current = readRun(ticketId);
    const savedImages = await evidenceImages((current.artifacts || []).filter((artifact) => artifact.kind === "visual-evidence"));
    const rootCauseClusters = unaddressedReviewClusters(current.reviews);
    const restartFeedback = [reviewFixConstraints(current), pendingFix.restartFeedback].filter(Boolean).join("\n");
    if (!await applyFinalReviewFix({ ticketId, ...pendingFix, restartFeedback, reviewImages: savedImages, verificationBaseTree, activity, signal, rootCauseClusters })) return { kind: "blocked" };
  }
  const resumed = readRun(ticketId);
  // The sequence, unlike the display round list, survives verification restarts
  // and keeps final evidence locators immutable for the run.
  const firstRound = finalReviewSequence(resumed) + 1;
  const previousReview = resumed.reviews?.at(-1);
  let previousFingerprint = previousReview?.fix?.report?.status === "completed"
    ? findingsFingerprint(previousReview.actionableFindings || [])
    : "";
  for (let round = firstRound; ; round++) {
    signal?.throwIfAborted();
    const current = ownedRun(ticketId, runId, signal);
    if (!current) return reviewOutcome(ticketId, signal);
    let savedAttempt = pendingReviewAttempt(current, round);
    if (savedAttempt && !savedAttempt.proofRevision && current.proofRevisionVersion) {
      let cleared = false;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (signal?.aborted || run?.runId !== runId) return;
        cleared = true;
        delete run.pendingReviewAttempt;
      });
      if (!cleared) return reviewOutcome(ticketId, signal);
      savedAttempt = null;
    }
    let checks = savedAttempt?.checks;
    let diff = savedAttempt?.diff;
    let verificationDiff = savedAttempt?.verificationDiff;
    let proofRevision = savedAttempt?.proofRevision;
    if (!savedAttempt) {
      activity.onEvent({ type: "thinking", label: `Running deterministic checks · round ${round}` }, "checks");
      const combinedRepos = gitRepositoriesForStep(current);
      const preCheckTrees = await snapshotRepositoryTrees(combinedRepos);
      const changedVsBaseline = await diffRepositoryTrees(combinedRepos, repositoryBaselines(current, combinedRepos), preCheckTrees);
      checks = await runChangedRepositoryChecks({
        ticketId, previewId: `${ticketId}:combined`, signal,
        required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence),
        requiredVideo: flattenSteps(current.plan).some((step) => step.requiresVideoEvidence),
        repositories: combinedRepos, diffs: changedVsBaseline
      });
      signal?.throwIfAborted();
      const afterTrees = await snapshotRepositoryTrees(combinedRepos);
      const afterProofRoots = await snapshotProofRootMap(current, null);
      diff = aggregateProofDiffs([
        ...labelRepositoryDiffs(combinedRepos, await diffRepositoryTrees(combinedRepos, repositoryBaselines(current, combinedRepos), afterTrees)),
        ...labeledProofRootDiffs(current, null, current.baselineProofRoots || afterProofRoots, afterProofRoots)
      ]);
      verificationDiff = aggregateProofDiffs(labelRepositoryDiffs(combinedRepos, await diffRepositoryTrees(combinedRepos, { ...repositoryBaselines(current, combinedRepos), primary: verificationBaseTree }, afterTrees)));
      const coveredRun = ownedRun(ticketId, runId, signal);
      if (!coveredRun) return reviewOutcome(ticketId, signal);
      proofRevision = await captureProofRevision(coveredRun);
      let attemptAdopted = false;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (signal?.aborted || run?.runId !== runId) return;
        attemptAdopted = true;
        run.proofRevisionVersion = 1;
        run.pendingReviewAttempt = { round, checks, diff, verificationDiff, proofRevision, createdAt: new Date().toISOString() };
      });
      if (!attemptAdopted) return reviewOutcome(ticketId, signal);
    } else {
      activity.onEvent({ type: "thinking", label: `Resuming independent reviewers · round ${round}` }, "checks");
    }
    const reviewImages = checks.status === "passed" ? await evidenceImages(checks.evidence) : [];
    // runChecksWithPreview adopts captured media first; refresh before constructing
    // review packets so reviewers receive the canonical media IDs.
    const reviewRun = ownedRun(ticketId, runId, signal);
    if (!reviewRun) return reviewOutcome(ticketId, signal);
    signal?.throwIfAborted();
const humanEvidenceFinding = humanProofFindings(current.pendingEvidenceFeedback);
    const focusFindings = [...unresolvedReviewFindings(current.reviews), ...humanEvidenceFinding];
    const operatorFeedback = [reviewFixConstraints(current), current.pendingEvidenceFeedback || ""].filter(Boolean).join("\n");
    const reviewArtifacts = await hydrateArtifacts(reviewRun.artifacts.filter((artifact) => artifact.kind !== "visual-evidence" || (checks.evidence || []).some((item) => item.path === artifact.path)), dataDir);
    const reviewMode = checks.status === "passed" ? "independent" : "prerequisite";
    if (reviewMode === "prerequisite") activity.onEvent({ type: "phase", label: "Independent review skipped: verification prerequisites failed" }, "checks");
    const reviewResults = reviewMode === "prerequisite" ? [] : await Promise.allSettled(["requirements", "integration", "verification"].map((role) => reviewTicket({
      cwd: current.workspace.cwd,
      ticket: current.ticket,
      access: current.access,
      plan: current.plan,
      artifacts: reviewArtifacts,
      diff,
      checks,
      proofMap: projectProofMap(reviewRun),
      focusFindings,
      operatorFeedback,
      images: reviewImages,
      role,
      round,
      runId: current.runId,
      profile: current.stageProfiles.verification,
      onEvent: (event) => activity.onEvent(event, role),
      signal
    })));
    const failedReview = reviewResults.find((result) => result.status === "rejected");
    if (failedReview) throw failedReview.reason;
    const coveredRun = ownedRun(ticketId, runId, signal);
    if (!coveredRun) return reviewOutcome(ticketId, signal);
    await assertProofRevision(coveredRun, proofRevision);
    if (!ownedRun(ticketId, runId, signal)) return reviewOutcome(ticketId, signal);
    const reviews = [repositoryCheckReview(checks), ...reviewResults.map((result) => result.value)].map(retainReviewRecord);
    signal?.throwIfAborted();
    const persisted = [];
    for (const review of reviews) {
      persisted.push(await persistArtifact(dataDir, current.ticket, {
        runId: current.runId,
        name: `${review.role}.json`,
        content: JSON.stringify(review, null, 2),
        stageId: `review-round-${round}`,
        kind: "independent-review"
      }));
    }
const reviewId = `final-review-${round}`;
    const finalChecks = {
      ...(checks.failureKind ? { failureKind: checks.failureKind, failureHighlights: checks.failureHighlights || "", missingCriterionIds: checks.missingCriterionIds || [] } : {}),
      status: checks.status, command: checks.command || null, summary: checks.summary || "", output: checks.output || "", durationMs: checks.durationMs || null,
      evidence: (checks.evidence || []).map(({ name, path, viewport, url }) => ({ name, path, viewport, url }))
    };
    const findings = reviewMode === "prerequisite" ? actionableFindings([{ findings: [...humanEvidenceFinding, ...actionableFindings(reviews)] }]) : humanEvidenceFinding.length ? humanEvidenceFinding : actionableFindings(reviews);
    let reviewAdopted = false;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (signal?.aborted || run?.runId !== runId) return;
      reviewAdopted = true;
      const createdAt = new Date().toISOString();
      run.artifacts.push(...persisted);
      run.finalChecks = finalChecks;
      run.finalCheckHistory ||= {};
      run.finalCheckHistory[reviewId] ||= structuredClone(finalChecks);
      run.finalDiffHistory ||= {};
      run.finalDiffHistory[reviewId] ||= structuredClone(diff);
      run.finalReviewHistory ||= {};
      run.finalReviewHistory[reviewId] ||= { createdAt };
      run.finalReviewSequence = Math.max(finalReviewSequence(run), round);
      run.reviews.push({ round, reviewId, reviewMode, reviews, finalChecks: structuredClone(finalChecks), actionableFindings: findings, diff, proofRevision, createdAt });
      run.failure = reviewMode === "prerequisite" ? executionFailure(checks, { phase: "verification" }) : null;
      if (run.proofMap && reviewMode === "independent") {
        const mediaIds = run.artifacts.filter((artifact) => (checks.evidence || []).some((item) => item.path === artifact.path)).map(({ id }) => id);
        run.proofMap = applyIndependentProofReports(run.proofMap, reviews.find((review) => review.role === "requirements")?.criterionResults, run, { mediaIds });
        // A dissenting reviewer cannot be outvoted by a later success report.
        for (const review of reviews) run.proofMap = applyProofReports(run.proofMap, (review.criterionResults || []).filter((result) => ["failed", "blocked"].includes(result.status)), run);
      }
      delete run.pendingReviewAttempt;
      delete run.pendingEvidenceFeedback;
      Object.assign(run.stages.find((stage) => stage.id === "verify"), { activity: activity.snapshot(), diff: verificationDiff });
    });
    if (!reviewAdopted) return reviewOutcome(ticketId, signal);
    await persistProofSnapshot(ticketId, { stageId: "verify", attemptId: `round-${round}`, name: "proof-map-final-review.json" });
    if (!findings.length) {
      return completeCleanReview({ ticketId, current, round, checks, diff, activity, signal, proofRevision });
    }
    const reviewsWithCurrent = [...(current.reviews || []), { round, actionableFindings: findings }];
    const decision = shouldPauseCorrection({ round: correctionWindowRound(round, reviewsWithCurrent, current.correctionWindowStartRound), findings, previousFingerprint });
    if (decision.pause) {
      const pauseReason = correctionPauseReason(decision.reason, findings);
      let paused = false;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (signal?.aborted || run?.runId !== runId) return;
        paused = true;
        run.status = "needs_attention";
        run.lastError = pauseReason;
        run.checkpoint = {
          id: randomUUID(), kind: "needs_attention", title: "Correction stalled",
          prompt: pauseReason, source: "verification", createdAt: new Date().toISOString()
        };
        setStage(run, "verify", "blocked", pauseReason).activity = activity.snapshot();
      });
      return paused ? { kind: "blocked" } : reviewOutcome(ticketId, signal);
    }
    previousFingerprint = decision.fingerprint;
// Final findings can affect cross-step integration. Preserve all prior proof as
    // stale before the fixer edits, requiring the following review to re-establish it.
    let invalidated = false;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (signal?.aborted || run?.runId !== runId) return;
      invalidated = true;
      if (run.proofMap) run.proofMap = invalidateProof(run.proofMap, run.proofMap.criteria.map((criterion) => criterion.id), { reason: "Automatic final-review correction." });
    });
    if (!invalidated) return reviewOutcome(ticketId, signal);
    await persistProofSnapshot(ticketId, { stageId: "verify", attemptId: `round-${round}`, name: "proof-map-final-automatic-correction.json" });
    const rootCauseClusters = unaddressedReviewClusters(reviewsWithCurrent);
    if (!await applyFinalReviewFix({ ticketId, round, findings, restartFeedback: reviewFixConstraints(current), reviewImages, verificationBaseTree, activity, signal, rootCauseClusters })) return { kind: "blocked" };
  }
}


  return { finalReviewLoop };
}
