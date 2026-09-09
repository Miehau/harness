import { randomUUID } from "node:crypto";
import { beginRunCleanup, completeRunCleanup } from "./execution.js";
import { createProcessContainment } from "./process-containment.js";
import { runRepositoryChecks } from "./repository-checks.js";

export class RunRuntime {
  constructor({
    readState = () => ({}),
    update = async () => {},
    harness = {},
    mockRepositoryChecks = null,
    containmentFactory,
    isClosed = () => false,
    cleanupTimeoutMs = 5000,
    workerAbortWaitMs = 1000,
  } = {}) {
    Object.assign(this, {
      readState,
      update,
      harness,
      mockRepositoryChecks,
      containmentFactory:
        containmentFactory ||
        harness.containmentFactory ||
        createProcessContainment,
      isClosed,
      cleanupTimeoutMs,
      workerAbortWaitMs,
      activeSteps: new Map(),
      stepControllers: new Map(),
      stepAcceptances: new Map(),
      activeTickets: new Map(),
      activeContainments: new Map(),
      activeMerges: new Set(),
      mergeQueues: new Map(),
      steeringDrainTimers: new Map(),
    });
  }
  run(ticketId) {
    const run = this.readState().ticketRuns?.[ticketId];
    if (!run) throw new Error("Ticket run not found");
    return run;
  }
  containmentForExecution(executionId) {
    return this.containmentFactory({ executionId });
  }
  trigger(trigger, at = new Date().toISOString()) {
    return trigger && typeof trigger === "object" && !Array.isArray(trigger)
      ? { ...trigger, at: trigger.at ?? at }
      : { trigger: typeof trigger === "string" ? trigger : "unspecified", at };
  }
  async persistContainment(ticketId, runId, executionId, evidence, trigger) {
    await this.update(
      (state) => {
        const active = state.ticketRuns?.[ticketId];
        const run =
          active?.runId === runId
            ? active
            : state.retainedRuns?.[`${ticketId}:${runId}`];
        if (run)
          completeRunCleanup(run, executionId, evidence, this.trigger(trigger));
      },
      { publish: false },
    );
  }
  async persistPreviewCleanup(ticketId, runId, previewId, record) {
    await this.update(
      (state) => {
        const active = state.ticketRuns?.[ticketId];
        const run =
          active?.runId === runId
            ? active
            : state.retainedRuns?.[`${ticketId}:${runId}`];
        const preview = run?.previews?.[previewId];
        if (preview) {
          preview.cleanup = record;
          preview.status =
            record.outcome === "incomplete" ? "cleanup_incomplete" : "stopped";
        }
      },
      { publish: false },
    );
  }
  trackPending(executionId, operation) {
    const entry = this.activeContainments.get(executionId);
    if (!entry) return;
    entry.pendingCleanup = operation;
    entry.pendingCleanupSettled = false;
    operation.finally(() => {
      if (entry.pendingCleanup !== operation) return;
      entry.pendingCleanupSettled = true;
      if (
        entry.executionFinished &&
        this.activeContainments.get(executionId) === entry
      )
        this.activeContainments.delete(executionId);
    });
  }
  finish(executionId, containment) {
    const entry = this.activeContainments.get(executionId);
    if (!entry || entry.containment !== containment) return;
    entry.executionFinished = true;
    if (entry.pendingCleanupSettled)
      this.activeContainments.delete(executionId);
  }
  async settleContainment(
    ticketId,
    executionId,
    containment,
    trigger,
    runId = this.activeContainments.get(executionId)?.runId,
  ) {
    const lifecycle = this.trigger(trigger);
    const operation = Promise.resolve()
      .then(() => containment.cleanup(lifecycle))
      .catch((error) => ({
        executionId,
        outcome: "incomplete",
        completedAt: new Date().toISOString(),
        diagnostics: [`Process cleanup failed: ${error.message || error}`],
        unresolved: [{ reason: "cleanup-failed" }],
      }));
    this.trackPending(executionId, operation);
    let timer;
    const evidence = await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), this.cleanupTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const value = evidence || {
      executionId,
      outcome: "incomplete",
      completedAt: new Date().toISOString(),
      diagnostics: [
        `Process cleanup did not settle within ${this.cleanupTimeoutMs}ms during ${lifecycle.trigger}`,
      ],
      unresolved: [{ reason: "cleanup-wait-timeout" }],
    };
    await this.persistContainment(
      ticketId,
      runId,
      executionId,
      value,
      lifecycle,
    );
    return value;
  }
  async cleanupTicketContainments(ticketId, trigger) {
    await Promise.all(
      [...this.activeContainments.values()]
        .filter((entry) => entry.ticketId === ticketId)
        .map((entry) =>
          this.settleContainment(
            ticketId,
            entry.executionId,
            entry.containment,
            trigger,
            entry.runId,
          ),
        ),
    );
  }
  async registerContainment(
    ticketId,
    executionId,
    containment,
    { stepId = null, attemptId = null, trigger = "worker-launch", runId: expectedRunId = null } = {},
  ) {
    const prior = this.activeContainments.get(executionId);
    if (prior) {
      if (prior.ticketId !== ticketId || prior.containment !== containment)
        throw new Error(
          `Execution ${executionId} is already owned by another containment`,
        );
      return prior.runId;
    }
    const entry = {
      ticketId,
      executionId,
      containment,
      runId: null,
      executionFinished: false,
      pendingCleanup: null,
      pendingCleanupSettled: false,
    };
    this.activeContainments.set(executionId, entry);
    try {
      await this.update(
        (state) => {
          const run = state.ticketRuns?.[ticketId];
          if (!run) throw new Error("Ticket run not found");
          if (expectedRunId && run.runId !== expectedRunId) {
            const error = new Error("Ticket run was superseded");
            error.code = "run_superseded";
            throw error;
          }
          entry.runId = run.runId;
          beginRunCleanup(run, {
            executionId,
            ownership: containment.ownership,
            stepId,
            attemptId,
            trigger,
          });
        },
        { publish: false },
      );
    } catch (error) {
      if (this.activeContainments.get(executionId) === entry)
        this.activeContainments.delete(executionId);
      throw error;
    }
    if (this.isClosed()) {
      await this.settleContainment(
        ticketId,
        executionId,
        containment,
        "daemon-shutdown",
        entry.runId,
      );
      this.finish(executionId, containment);
      throw new Error("Daemon is shutting down");
    }
    return entry.runId;
  }
  completion(signal, aborted, completed) {
    return !signal?.aborted
      ? completed
      : /timeout/i.test(String(signal.reason?.message || signal.reason || ""))
        ? "timeout"
        : aborted;
  }
  async runContainedWorker({
    ticketId,
    stepId,
    attemptId = null,
    signal,
    ...input
  }) {
    const executionId = input.executionId || randomUUID();
    const containment =
      input.containment || this.containmentForExecution(executionId);
    const runId = await this.registerContainment(
      ticketId,
      executionId,
      containment,
      { stepId, attemptId, runId: input.runId ?? null },
    );
    let result;
    try {
      result = await this.harness.runStep({
        ...input,
        containment,
        ticketId,
        attemptId,
        signal,
        access: input.access || this.run(ticketId).access,
        repositories:
          input.repositories || this.run(ticketId).repositories || [],
        onCleanup: (evidence, trigger) =>
          this.persistContainment(
            ticketId,
            runId,
            executionId,
            evidence,
            trigger,
          ),
      });
      return result;
    } finally {
      await this.settleContainment(
        ticketId,
        executionId,
        containment,
        this.completion(
          signal,
          "worker-aborted",
          result?.report?.status === "completed"
            ? "worker-completed"
            : "worker-exit",
        ),
        runId,
      );
      this.finish(executionId, containment);
    }
  }
  async runContainedRepositoryChecks({
    ticketId,
    stepId = null,
    signal,
    runId: expectedRunId = null,
    ...input
  }) {
    const executionId = input.executionId || randomUUID();
    const containment =
      input.containment || this.containmentForExecution(executionId);
    const runId = await this.registerContainment(
      ticketId,
      executionId,
      containment,
      { stepId, trigger: "repository-check-launch", runId: expectedRunId },
    );
    let result, failure;
    try {
      const check = this.mockRepositoryChecks
        ? this.mockRepositoryChecks.bind(this.harness)
        : (args) =>
            runRepositoryChecks({
              ...args,
              dataDir: this.harness.dataDir,
              containmentFactory: this.harness.containmentFactory,
              execImpl: this.harness.exec,
              repositoryCheckTimeoutMs: this.harness.repositoryCheckTimeoutMs,
            });
      result = await check({ ...input, containment, signal });
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.settleContainment(
        ticketId,
        executionId,
        containment,
        result?.cleanupTrigger ||
          failure?.cleanupTrigger ||
          this.completion(
            signal,
            "repository-check-aborted",
            "repository-check-exit",
          ),
        runId,
      );
      this.finish(executionId, containment);
    }
  }
  start(ticketId, work) {
    if (this.activeTickets.has(ticketId))
      return this.activeTickets.get(ticketId).promise;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        if (this.activeTickets.get(ticketId)?.controller === controller)
          this.activeTickets.delete(ticketId);
      });
    this.activeTickets.set(ticketId, { controller, promise });
    return promise;
  }
  async waitForWorkerAbort(promise) {
    let timer;
    try {
      await Promise.race([
        promise.catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.workerAbortWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  clearSteeringTimers() {
    for (const timer of this.steeringDrainTimers.values()) clearTimeout(timer);
    this.steeringDrainTimers.clear();
  }
}
