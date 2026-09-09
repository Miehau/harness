import { randomUUID } from "node:crypto";
import { parseWriteScopeEntry } from "./access-policy.js";
import { combineRepositoryChecks } from "./git.js";
import { publicPreviewState } from "./inspection.js";
import { loadProjectConfig } from "./project-config.js";
import { projectProofMap } from "./proof-map.js";
import { retainChecks } from "./redaction.js";
import { liveCaptureEnvironment } from "./execution.js";
import { applyVerifyEvidenceGate, ticketBoundVisualEvidence } from "./visual-evidence.js";

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

function assertOwningRun(state, ticketId, runId, signal) {
  signal?.throwIfAborted();
  const run = state.read().ticketRuns?.[ticketId];
  if (run?.runId === runId) return run;
  const error = new Error("Ticket run was superseded");
  error.code = "run_superseded";
  throw error;
}

export function captureProofCriteria(criteria = [], stepId = null) {
  const hasVisualCriteria = criteria.some((criterion) => criterion.evidenceType || criterion.requiresVisualEvidence || criterion.requiresVideoEvidence);
  return criteria
    .filter((criterion) =>
      (!stepId || criterion.stepId === stepId) &&
      (!hasVisualCriteria || criterion.requiresVisualEvidence || criterion.requiresVideoEvidence)
    )
    .map(({ id, text, stepId: criterionStepId, requiresVideoEvidence, journeyId }) => ({
      id,
      text,
      stepId: criterionStepId,
      requiresVideoEvidence,
      ...(journeyId ? { journeyId } : {})
    }));
}

export function reconcileVisualChecks(
  checks,
  evidence = [],
  { required = false, requiredVideo = false, ticketId = null, runId = null, criteria = [] } = {}
) {
  checks.evidence = [...new Map((checks.evidence || []).map((item) => [item.path, item])).values()];
  checks.previewEvidence = [...new Map(evidence.map((item) => [item.path, item])).values()];
  return applyVerifyEvidenceGate(checks, { required, requiredVideo, ticketId, runId, criteria });
}

function extraReposForChecks(repositories, diffs, writeScope = "") {
  const scoped = String(writeScope || "")
    .split(",")
    .map((item) => parseWriteScopeEntry(item))
    .filter(Boolean);
  return (repositories || []).filter((repository) => {
    const id = repository.id || "primary";
    if (id === "primary" || !repository.cwd) return false;
    if ((diffs?.[id]?.files || []).length) return true;
    return scoped.some((entry) => entry.kind === "root" && entry.rootId === id);
  });
}

function previewCleanupPending(timeoutMs) {
  return {
    outcome: "running",
    diagnostics: [`Preview cleanup did not settle within ${timeoutMs}ms; containment remains pending.`],
    unresolved: [{ reason: "cleanup-wait-timeout" }]
  };
}

/**
 * Coordinates proof previews with deterministic repository checks. Preview
 * processes belong to RunRuntime containment records; PreviewManager only owns
 * process launch, capture, and bounded settlement.
 */
