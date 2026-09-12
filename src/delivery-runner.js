import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { compactReviewPacket } from "./review-packet.js";
import { flattenSteps } from "./plan.js";
import { persistArtifact, persistProductContext, safeName, visualEvidenceComment, visualEvidenceHandoffSection } from "./artifacts.js";
import { diffTrees, snapshotTree } from "./git.js";
import { commitWorkspace, diffRepositoryTrees, gitRepositoriesForStep, integrateBranch, mergeRepositoryDiff, snapshotRepositoryTrees } from "./worktrees.js";
import { enqueueSerial } from "./merge-queue.js";
import { changedGitDeliveryRepos, classifyDeliveryFailure, createDeliveryRecord, deliveryFinished, deliveryForRemote, deliveryRepositoryId, publishDeliveryEvidence, pushTicketBranch, reconcileWithRemote, remoteContext, safeSyncLocal, unmergedPaths, upsertDeliveryRecord } from "./delivery.js";
import { redactText, retainChecks } from "./redaction.js";
import { executionFailure, reviewFixConstraints } from "./execution.js";
import { projectProofMap } from "./proof-map.js";
import { assertProofRevision } from "./proof-revision.js";
import { repositoryCheckError } from "./repository-checks.js";
import { cleanupMergedRun } from "./retention.js";
import { setStage } from "./run-status.js";

const runFile = promisify(execFile);

export function deliveryFeedbackReferences(feedback = []) {
  return [...new Set(feedback.flatMap((item) => [...`${item.path || ""}\n${item.body || ""}`
    .matchAll(/(?:^|[\/\s'"(])((?:src|test|public|scripts|\.agent-plan)\/[a-z0-9._/-]+)/gi)]
    .map((match) => match[1])))];
}

export function deliveryFailureNeedsFix(message = "", failure = null) {
  if (failure?.kind) return ["repository-check", "visual-evidence", "capture-configuration", "capture-preflight", "merge-conflict"].includes(failure.kind);
  return /SyntaxError|ReferenceError|AssertionError|\bERR_[A-Z_]+\b|Visual verification produced|Failure highlights:|\bnot ok\b/i.test(String(message));
}

export function createDeliveryRunner({ state, runtime, checks, worker, activity, tracker, artifacts, lifecycle, options = {} }) {
  const { runWithPreview: runChecksWithPreview, runRepository: runContainedRepositoryChecks } = checks;
  const { run: runContainedWorker } = worker;
  const { capture: captureStageActivity } = activity;
  const { action: trackerAction, comment: trackerComment, done: trackerDone } = tracker;
  const { dataDir, hydrate: hydrateArtifacts } = artifacts;
  const { stopPreviews: stopTicketPreviews, mirrorBlocker: mirrorExecutionBlocker } = lifecycle;
  const mergeQueues = runtime.mergeQueues;
  const activeMerges = runtime.activeMerges;
  const readRun = (ticketId) => { const run = state.read().ticketRuns[ticketId]; if (!run) throw new Error("Ticket run not found"); return run; };
  const update = state.update;
  const forgeForRepository = (remote, repo) => (options.deliveryForRemote || deliveryForRemote)(remote, { repository: repo });
  const deliveryPollMs = options.deliveryPollMs;
async function resolveMergeConflicts(ticketId, { cwd, conflicts, activity, signal, attempt, operation = "merge" }) {
  signal?.throwIfAborted();
  const current = readRun(ticketId);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    Object.assign(run.merge, { status: "resolving_conflicts", conflicts, resolverStartedAt: new Date().toISOString() });
    run.status = "resolving_conflicts";
    setStage(run, "handoff", "active", `Resolving ${conflicts.length} merge conflict${conflicts.length === 1 ? "" : "s"}`);
  });
  activity.onEvent({ type: "phase", label: `Merge conflicts detected · ${conflicts.join(", ")}` }, "merge queue");
  const requirementIds = flattenSteps(current.plan).flatMap((step) => step.requirementIds || []).filter((id, index, all) => all.indexOf(id) === index);
  const step = {
    id: `merge-conflict-${attempt}`, type: "step", role: "implementation",
    title: `Resolve ${operation} conflicts`, description: `Reconcile ${current.ticket.identifier} with the latest target branch.`,
    prompt: `A Git ${operation} is already in progress in this isolated ticket worktree. Resolve only these conflicted files: ${conflicts.join(", ")}. Preserve the verified ticket behavior and compatible target-branch changes. Do not abort, restart, or commit the ${operation}. Run focused checks, leave every conflict resolved, and report exactly what was reconciled.`,
    contextPolicy: "seeded", harness: "pi", agentId: `merge-conflict-resolver:${current.ticket.identifier}`,
    permission: "write", writeScope: conflicts.join(", "), skills: [], references: conflicts,
    requirementIds, capabilityIds: [], deltaIds: [], productContext: "Resolve only the concrete merge conflict without expanding ticket scope.",
    expectedArtifacts: [`merge-conflict-resolution-${attempt}.md`], acceptanceCriteria: ["Every Git conflict is resolved", "Verified behavior from both branches is preserved"],
    dependsOn: [], required: true, status: "ready", attempts: [], artifacts: [], attachments: []
  };
const artifacts = compactReviewPacket({
    ticket: current.ticket, plan: current.plan,
    artifacts: await hydrateArtifacts(current.artifacts.filter((artifact) => ["requirements", "feature-brief", "architecture"].includes(artifact.kind)), dataDir)
  }).artifacts;
  const result = await runContainedWorker({
    ticketId, stepId: step.id, cwd, plan: current.plan, step, artifacts, proofMap: projectProofMap(current), images: [], forkSessionFile: null,
    resumeSessionFile: current.merge?.resolverSessionFile || null, feedback: "", runId: current.runId, profile: current.stageProfiles.handoff,
    onSessionFile: (sessionFile) => update((state) => { state.ticketRuns[ticketId].merge.resolverSessionFile = sessionFile; }),
    onEvent: (event) => activity.onEvent(event, "merge conflict resolver"), signal
  });
  signal?.throwIfAborted();
  if (result.report.status !== "completed") throw new Error(result.report.request || result.report.summary || "Merge conflict resolver needs attention");
  const artifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: step.expectedArtifacts[0], content: result.output, stageId: "handoff", kind: "merge-conflict-resolution"
  });
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    run.artifacts.push(artifact);
    Object.assign(run.merge, { resolverCompletedAt: new Date().toISOString(), resolutionArtifact: artifact, resolverSessionFile: null });
  });
}

