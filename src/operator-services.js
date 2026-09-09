import { initializeProject } from "./initialization.js";
import { inspectReadiness } from "./readiness.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import {
  canonicalPrimaryPath,
  normalizeProjectPolicy,
  readProjectPolicy,
  writeProjectPolicy,
} from "./access-policy.js";
import { publicState } from "./inspection.js";
import { normalizeStageProfiles, parseModelRef } from "./profiles.js";
import { cleanupRetainedRun, retentionInventory } from "./retention.js";
import { clearInactiveRuns } from "./execution.js";
import { terminalRunStatusSet } from "./run-status.js";
import { normalizeSettings } from "./store.js";

const runFile = promisify(execFile);

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

export function createWorkspaceService({
  state,
  harness,
  loadLocal,
  ticketSources,
  vcsMode = "jj",
  runtime,
} = {}) {
  if (
    !state?.read ||
    !state?.update ||
    !harness ||
    typeof loadLocal !== "function" ||
    typeof ticketSources?.clear !== "function"
  ) {
    throw new TypeError(
      "Workspace service requires state, harness, local loader, and ticket sources",
    );
  }
  return {
    async initialize(input = {}) {
      if (Object.keys(input).some((key) => !["install", "verify"].includes(key)) || Object.values(input).some((value) => typeof value !== "boolean")) throw new Error("Initialization accepts boolean install and verify options only");
      if (runtime.projectSetup || runtime.activeTickets.size || runtime.activeMerges.size) throw new Error("Stop active work before project initialization");
      runtime.projectSetup = true;
      try {
        const result = await initializeProject(state.read().workspace.cwd, { vcsMode, ...input });
        return { ...result, readiness: await this.readiness() };
      } finally { runtime.projectSetup = false; }
    },
    readiness({ visual = false } = {}) {
      const snapshot = state.read();
      return inspectReadiness({ cwd: snapshot.workspace.cwd, vcsMode, visual,
        validateModels: () => harness.inspectModels ? harness.inspectModels(snapshot.stageProfiles) : harness.validateProfiles(snapshot.stageProfiles) });
    },
    async pick() {
      if (process.platform !== "darwin")
        throw new Error("Native repository selection currently requires macOS");
      try {
        const { stdout } = await runFile("osascript", [
          "-e",
          'POSIX path of (choose folder with prompt "Open repository")',
        ]);
        return { cwd: normalize(stdout.trim()) };
      } catch (error) {
        if (error.code === 1) throw new Error("Repository selection cancelled");
        throw error;
      }
    },
    async accessPolicy() {
      const snapshot = state.read();
      return readProjectPolicy(snapshot, snapshot.workspace.cwd);
    },
    async saveAccessPolicy(input) {
      const primaryCwd = state.read().workspace.cwd;
      const policy = await normalizeProjectPolicy(input, { primaryCwd });
      const key = await canonicalPrimaryPath(primaryCwd);
      await state.update((draft) => {
        writeProjectPolicy(draft, key, policy);
      });
      return policy;
    },
    async set(input) {
      if (runtime?.projectSetup) throw new Error("Wait for project initialization before switching workspace");
      const cwd = normalize(String(input.cwd || ""));
      if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
        throw new Error("Workspace must be an existing absolute directory");
      const previous = state.read().workspace?.cwd;
      const saved = await state.update((draft) => {
        draft.workspace = { cwd };
      });
      if (previous !== cwd) harness.reset();
      // Sources belong to the prior workspace even when an operator selects
      // the same path again; force the next ticket listing to refresh them.
      ticketSources.clear();
      return publicState(saved);
    },
    loadLocal(input) {
      return loadLocal(String(input.path || "fixtures/zero-state-task-board"));
    },
  };
}

