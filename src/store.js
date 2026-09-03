import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { artifactPathInDataDir } from "./artifacts.js";
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

const STATE_EVENT_DETAIL_LIMIT = 4000;
const STATE_PROMPT_LIMIT = 50000;
const STATE_OUTPUT_LIMIT = 50000;
const STATE_ARTIFACT_SUMMARY_LIMIT = 1000;
const STATE_EVENT_COUNT_LIMIT = 100;
const STATE_PROMPT_COUNT_LIMIT = 10;

function boundedAuditText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… state detail truncated to keep the harness responsive`;
}

function compactActivity(activity) {
  if (!activity) return;
  activity.events = (activity.events || []).slice(-STATE_EVENT_COUNT_LIMIT).map((event) => {
    const compact = { ...event };
    for (const key of ["args", "output", "result", "detail"]) compact[key] = boundedAuditText(compact[key], STATE_EVENT_DETAIL_LIMIT);
    return compact;
  });
  activity.prompts = (activity.prompts || []).slice(-STATE_PROMPT_COUNT_LIMIT).map((prompt) => ({
    ...prompt,
    content: boundedAuditText(prompt.content, STATE_PROMPT_LIMIT),
    prompt: boundedAuditText(prompt.prompt, STATE_PROMPT_LIMIT)
  }));
  activity.rawOutput = boundedAuditText(activity.rawOutput, STATE_OUTPUT_LIMIT);
  delete activity.groups;
}

function compactDiff(diff) {
  if (diff && typeof diff === "object") delete diff.patch;
}

// Keep the full canonical diffs that proof routes reopen before compacting their
// display copies. The live attempt/review records stay small without making an
// archived locator resolve to a patchless summary after restart.
function preserveCanonicalDiffs(run) {
  for (const node of run.plan?.nodes || []) for (const step of node.type === "group" ? node.children : [node]) {
    for (const attempt of step.attempts || []) {
      if (!attempt.attemptId || !attempt.diff) continue;
      run.attemptDiffHistory ||= {};
      run.attemptDiffHistory[step.id] ||= {};
      // Break aliases before compactDiff mutates the display record below.
      run.attemptDiffHistory[step.id][attempt.attemptId] = structuredClone(
        run.attemptDiffHistory[step.id][attempt.attemptId] || attempt.diff
      );
    }
  }
  for (const review of run.reviews || []) {
    if (!review.diff) continue;
    const reviewId = review.reviewId || (Number(review.round) ? `final-review-${Number(review.round)}` : null);
    if (!reviewId) continue;
    run.finalDiffHistory ||= {};
    // Final review history is the immutable proof target. It can share an object
    // with a review supplied by a caller, which compactDiff intentionally mutates.
    run.finalDiffHistory[reviewId] = structuredClone(run.finalDiffHistory[reviewId] || review.diff);
  }
}

function compactArtifactBodies(value, dataDir) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) compactArtifactBodies(item, dataDir);
    return;
  }
  const storedPath = typeof value.content === "string" && value.id && value.name && value.kind
    ? artifactPathInDataDir(value, dataDir)
    : null;
  if (storedPath && existsSync(storedPath)) {
    value.bodyStored = true;
    value.bodySummary = boundedAuditText(value.content, STATE_ARTIFACT_SUMMARY_LIMIT);
    delete value.content;
  }
  for (const child of Object.values(value)) compactArtifactBodies(child, dataDir);
}

export function compactPersistedState(state, dataDir = null) {
  for (const run of [...Object.values(state.ticketRuns || {}), ...Object.values(state.retainedRuns || {})]) {
    preserveCanonicalDiffs(run);
    for (const stage of run.stages || []) {
      compactActivity(stage.activity);
      compactDiff(stage.diff);
    }
    for (const active of Object.values(run.activeRuns || {})) compactActivity(active.activity);
    for (const node of run.plan?.nodes || []) for (const step of node.type === "group" ? node.children : [node]) {
      compactDiff(step.diff);
      for (const attempt of step.attempts || []) {
        attempt.events = (attempt.events || []).slice(-STATE_EVENT_COUNT_LIMIT).map((event) => {
          const compact = { ...event };
          for (const key of ["args", "output", "result", "detail"]) compact[key] = boundedAuditText(compact[key], STATE_EVENT_DETAIL_LIMIT);
          return compact;
        });
        attempt.rawOutput = boundedAuditText(attempt.rawOutput, STATE_OUTPUT_LIMIT);
        if (attempt.verification) attempt.verification.rawOutput = boundedAuditText(attempt.verification.rawOutput, STATE_OUTPUT_LIMIT);
        compactDiff(attempt.diff);
        compactDiff(attempt.checkDiff);
        compactDiff(attempt.aggregateDiff);
        delete attempt.activityGroups;
      }
    }
    for (const review of run.reviews || []) {
      compactDiff(review.diff);
      compactDiff(review.fix?.diff);
    }
  }
  if (dataDir) compactArtifactBodies(state, dataDir);
  return state;
}

export function normalizeSettings(value = {}) {
  const pollIntervalSeconds = Number(value.pollIntervalSeconds);
  return {
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
    }
    await this.save();
    return this.read();
  }

  read() { return structuredClone(this.state); }

  async update(change, { snapshot = true } = {}) {
    const work = this.queue.then(async () => {
      await change(this.state);
      this.state.revision = (this.state.revision || 0) + 1;
      await this.save();
      return snapshot ? this.read() : this.state;
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async save() {
    compactPersistedState(this.state, dirname(this.file));
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