function waitForDelivery(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("Delivery cancelled")); }, { once: true });
  });
}

async function fixRemoteFeedback(ticketId, feedback, signal, reason = "remote review feedback", cwd = null) {
  const current = readRun(ticketId);
  const activity = captureStageActivity(ticketId, "handoff", current.runId);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    run.status = run.merge.status = "addressing_feedback";
    run.lastError = null;
    setStage(run, "handoff", "active", `Addressing ${reason}`);
  });
  const workCwd = cwd || current.workspace.cwd;
  const beforeTree = await snapshotTree(workCwd);
  const references = deliveryFeedbackReferences(feedback);
  const step = {
    id: `remote-feedback-${Date.now()}`, type: "step", role: "implementation",
    title: `Address ${reason}`, description: `Apply the smallest change that resolves concrete ${reason}.`,
    prompt: `Address these ${reason}. Read every referenced failing file before editing. Preserve approved behavior, remove unverified experiments from earlier failed delivery passes, and avoid unrelated changes. After the final edit, run focused tests with project_command name "test" and safe filename-filter args; never edit verification configuration just to create a command:\n\n${feedback.map((item) => `- ${item.path ? `${item.path}${item.line ? `:${item.line}` : ""}: ` : ""}${item.body}`).join("\n")}`,
    contextPolicy: "seeded", harness: "pi", agentId: `remote-review-fixer:${current.ticket.identifier}`,
    permission: "write", writeScope: "src,test,public,scripts", skills: [], references, requirementIds: [], capabilityIds: [], deltaIds: [], productContext: "Only resolve the concrete remote review feedback.",
    expectedArtifacts: [], acceptanceCriteria: feedback.map((item) => item.body), dependsOn: [], required: true, status: "ready", attempts: [], artifacts: [], attachments: []
  };
const result = await runContainedWorker({
    ticketId, stepId: step.id, cwd: workCwd, plan: current.plan, step,
    artifacts: compactReviewPacket({ ticket: current.ticket, plan: current.plan, artifacts: await hydrateArtifacts(current.artifacts.filter((artifact) => ["requirements", "feature-brief", "architecture"].includes(artifact.kind)), dataDir) }).artifacts,
    proofMap: projectProofMap(current), images: [], forkSessionFile: null, resumeSessionFile: null, feedback: `${reviewFixConstraints(current)}\n\nThe current post-merge delivery failure in this step is authoritative. Earlier passing checks, screenshots, approvals, and no-defect statements describe an older tree and do not resolve this failure. Preserve current user scope constraints (including any mobile exclusion), but fix the exact current error and validate that failing path before reporting completed. Do not substitute ancillary cleanup or a preflight of a different path for the failed journey.`,
    runId: current.runId, profile: current.stageProfiles.implementation, signal,
    onEvent: (event) => activity.onEvent(event, "delivery fixer")
  });
  if (result.report.status !== "completed") throw new Error(result.report.request || result.report.summary || "Remote review fixer needs attention");
  const checks = await runChecksWithPreview({ ticketId, previewId: `${ticketId}:remote-feedback`, cwd: workCwd, signal, required: flattenSteps(current.plan).some((item) => item.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((item) => item.requiresVideoEvidence) });
  if (checks.status === "failed") throw repositoryCheckError(checks);
  const afterTree = await snapshotTree(workCwd);
  const diff = await diffTrees(workCwd, beforeTree, afterTree);
  const commit = await commitWorkspace(workCwd, `fix: address ${reason}\n\nWhy: The reviewed change must resolve concrete delivery feedback before merge.\nRequirement: ${current.ticket.identifier}`);
  const artifact = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: "remote-review-fix.md", content: result.output, stageId: "handoff", kind: "remote-review-fix"
  });
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    run.artifacts.push(artifact);
    run.merge.checks = retainChecks(checks);
    run.merge.feedbackFixes ||= [];
    run.merge.feedbackFixes.push({ feedback, diff, artifact, commit, createdAt: new Date().toISOString() });
  });
  return { commit, checks };
}

