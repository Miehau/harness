import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultStageProfiles, normalizeStageProfiles } from "./profiles.js";

function initialState(cwd) {
  return {
    version: 4,
    revision: 0,
    workspace: { cwd },
    settings: normalizeSettings(),
    stageProfiles: defaultStageProfiles(),
    selectedTicketId: null,
    ticketRuns: {},
    notice: null
  };
}

export function normalizeSettings(value = {}) {
  const maxConcurrentTickets = Number(value.maxConcurrentTickets);
  return {
    maxConcurrentTickets: Number.isInteger(maxConcurrentTickets) && maxConcurrentTickets >= 1 && maxConcurrentTickets <= 32
      ? maxConcurrentTickets
      : 2
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
      if ([3, 4].includes(saved.version)) this.state = saved;
      this.state.version = 4;
      this.state.workspace ||= { cwd: this.cwd };
      this.state.workspace.cwd ||= this.cwd;
      this.state.settings = normalizeSettings(this.state.settings);
      this.state.stageProfiles = normalizeStageProfiles(this.state.stageProfiles);
      this.state.ticketRuns ||= {};
      for (const run of Object.values(this.state.ticketRuns)) {
        run.stageProfiles = normalizeStageProfiles(run.stageProfiles || this.state.stageProfiles);
        run.auto ||= false;
        run.activeRuns = {};
        for (const node of run.plan?.nodes || []) {
          for (const step of node.type === "group" ? node.children : [node]) {
            if (["running", "fixing"].includes(step.status)) step.status = "interrupted";
          }
        }
        if (["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing", "queued_for_merge", "merging", "resolving_conflicts", "verifying_merge"].includes(run.status)) {
          run.status = "interrupted";
          if (["queued", "merging", "resolving_conflicts", "verifying"].includes(run.merge?.status)) run.merge.status = "interrupted";
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
