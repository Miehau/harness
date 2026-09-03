import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { artifactPathInDataDir, persistArtifact, safeName } from "./artifacts.js";
import { defaultStageProfiles, normalizeStageProfiles } from "./profiles.js";
import { inFlightMergeStatusSet, inFlightRunStatusSet, inFlightStepStatusSet } from "./run-status.js";
import { flattenSteps } from "./plan.js";
import { initializeRunCleanup, materializeActiveAttempt } from "./execution.js";

function ensureAttemptIds(run) {
  let changed = false;
  for (const step of flattenSteps(run.plan || { nodes: [] })) {
    for (const [index, attempt] of (step.attempts || []).entries()) {
      if (!attempt.attemptId) { attempt.attemptId = `attempt-${index + 1}`; changed = true; }
    }
    const active = run.activeRuns?.[step.id];
    if (active && !active.attemptId) { active.attemptId = `active-${active.runId || step.id}`; changed = true; }
  }
  return changed;
}

async function migrateArtifactBodies(run, dataDir) {
  let changed = false;
  const artifacts = run.artifacts || [];
  const legacyArtifacts = artifacts.filter((artifact) => artifact && typeof artifact === "object" && "content" in artifact);
  const pathCounts = new Map();
  const idCounts = new Map();
  const usedIds = new Set(artifacts.filter((artifact) => !legacyArtifacts.includes(artifact)).map((artifact) => artifact?.id).filter(Boolean));
  const migratedIds = new Map();
  const artifactPathKey = (artifact) => {
    const base = safeName(artifact.name || artifact.id || "artifact.md");
    const filename = base.includes(".") ? base : `${base}.md`;
    return [artifact.stageId || "legacy", artifact.stepId || "", artifact.attemptId || "", artifact.kind || "agent-output", filename].map(safeName).join(":");
  };
  for (const artifact of legacyArtifacts) {
    const pathKey = artifactPathKey(artifact);
    pathCounts.set(pathKey, (pathCounts.get(pathKey) || 0) + 1);
    if (artifact.id) idCounts.set(artifact.id, (idCounts.get(artifact.id) || 0) + 1);
  }
  const uniqueId = (base) => {
    let candidate = base || "legacy-artifact";
    for (let suffix = 2; usedIds.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    usedIds.add(candidate);
    return candidate;
  };
  for (const [index, artifact] of legacyArtifacts.entries()) {
    if (typeof artifact.content === "string") {
      const pathCollision = pathCounts.get(artifactPathKey(artifact)) > 1;
      const idCollision = !artifact.id || idCounts.get(artifact.id) > 1 || usedIds.has(artifact.id);
      const persisted = await persistArtifact(dataDir, run.ticket || { identifier: run.id || "legacy" }, {
        name: artifact.name || artifact.id || "artifact.md",
        content: artifact.content,
        runId: run.runId || "legacy",
        stageId: artifact.stageId || "legacy",
        kind: artifact.kind || "agent-output",
        stepId: artifact.stepId || null,
        attemptId: artifact.attemptId || null,
        // Legacy records may share every storage component, including kind. Keep
        // their original ID in the storage key so migration never overwrites a body.
        storageKey: pathCollision ? `${artifact.id || "legacy"}-${index + 1}` : null
      });
      artifact.path = persisted.path;
      // Content routes and dashboard selection use IDs, not file paths. A legacy
      // duplicate therefore needs the same durable identity separation as its body.
      if (idCollision) {
        const legacyId = artifact.id;
        artifact.id = uniqueId(persisted.id);
        if (legacyId) migratedIds.set(legacyId, [...(migratedIds.get(legacyId) || []), artifact.id]);
      } else usedIds.add(artifact.id);
    }
    delete artifact.content;
    changed = true;
  }
  const remapIds = (ids) => {
    const seen = new Map();
    return ids.map((id) => {
      const replacements = migratedIds.get(id);
      if (!replacements?.length) return id;
      const index = seen.get(id) || 0;
      seen.set(id, index + 1);
      return replacements[index] || replacements.at(-1);
    });
  };
  if (Array.isArray(run.checkpoint?.evidenceArtifactIds)) {
    const remapped = remapIds(run.checkpoint.evidenceArtifactIds);
    if (remapped.some((id, index) => id !== run.checkpoint.evidenceArtifactIds[index])) {
      run.checkpoint.evidenceArtifactIds = remapped;
      changed = true;
    }
  }
  if (Array.isArray(run.checkpoint?.media)) {
    const ids = remapIds(run.checkpoint.media.map((artifact) => artifact.id));
    if (ids.some((id, index) => id !== run.checkpoint.media[index].id)) {
      run.checkpoint.media = run.checkpoint.media.map((artifact, index) => ({ ...artifact, id: ids[index] }));
      changed = true;
    }
  }
  if (Array.isArray(run.pauseHistory)) for (const pause of run.pauseHistory) {
    const replacement = migratedIds.get(pause.artifactId)?.[0];
    if (replacement) { pause.artifactId = replacement; changed = true; }
  }
  return changed;
}

function recoverInterruptedCleanup(run, at = new Date().toISOString()) {
  const cleanup = initializeRunCleanup(run, { legacy: true });
  for (const execution of cleanup.executions) {
    if (execution.outcome !== "running") continue;
    // Ownership tokens are intentionally never persisted, so a restarted
    // daemon cannot safely rediscover these processes. Preserve uncertainty
    // rather than claiming a cleanup result based on a reusable PID.
    execution.outcome = "incomplete";
    execution.completedAt = at;
    execution.triggers ||= [];
    execution.triggers.push({ trigger: "daemon-restart-recovery", at });
    execution.unresolved ||= [];
    execution.unresolved.push({ reason: "restart-ownership-token-unavailable" });
    execution.diagnostics ||= [];
    execution.diagnostics.push("Daemon restart cannot safely inspect an interrupted execution without its non-persisted ownership token");
  }
  if (cleanup.executions.some((execution) => execution.outcome === "incomplete")) cleanup.outcome = "incomplete";
  cleanup.updatedAt = at;
}

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
const STATE_OUTPUT_LIMIT = 100000;
const STATE_ARTIFACT_SUMMARY_LIMIT = 1000;
const STATE_EVENT_COUNT_LIMIT = 100;
const STATE_PROMPT_COUNT_LIMIT = 10;

function boundedAuditText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… state detail truncated to keep the harness responsive`;
}

// Worker capture already retains a 100 KB tail. Preserve that deliberate
// bounded window, but compact oversized legacy or malformed output further
// before it can make a state write unexpectedly large.
function compactOutput(value) {
  return typeof value === "string" && value.length > STATE_OUTPUT_LIMIT
    ? boundedAuditText(value, STATE_PROMPT_LIMIT)
    : value;
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
  activity.rawOutput = compactOutput(activity.rawOutput);
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
        const eventCount = (attempt.events || []).length;
        attempt.eventsTotal = Math.max(Number(attempt.eventsTotal) || 0, eventCount);
        attempt.events = (attempt.events || []).slice(-STATE_EVENT_COUNT_LIMIT).map((event) => {
          const compact = { ...event };
          for (const key of ["args", "output", "result", "detail"]) compact[key] = boundedAuditText(compact[key], STATE_EVENT_DETAIL_LIMIT);
          return compact;
        });
        attempt.rawOutput = compactOutput(attempt.rawOutput);
        if (attempt.verification) attempt.verification.rawOutput = compactOutput(attempt.verification.rawOutput);
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
    let recovered = false;
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
      for (const run of [...Object.values(this.state.ticketRuns), ...Object.values(this.state.retainedRuns)]) {
        recoverInterruptedCleanup(run);
        run.stageProfiles = normalizeStageProfiles(run.stageProfiles || this.state.stageProfiles);
        if (await migrateArtifactBodies(run, dirname(this.file))) recovered = true;
        if (ensureAttemptIds(run)) recovered = true;
        run.auto ||= false;
        const activeRuns = run.activeRuns || {};
        for (const step of flattenSteps(run.plan || { nodes: [] })) {
          if (!inFlightStepStatusSet.has(step.status)) continue;
          materializeActiveAttempt(step, activeRuns[step.id] || {}, {
            status: "interrupted",
            completedAt: new Date().toISOString(),
            reason: "daemon_restart",
            phase: "daemon_recovery"
          });
          step.status = "interrupted";
          recovered = true;
        }
        if (Object.keys(activeRuns).length) recovered = true;
        run.activeRuns = {};
        for (const preview of Object.values(run.previews || {})) Object.assign(preview, { status: "stopped", stoppedReason: "daemon_restart" });
        if (inFlightRunStatusSet.has(run.status)) {
          const previousStatus = run.status;
          const previousMergeStatus = run.merge?.status;
          run.status = "interrupted";
          if (inFlightMergeStatusSet.has(run.merge?.status)) run.merge.status = "interrupted";
          recovered = true;
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
      // Retained runs are audit evidence too; a saved in-flight record remains
      // uncertain after restart rather than being represented as a success.
      for (const run of Object.values(this.state.retainedRuns)) recoverInterruptedCleanup(run);
      await this.save();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Restart recovery is a lifecycle transition, so persist it before exposure.
    if (recovered) await this.save();
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
