import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultStageProfiles, normalizeStageProfiles } from "./profiles.js";

function initialState(cwd) {
  return {
    version: 3,
    revision: 0,
    workspace: { cwd },
    stageProfiles: defaultStageProfiles(),
    selectedTicketId: null,
    ticketRuns: {},
    notice: null
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
      if (saved.version === 3) this.state = saved;
      this.state.workspace ||= { cwd: this.cwd };
      this.state.workspace.cwd ||= this.cwd;
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
        if (["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing"].includes(run.status)) run.status = "interrupted";
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