async function persistRepoDeliveryFailure(ticketId, repo, error) {
  const message = redactText(error.message);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    patchRunDelivery(run, {
      repositoryId: deliveryRepositoryId(repo),
      displayPath: repo.displayPath || repo.sourceCwd,
      sourceCwd: repo.sourceCwd,
      cwd: repo.cwd,
      branch: repo.branch,
      status: "failed",
      error: message,
      failedAt: new Date().toISOString()
    });
    run.lastError = classifyDeliveryFailure([{ repositoryId: deliveryRepositoryId(repo), displayPath: repo.displayPath || repo.sourceCwd, error: message }]);
  });
}

async function completeNoChangeDelivery(ticketId, queuedRun, { diff, contextContent, ownerRunId }) {
  const currentOwner = () => readRun(ticketId).runId === ownerRunId;
  const superseded = () => ({ position: 0, promise: Promise.resolve({ superseded: true }) });
  if (!currentOwner()) return superseded();
  const integratedAt = new Date().toISOString();
  const productContext = contextContent === null ? null : await persistProductContext(dataDir, queuedRun.workspace.sourceCwd, contextContent);
  if (!currentOwner()) return superseded();
  const handoff = await persistArtifact(dataDir, queuedRun.ticket, {
    runId: queuedRun.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
    content: `# ${queuedRun.ticket.identifier} handoff\n\nVerified as already satisfied. No repository changes or remote review were required.`
  });
  if (!currentOwner()) return superseded();
  await trackerAction(ticketId, "delivery_complete", (ticket) => trackerComment(ticket, "Verified as already satisfied. No repository changes or remote review were required."));
  if (!currentOwner()) return superseded();
  await trackerAction(ticketId, "tracker_done", (ticket) => trackerDone(ticket));
  if (!currentOwner()) return superseded();
  let adopted = false;
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    if (run?.runId !== ownerRunId) return;
    adopted = true;
    run.deliveries = [createDeliveryRecord(run.workspace || {}, { status: "not_required", integratedAt })];
    run.deliveries[0].reason = "no_changes";
    run.integration = { sourceCwd: run.workspace.sourceCwd, branch: run.workspace.branch, commit: null, integratedAt, diff, noChange: true };
    run.deliveredDiff = diff;
    run.merge = { status: "not_required", reason: "no_changes", integratedAt };
    if (productContext) run.productContextPath = productContext.path;
    run.artifacts.push(handoff);
    run.checkpoint = null;
    setStage(run, "handoff", "completed", "Verified with no repository changes");
    run.status = "completed";
    run.failure = null;
    run.lastError = null;
    run.completedAt = integratedAt;
  });
  if (!adopted) return superseded();
  await stopTicketPreviews(ticketId, "run_completed");
  return { position: 0, promise: Promise.resolve({ noChange: true }) };
}

