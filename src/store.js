import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultStageProfiles, normalizeStageProfiles } from "./profiles.js";
import { inFlightMergeStatusSet, inFlightRunStatusSet, inFlightStepStatusSet } from "./run-status.js";

function initialState(cwd) {
  return {
    version: 6,
    revision: 0,
    workspace: { cwd },
    settings: normalizeSettings(),
    stageProfiles: defaultStageProfiles(),
    selectedTicketId: null,
    ticketRuns: {},
    retainedRuns: {},
    notice: null
  };
}

export function normalizeSettings(value = {}) {
  const maxConcurrentTickets = Number(value.maxConcurrentTickets);
  const pollIntervalSeconds = Number(value.pollIntervalSeconds);
  return {
    maxConcurrentTickets: Number.isInteger(maxConcurrentTickets) && maxConcurrentTickets >= 1 && maxConcurrentTickets <= 32
      ? maxConcurrentTickets
      : 2,
    projectMode: value.projectMode === "automatic" ? "automatic" : "manual",
    pollIntervalSeconds: Number.isInteger(pollIntervalSeconds) && pollIntervalSeconds >= 15 && pollIntervalSeconds <= 3600
      ? pollIntervalSeconds
      : 60
  };
}

export class JsonStore {
  constructor(file, cwd) {
    this.file = file;
    this.cwd = cwd;
    this.state = initialState(cwd);
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      if ([3, 4, 5, 6].includes(saved.version)) this.state = saved;
      this.state.version = 6;
      this.state.workspace ||= { cwd: this.cwd };
      this.state.workspace.cwd ||= this.cwd;
      this.state.settings = normalizeSettings(this.state.settings);
      this.state.stageProfiles = normalizeStageProfiles(this.state.stageProfiles);
      this.state.ticketRuns ||= {};
      this.state.retainedRuns ||= {};
      for (const run of Object.values(this.state.ticketRuns)) {
        run.stageProfiles = normalizeStageProfiles(run.stageProfiles || this.state.stageProfiles);
        run.auto ||= false;
        run.activeRuns = {};
        for (const node of run.plan?.nodes || []) {
          for (const step of node.type === "group" ? node.children : [node]) {
            if (inFlightStepStatusSet.has(step.status)) step.status = "interrupted";
          }
        }
        for (const preview of Object.values(run.previews || {})) Object.assign(preview, { status: "stopped", stoppedReason: "daemon_restart" });
        if (inFlightRunStatusSet.has(run.status)) {
          const previousStatus = run.status;
          const previousMergeStatus = run.merge?.status;
          run.status = "interrupted";
          if (inFlightMergeStatusSet.has(run.merge?.status)) run.merge.status = "interrupted";
          run.recovery = {
            kind: previousMergeStatus ? "delivery" : "execution",
            previousStatus,
            previousMergeStatus: previousMergeStatus || null,
            uncertainExternalActions: Boolean(run.merge?.change || run.merge?.externalActionPending),
            message: run.merge?.externalActionPending
              ? `Delivery stopped while ${run.merge.externalActionPending.replaceAll("_", " ")} may have been in flight. Inspect the forge before resuming.`
              : run.merge?.change
              ? "Delivery was interrupted. Resume will inspect the existing remote change before taking another external action."
              : "Execution was interrupted. Review the checkpoint and resume manually."
          };
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    return this.read();
  }

  read() { return structuredClone(this.state); }

  async update(change) {
    const work = this.queue.then(async () => {
      await change(this.state);
      this.state.revision = (this.state.revision || 0) + 1;
      await this.save();
      return this.read();
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async save() {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
