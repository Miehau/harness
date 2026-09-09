import { assertUiProposal, requiresUiProposal } from "./ui-proposal.js";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { redactText, retainWorkflowContinuation } from "./redaction.js";
import { diffTrees, restoreTree, reviewNoteFeedback } from "./git.js";
import { flattenSteps, findNode, normalizeEditedPlan, planReviewViolations } from "./plan.js";
import { actionableFindings, archiveRun, auditVisualEvidencePolicy, createTicketRun, executionFailure, localStages, markRunCancelled, markRunPaused, nextRunnableBatch, planApprovalPending, prepareRunResume, providerWaitCheckpoint, restartReviewFixSession, resumeStage, rewindRun, supervisorReviewCheckpoint, workflowResumeStage } from "./execution.js";
import { applyPendingWorkflowGate, applyWorkflowContinuation, bindWorkflowSkill, executionBlockedByWorkflow, initialWorkflow, isWorkflowRunCheckpoint, pauseIfWorkflowBlocked, runCheckpointFromWorkflow } from "./workflow.js";
import { earlyFailureStatusSet, normalizeRunCleanup, replaceableRunStatusSet, setStage, terminalRunStatusSet } from "./run-status.js";
import { prepareJjForGit } from "./jj.js";
import { createParallelWorktrees, gitRepositoriesForStep, needsLocalWorkspaceRepair, repairZeroStateWorkspace, restoreRepositoryTrees } from "./worktrees.js";
import { snapshotTree } from "./git.js";
import { verifyStageEvidenceError } from "./visual-evidence.js";
import { assertProofRevision } from "./proof-revision.js";
import { initializeProofMap, invalidateProof, proofGate, proofGateError, stepCriterionIds } from "./proof-map.js";
import { planApprovalCheckpoint } from "./planning.js";
import { freezeRunAccess, readProjectPolicy } from "./access-policy.js";
import { persistArtifact, safeName } from "./artifacts.js";
import { designSystemExists, ensureDesignSystemStep, uiContractViolations } from "./design-system.js";
import { loadLocalFixture } from "./local.js";
import { auditHarnessWriteScopes, ensureVerificationContractStep, verificationContractExists } from "./pi-prompts.js";
import { loadProjectConfig, projectConfigPath } from "./project-config.js";
import { publicRun, publicState } from "./inspection.js";
import { coordinationBlockedSteps } from "./coordination-service.js";

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

function approvedScopePaths(values) {
  const paths = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "")))];
  if (!paths.length || paths.length > 10) throw new Error("Approve between one and ten explicit repository paths");
  for (const path of paths) {
    if (!path || path === "." || path === ".." || path.startsWith("../")
      || isAbsolute(path) || path.includes(",") || /[*?[\]{}]/.test(path)) {
      throw new Error(`Scope expansion must name an explicit repository-relative path: ${path}`);
    }
  }
  return paths;
}