async function finalizeSuccessfulDelivery(ticketId, { diff, contextContent, activity }) {
  const current = readRun(ticketId);
  const deliveries = current.deliveries || [];
  if (!deliveries.length || deliveries.some((item) => !deliveryFinished(item))) return null;
  const primary = deliveries.find((item) => item.repositoryId === "primary") || deliveries[0];
  const integratedAt = new Date().toISOString();
  const productContext = contextContent == null ? null : await persistProductContext(dataDir, current.workspace.sourceCwd, contextContent);
  const evidenceArtifacts = current.artifacts;
  const remoteLines = deliveries.map((item) => item.change?.url
    ? `- ${item.displayPath || item.repositoryId}: ${item.change.url} (\"${item.commit || "pending"}\")`
    : `- ${item.displayPath || item.repositoryId}: integrated \"${item.commit || ""}\"`);
  const handoff = await persistArtifact(dataDir, current.ticket, {
    runId: current.runId, name: "handoff.md", stageId: "handoff", kind: "handoff",
    content: `# ${current.ticket.identifier} handoff\n\n${remoteLines.join("\n")}\n\n${diff?.stat || "See changed files."}${visualEvidenceHandoffSection(evidenceArtifacts)}`
  });
  const remoteUrl = deliveries.map((item) => item.change?.url).filter(Boolean).join(", ");
  await trackerAction(ticketId, "delivery_complete", (ticket) => trackerComment(ticket, remoteUrl
    ? `Merged after remote checks and review: ${remoteUrl}\n\n${deliveries.map((item) => `${item.displayPath || item.repositoryId}: ${item.commit || ""}`).join("\n")}${visualEvidenceComment(evidenceArtifacts)}`
    : `Integrated ${deliveries.length} repositor${deliveries.length === 1 ? "y" : "ies"}.${visualEvidenceComment(evidenceArtifacts)}`));
  await trackerAction(ticketId, "tracker_done", (ticket) => trackerDone(ticket));
  const repos = gitRepositoriesForStep(current);
  const diffsById = Object.fromEntries(deliveries.filter((item) => item.diff).map((item) => [item.repositoryId, item.diff]));
  const deliveredDiff = Object.keys(diffsById).length ? mergeRepositoryDiff(repos, diffsById) : (primary.diff || diff);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    run.integration = {
      sourceCwd: primary.sourceCwd || run.workspace.sourceCwd,
      branch: primary.branch || run.workspace.branch,
      commit: primary.commit,
      integratedAt,
      change: primary.change || null,
      sync: primary.sync || null,
      diff: deliveredDiff,
      ...(deliveries.length > 1 ? { repositories: deliveries } : {})
    };
    run.deliveredDiff = deliveredDiff;
    Object.assign(run.stages.find((stage) => stage.id === "handoff"), { diff: deliveredDiff });
    Object.assign(run.merge, { status: "integrated", commit: primary.commit, integratedAt, sync: primary.sync || null, change: primary.change || run.merge?.change, externalActionPending: null });
    if (productContext) run.productContextPath = productContext.path;
    run.artifacts.push(handoff);
    run.status = "completed";
    run.failure = null;
    run.lastError = null;
    run.completedAt = integratedAt;
    if (remoteUrl) run.retentionCleanup = { status: process.env.AGENT_PLAN_KEEP_MERGED_RUNS === "1" ? "retained" : "pending", runId: run.runId, requestedAt: integratedAt };
    const stage = setStage(run, "handoff", "completed", remoteUrl ? `Merged via ${remoteUrl}` : `Merged into ${primary.sourceCwd}`);
    if (activity) stage.activity = activity.snapshot();
  });
  try { await stopTicketPreviews(ticketId, "run_completed"); }
  catch (error) { await update((draft) => { draft.ticketRuns[ticketId].previewCleanupError = redactText(error.message); }); }
  await cleanupMergedRun({ state, ticketId, dataDir, stopPreviews: stopTicketPreviews });
  return { commit: primary.commit, change: primary.change, sync: primary.sync, deliveries };
}