export function createSettingsService({
  state,
  runtime,
  previews,
  dataDir,
  harness,
  credentials,
  trackers,
} = {}) {
  if (
    !state?.read ||
    !state?.update ||
    !runtime ||
    !previews ||
    !dataDir ||
    !harness ||
    !credentials ||
    !trackers
  ) {
    throw new TypeError(
      "Settings service requires state, runtime, previews, data, harness, credentials, and trackers",
    );
  }
  return {
    trackerSettings: () => credentials.public(),
    async saveTrackerSettings(input) {
      await trackers.waitForRefresh?.();
      const saved = await credentials.save(input);
      await trackers.replace(saved);
      return {
        settings: credentials.public(saved),
        ticketSources: await trackers.refresh({ admit: false }),
      };
    },
    async clearQueue() {
      let cleared = 0;
      const saved = await state.update((draft) => {
        cleared = clearInactiveRuns(
          draft,
          new Set([...runtime.activeTickets.keys(), ...runtime.activeMerges]),
        );
      });
      return { cleared, state: saved };
    },
    async forgetRun(ticketId, input) {
      if (!input.confirmed)
        throw new Error("Confirm permanently forgetting this run");
      if (
        runtime.activeTickets.has(ticketId) ||
        runtime.activeMerges.has(ticketId)
      )
        throw new Error("Cancel the active run before forgetting it");
      await cleanupRetainedRun({
        run: ticketRun(state.read(), ticketId),
        dataDir,
        previewManager: previews,
      });
      const saved = await state.update((draft) => {
        delete draft.ticketRuns[ticketId];
        if (draft.selectedTicketId === ticketId) draft.selectedTicketId = null;
      });
      return { forgotten: true, ticketId, state: saved };
    },
    retention: () => retentionInventory(state.read(), dataDir),
    async cleanupRetention(input) {
      const ticketIds = [
        ...new Set(
          Array.isArray(input.ticketIds) ? input.ticketIds.map(String) : [],
        ),
      ];
      if (!input.confirmed || !ticketIds.length)
        throw new Error("Confirm at least one retained run for cleanup");
      const cleaned = [];
      for (const id of ticketIds) {
        const snapshot = state.read();
        const run = snapshot.ticketRuns[id] || snapshot.retainedRuns?.[id];
        if (!run) throw new Error(`Retained run not found: ${id}`);
        if (
          runtime.activeTickets.has(run.id) ||
          runtime.activeMerges.has(run.id)
        )
          throw new Error(`Cannot clean active run ${run.id}`);
        if (!terminalRunStatusSet.has(run.status))
          throw new Error(`Run ${id} is not safe to clean`);
        cleaned.push(
          await cleanupRetainedRun({
            run,
            dataDir,
            previewManager:
              snapshot.ticketRuns[run.id] && id !== run.id ? null : previews,
          }),
        );
        await state.update((draft) => {
          delete draft.ticketRuns[id];
          delete draft.retainedRuns?.[id];
          if (draft.selectedTicketId === id) draft.selectedTicketId = null;
        });
      }
      return {
        cleaned,
        inventory: await retentionInventory(state.read(), dataDir),
        state: state.read(),
      };
    },
    async saveStageProfiles(input) {
      const profiles = normalizeStageProfiles(input.profiles);
      if (!["manual", "automatic"].includes(input.settings?.projectMode))
        throw new Error("Project mode must be manual or automatic");
      const interval = Number(input.settings?.pollIntervalSeconds);
      if (!Number.isInteger(interval) || interval < 15 || interval > 3600)
        throw new Error(
          "Polling interval must be an integer from 15 to 3600 seconds",
        );
      const settings = normalizeSettings(input.settings);
      await harness.validateProfiles(profiles);
      const saved = await state.update((draft) => {
        draft.stageProfiles = profiles;
        draft.settings = settings;
      });
      trackers.schedulePolling();
      if (settings.projectMode === "automatic")
        trackers.refresh().catch(() => {});
      return saved;
    },
    async saveTicketStageProfile(ticketId, profileId, input) {
      const run = ticketRun(state.read(), ticketId);
      if (runtime.activeTickets.has(ticketId))
        throw new Error("Pause the run before changing its stage profile");
      if (!run.stageProfiles?.[profileId])
        throw new Error("Unknown stage profile");
      const parsed = parseModelRef(
        input.model,
        input.provider || run.stageProfiles[profileId].provider,
      );
      const profiles = normalizeStageProfiles({
        ...run.stageProfiles,
        [profileId]: {
          ...run.stageProfiles[profileId],
          provider:
            parsed.provider ||
            input.provider ||
            run.stageProfiles[profileId].provider,
          model: parsed.model,
          thinking: input.thinking,
        },
      });
      await harness.validateProfiles({ [profileId]: profiles[profileId] });
      await state.update((draft) => {
        if (runtime.activeTickets.has(ticketId))
          throw new Error("Pause the run before changing its stage profile");
        ticketRun(draft, ticketId).stageProfiles[profileId] =
          profiles[profileId];
      });
      return { ticketId, profile: profiles[profileId] };
    },
  };
}
