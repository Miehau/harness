import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { findNode, flattenSteps } from "./plan.js";
import { prepareRevisionWork } from "./coordination-workspaces.js";
import { ensureCoordination, coordinationBlockedStepIds, proposePlanRevision, acceptPlanRevision, rejectPlanRevision, reportConflict, recordCoordinationDecision } from "./coordination.js";
import { redactRecord, redactText } from "./redaction.js";
import { publicCoordination } from "./inspection.js";

export function coordinationBlockedSteps(run) {
  if (run?.coordination?.applyingRevisionId) return new Set(flattenSteps(run.plan).map((step) => step.id));
  return new Set(coordinationBlockedStepIds(run || {}));
}

function bounded(value, label, limit = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label} must contain 1–${limit} printable characters`);
  return redactText(value.trim());
}

export function createCoordinationService({ readState, update, runtime, harness, dataDir }) {
  const accepting = new Set();
  const assertNotApplying = (run) => { if (run.coordination?.applyingRevisionId) throw new Error("Finish applying the current revision before another coordination change"); };
  const runFor = (ticketId) => {
    const run = readState().ticketRuns?.[ticketId];
    if (!run) throw new Error("Ticket run not found");
    return run;
  };
  const editable = (run) => {
    if (!run?.plan || run.status === "completed" || run.merge || run.integration || run.stages?.some((stage) => ["verify", "handoff"].includes(stage.id) && stage.status === "active")) throw new Error("Coordination changes require an implementation run before final review or delivery");
  };
  const activeTarget = (run, target) => run?.runId === target.runId && run.activeRuns?.[target.stepId]?.attemptId === target.attemptId && run.activeRuns[target.stepId].piSessionState === "active";
  const root = (run) => resolve(run.access?.primary?.path || run.workspace?.sourceCwd || run.workspace?.cwd || readState().workspace.cwd);
  function listAgents(sender) {
    const own = runFor(sender.ticketId);
    if (!activeTarget(own, sender)) throw new Error("The sending worker attempt is no longer active");
    return Object.values(readState().ticketRuns || {}).filter((run) => root(run) === root(own)).flatMap((run) =>
      Object.entries(run.activeRuns || {}).map(([stepId, active]) => {
        const step = findNode(run.plan, stepId);
        return { ticketId: run.id, runId: run.runId, stepId, attemptId: active.attemptId, title: step?.title, agentId: step?.agentId, status: step?.status, writeScope: step?.writeScope, repository: root(run), available: active.piSessionState === "active", planRevision: active.planRevision || 1 };
      }));
  }
  async function sendMessage(sender, { target, text }) {
    const messageText = bounded(text, "Message");
    if (!target || !["ticketId", "runId", "stepId", "attemptId"].every((key) => typeof target[key] === "string" && target[key])) throw new Error("Choose an exact worker attempt returned by list_agents");
    const to = Object.fromEntries(["ticketId", "runId", "stepId", "attemptId"].map((key) => [key, target[key]]));
    if (JSON.stringify(sender) === JSON.stringify(to)) throw new Error("Choose a different worker");
    const id = randomUUID();
    const entry = { id, from: sender, to, text: messageText, state: "queued", createdAt: new Date().toISOString() };
    await update((state) => {
      const own = state.ticketRuns[sender.ticketId], recipient = state.ticketRuns[to.ticketId];
      if (!activeTarget(own, sender) || !activeTarget(recipient, to)) throw new Error("A worker attempt is no longer active; refresh list_agents");
      if (root(own) !== root(recipient)) throw new Error("Peer messaging is restricted to related repository work");
      for (const run of new Set([own, recipient])) {
        const ledger = ensureCoordination(run);
        if (ledger.messages.length >= 500) throw new Error("This run reached its 500-message coordination budget");
        ledger.messages.push(structuredClone(entry));
      }
    });
    try {
      if (typeof harness.deliverPeerMessage !== "function") throw new Error("Peer delivery is unavailable");
      const evidence = await harness.deliverPeerMessage({ ...to, message: entry });
      entry.state = "delivered";
      entry.deliveredAt = new Date().toISOString();
      entry.deliveryEvidence = evidence;
    } catch (error) {
      entry.state = error.code === "peer_session_unavailable" ? "failed" : "uncertain";
      entry.reason = redactText(error.message);
    }
    await update((state) => {
      for (const run of [...Object.values(state.ticketRuns || {}), ...Object.values(state.retainedRuns || {})]) {
        const saved = run.coordination?.messages?.find((item) => item.id === id);
        if (saved) Object.assign(saved, entry);
      }
    });
    return entry;
  }
  function abortAffected(ticketId, ids) {
    for (const id of ids) runtime.stepControllers?.get(`${ticketId}:${id}`)?.abort(new Error("Paused for coordination"));
  }
  async function settleAffected(ticketId, ids) {
    abortAffected(ticketId, ids);
    await Promise.all([...ids].map(async (id) => {
      const key = `${ticketId}:${id}`;
      const pending = runtime.activeSteps.get(key);
      if (pending) await runtime.waitForWorkerAbort(pending);
      if (runtime.activeSteps.has(key)) throw new Error("Affected workers are still stopping; retry after they settle");
    }));
    if ([...ids].some((id) => runFor(ticketId).activeRuns?.[id])) throw new Error("Affected attempts have not stopped yet");
  }
  async function conflict(ticketId, input, sender = null) {
    let saved;
    await update((state) => {
      const run = state.ticketRuns[ticketId];
      editable(run);
      if (sender && !activeTarget(run, sender)) throw new Error("The reporting worker attempt is no longer active");
      saved = reportConflict(run, { ...redactRecord(input), summary: bounded(input.summary, "Conflict"), author: sender || "operator" });
      if (sender && typeof harness.resolveCoordination === "function") saved.resolutionState = "queued";
    });
    abortAffected(ticketId, coordinationBlockedSteps(runFor(ticketId)));
    if (sender && typeof harness.resolveCoordination === "function") void resolveConflict(ticketId, { conflictId: saved.id }).catch(() => {});
    return saved;
  }
  async function propose(ticketId, input, author = "operator") {
    let revision;
    await update((state) => { const run = state.ticketRuns[ticketId]; editable(run); assertNotApplying(run); revision = proposePlanRevision(run, { ...redactRecord(input), author }); });
    abortAffected(ticketId, coordinationBlockedSteps(runFor(ticketId)));
    return revision;
  }
  async function accept(ticketId, id) {
    const before = runFor(ticketId);
    editable(before);
    const proposal = before.coordination?.revisions.find((item) => item.id === id);
    if (!proposal || proposal.status !== "proposed") throw new Error("Choose a proposed revision");
    if (accepting.has(ticketId)) throw new Error("A revision is already being applied");
    accepting.add(ticketId);
    try {
      await settleAffected(ticketId, new Set(proposal.affectedStepIds));
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId) throw new Error("The ticket run changed");
        if (run.coordination.applyingRevisionId && run.coordination.applyingRevisionId !== id) throw new Error("Finish applying the current revision first");
        // Validate before touching workspaces; this clone deliberately discards the dry-run mutation.
        acceptPlanRevision(structuredClone(run), id, { author: "operator" });
        run.coordination.applyingRevisionId = id;
      });
      for (const [key, pending] of runtime.stepAcceptances || []) if (key.startsWith(`${ticketId}:`)) await runtime.waitForWorkerAbort(pending);
      if ([...(runtime.stepAcceptances?.keys() || [])].some((key) => key.startsWith(`${ticketId}:`))) throw new Error("Step acceptance is still settling; retry the revision after it completes");
      const live = runFor(ticketId);
      await prepareRevisionWork({ run: live, revision: live.coordination.revisions.find((item) => item.id === id), dataDir, persist: (journal) => update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId || run.coordination.applyingRevisionId !== id) throw new Error("The revision changed while preserving work");
        run.coordination.revisions.find((item) => item.id === id).workPreparation = journal;
        for (const record of journal.repositories) if (record.artifact && !run.artifacts.some((item) => item.id === record.artifact.id)) run.artifacts.push(record.artifact);
      }) });
      let result;
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId) throw new Error("The ticket run changed");
        editable(run);
        result = acceptPlanRevision(run, id, { author: "operator" });
        delete run.coordination.applyingRevisionId;
      });
      return result;
    } catch (error) {
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run?.runId !== before.runId) return;
        const revision = run.coordination.revisions.find((item) => item.id === id);
        if (!revision?.workPreparation) delete run.coordination.applyingRevisionId;
        if (revision) revision.applyError = redactText(error.message);
      });
      throw error;
    } finally { accepting.delete(ticketId); }
  }
  async function reject(ticketId, id, input = {}) {
    let result;
    await update((state) => { const run = state.ticketRuns[ticketId]; editable(run); assertNotApplying(run); result = rejectPlanRevision(run, id, { ...input, author: "operator" }); });
    return result;
  }
  async function decide(ticketId, input) {
    const ownerRunId = runFor(ticketId).runId;
    let result;
    await settleAffected(ticketId, coordinationBlockedSteps(runFor(ticketId)));
    await update((state) => { const run = state.ticketRuns[ticketId]; if (run.runId !== ownerRunId) throw new Error("The ticket run changed"); editable(run); assertNotApplying(run); result = recordCoordinationDecision(run, { ...redactRecord(input), author: "operator" }); });
    return result;
  }
  const resolving = new Map();
  async function resolveConflict(ticketId, { conflictId }) {
    const before = runFor(ticketId);
    editable(before);
    if (resolving.has(ticketId)) throw new Error("The supervisor is already resolving a conflict for this run");
    const conflicts = (before.coordination?.conflicts || []).filter((item) => item.status !== "resolved" && (!conflictId || item.id === conflictId));
    if (!conflicts.length) throw new Error("No unresolved conflict found");
    if (typeof harness.resolveCoordination !== "function") throw new Error("Supervisor conflict resolution is unavailable");
    const controller = new AbortController();
    resolving.set(ticketId, controller);
    try {
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId) throw new Error("The ticket run changed");
        for (const conflict of run.coordination.conflicts) if (conflicts.some((item) => item.id === conflict.id)) Object.assign(conflict, { resolutionState: "resolving", resolutionError: null });
      });
      const result = await harness.resolveCoordination({ cwd: before.workspace.cwd, ticket: before.ticket, runId: before.runId, sessionFile: before.sessionFile, plan: before.plan, conflicts, decisions: before.coordination?.decisions || [], profile: before.stageProfiles.architecture, access: before.access, repositories: before.repositories || [], signal: controller.signal });
      controller.signal.throwIfAborted();
      const live = runFor(ticketId);
      if (live.runId !== before.runId || (live.planRevision || 1) !== (before.planRevision || 1)) throw new Error("The plan changed while the supervisor was resolving the conflict");
      const selected = result.conflictIds;
      if (!Array.isArray(selected) || !selected.length || selected.some((id) => !conflicts.some((item) => item.id === id))) throw new Error("The supervisor must identify the requested conflicts its proposal resolves");
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId) throw new Error("The ticket run changed");
        for (const conflict of run.coordination.conflicts) if (conflicts.some((item) => item.id === conflict.id) && !selected.includes(conflict.id)) conflict.resolutionState = "unresolved";
      });
      if (!result.changes?.length && !result.addSteps?.length) {
        const proposal = { reason: bounded(result.reason, "Resolution"), conflictIds: selected, author: "supervisor", createdAt: new Date().toISOString() };
        await update((state) => {
          const run = state.ticketRuns[ticketId];
          if (run.runId !== before.runId || (run.planRevision || 1) !== (before.planRevision || 1)) throw new Error("The plan changed");
          for (const id of selected) {
            const conflict = run.coordination.conflicts.find((item) => item.id === id && item.status === "open");
            if (!conflict) throw new Error("The conflict was already resolved");
            conflict.resolutionProposal = proposal;
            conflict.resolutionState = "proposed";
          }
        });
        return proposal;
      }
      const revision = await propose(ticketId, { ...result, conflictIds: selected }, "supervisor");
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run.runId !== before.runId) return;
        for (const conflict of run.coordination.conflicts) if (selected.includes(conflict.id)) conflict.resolutionState = "proposed";
      });
      return revision;
    } catch (error) {
      await update((state) => {
        const run = state.ticketRuns[ticketId];
        if (run?.runId !== before.runId) return;
        for (const conflict of run.coordination?.conflicts || []) if (conflicts.some((item) => item.id === conflict.id)) Object.assign(conflict, { resolutionState: "failed", resolutionError: redactText(error.message) });
      });
      throw error;
    } finally {
      resolving.delete(ticketId);
      const live = readState().ticketRuns?.[ticketId];
      const queued = live?.runId === before.runId && live.coordination?.conflicts.find((item) => item.status === "open" && item.resolutionState === "queued");
      if (queued && !controller.signal.aborted) void resolveConflict(ticketId, { conflictId: queued.id }).catch(() => {});
    }
  }
  function read(ticketId) {
    const run = runFor(ticketId);
    ensureCoordination(run);
    return { ...publicCoordination(run), planRevision: run.planRevision, blockedStepIds: [...coordinationBlockedSteps(run)] };
  }
  function forWorker(sender) {
    const run = runFor(sender.ticketId);
    return { listAgents: () => listAgents(sender), sendMessage: (input) => sendMessage(sender, input), reportConflict: (input) => conflict(sender.ticketId, input, sender), context: { planRevision: run.planRevision || 1, decisions: run.coordination?.decisions || [], conflicts: run.coordination?.conflicts || [] } };
  }
  return { read, forWorker, conflict, propose, accept, reject, decide, resolveConflict, close() { for (const controller of resolving.values()) controller.abort(new Error("Daemon shutting down")); } };
}