async function deliverRemoteRepository(ticketId, repo, { diff, signal, activity, attempt }) {
  const repositoryId = deliveryRepositoryId(repo);
  const current = readRun(ticketId);
  const existing = (current.deliveries || []).find((item) => item.repositoryId === repositoryId);
  if (deliveryFinished(existing)) return existing;
  const sourceCwd = repo.sourceCwd || current.workspace.sourceCwd;
  const cwd = repo.cwd || current.workspace.cwd;
  const branch = repo.branch || current.workspace.branch;
  const resumedChange = existing?.change || (repositoryId === "primary" ? current.merge?.change : null) || null;
  const remoteDetails = existing?.remote && existing?.base
    ? { remote: existing.remote, base: existing.base }
    : current.merge?.remote && current.merge?.base && repositoryId === "primary"
      ? { remote: current.merge.remote, base: current.merge.base }
      : await remoteContext(sourceCwd);
  const { remote, base } = remoteDetails;
  const forge = forgeForRepository(remote, repo);
  await update((state) => {
    const run = state.ticketRuns[ticketId];
    patchRunDelivery(run, {
      repositoryId, sourceCwd, cwd, branch, displayPath: repo.displayPath || sourceCwd, kind: repo.kind,
      status: resumedChange ? "waiting_for_checks" : "rebasing",
      attempt, base, remote, change: resumedChange,
      feedbackIds: existing?.feedbackIds || (repositoryId === "primary" ? run.merge?.feedbackIds : []) || []
    });
    run.status = resumedChange ? "waiting_for_checks" : "rebasing";
    run.recovery = null;
    run.checkpoint = null;
    setStage(run, "handoff", "active", resumedChange ? `Inspecting existing remote review: ${resumedChange.url}` : `Reconciling ${repo.displayPath || sourceCwd} with origin/${base}`);
  });
  const reconcile = () => reconcileWithRemote(cwd, base, {
    resolveConflicts: (input) => resolveMergeConflicts(ticketId, { ...input, activity, signal, attempt, operation: "rebase" })
  });
  let checks = existing?.checks || (repositoryId === "primary" ? current.merge?.checks : null) || null;
  let change = resumedChange;
  let awaitingHeadAfterPush = null;
  if ((await unmergedPaths(cwd)).length) await reconcile();
  if (existing?.externalActionPending === "push_feedback_revision") {
    await pushTicketBranch(cwd, branch);
    await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: null }); });
  }
  if (!change) {
    if (current.recovery?.kind === "delivery" && deliveryFailureNeedsFix(current.lastError, current.failure)) {
      const failure = String(current.lastError).match(/Failure highlights:\n([\s\S]*?)(?:\nFailed |$)/)?.[1]
        || String(current.lastError).slice(-4500);
      ({ checks } = await fixRemoteFeedback(ticketId, [{
        id: `delivery-recovery-${attempt}-${repositoryId}`,
        body: `${failure}\n\nContinue from the current worktree and make ${existing?.checks?.command || current.merge?.checks?.command || "the canonical verification command"} pass before reconciling with the target branch again.`
      }], signal, "persisted delivery verification failure", cwd));
    }
    await reconcile();
    checks = repositoryId === "primary"
      ? await runChecksWithPreview({ ticketId, previewId: `${ticketId}:delivery:${repositoryId}`, cwd, signal, required: flattenSteps(current.plan).some((step) => step.requiresVisualEvidence), requiredVideo: flattenSteps(current.plan).some((step) => step.requiresVideoEvidence) })
      : retainChecks(await runContainedRepositoryChecks({ ticketId, cwd, signal, requireVisualEvidence: false, requireVideoEvidence: false, environment: {} }));
    if (checks.status === "failed") {
      ({ checks } = await fixRemoteFeedback(ticketId, [{
        id: `post-rebase-check-${attempt}-${repositoryId}`,
        body: `${checks.summary}${checks.failureHighlights ? `\n\nFailure highlights:\n${checks.failureHighlights}` : ""}\n\nRun ${checks.command} and reconcile only failures introduced by combining the verified ticket with the target branch.`
      }], signal, "post-rebase verification failures", cwd));
    }
    await pushTicketBranch(cwd, branch);
    await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: "create_remote_change", checks }); });
    change = await forge.create({
      branch, base, title: `${current.ticket.identifier}: ${current.ticket.title}`,
      body: [`## Outcome`, current.plan.summary || current.ticket.description, `## Verification`, checks.summary, `## Change`, diff?.stat || repo.deliveryDiff?.stat || "See changed files."].join("\n\n")
    });
    await update((state) => {
      patchRunDelivery(state.ticketRuns[ticketId], {
        repositoryId, status: "waiting_for_checks", change, remoteChangeId: change.id, checks,
        openedAt: new Date().toISOString(), externalActionPending: null
      });
    });
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      run.status = "waiting_for_checks";
      setStage(run, "handoff", "active", `Waiting for checks and review: ${change.url}`);
    });
  }

  if (change) {
    await trackerAction(ticketId, `remote_change:${repositoryId}`, (ticket) => trackerComment(ticket, `Remote review opened: ${change.url}`));
    const { stdout: status = "" } = await runFile("git", ["status", "--porcelain"], { cwd });
    if (!status.trim()) {
      const { stdout: before = "" } = await runFile("git", ["rev-parse", "HEAD"], { cwd });
      const reconciled = await reconcile();
      if (reconciled.commit !== before.trim()) {
        await pushTicketBranch(cwd, branch);
        awaitingHeadAfterPush = before.trim();
      }
    }
  }

  let mergeResult = null;
  let lastRebaseHead = null;
  for (;;) {
    signal?.throwIfAborted();
    await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: "publish_evidence" }); });
    let publication;
    try { publication = await publishDeliveryEvidence(forge, change, checks, readRun(ticketId).artifacts); }
    catch (error) { throw Object.assign(error, { failureKind: "evidence-publication" }); }
    await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: null, evidencePublication: { ...publication, checkedAt: new Date().toISOString() } }); });
    const delivery = await forge.status(change);
    if (awaitingHeadAfterPush === delivery.headSha) {
      await waitForDelivery(deliveryPollMs, signal);
      continue;
    }
    awaitingHeadAfterPush = null;
    const processed = new Set((readRun(ticketId).deliveries || []).find((item) => item.repositoryId === repositoryId)?.feedbackIds || []);
    const feedback = delivery.feedback.filter((item) => !processed.has(item.id));
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      patchRunDelivery(run, { repositoryId, status: feedback.length ? "addressing_feedback" : delivery.checks === "pending" ? "waiting_for_checks" : "waiting_for_merge", remoteStatus: delivery, checkedAt: new Date().toISOString() });
      run.status = run.merge.status;
      setStage(run, "handoff", "active", feedback.length ? `Addressing ${feedback.length} review comment${feedback.length === 1 ? "" : "s"} in ${repo.displayPath || repositoryId}` : `Remote checks (${repo.displayPath || repositoryId}): ${delivery.checks}; merge: ${delivery.mergeState}`);
    });
    if (delivery.merged) { mergeResult = { commit: delivery.headSha, externallyMerged: true }; break; }
    if (feedback.length) {
      ({ checks } = await fixRemoteFeedback(ticketId, feedback, signal, "remote review feedback", cwd));
      await reconcile();
      await update((state) => {
        const record = (state.ticketRuns[ticketId].deliveries || []).find((item) => item.repositoryId === repositoryId);
        patchRunDelivery(state.ticketRuns[ticketId], {
          repositoryId,
          feedbackIds: [...(record?.feedbackIds || []), ...feedback.map((item) => item.id)],
          externalActionPending: "push_feedback_revision"

        });
      });
      await pushTicketBranch(cwd, branch);
      awaitingHeadAfterPush = delivery.headSha;
      await forge.comment(change, `Addressed review feedback in the latest pushed revision:\n\n${feedback.map((item) => `- ${item.body}`).join("\n")}`);
      await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: null }); });
      continue;
    }
    if (delivery.checks === "failed" && awaitingHeadAfterPush === delivery.headSha) {
      await waitForDelivery(deliveryPollMs, signal);
      continue;
    }
    if (delivery.checks === "failed") throw new Error(`Remote CI failed for ${change.url}`);
    const unresolvedReview = delivery.feedback.some((item) => item.id.startsWith("review:"));
    if (delivery.mergeable && delivery.checks === "passed" && !unresolvedReview) {
      await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: "squash_merge" }); });
      try {
        mergeResult = await forge.merge({ ...change, headSha: delivery.headSha }, `${current.ticket.identifier}: ${current.ticket.title}`);
      } catch (error) {
        if (error.status !== 409) throw error;
        await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, externalActionPending: null }); });
        await waitForDelivery(deliveryPollMs, signal);
        continue;
      }
      break;
    }
    if (!delivery.mergeable && delivery.headSha !== lastRebaseHead && /(behind|dirty|conflict|rebase)/i.test(delivery.mergeState || "")) {
      lastRebaseHead = delivery.headSha;
      await reconcile();
      await pushTicketBranch(cwd, branch);
      continue;
    }
    await waitForDelivery(deliveryPollMs, signal);
  }

  const deliveredTree = await snapshotTree(cwd);
  const deliveredDiff = await diffTrees(cwd, `origin/${base}^{tree}`, deliveredTree);
  const sync = await safeSyncLocal(sourceCwd, base);
  await update((state) => {
    patchRunDelivery(state.ticketRuns[ticketId], {
      repositoryId, status: "integrated", commit: mergeResult.commit, change, checks, sync, diff: deliveredDiff,
      integratedAt: new Date().toISOString(), externalActionPending: null, error: null
    });
  });
  return { commit: mergeResult.commit, change, sync, diff: deliveredDiff };
}