export function createPreviewOrchestrator({ state, runtime, previews, address = () => null } = {}) {
  if (!state?.read || !state?.update) throw new Error("Preview orchestration requires state read and update operations");
  if (!runtime) throw new Error("Preview orchestration requires RunRuntime");
  if (!previews) throw new Error("Preview orchestration requires PreviewManager");

  async function runChecksWithPreview({ ticketId, previewId, cwd, signal, required, requiredVideo = false, stepId = null }) {
    const runId = ticketRun(state.read(), ticketId).runId;
    const config = !stepId ? await loadProjectConfig(cwd) : null;
    assertOwningRun(state, ticketId, runId, signal);
    const captureProof = Boolean(config?.commands["capture-proof"] || config?.commandErrors?.["capture-proof"]);
    required ||= captureProof;

    // A preview and checks share a containment record, so cancellation cannot
    // leave a separately owned development server behind.
    const executionId = randomUUID();
    const containment = runtime.containmentForExecution(executionId);
    let preview = null;
    let evidence = [];
    if (required) {
      const containmentRunId = await runtime.registerContainment(ticketId, executionId, containment, {
        stepId,
        trigger: "preview-launch",
        runId
      });
      try {
        assertOwningRun(state, ticketId, runId, signal);
        preview = await previews.ensure({
          id: previewId,
          cwd,
          seedState: publicPreviewState(state.read(), ticketId),
          containment,
          // Retain the owning run identity: a fresh restart can archive this
          // run while its preview teardown still settles.
          onCleanup: (trigger) => runtime.settleContainment(ticketId, executionId, containment, trigger, containmentRunId),
          onCleanupSettled: (record) => runtime.persistPreviewCleanup(ticketId, containmentRunId, previewId, record)
        });
        assertOwningRun(state, ticketId, runId, signal);
        if (preview) evidence = await previews.capture(previewId, { signal });
        assertOwningRun(state, ticketId, runId, signal);
      } catch (error) {
        await runtime.settleContainment(ticketId, executionId, containment, "preview-launch-failed", containmentRunId);
        runtime.finish(executionId, containment);
        throw error;
      }
    }

    const current = assertOwningRun(state, ticketId, runId, signal);
    const proof = projectProofMap(current);
    const criteria = proof.criteria.filter((criterion) => !stepId || criterion.stepId === stepId);
    const checks = await runtime.runContainedRepositoryChecks({
      ticketId,
      runId,
      stepId,
      cwd,
      signal,
      executionId,
      containment,
      requireVisualEvidence: required,
      requireVideoEvidence: requiredVideo,
      // Legacy capture-only plans still receive their relevant criteria.
      proofCriteria: captureProof ? captureProofCriteria(proof.criteria, stepId) : undefined,
      environment: required
        ? {
            ...liveCaptureEnvironment(preview?.url || address(), ticketId, current.runId),
            AGENT_PLAN_CAPTURE_CRITERIA: JSON.stringify(
              criteria
                .filter((criterion) => criterion.requiresVisualEvidence)
                .map(({ id, text, stepId: criterionStepId, requiresVideoEvidence, journeyId }) => ({
                  id,
                  text,
                  stepId: criterionStepId,
                  requiresVideoEvidence,
                  ...(journeyId ? { journeyId } : {})
                }))
            )
          }
        : {}
    });
    assertOwningRun(state, ticketId, runId, signal);
    reconcileVisualChecks(checks, evidence, {
      required,
      requiredVideo,
      ticketId,
      runId: current.runId,
      criteria
    });
    checks.repositoryId ||= "primary";
    const bound = required
      ? ticketBoundVisualEvidence(checks.evidence, {
          ticketId,
          runId: current.runId,
          evidenceDir: checks.evidenceDir
        })
      : { bound: false };

    if (preview || checks.evidence.length || checks.previewEvidence.length) {
      await state.update((draft) => {
        const run = ticketRun(draft, ticketId);
        if (run.runId !== runId) return;
        run.previews ||= {};
        if (preview) run.previews[previewId] = preview;
        for (const [kind, items] of [["visual-evidence", checks.evidence], ["preview-diagnostic", checks.previewEvidence]]) {
          for (const item of items) {
            if (run.artifacts.some((artifact) => artifact.path === item.path)) continue;
            run.artifacts.push({
              id: randomUUID(),
              name: item.name,
              path: item.path,
              kind,
              stageId: "verify",
              stepId,
              mediaType: item.mediaType,
              mediaKind: item.mediaKind,
              criterionIds: item.criterionIds || [],
              commands: item.commands || [],
              assertions: item.assertions || [],
              videoPath: item.videoPath || null,
              summary: item.viewport ? `${item.viewport.width}×${item.viewport.height} · ${item.url}` : item.mediaType,
              createdAt: new Date().toISOString(),
              ...(kind === "visual-evidence" && bound.bound
                ? { boundTicketId: ticketId, boundRunId: runId }
                : {})
            });
          }
        }
      });
    }
    return retainChecks(checks);
  }

  async function runChangedRepositoryChecks({ ticketId, previewId, signal, required, requiredVideo = false, stepId = null, repositories, diffs, writeScope = "" }) {
    const runId = ticketRun(state.read(), ticketId).runId;
    const repos = repositories || [];
    const primary = repos.find((repo) => (repo.id || "primary") === "primary") || repos[0];
    const targets = [primary, ...extraReposForChecks(repos, diffs, writeScope)].filter(Boolean);
    const results = [];
    for (const repository of targets) {
      assertOwningRun(state, ticketId, runId, signal);
      const id = repository.id || "primary";
      const primaryRepository = id === "primary";
      const raw = primaryRepository
        ? await runChecksWithPreview({ ticketId, previewId, cwd: repository.cwd, signal, required, requiredVideo, stepId })
        : retainChecks(await runtime.runContainedRepositoryChecks({
            ticketId,
            runId,
            stepId,
            cwd: repository.cwd,
            signal,
            requireVisualEvidence: false,
            requireVideoEvidence: false,
            environment: {}
          }));
      assertOwningRun(state, ticketId, runId, signal);
      results.push({
        ...raw,
        repositoryId: id,
        displayPath: repository.displayPath || repository.sourceCwd || id,
        kind: repository.kind || (primaryRepository ? "primary" : "extra")
      });
    }
    return combineRepositoryChecks(results);
  }

  async function startOperatorPreview(ticketId) {
    const current = state.read();
    const run = ticketRun(current, ticketId);
    const runId = run.runId;
    const cwd = run.workspace?.cwd || current.workspace?.cwd;
    if (!cwd) throw new Error("Worktree is not ready");

    const previewId = `${ticketId}:operator`;
    const executionId = randomUUID();
    const containment = runtime.containmentForExecution(executionId);
    const containmentRunId = await runtime.registerContainment(ticketId, executionId, containment, {
      trigger: "preview-launch",
      runId
    });
    try {
      assertOwningRun(state, ticketId, runId);
      const preview = await previews.ensure({
        id: previewId,
        cwd,
        seedState: publicPreviewState(state.read(), ticketId),
        containment,
        onCleanup: (trigger) => runtime.settleContainment(ticketId, executionId, containment, trigger, containmentRunId),
        onCleanupSettled: (record) => runtime.persistPreviewCleanup(ticketId, containmentRunId, previewId, record)
      });
      assertOwningRun(state, ticketId, runId);
      if (!preview) throw new Error("No preview or start command is configured for this repository");
      await state.update((draft) => {
        const active = ticketRun(draft, ticketId);
        if (active.runId !== runId) return;
        active.previews ||= {};
        active.previews[previewId] = preview;
      });
      return preview;
    } catch (error) {
      await runtime.settleContainment(ticketId, executionId, containment, "preview-launch-failed", containmentRunId);
      runtime.finish(executionId, containment);
      throw error;
    }
  }

  async function stopOperatorPreview(ticketId) {
    const runId = ticketRun(state.read(), ticketId).runId;
    const previewId = `${ticketId}:operator`;
    previews.stop(previewId, { trigger: "preview-stop", reason: "operator-stop" });
    await previews.settleMatching(previewId, runtime.cleanupTimeoutMs);
    await state.update((draft) => {
      const run = ticketRun(draft, ticketId);
      if (run.runId !== runId) return;
      const preview = run.previews?.[previewId];
      const observed = previews.previewState(previewId);
      if (!preview) return;
      Object.assign(preview, {
        ...(observed?.cleanup ? { cleanup: observed.cleanup } : {}),
        status: observed?.status === "cleanup_incomplete" ? "cleanup_incomplete" : "stopped",
        stoppedReason: "operator-stop",
        stoppedAt: new Date().toISOString()
      });
    });
  }

  async function stopTicketPreviews(ticketId, reason) {
    const runId = ticketRun(state.read(), ticketId).runId;
    previews.stopMatching(`${ticketId}:`, { trigger: "preview-stop", reason });
    await previews.settleMatching(`${ticketId}:`, runtime.cleanupTimeoutMs);
    await state.update((draft) => {
      const run = draft.ticketRuns?.[ticketId];
      if (run?.runId !== runId) return;
      for (const [id, preview] of Object.entries(run?.previews || {})) {
        const observed = previews.previewState(id);
        const status = observed?.status || preview.status;
        Object.assign(preview, {
          ...(observed?.cleanup
            ? { cleanup: observed.cleanup }
            : status === "stopping" ? { cleanup: previewCleanupPending(runtime.cleanupTimeoutMs) } : {}),
          // A bounded wait may expire before containment reports a terminal
          // outcome. Keep that state visible rather than falsely reporting stop.
          status: status === "stopping" || status === "cleanup_incomplete" ? status : "stopped",
          stoppedReason: reason,
          stoppedAt: new Date().toISOString()
        });
      }
    });
  }

  return {
    runChecksWithPreview,
    runChangedRepositoryChecks,
    startOperatorPreview,
    stopOperatorPreview,
    stopTicketPreviews
  };
}