export function createTicketRunner({
  state,
  runtime,
  dataDir,
  lifecycle,
  tracker,
  steps,
  finalReview,
  delivery,
  artifacts,
  proof,
  planning = {},
  harness = {},
  config = {}
}) {
  const { mirrorCheckpoint, stopPreviews } = lifecycle;
  const { ensureExecutionStarted, mirrorBlocker } = tracker;
  const { execute, accept } = steps;
  const { run: runFinalReview } = finalReview;
  const { schedule } = delivery;
  const { artifactText } = artifacts;
  const { persistSnapshot } = proof;
  const { prepare: prepareTicket, continueRequirements: continueAfterRequirements, design: designTicket, reviseProposal: reviseUiProposal } = planning;
  const { continueWorkflow: continueWorkflowWorker, generateCommitMessage } = harness;
  const { packageMetadata = {}, isAsyncResponse = () => false, ticketById = () => null, publishSelection = () => {} } = config;
  const readRun = (ticketId) => ticketRun(state.read(), ticketId);
  const ownedRun = (ticketId, runId, signal) => {
    const run = state.read().ticketRuns?.[ticketId];
    return !signal?.aborted && run?.runId === runId ? run : null;
  };
  const ownedCheckpoint = (ticketId, runId, checkpointId, signal) => {
    const run = ownedRun(ticketId, runId, signal);
    return run?.checkpoint?.id === checkpointId ? run : null;
  };
  const superseded = (ticketId, signal) => ({ kind: signal?.aborted ? "aborted" : "superseded", ticketId });

  function newTicketRun(ticket, stageProfiles, extras = {}) {
    return createTicketRun(ticket, stageProfiles, { ...extras, proofStorageRoot: dataDir });
  }

  async function snapshotWorkspaceAccess() {
    const snapshot = state.read();
    return freezeRunAccess({ primaryCwd: snapshot.workspace.cwd, policy: await readProjectPolicy(snapshot, snapshot.workspace.cwd) });
  }

  function assertRestartable(run) {
    if (runtime.activeTickets.has(run.id) || runtime.activeMerges.has(run.id)) throw new Error("Cancel the active run before restarting it");
    if (run.merge || run.integration) throw new Error("A run that reached delivery cannot be restarted automatically; start a new ticket instead");
  }

  async function restartAuditArtifact(run, audit) {
    return persistArtifact(dataDir, run.ticket, { runId: run.runId, stageId: "restart-audit", name: `${audit.id}.json`, kind: "restart-audit", content: JSON.stringify({ ...audit, runId: run.runId, ticketId: run.id }, null, 2) });
  }

  async function surfaceFailure(ticketId, work, { awaitWork = true } = {}) {
    const active = runtime.activeTickets.get(ticketId);
    const tracked = Promise.resolve(work).catch(async (error) => {
      if (active?.controller.signal.aborted) return;
      await state.update((draft) => {
        const run = draft.ticketRuns[ticketId];
        if (!run || run.lastError) return;
        run.status = earlyFailureStatusSet.has(run.status) ? "failed" : "needs_attention";
        run.lastError = redactText(error.message);
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    const run = state.read().ticketRuns?.[ticketId];
    if (run && ["failed", "needs_attention"].includes(run.status) && run.lastError) throw new Error(run.lastError);
    if (awaitWork && !isAsyncResponse()) return tracked;
    void tracked;
  }
  const explicitCriterionIds = (run, candidateIds, { stepId = null } = {}) => {
    const known = new Set((run.proofMap?.criteria || [])
      .filter((criterion) => !stepId || criterion.stepId === stepId)
      .map((criterion) => criterion.id));
    const selected = [...new Set((Array.isArray(candidateIds) ? candidateIds : []).map(String))];
    const unknown = selected.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown or unrelated criterion IDs: ${unknown.join(", ")}`);
    return selected;
  };

  async function ensureLocalWorkspace(ticketId, signal) {
    const before = state.read();
    const previous = ticketRun(before, ticketId);
    if (!(await needsLocalWorkspaceRepair(previous.ticket, previous.workspace))) return previous;
    if (!ownedRun(ticketId, previous.runId, signal)) return null;
    const { workspace, recovered } = await repairZeroStateWorkspace({
      cwd: before.workspace.cwd,
      ticket: previous.ticket,
      runId: previous.runId,
      previousCwd: previous.workspace?.cwd
    });
    if (!ownedRun(ticketId, previous.runId, signal)) return null;
    let adopted = false;
    await state.update((draft) => {
      const run = ticketRun(draft, ticketId);
      if (signal?.aborted || run.runId !== previous.runId) return;
      adopted = true;
      run.workspace = workspace;
      run.baselineTree = workspace.baselineTree;
      run.lastError = null;
      for (const step of flattenSteps(run.plan)) {
        if (!recovered && step.status === "accepted") step.status = "ready";
        if (step.status !== "accepted") {
          if (!["ready", "interrupted"].includes(step.status)) step.status = "interrupted";
          delete step.workspace;
          delete step.baseTree;
        }
      }
    });
    return adopted ? readRun(ticketId) : null;
  }

  async function advanceTicket(ticketId, signal) {
    signal?.throwIfAborted();
    const current = readRun(ticketId);
    assertUiProposal(current);
    const ownerRunId = current.runId;
    if (executionBlockedByWorkflow(current)) {
      await state.update((draft) => pauseIfWorkflowBlocked(ticketRun(draft, ticketId)));
      await mirrorCheckpoint(ticketId);
      return { kind: "blocked" };
    }
    const run = await ensureLocalWorkspace(ticketId, signal);
    if (!run || run.runId !== ownerRunId) return superseded(ticketId, signal);
    const planRevision = run.planRevision || 1;
    const blocked = coordinationBlockedSteps(run);
    const reviewReady = flattenSteps(run.plan).filter((step) => step.status === "review_ready" && !blocked.has(step.id));
    if (reviewReady.length) {
      if (!run.auto) return { kind: "awaiting_step_review" };
      for (const step of reviewReady) await accept(ticketId, step.id);
      return advanceTicket(ticketId, signal);
    }
    const ready = nextRunnableBatch(run.plan, { blockedStepIds: blocked });
    const batch = run.workspace.vcs === "jj" ? ready.slice(0, 1) : ready;
    if (batch.length) {
      let schedulingCurrent = true;
      if (batch.length > 1 || batch.some((step) => step.coordinationRestart)) {
        const tree = await snapshotTree(run.workspace.cwd);
        const workspaces = await createParallelWorktrees({
          sourceCwd: run.workspace.cwd,
          dataDir,
          ticket: run.ticket,
          runId: run.runId,
          revision: run.planRevision > 1 ? run.planRevision : null,
          steps: batch.filter((step) => !step.workspace?.isolated || step.coordinationRestart),
          tree,
          repositories: run.repositories || []
        });
        await state.update((draft) => {
          const current = ticketRun(draft, ticketId);
          if (signal?.aborted || current.runId !== ownerRunId) return;
          if ((current.planRevision || 1) !== planRevision || batch.some((step) => coordinationBlockedSteps(current).has(step.id))) { schedulingCurrent = false; return; }
          for (const [stepId, workspace] of workspaces) Object.assign(findNode(current.plan, stepId), { workspace, baseTree: tree, coordinationRestart: false });
        });
      }
      await state.update((draft) => {
        const current = ticketRun(draft, ticketId);
        if (signal?.aborted || current.runId !== ownerRunId) return;
        if ((current.planRevision || 1) !== planRevision || batch.some((step) => coordinationBlockedSteps(current).has(step.id))) { schedulingCurrent = false; return; }
        current.status = "running";
        current.checkpoint = null;
        setStage(current, "implement", "active", batch.length > 1 ? `Running ${batch.length} tickets in parallel` : `Running ${batch[0].title}`);
      });
      if (!schedulingCurrent) return advanceTicket(ticketId, signal);
      await Promise.all(batch.map((step) => execute(ticketId, step.id, { signal })));
      const after = readRun(ticketId);
      if (!ownedRun(ticketId, ownerRunId, signal)) return superseded(ticketId, signal);
      return after.auto && !terminalRunStatusSet.has(after.status)
        ? advanceTicket(ticketId, signal)
        : { kind: "steps_finished" };
    }
    if (blocked.size) {
      await state.update((draft) => {
        const current = ticketRun(draft, ticketId);
        if (current.runId !== ownerRunId || signal?.aborted) return;
        current.status = "needs_attention";
        current.checkpoint = { id: randomUUID(), kind: "needs_attention", source: "coordination", title: "Resolve work coordination", prompt: "Review the open conflicts and proposed plan revisions, then resume execution.", createdAt: new Date().toISOString() };
        setStage(current, "implement", "blocked", "Waiting for a coordination decision");
      });
      return { kind: "coordination" };
    }
    if (flattenSteps(run.plan).every((step) => step.status === "accepted")) {
      if (run.workspace.vcs === "jj" && !run.workspace.jjFinalized) {
        await prepareJjForGit(run.workspace.cwd, run.workspace.branch);
        for (const repo of (run.repositories || []).filter((item) => (item.id || "primary") !== "primary" && item.cwd && item.branch)) {
          await prepareJjForGit(repo.cwd, repo.branch);
        }
        await state.update((draft) => { ticketRun(draft, ticketId).workspace.jjFinalized = true; });
      }
      return runFinalReview(ticketId, signal);
    }
    return { kind: "idle" };
  }

  function runTicket(ticketId) {
    return runtime.start(ticketId, async (signal) => {
      const ownerRunId = readRun(ticketId).runId;
      try {
        signal.throwIfAborted();
        assertUiProposal(readRun(ticketId));
        await ensureExecutionStarted(ticketId);
        if (!ownedRun(ticketId, ownerRunId, signal)) return superseded(ticketId, signal);
        await ensureLocalWorkspace(ticketId, signal);
        if (!ownedRun(ticketId, ownerRunId, signal)) return superseded(ticketId, signal);
        let blocked = false;
        await state.update((draft) => {
          const run = ticketRun(draft, ticketId);
          if (signal.aborted || run.runId !== ownerRunId) return;
          if (pauseIfWorkflowBlocked(run)) {
            blocked = true;
            return;
          }
          run.status = "running";
          run.recovery = null;
          run.checkpoint = null;
          setStage(run, "design", "completed", "Plan approved");
          setStage(run, "implement", "active", "Executing dependency-ready steps");
        });
        if (blocked) {
          await mirrorCheckpoint(ticketId);
          return { kind: "blocked" };
        }
        return advanceTicket(ticketId, signal);
      } catch (error) {
        if (signal.aborted) return { kind: "aborted" };
        const providerWait = providerWaitCheckpoint(error);
        await state.update((draft) => {
          const run = draft.ticketRuns[ticketId];
          if (!run || run.runId !== ownerRunId) return;
          run.status = providerWait ? "paused" : "needs_attention";
          run.lastError = redactText(error.message);
          run.failure = executionFailure(error, { phase: run.stages.find((stage) => stage.status === "active")?.id || "execution" });
          if (providerWait) run.checkpoint = { id: randomUUID(), ...providerWait, source: "execution", createdAt: new Date().toISOString() };
          const stage = run.stages.find((item) => item.status === "active");
          if (stage) {
            stage.status = providerWait ? "paused" : "blocked";
            stage.summary = redactText(error.message);
          }
        });
        if (!providerWait) await mirrorBlocker(ticketId, error);
        return { kind: providerWait ? "paused" : "blocked" };
      }
    });
  }

  async function finishHandoff(ticketId) {
    const current = readRun(ticketId);
    assertUiProposal(current);
    if (current.checkpoint?.kind !== "evidence_review") throw new Error("No final proof review is awaiting approval");
    const ownerRunId = current.runId;
    const checkpointId = current.checkpoint.id;
    const assertCurrentHandoff = () => {
      const live = readRun(ticketId);
      if (live.runId !== ownerRunId || live.checkpoint?.kind !== "evidence_review" || live.checkpoint.id !== checkpointId) {
        throw new Error("Final proof approval is no longer current");
      }
      return live;
    };
    const eligibility = proofGate(current);
    if (!eligibility.eligible) throw new Error(proofGateError(eligibility));
    const missingEvidence = verifyStageEvidenceError(current);
    if (missingEvidence) throw new Error(missingEvidence);
    await assertProofRevision(current, current.checkpoint?.proofRevision || current.finalProofRevision);
    assertCurrentHandoff();
    const proposal = [...current.artifacts].reverse().find((artifact) => artifact.kind === "product-context-update");
    const contextContent = current.ticket.source === "local" ? null : await artifactText(proposal);
    if (current.ticket.source !== "local" && !contextContent) throw new Error("Product-context proposal not found");
    assertCurrentHandoff();
    let adopted = false;
    await state.update((draft) => {
      const run = ticketRun(draft, ticketId);
      if (run.runId !== ownerRunId || run.checkpoint?.kind !== "evidence_review" || run.checkpoint.id !== checkpointId) return;
      adopted = true;
      run.finalEvidenceArtifactIds = [...new Set(run.checkpoint.evidenceArtifactIds || [])];
    });
    if (!adopted) throw new Error("Final proof approval is no longer current");
    const live = assertCurrentHandoff();
    const queued = await schedule(ticketId, { diff: live.reviews?.at(-1)?.diff, contextContent });
    return { kind: "scheduled_delivery", queued };
  }

  async function editPlan(ticketId, input) {
    const run = readRun(ticketId);
    if (!planApprovalPending(run)) throw new Error("Plans can only be edited at the approval checkpoint");
    const plan = normalizeEditedPlan(input.plan);
    if (run.plan.uiImpact && !plan.uiImpact) plan.uiImpact = run.plan.uiImpact;
    const violations = [...planReviewViolations(plan), ...uiContractViolations(plan)];
    if (violations.length) throw new Error(violations.join("; "));
    return state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (JSON.stringify(current.plan.uiImpact) !== JSON.stringify(plan.uiImpact)) (current.uiImpactHistory ||= []).push({ before: current.plan.uiImpact || null, after: plan.uiImpact || null, source: "operator", at: new Date().toISOString() });
      current.plan = plan;
      current.uiReviewRequired = plan.uiImpact?.level === "material";
      current.planEditedAt = new Date().toISOString();
    });
  }

  async function changeEvidence(ticketId, input) {
    const feedback = redactText(String(input.feedback || "")).slice(0, 4000).trim();
    if (!feedback) throw new Error("Describe the final-proof changes required before continuing");
    const run = readRun(ticketId);
    if (run.checkpoint?.kind !== "evidence_review") throw new Error("No final proof review is awaiting changes");
    const checkpoint = run.checkpoint;
    const affectedCriterionIds = explicitCriterionIds(run, input.criterionIds);
    if (run.proofMap && !affectedCriterionIds.length) throw new Error("Identify at least one affected criterion before requesting proof changes");
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (affectedCriterionIds.length) current.proofMap = invalidateProof(current.proofMap, affectedCriterionIds, { reason: feedback });
      current.pendingEvidenceFeedback = feedback;
      (current.evidenceFeedbackHistory ||= []).push({
        feedback,
        checkpointId: checkpoint.id,
        evidenceArtifactIds: checkpoint.evidenceArtifactIds || [],
        createdAt: new Date().toISOString()
      });
      current.checkpoint = null;
      current.status = "reviewing";
      setStage(current, "verify", "active", "Addressing final proof review feedback");
    });
    if (affectedCriterionIds.length) await persistSnapshot(ticketId, { stageId: "verify", name: "proof-map-final-correction.json" });
    await surfaceFailure(
      ticketId,
      runtime.start(ticketId, (signal) => runFinalReview(ticketId, signal)),
      { awaitWork: false }
    );
    return { accepted: true, ticketId };
  }

  async function expandStepScope(ticketId, stepId, input) {
    const paths = approvedScopePaths(input.paths);
    const reviewBudget = input.reviewBudget;
    if (reviewBudget && (!Number.isInteger(reviewBudget.maxFiles) || reviewBudget.maxFiles <= 0
      || !Number.isInteger(reviewBudget.maxChangedLines) || reviewBudget.maxChangedLines <= 0)) throw new Error("Review budget requires positive integer file and line limits");
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Explain why the approved scope must expand");
    if (runtime.activeTickets.has(ticketId)) throw new Error("Pause the run before changing a step scope");
    const result = await state.update((draft) => {
      const run = ticketRun(draft, ticketId);
      const step = findNode(run.plan, stepId);
      if (!step || !["needs_attention", "needs_input", "awaiting_approval", "failed", "interrupted", "review_ready"].includes(step.status)) throw new Error("Only a stopped step can receive a scope expansion");
      const existing = step.writeScope.split(",").map((path) => path.trim()).filter(Boolean);
      step.writeScope = [...new Set([...existing, ...paths])].join(",");
      step.expectedFiles = [...new Set([...(step.expectedFiles || []), ...paths])];
      if (reviewBudget) step.reviewBudget = { maxFiles: reviewBudget.maxFiles, maxChangedLines: reviewBudget.maxChangedLines, justification: "" };
      step.scopeChanges ||= [];
      const change = { at: new Date().toISOString(), paths, reason, source: "operator" };
      if (reviewBudget) change.reviewBudget = { ...step.reviewBudget };
      step.scopeChanges.push(change);
      const note = `Approved scope expansion: ${paths.join(", ")} — ${reason}`;
      step.lastError = [step.lastError, note].filter(Boolean).join("\n\n");
      run.lastError = [run.lastError, note].filter(Boolean).join("\n\n");
      if (run.checkpoint?.stepId === stepId) run.checkpoint.prompt = [run.checkpoint.prompt, note].filter(Boolean).join("\n\n");
    });
    const step = findNode(ticketRun(result, ticketId).plan, stepId);
    return { ticketId, stepId, writeScope: step.writeScope, expectedFiles: step.expectedFiles, scopeChange: step.scopeChanges.at(-1) };
  }

  async function waiveStep(ticketId, stepId, input) {
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("Explain why the verifier finding is false or outside this slice");
    if (runtime.activeTickets.has(ticketId)) throw new Error("Pause the run before waiving a verifier finding");
    const result = await state.update((draft) => {
      const run = ticketRun(draft, ticketId);
      const step = findNode(run.plan, stepId);
      if (!step || step.status !== "needs_attention" || run.checkpoint?.stepId !== stepId || run.checkpoint?.source !== "verification") {
        throw new Error("Only a stopped verifier finding can be waived");
      }
      const attempt = [...(step.attempts || [])].reverse().find((item) => item.verification);
      if (!attempt) throw new Error("No verifier finding is available to waive");
      const waiver = { at: new Date().toISOString(), reason, source: "operator", findings: actionableFindings([attempt.verification]) };
      attempt.verificationDisposition = { status: "waived", at: waiver.at, reason, source: waiver.source };
      step.verificationWaivers ||= [];
      step.verificationWaivers.push(waiver);
      step.status = "review_ready";
      step.lastError = null;
      run.status = "awaiting_step_review";
      run.lastError = null;
      run.checkpoint = { id: randomUUID(), kind: "step_review", stepId, title: `Review after verification waiver: ${step.title}`, prompt: reason, createdAt: waiver.at };
      setStage(run, "implement", "blocked", `Verifier finding waived for review: ${reason}`);
    });
    const step = findNode(ticketRun(result, ticketId).plan, stepId);
    return { ticketId, stepId, status: step.status, waiver: step.verificationWaivers.at(-1) };
  }

  async function decideStep(ticketId, stepId, decision, input) {
    const current = readRun(ticketId);
    const step = findNode(current.plan, stepId);
    if (!step) throw new Error("This step is not ready for review");
    if (decision === "accept" && input.auto === true) await state.update((draft) => { ticketRun(draft, ticketId).auto = true; });
    if (decision === "accept" && step.status === "accepted") return { accepted: true, alreadyAccepted: true, ticketId, stepId, auto: input.auto === true };
    const stoppedExecution = decision === "changes" && current.status === "needs_attention"
      && ["execution", "verification"].includes(current.checkpoint?.source) && current.checkpoint?.stepId === stepId
      && !runtime.activeTickets.has(ticketId);
    if (step.status !== "review_ready" && !stoppedExecution) throw new Error("This step is not ready for review");
    if (decision === "changes") {
      const noteRequests = Array.isArray(input.noteRequests)
        ? input.noteRequests
        : [...(Array.isArray(input.noteIds) ? input.noteIds : []), input.noteId].map((id) => ({ id, feedback: input.feedback }));
      const feedback = reviewNoteFeedback(step.reviewNotes, noteRequests, input.feedback);
      const affectedCriterionIds = explicitCriterionIds(current, input.criterionIds, { stepId });
      if (current.proofMap && !affectedCriterionIds.length) throw new Error("Identify at least one affected criterion before requesting changes");
      await state.update((draft) => {
        const run = ticketRun(draft, ticketId);
        if (affectedCriterionIds.length) run.proofMap = invalidateProof(run.proofMap, affectedCriterionIds, { reason: feedback });
        delete findNode(run.plan, stepId).workspaceCommit;
        run.status = "running";
        run.lastError = null;
        run.checkpoint = null;
        setStage(run, "implement", "active", `Revising ${step.title}`);
      });
      if (affectedCriterionIds.length) await persistSnapshot(ticketId, { stageId: "implement", stepId, name: "proof-map-step-correction.json" });
      await surfaceFailure(
        ticketId,
        runtime.start(ticketId, (signal) => execute(ticketId, stepId, { feedback, signal }))
      );
      return { accepted: true, ticketId, stepId };
    }
    await accept(ticketId, stepId);
    await surfaceFailure(ticketId, runtime.start(ticketId, async (signal) => {
      try {
        await advanceTicket(ticketId, signal);
      } catch (error) {
        if (signal.aborted) return;
        await state.update((draft) => {
          const run = ticketRun(draft, ticketId);
          run.status = "needs_attention";
          run.lastError = redactText(error.message);
        });
      }
    }));
    return { accepted: true, ticketId, stepId, auto: input.auto === true };
  }

  function workflowSession(run) {
    const snapshot = state.read();
    return { cwd: run?.workspace?.cwd || snapshot.workspace.cwd, sessionFile: run?.sessionFile || null, sessionKey: run ? `${run.ticket.id}-${run.runId}` : undefined, access: run?.access || null };
  }

  async function cancelTicket(ticketId) {
    const active = runtime.activeTickets.get(ticketId);
    if (!active) throw new Error("This run is not active");
    active.controller.abort(new Error("Run cancelled"));
    await Promise.all([runtime.waitForWorkerAbort(active.promise), runtime.cleanupTicketContainments(ticketId, "run-cancelled")]);
    await state.update((draft) => markRunCancelled(ticketRun(draft, ticketId)));
    await stopPreviews(ticketId, "run_cancelled");
  }

  async function pauseTicket(ticketId) {
    const active = runtime.activeTickets.get(ticketId);
    if (!active) throw new Error("This run is not active");
    active.controller.abort(new Error("Run paused"));
    await Promise.all([runtime.waitForWorkerAbort(active.promise), runtime.cleanupTicketContainments(ticketId, "run-paused")]);
    let audit;
    const snapshot = await state.update((draft) => { audit = markRunPaused(ticketRun(draft, ticketId)); });
    const run = ticketRun(snapshot, ticketId);
    const artifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId,
      stageId: audit.stageId,
      name: `${audit.id}-checkpoint.json`,
      kind: "pause-checkpoint",
      content: JSON.stringify(audit, null, 2)
    });
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      current.artifacts.push(artifact);
      const saved = current.pauseHistory?.find((item) => item.id === audit.id);
      if (saved) saved.artifactId = artifact.id;
    });
    await stopPreviews(ticketId, "run_paused");
    return { auditId: audit.id, artifactId: artifact.id };
  }

  async function beginTicket(ticket, { automaticAdmission = false, awaitWork = true } = {}) {
    if (runtime.projectSetup) throw new Error("Wait for project initialization before starting work");
    if (!ticket?.id) throw new Error("Refresh the ticket sources and select a ticket first");
    const access = await snapshotWorkspaceAccess();
    await state.update((draft) => {
      draft.selectedTicketId = automaticAdmission ? draft.selectedTicketId : ticket.id;
      if (!draft.ticketRuns[ticket.id] || replaceableRunStatusSet.has(draft.ticketRuns[ticket.id].status)) draft.ticketRuns[ticket.id] = newTicketRun(ticket, draft.stageProfiles, { automaticAdmission, access });
    });
    await surfaceFailure(ticket.id, prepareTicket(ticket.id), { awaitWork });
    return ticket.id;
  }

  async function continueWorkflowThenResume(ticketId, checkpoint, answers) {
    const before = readRun(ticketId);
    const ownerRunId = before.runId;
    const checkpointId = checkpoint.id;
    try {
      const continued = retainWorkflowContinuation(await continueWorkflowWorker({ ...workflowSession(before), checkpoint, response: String(answers || "Approved"), profile: before.stageProfiles.architecture }));
      let adopted = false;
      await state.update((draft) => {
        const current = ticketRun(draft, ticketId);
        if (current.runId !== ownerRunId || current.checkpoint?.id !== checkpointId) return;
        adopted = true;
        current.workflow = initialWorkflow(current.workflow);
        applyWorkflowContinuation(current.workflow, checkpoint.id, answers, continued.result);
        if (continued.sessionFile) current.sessionFile = continued.sessionFile;
        applyPendingWorkflowGate(current);
      });
      if (!adopted) return superseded(ticketId);
      const live = ownedRun(ticketId, ownerRunId);
      if (!live) return superseded(ticketId);
      if (executionBlockedByWorkflow(live)) return mirrorCheckpoint(ticketId);
    } catch (error) {
      await state.update((draft) => {
        const current = draft.ticketRuns[ticketId];
        if (current?.runId === ownerRunId && current.checkpoint?.id === checkpointId) {
          current.status = "needs_attention";
          current.lastError = redactText(error.message);
        }
      });
      return;
    }
    if (!runtime.activeTickets.has(ticketId) && ownedRun(ticketId, ownerRunId)) {
      await resumeTicketPipeline(ticketId);
    }
  }

  async function acceptCheckpointAnswer(ticketId, answers, source, { checkpointId } = {}) {
    const before = readRun(ticketId);
    let checkpoint = before.checkpoint;
    if (checkpointId && checkpoint?.id !== checkpointId) {
      const workflowCheckpoint = (before.workflow?.checkpoints || []).find((item) => item.id === checkpointId && item.status === "pending");
      if (workflowCheckpoint) checkpoint = runCheckpointFromWorkflow(workflowCheckpoint);
    }
    if (!checkpoint || checkpoint.answerAcceptedAt) return false;
    const ownerRunId = before.runId;
    const answeredAt = new Date().toISOString();
    let adopted = false;
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.runId !== ownerRunId || current.checkpoint?.id !== checkpoint.id) return;
      adopted = true;
      Object.assign(current.checkpoint, { answerAcceptedAt: answeredAt, answerSource: source });
      current.clarificationHistory ||= [];
      current.clarificationHistory.push({ checkpointId: checkpoint.id, kind: checkpoint.kind, title: checkpoint.title, questions: checkpoint.questions || [], answer: answers || "Approved without changes.", askedAt: checkpoint.createdAt || null, answeredAt, answerSource: source });
    });
    if (!adopted || !ownedCheckpoint(ticketId, ownerRunId, checkpoint.id)) return false;
    if (source === "dashboard" && ["linear", "jira"].includes(before.ticket?.provider)) {
      tracker.answer(
        before.ticket,
        `Answer (dashboard):\n\n${answers || "Approved without changes."}\n\n[agent-plan-answer:${checkpoint.id}]`
      ).catch(async (error) => {
        await state.update((draft) => {
          const current = draft.ticketRuns[ticketId];
          if (current?.runId === ownerRunId) current.trackerSyncError = `Could not mirror dashboard answer: ${redactText(error.message)}`;
        });
      });
    }
    if (!ownedCheckpoint(ticketId, ownerRunId, checkpoint.id)) return false;
    if (isWorkflowRunCheckpoint(checkpoint)) await surfaceFailure(ticketId, continueWorkflowThenResume(ticketId, checkpoint, answers));
    else if (checkpoint.kind === "requirements_review") await surfaceFailure(ticketId, continueAfterRequirements(ticketId, answers));
    else if (checkpoint.stepId) await surfaceFailure(ticketId, resumeStepCheckpoint(ticketId, checkpoint, answers));
    else await surfaceFailure(ticketId, runtime.start(ticketId, (signal) => designTicket(ticketId, answers, signal)));
    return true;
  }

  async function resumeTicketPipeline(ticketId) {
    const run = readRun(ticketId);
    const ownerRunId = run.runId;
    const stage = workflowResumeStage(run);
    if (stage === "blocked") return;
    if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    if (stage === "requirements") return prepareTicket(ticketId);
    if (stage === "requirements_review") {
      const draft = [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "requirements-draft");
      if (!run.checkpoint && draft) {
        const prompt = await artifactText(draft);
        let adopted = false;
        await state.update((state) => {
          const current = ticketRun(state, ticketId);
          if (current.runId !== ownerRunId || current.checkpoint) return;
          adopted = true;
          current.status = "awaiting_requirements";
          current.checkpoint = { id: randomUUID(), kind: "requirements_review", title: "Approve ticket requirements", prompt, questions: [], createdAt: new Date().toISOString() };
          setStage(current, "requirements", "blocked", "Requirement approval needed before repository access");
        });
        if (!adopted) return superseded(ticketId);
        await mirrorCheckpoint(ticketId);
      }
      return;
    }
    if (stage === "explore") return continueAfterRequirements(ticketId, "");
    if (stage === "design") return runtime.start(ticketId, (signal) => designTicket(ticketId, "Continue after the supervisor workflow gate.", signal));
    if (stage === "plan_approval" && !run.checkpoint) {
      const design = [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "architecture");
      const prompt = await artifactText(design);
      let adopted = false;
      const next = await state.update((state) => {
        const current = ticketRun(state, ticketId);
        if (current.runId !== ownerRunId || current.checkpoint) return;
        adopted = true;
        current.status = "awaiting_approval";
        current.checkpoint = planApprovalCheckpoint(prompt);
        setStage(current, "design", "blocked", "Plan ready for approval. Named project commands are not a filesystem sandbox.");
      });
      return adopted ? next : superseded(ticketId);
    }
    return runTicket(ticketId);
  }

  async function resumeStepCheckpoint(ticketId, checkpoint, answers) {
    const feedback = String(answers || "").trim() || "Approved";
    const before = readRun(ticketId);
    const ownerRunId = before.runId;
    const checkpointId = checkpoint.id;
    if (!ownedCheckpoint(ticketId, ownerRunId, checkpointId)) return superseded(ticketId);
    if (checkpoint.source === "supervisor") return runtime.start(ticketId, async (signal) => {
      try {
        const run = ownedCheckpoint(ticketId, ownerRunId, checkpointId, signal);
        if (!run) return superseded(ticketId, signal);
        const step = findNode(run.plan, checkpoint.stepId);
        if (!step) throw new Error("Checkpoint step not found");
        let started = false;
        await state.update((state) => {
          const current = ticketRun(state, ticketId);
          if (signal.aborted || current.runId !== ownerRunId || current.checkpoint?.id !== checkpointId) return;
          started = true;
          current.checkpoint = null;
          current.status = "reviewing";
          setStage(current, "implement", "active", `Supervisor continuing review of ${step.title}`);
        });
        if (!started || !ownedRun(ticketId, ownerRunId, signal)) return superseded(ticketId, signal);
        const continued = retainWorkflowContinuation(await continueWorkflowWorker({ ...workflowSession(run), checkpoint, response: feedback, profile: run.stageProfiles.architecture, signal }));
        let adopted = false;
        await state.update((state) => {
          const current = ticketRun(state, ticketId);
          if (signal.aborted || current.runId !== ownerRunId) return;
          adopted = true;
          current.workflow = initialWorkflow(current.workflow);
          if (continued.sessionFile) current.sessionFile = continued.sessionFile;
          const target = findNode(current.plan, checkpoint.stepId);
          if (target) target.supervisorReview = { reply: continued.result.reply, error: null, at: new Date().toISOString() };
        });
        if (!adopted) return superseded(ticketId, signal);
        const latest = ownedRun(ticketId, ownerRunId, signal);
        if (!latest) return superseded(ticketId, signal);
        const currentStep = findNode(latest.plan, checkpoint.stepId);
        const nextGate = supervisorReviewCheckpoint(currentStep, continued.result);
        if (nextGate) {
          await state.update((state) => {
            const current = ticketRun(state, ticketId);
            if (signal.aborted || current.runId !== ownerRunId) return;
            const target = findNode(current.plan, checkpoint.stepId);
            target.status = nextGate.kind;
            current.status = nextGate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
            current.checkpoint = { id: randomUUID(), ...nextGate, createdAt: new Date().toISOString() };
            setStage(current, "implement", "blocked", nextGate.title);
          });
          if (ownedRun(ticketId, ownerRunId, signal)) return mirrorCheckpoint(ticketId);
          return superseded(ticketId, signal);
        }
        const cwd = currentStep.workspace?.cwd || latest.workspace.cwd;
        const commitMessage = currentStep.commitMessage || await generateCommitMessage({ cwd, ticket: latest.ticket, step: currentStep, diff: currentStep.diff || { files: [], patch: "", stat: "" }, runId: latest.runId, profile: latest.stageProfiles.commit, signal });
        let completed = false;
        await state.update((state) => {
          const current = ticketRun(state, ticketId);
          if (signal.aborted || current.runId !== ownerRunId) return;
          completed = true;
          const target = findNode(current.plan, checkpoint.stepId);
          target.status = "review_ready";
          target.commitMessage = commitMessage;
          if (target.reviewBudgetResult?.exceeded) current.auto = false;
          current.status = "awaiting_step_review";
          current.checkpoint = { id: randomUUID(), kind: "step_review", stepId: checkpoint.stepId, title: `${target.reviewBudgetResult?.exceeded ? "Oversized review required" : "Review"}: ${target.title}`, createdAt: new Date().toISOString() };
          setStage(current, "implement", "blocked", target.reviewBudgetResult?.exceeded ? target.reviewBudgetResult.reasons.join("; ") : `${target.title} is verified and awaiting your review`);
        });
        if (!completed) return superseded(ticketId, signal);
        const completedRun = ownedRun(ticketId, ownerRunId, signal);
        if (completedRun?.auto) await advanceTicket(ticketId, signal);
      } catch (error) {
        if (signal.aborted) return;
        await state.update((state) => {
          const run = state.ticketRuns[ticketId];
          if (run?.runId === ownerRunId) {
            run.status = "needs_attention";
            run.lastError = redactText(error.message);
            setStage(run, "implement", "blocked", redactText(error.message));
          }
        });
      }
    });
    if (checkpoint.source === "worker") {
      let invalidated = false;
      await state.update((state) => {
        const run = ticketRun(state, ticketId);
        if (run.runId !== ownerRunId || run.checkpoint?.id !== checkpointId) return;
        invalidated = true;
        if (run.proofMap) run.proofMap = invalidateProof(run.proofMap, stepCriterionIds(run, checkpoint.stepId), { reason: "Worker checkpoint resumed with user feedback." });
      });
      if (!invalidated) return superseded(ticketId);
      await persistSnapshot(ticketId, { stageId: "implement", stepId: checkpoint.stepId, name: "proof-map-worker-resume-correction.json" });
    }
    let resumed = false;
    await state.update((state) => {
      const run = ticketRun(state, ticketId);
      if (run.runId !== ownerRunId || run.checkpoint?.id !== checkpointId) return;
      resumed = true;
      run.checkpoint = null;
      run.status = "running";
    });
    if (!resumed) return superseded(ticketId);
    return runtime.start(ticketId, async (signal) => {
      if (!ownedRun(ticketId, ownerRunId, signal)) return superseded(ticketId, signal);
      await execute(ticketId, checkpoint.stepId, { feedback, signal });
      if (ownedRun(ticketId, ownerRunId, signal)?.auto) await advanceTicket(ticketId, signal);
    });
  }

  async function freshLocalRun(previous, runId, access) {
    const source = state.read().workspace.cwd;
    const fixture = await loadLocalFixture(source, previous.ticket.fixturePath);
    const [contractExists, projectConfigExists] = await Promise.all([
      verificationContractExists(source), stat(join(source, projectConfigPath)).then(() => true, () => false)
    ]);
    let plan = ensureVerificationContractStep(fixture.plan, contractExists, projectConfigExists, Boolean((await loadProjectConfig(source)).commands["capture-proof"]));
    plan = ensureDesignSystemStep(plan, await designSystemExists(source, plan));
    const artifacts = await Promise.all([
      persistArtifact(dataDir, previous.ticket, { runId, name: "feature.md", content: fixture.feature, stageId: "requirements", kind: "feature-brief" }),
      persistArtifact(dataDir, previous.ticket, { runId, name: "plan.json", content: fixture.planSource, stageId: "design", kind: "plan-source" }),
      persistArtifact(dataDir, previous.ticket, { runId, name: "run-manifest.json", stageId: "design", kind: "run-manifest", content: JSON.stringify({ frameworkVersion: packageMetadata.version, piDependency: packageMetadata.dependencies?.["@earendil-works/pi-coding-agent"], nodeVersion: process.version, stageProfiles: previous.stageProfiles, baselineTree: null, featureSha256: createHash("sha256").update(fixture.feature).digest("hex"), planSha256: createHash("sha256").update(fixture.planSource).digest("hex") }, null, 2) })
    ]);
    return { id: previous.id, runId, ticket: previous.ticket, workspace: null, baselineTree: null, status: "awaiting_approval", stages: localStages(), checkpoint: { id: randomUUID(), kind: "awaiting_approval", title: "Approve fresh local execution plan", prompt: fixture.feature, createdAt: new Date().toISOString() }, plan, stageProfiles: structuredClone(previous.stageProfiles), artifacts, activeRuns: {}, auto: false, sessionFile: null, lastError: null, createdAt: new Date().toISOString(), access };
  }

  async function loadLocalRun(inputPath) {
    const snapshot = state.read();
    const source = snapshot.workspace.cwd;
    const fixture = await loadLocalFixture(source, inputPath);
    const [contractExists, projectConfigExists] = await Promise.all([
      verificationContractExists(source), stat(join(source, projectConfigPath)).then(() => true, () => false)
    ]);
    let plan = ensureVerificationContractStep(fixture.plan, contractExists, projectConfigExists, Boolean((await loadProjectConfig(source)).commands["capture-proof"]));
    plan = ensureDesignSystemStep(plan, await designSystemExists(source, plan));
    const runId = randomUUID();
    const slug = safeName(plan.title).slice(0, 32);
    const id = `local-${slug}-${runId.slice(0, 8)}`;
    const ticket = {
      id, identifier: `LOCAL-${slug}`, title: plan.title,
      description: plan.summary || fixture.feature.split("\n").find((line) => line.trim() && !line.startsWith("#")) || "Local zero-state fixture",
      source: "local", fixturePath: fixture.directory,
      state: { name: "Local fixture", type: "local", color: "#8b7cf6" }, team: { name: "Local" }
    };
    const artifacts = await Promise.all([
      persistArtifact(dataDir, ticket, { runId, name: "feature.md", content: fixture.feature, stageId: "requirements", kind: "feature-brief" }),
      persistArtifact(dataDir, ticket, { runId, name: "plan.json", content: fixture.planSource, stageId: "design", kind: "plan-source" }),
      persistArtifact(dataDir, ticket, { runId, name: "run-manifest.json", stageId: "design", kind: "run-manifest", content: JSON.stringify({ frameworkVersion: packageMetadata.version, piDependency: packageMetadata.dependencies?.["@earendil-works/pi-coding-agent"], nodeVersion: process.version, stageProfiles: snapshot.stageProfiles, baselineTree: null, featureSha256: createHash("sha256").update(fixture.feature).digest("hex"), planSha256: createHash("sha256").update(fixture.planSource).digest("hex") }, null, 2) })
    ]);
    const access = await snapshotWorkspaceAccess();
    const next = await state.update((draft) => {
      draft.selectedTicketId = id;
      draft.ticketRuns[id] = { id, runId, ticket, workspace: null, baselineTree: null, status: "awaiting_approval", stages: localStages(), checkpoint: { id: randomUUID(), kind: "awaiting_approval", title: "Approve local execution plan", prompt: fixture.feature, createdAt: new Date().toISOString() }, plan, stageProfiles: snapshot.stageProfiles, artifacts, activeRuns: {}, auto: false, sessionFile: null, lastError: null, workflow: initialWorkflow(), cleanup: normalizeRunCleanup(), createdAt: new Date().toISOString(), access };
    });
    return { ticketId: id, state: next };
  }

  async function startFreshRun(ticketId) {
    const previous = readRun(ticketId); assertRestartable(previous);
    const at = new Date().toISOString();
    const audit = { id: `restart-${(previous.restartHistory?.length || 0) + 1}`, at, target: "fresh", fromStatus: previous.status, fromCheckpoint: previous.checkpoint?.kind || null, previousRunId: previous.runId, nextRunId: randomUUID(), previousStages: previous.stages.map(({ id, status }) => ({ id, status })), previousSteps: flattenSteps(previous.plan).map((step) => ({ id: step.id, title: step.title, status: step.status, baseTree: step.baseTree || null, commit: step.commit || null, vcsChange: step.vcsChange || null, attempts: step.attempts?.length || 0 })) };
    const access = await snapshotWorkspaceAccess();
    const fixture = previous.ticket.source === "local" && previous.ticket.fixturePath ? await freshLocalRun(previous, audit.nextRunId, access) : null;
    if (previous.ticket.source === "local" && previous.workspace?.cwd && previous.baselineTree) await restoreTree(previous.workspace.cwd, previous.baselineTree);
    const artifact = await restartAuditArtifact(previous, audit);
    await stopPreviews(ticketId, "run_fresh_restart");
    await state.update((state) => {
      const old = ticketRun(state, ticketId); old.restartHistory ||= []; old.restartHistory.push(audit); old.artifacts.push(artifact); archiveRun(state, ticketId);
      state.ticketRuns[ticketId] = fixture || newTicketRun(old.ticket, old.stageProfiles, { runId: audit.nextRunId, access });
      state.ticketRuns[ticketId].startedFreshFrom = { runId: old.runId, auditArtifactId: artifact.id, at }; state.selectedTicketId = ticketId;
    });
    if (!fixture) await surfaceFailure(ticketId, prepareTicket(ticketId));
    return audit;
  }

  async function restartFrom(ticketId, target) {
    const previous = readRun(ticketId);
    assertRestartable(previous);
    const at = new Date().toISOString();
    const audit = rewindRun(structuredClone(previous), target, at);
    if (audit.restoredTree) {
      if (!previous.workspace?.cwd) throw new Error("The run has no worktree to restore");
      const restored = await restoreTree(previous.workspace.cwd, audit.restoredTree);
      if (restored !== audit.restoredTree) throw new Error("The worktree did not match the selected restart checkpoint");
      const stepId = String(target || "").replace(/^step:/, "");
      const selected = findNode(previous.plan, stepId);
      const trees = { ...(selected?.baseTrees || {}), ...(audit.restoredTrees || {}), primary: audit.restoredTree };
      if (target === "stage:explore" || target === "stage:design") {
        for (const repo of gitRepositoriesForStep(previous)) {
          if ((repo.id || "primary") !== "primary" && !trees[repo.id] && repo.baselineTree) trees[repo.id] = repo.baselineTree;
        }
      }
      const resetIds = new Set(audit.resetStepIds || []);
      const commits = {};
      for (const step of flattenSteps(previous.plan)) {
        if (resetIds.has(step.id)) continue;
        for (const [id, record] of Object.entries(step.acceptedRepositories || {})) {
          if (id !== "primary" && record?.commit) commits[id] = record.commit;
        }
      }
      await restoreRepositoryTrees(gitRepositoriesForStep(previous), trees, { commits });
    }
    const artifact = await restartAuditArtifact(previous, audit);
    await stopPreviews(ticketId, "run_restart");
    await state.update((state) => {
      const run = ticketRun(state, ticketId);
      rewindRun(run, target, at);
      run.artifacts.push(artifact);
    });
    if (target === "stage:explore") await surfaceFailure(ticketId, continueAfterRequirements(ticketId, ""));
    else if (target === "stage:design") await surfaceFailure(ticketId, runtime.start(ticketId, (signal) => designTicket(ticketId, "Restart design from the persisted exploration.", signal)));
    else if (target === "stage:verify") await surfaceFailure(ticketId, runtime.start(ticketId, (signal) => runFinalReview(ticketId, signal)));
    else await surfaceFailure(ticketId, runTicket(ticketId));
    return audit;
  }

  async function createReviewMap(ticketId, stepId) {
    const run = readRun(ticketId);
    const ownerRunId = run.runId;
    const step = findNode(run.plan, stepId);
    if (!step?.diff?.available || !step.diff.patch) throw new Error("This step has no textual diff to map");
    const reviewMap = await harness.generateReviewMap({ cwd: step.workspace?.cwd || run.workspace.cwd, ticket: run.ticket, step, diff: step.diff, runId: run.runId, profile: run.stageProfiles.verification });
    if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    const artifact = await persistArtifact(dataDir, run.ticket, { runId: run.runId, stageId: "implement", stepId, name: "review-map.json", content: JSON.stringify(reviewMap, null, 2), kind: "semantic-review-map" });
    let adopted = false;
    const next = await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.runId !== ownerRunId) return;
      const target = findNode(current.plan, stepId);
      if (!target) return;
      adopted = true;
      target.reviewMap = reviewMap;
      target.artifacts ||= [];
      target.artifacts.push(artifact);
      current.artifacts.push(artifact);
    });
    if (!adopted) return superseded(ticketId);
    return { reviewMap, state: next };
  }

  async function beginMany(input) {
    const ids = [...new Set(Array.isArray(input.ticketIds) ? input.ticketIds.map(String) : [])];
    if (!ids.length) throw new Error("Select at least one ticket");
    const tickets = ids.map(ticketById);
    if (tickets.some((ticket) => !ticket)) throw new Error("Refresh the ticket sources before starting the selection");
    for (const ticket of tickets) await beginTicket(ticket);
    return { accepted: true, ticketIds: ids };
  }

  async function begin(ticketId, input = {}) {
    const ticket = ticketById(ticketId) || input.ticket;
    await beginTicket(ticket, { awaitWork: false });
  }

  async function select(ticketId) {
    const next = await state.update((draft) => { draft.selectedTicketId = ticketId; }, { publish: false });
    const selection = {
      selectedTicketId: ticketId,
      revision: next.revision,
      run: next.ticketRuns[ticketId] ? publicRun(next.ticketRuns[ticketId]) : null
    };
    publishSelection(selection);
    return selection;
  }

  async function bindWorkflow(ticketId, input) {
    const skillName = String(input.skillName || "").trim();
    if (!skillName) throw new Error("Choose a Pi skill to bind");
    const run = readRun(ticketId);
    const ownerRunId = run.runId;
    const activation = await harness.activateWorkflow({ ...workflowSession(run), skillName });
    if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    let adopted = false;
    const next = await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.runId !== ownerRunId) return;
      adopted = true;
      current.workflow = bindWorkflowSkill(initialWorkflow(current.workflow), skillName, activation);
      if (activation.sessionFile) current.sessionFile = activation.sessionFile;
      applyPendingWorkflowGate(current);
    });
    if (!adopted) return superseded(ticketId);
    return { skillName, state: publicState(next) };
  }

  async function continueWorkflow(ticketId, input) {
    const run = readRun(ticketId);
    const checkpoint = initialWorkflow(run.workflow).checkpoints.find((item) => item.id === input.checkpointId && item.status === "pending");
    if (!checkpoint) throw new Error("Workflow checkpoint not found");
    await acceptCheckpointAnswer(ticketId, String(input.response || "Approved"), "dashboard", { checkpointId: checkpoint.id });
    return { accepted: true, ticketId };
  }

  async function clarify(ticketId, input) {
    const run = readRun(ticketId); const answers = String(input.answers || ""); const checkpoint = run.checkpoint;
    if (checkpoint?.kind === "requirements_review") {
      if (!answers.trim() && checkpoint.questions?.length) throw new Error("Answer the open requirements questions before approval");
    } else if (["technical_input", "needs_input"].includes(checkpoint?.kind) || (checkpoint?.kind === "awaiting_approval" && (checkpoint.stepId || checkpoint.source === "supervisor"))) {
      if (checkpoint.kind !== "awaiting_approval" && !answers.trim()) throw new Error("Answer the open question before continuing");
    } else throw new Error("This ticket has no open question");
    await acceptCheckpointAnswer(ticketId, answers, "dashboard");
    return { accepted: true, ticketId };
  }

  async function reviseProposal(ticketId, input = {}) {
    const run = readRun(ticketId);
    const feedback = String(input.feedback || "").trim().slice(0, 4000);
    if (!feedback) throw new Error("Describe the requested UI proposal changes");
    if (runtime.activeTickets.has(ticketId) || runtime.activeMerges.has(ticketId)) throw new Error("Pause active work before revising UI direction");
    if (!["awaiting_approval", "paused", "interrupted", "needs_attention", "awaiting_input", "failed"].includes(run.status)) throw new Error("UI proposals can be revised only before execution or while work is stopped");
    if (run.uiProposal && input.proposalRevision !== run.uiProposal.revisionId) throw new Error("UI proposal revision is stale");
    if (run.plan?.uiImpact?.level !== "material") throw new Error("This plan does not require a UI proposal");
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.uiProposalGenerating || current.runId !== run.runId || current.uiProposal?.revisionId !== run.uiProposal?.revisionId) throw new Error("UI proposal revision is no longer current");
      current.uiProposalGenerating = true;
      if (current.uiProposal) current.uiProposal.invalidatedAt = new Date().toISOString();
      if (current.proofMap) current.proofMap = invalidateProof(current.proofMap, current.proofMap.criteria.filter((criterion) => criterion.requiresVisualEvidence).map((criterion) => criterion.id), { reason: "UI direction revised" });
    });
    try { return await reviseUiProposal(ticketId, feedback); }
    finally { await state.update((draft) => { if (draft.ticketRuns[ticketId]?.runId === run.runId) draft.ticketRuns[ticketId].uiProposalGenerating = false; }); }
  }

  async function approvePlan(ticketId, input = {}) {
    const run = readRun(ticketId);
    if (!planApprovalPending(run)) throw new Error("This ticket has no plan awaiting approval");
    const violations = [...planReviewViolations(run.plan), ...uiContractViolations(run.plan)];
    if (violations.length) throw new Error(`Split or justify oversized plan steps before approval: ${violations.join("; ")}`);
    assertUiProposal(run, input.proposalRevision, { approving: true });
    if (requiresUiProposal(run)) {
      const html = await artifactText(run.artifacts.find((artifact) => artifact.id === run.uiProposal.artifactId));
      if (!html || createHash("sha256").update(html).digest("hex") !== run.uiProposal.contentHash) throw new Error("Retained UI proposal is missing or changed; generate a new revision before approval");
    }
    const approvalRunId = run.runId;
    const approvedAt = new Date().toISOString();
    const proofMap = run.proofMap || initializeProofMap(run.plan, { approvedAt });
    const proofArtifact = run.proofMap ? null : await persistArtifact(dataDir, run.ticket, { runId: run.runId, stageId: "design", name: "proof-map-approved.json", kind: "proof-map", content: JSON.stringify(proofMap, null, 2) });
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.runId !== approvalRunId) throw new Error("Plan approval is stale");
      assertUiProposal(current, input.proposalRevision, { approving: true });
      if (requiresUiProposal(current)) current.uiProposal.approvedAt = approvedAt;
      current.auto = input.auto === undefined ? Boolean(current.automaticAdmission) : Boolean(input.auto);
      current.status = "awaiting_approval";
      current.ticketSnapshot = structuredClone(current.ticket);
      current.trackerRevision = current.ticket.updatedAt || null;
      current.planApprovedAt ||= approvedAt;
      current.proofStorageRoot ||= dataDir;
      current.proofMap ||= proofMap;
      if (proofArtifact) current.artifacts.push(proofArtifact);
      current.lastError = null;
    });
    await surfaceFailure(ticketId, runTicket(ticketId));
    return { accepted: true, ticketId };
  }

  async function restart(ticketId, input) {
    if (input.confirmed !== true) throw new Error("Confirm the restart after reviewing its impact");
    const target = String(input.target || "");
    if (target === "fresh") await startFreshRun(ticketId);
    else if (/^(?:stage:(?:explore|design|verify)|step:[a-z0-9][a-z0-9-]*)$/.test(target)) await restartFrom(ticketId, target);
    else throw new Error("Choose a valid stage or step restart point");
    return { accepted: true, ticketId, target };
  }

  async function resume(ticketId) {
    const run = readRun(ticketId);
    const ownerRunId = run.runId;
    if (run.recovery?.kind === "delivery") {
      if (run.recovery.uncertainExternalActions
        && !run.merge?.change
        && !(run.deliveries || []).some((item) => item.change)) {
        throw new Error(run.recovery.message);
      }
      const contextContent = await artifactText(
        [...(run.artifacts || [])].reverse().find((artifact) => artifact.kind === "product-context-update")
      ) || null;
      if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
      const diff = run.reviews?.at(-1)?.diff || null;
      void Promise.resolve(schedule(ticketId, { diff, contextContent }))
        .then(({ promise }) => promise)
        .catch(() => {});
      return { accepted: true, ticketId, recovery: "delivery" };
    }
    const stage = resumeStage(run);
    if (!["run", "requirements", "explore", "design"].includes(stage)) throw new Error("This run cannot be resumed from its current stage");
    if (["cancelled", "needs_attention", "failed", "paused"].includes(run.status)) {
      let prepared = false;
      await state.update((draft) => {
        const current = ticketRun(draft, ticketId);
        if (current.runId !== ownerRunId) return;
        prepared = true;
        auditHarnessWriteScopes(current);
        auditVisualEvidencePolicy(current);
        prepareRunResume(current);
      });
      if (!prepared) return superseded(ticketId);
    }
    if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    if (stage === "requirements") await surfaceFailure(ticketId, prepareTicket(ticketId), { awaitWork: false });
    else if (stage === "explore") await surfaceFailure(ticketId, continueAfterRequirements(ticketId, ""));
    else if (stage === "design") await surfaceFailure(ticketId, runtime.start(ticketId, (signal) => designTicket(ticketId, "Resume the interrupted design.", signal)));
    else await surfaceFailure(ticketId, runTicket(ticketId));
    return { accepted: true, ticketId };
  }

  async function restartFixer(ticketId, input) {
    const run = readRun(ticketId);
    const ownerRunId = run.runId;
    if (!run.workspace?.cwd) throw new Error("No fixer worktree is available to inspect");
    const currentTree = await snapshotTree(run.workspace.cwd);
    const baseTree = run.stages.find((stage) => stage.id === "verify")?.baseTree || run.baselineTree;
    const inheritedDiff = await diffTrees(run.workspace.cwd, baseTree, currentTree);
    if (!ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    let restarted;
    await state.update((draft) => {
      const current = ticketRun(draft, ticketId);
      if (current.runId !== ownerRunId) return;
      restarted = restartReviewFixSession(current, input.reason, inheritedDiff.files);
      setStage(current, "verify", "active", `Restarting final-review fixer · round ${restarted.round}`);
    });
    if (!restarted || !ownedRun(ticketId, ownerRunId)) return superseded(ticketId);
    await surfaceFailure(ticketId, runTicket(ticketId));
    return { accepted: true, ticketId, round: restarted.round };
  }

  return {
    advanceTicket,
    acceptCheckpointAnswer,
    begin,
    beginMany,
    bindWorkflow,
    beginTicket,
    cancelTicket,
    changeEvidence,
    clarify,
    continueWorkflow,
    createReviewMap,
    decideStep,
    editPlan,
    reviseProposal,
    ensureLocalWorkspace,
    expandStepScope,
    finishHandoff,
    freshLocalRun,
    loadLocalRun,
    pauseTicket,
    approvePlan,
    restartFrom,
    restart,
    restartFixer,
    resumeStepCheckpoint,
    resumeTicketPipeline,
    resume,
    runTicket,
    select,
    startFreshRun,
    waiveStep
  };
}