async function deliverLocalRepository(ticketId, repo, { signal, activity, attempt }) {
  const repositoryId = deliveryRepositoryId(repo);
  const current = readRun(ticketId);
  const existing = (current.deliveries || []).find((item) => item.repositoryId === repositoryId);
  if (deliveryFinished(existing)) return existing;
  const sourceCwd = repo.sourceCwd || current.workspace.sourceCwd;
  const queued = enqueueSerial(mergeQueues, sourceCwd, (position) => update((state) => {
    const run = state.ticketRuns[ticketId];
    patchRunDelivery(run, {
      repositoryId, sourceCwd, cwd: repo.cwd, branch: repo.branch, displayPath: repo.displayPath || sourceCwd,
      status: "queued", position, attempt, conflicts: []
    });
    run.status = "queued_for_merge";
    run.recovery = null;
    run.checkpoint = null;
    setStage(run, "handoff", "active", `Merge queue position ${position} (${repo.displayPath || sourceCwd})`);
  }), async () => {
    signal?.throwIfAborted();
    const live = readRun(ticketId);
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      patchRunDelivery(run, { repositoryId, status: "merging", position: 1, startedAt: new Date().toISOString() });
      run.status = "merging";
      run.lastError = null;
      setStage(run, "handoff", "active", `Merging ${repo.branch || run.workspace.branch} (${repo.displayPath || sourceCwd})`);
    });
    activity.onEvent({ type: "phase", label: `Automated merge started (${repo.displayPath || sourceCwd})` }, "merge queue");
    const integrationCwd = repositoryId === "primary"
      ? join(dataDir, "ticket-runs", safeName(live.ticket.identifier || live.ticket.id), "runs", safeName(live.runId), "integration")
      : join(dataDir, "ticket-runs", safeName(live.ticket.identifier || live.ticket.id), "runs", safeName(live.runId), "repos", safeName(repositoryId), "integration");
    const integration = await integrateBranch({
      sourceCwd, branch: repo.branch || live.workspace.branch, integrationCwd, dependencyCwd: repo.cwd || live.workspace.cwd,
      resolveConflicts: (input) => resolveMergeConflicts(ticketId, { ...input, activity, signal, attempt }),
      verify: async ({ cwd, conflicts }) => {
        signal?.throwIfAborted();
        await update((state) => {
          const run = state.ticketRuns[ticketId];
          patchRunDelivery(run, { repositoryId, status: "verifying", conflicts, verificationStartedAt: new Date().toISOString() });
          run.status = "verifying_merge";
          setStage(run, "handoff", "active", `Verifying merged result (${repo.displayPath || sourceCwd})`);
        });
        activity.onEvent({ type: "phase", label: "Running post-merge repository checks" }, "merge queue");
        const checks = repositoryId === "primary"
          ? await runChecksWithPreview({ ticketId, previewId: `${ticketId}:integration:${repositoryId}`, cwd, signal, required: flattenSteps(live.plan).some((step) => step.requiresVisualEvidence), requiredVideo: flattenSteps(live.plan).some((step) => step.requiresVideoEvidence) })
          : retainChecks(await runContainedRepositoryChecks({ ticketId, cwd, signal, requireVisualEvidence: false, requireVideoEvidence: false, environment: {} }));
        if (checks.status === "failed") throw new Error(`${checks.summary}\n\n${checks.output}`);
        await update((state) => { patchRunDelivery(state.ticketRuns[ticketId], { repositoryId, checks, verifiedAt: new Date().toISOString() }); });
      }
    });
    await update((state) => {
      patchRunDelivery(state.ticketRuns[ticketId], {
        repositoryId, status: "integrated", commit: integration.commit, conflicts: integration.conflicts,
        diff: integration.diff, integratedAt: new Date().toISOString(), error: null
      });
    });
    return integration;
  });
  return queued.promise;
}

async function scheduleAllDeliveries(ticketId, { diff, contextContent = null, signal } = {}) {
  if (activeMerges.has(ticketId)) {
    const live = readRun(ticketId);
    throw new Error(live.ticket.source === "local" ? "This ticket is already in the merge queue" : "This ticket is already being delivered");
  }
  const queuedRun = readRun(ticketId);
  const ownerRunId = queuedRun.runId;
  // Claim delivery before inspecting repositories. The inspection itself awaits
  // filesystem work, so claiming later permits two approvals to enqueue merges.
  activeMerges.add(ticketId);
  let required;
  try {
    required = await requiredChangedGitRepos(queuedRun);
    const live = readRun(ticketId);
    if (live.runId !== ownerRunId) throw new Error("Delivery run was replaced before scheduling");
    // Required repositories decide which changes to deliver. Proof validation has
    // a wider scope: every repository without a completed delivery must still
    // match the revision reviewed by the operator, even if it was later reverted
    // or no longer appears in the current delivery diff.
    const pendingRepositoryIds = gitRepositoriesForStep(live)
      .filter((repo) => !deliveryFinished((live.deliveries || []).find((item) => item.repositoryId === deliveryRepositoryId(repo))))
      .map((repo) => deliveryRepositoryId(repo));
    await assertProofRevision(live, live.finalProofRevision || live.checkpoint?.proofRevision, {
      repositoryIds: pendingRepositoryIds
    });
    if (readRun(ticketId).runId !== ownerRunId) throw new Error("Delivery run was replaced during proof validation");
    if (!required.length) {
      try {
        return await completeNoChangeDelivery(ticketId, live, { diff, contextContent, ownerRunId });
      } finally {
        activeMerges.delete(ticketId);
      }
    }
  } catch (error) {
    activeMerges.delete(ticketId);
    throw error;
  }
  if (queuedRun.ticket.source === "local" && ["queued", "merging", "resolving_conflicts", "verifying"].includes(queuedRun.merge?.status)) {
    activeMerges.delete(ticketId);
    throw new Error("This ticket is already in the merge queue");
  }
  const attempt = (queuedRun.merge?.attempt || 0) + 1;
  const promise = (async () => {
    let adopted = false;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (run?.runId !== ownerRunId) return;
      adopted = true;
      run.merge = { ...(run.merge || {}), attempt, sourceCwd: run.workspace.sourceCwd, branch: run.workspace.branch };
      for (const repo of required) {
        const repositoryId = deliveryRepositoryId(repo);
        if ((run.deliveries || []).some((item) => item.repositoryId === repositoryId && deliveryFinished(item))) continue;
        if ((run.deliveries || []).some((item) => item.repositoryId === repositoryId)) continue;
        patchRunDelivery(run, createDeliveryRecord(repo, { status: "pending", attempt }));
      }
    });
    if (!adopted) return { kind: "superseded" };
    const activity = captureStageActivity(ticketId, "handoff", queuedRun.runId);
    const failures = [];
    for (const repo of required) {
      const live = readRun(ticketId);
      const existing = (live.deliveries || []).find((item) => item.repositoryId === deliveryRepositoryId(repo));
      if (deliveryFinished(existing)) continue;
      try {
        if (queuedRun.ticket.source === "local") await deliverLocalRepository(ticketId, repo, { signal, activity, attempt });
        else await deliverRemoteRepository(ticketId, repo, { diff: repo.deliveryDiff || diff, signal, activity, attempt });
      } catch (error) {
        await persistRepoDeliveryFailure(ticketId, repo, error);
        failures.push({ repositoryId: deliveryRepositoryId(repo), displayPath: repo.displayPath || repo.sourceCwd, error: redactText(error.message) });
      }
    }
    if (failures.length) throw new Error(classifyDeliveryFailure(failures));
    return finalizeSuccessfulDelivery(ticketId, { diff, contextContent, activity });
  })().catch(async (error) => {
    if (!signal?.aborted) await update((state) => {
      const run = state.ticketRuns[ticketId];
      if (run?.runId !== ownerRunId) return;
      const previousStatus = run.status;
      const previousMergeStatus = run.merge?.status || null;
      run.status = "needs_attention";
      run.lastError = redactText(error.message);
      run.failure = executionFailure(error, { phase: "delivery" });
      if (run.merge) Object.assign(run.merge, { status: "failed", error: redactText(error.message), failedAt: new Date().toISOString() });
      const deliveries = run.deliveries || [];
      run.recovery = {
        kind: "delivery",
        previousStatus,
        previousMergeStatus,
        uncertainExternalActions: Boolean(run.merge?.change || run.merge?.externalActionPending || deliveries.some((item) => item.change || item.externalActionPending)),
        message: run.failure.nextAction, failure: run.failure
      };
      setStage(run, "handoff", "blocked", redactText(error.message));
    });
    await mirrorExecutionBlocker(ticketId, error);
    throw error;
  }).finally(() => activeMerges.delete(ticketId));
  return { position: 1, promise };
}
  return { scheduleAllDeliveries };
}

export { createDeliveryRecord, deliveryFinished, deliveryRepositoryId };

export function patchRunDelivery(run, patch) {
  run.deliveries = upsertDeliveryRecord(run.deliveries || [], patch);
  const record = run.deliveries.find((item) => item.repositoryId === deliveryRepositoryId(patch));
  const primary = run.deliveries.find((item) => item.repositoryId === "primary") || run.deliveries[0];
  const failed = run.deliveries.filter((item) => item.status === "failed");
  const unfinished = run.deliveries.filter((item) => !deliveryFinished(item) && item.status !== "failed");
  const inFlight = unfinished[0] || null;
  run.merge = {
    ...(run.merge || {}),
    status: inFlight?.status || (failed.length ? "failed" : primary?.status || run.merge?.status),
    sourceCwd: primary?.sourceCwd || run.merge?.sourceCwd,
    branch: primary?.branch || run.merge?.branch,
    base: primary?.base ?? inFlight?.base ?? run.merge?.base,
    remote: primary?.remote ?? inFlight?.remote ?? run.merge?.remote,
    change: primary?.change || run.merge?.change || null,
    checks: inFlight?.checks || primary?.checks || run.merge?.checks,
    commit: primary?.commit || run.merge?.commit,
    sync: primary?.sync || run.merge?.sync,
    error: failed[0]?.error || null,
    externalActionPending: inFlight?.externalActionPending || null,
    feedbackIds: primary?.feedbackIds || run.merge?.feedbackIds || []
  };
  if (record?.status === "failed") Object.assign(run.merge, { status: "failed", error: record.error, failedAt: record.failedAt || new Date().toISOString() });
  return record;
}

export async function requiredChangedGitRepos(run) {
  const repos = gitRepositoriesForStep(run);
  const trees = await snapshotRepositoryTrees(repos);
  const baseline = Object.fromEntries(repos.map((repo) => [repo.id || "primary", repo.baselineTree || ((repo.id || "primary") === "primary" ? run.baselineTree : null)]));
  const diffs = await diffRepositoryTrees(repos, baseline, trees);
  return changedGitDeliveryRepos(repos, diffs).map((repo) => ({ ...repo, deliveryDiff: diffs[deliveryRepositoryId(repo)] }));
}
