import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { flattenSteps } from "./plan.js";
import { safeName } from "./artifacts.js";

const exec = promisify(execFile);

function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function runRoot(dataDir, run) {
  return join(dataDir, "ticket-runs", safeName(run.ticket?.identifier || run.ticket?.id || run.id), "runs", safeName(run.runId));
}

export async function directorySize(path) {
  const entry = await stat(path).catch(() => null);
  if (!entry) return 0;
  if (!entry.isDirectory()) return entry.size;
  const children = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(children.map((child) => directorySize(join(path, child.name))));
  return sizes.reduce((total, size) => total + size, 0);
}

export async function retentionInventory(state, dataDir) {
  const records = [
    ...Object.entries(state.ticketRuns || {}).map(([ticketId, run]) => ({ ticketId, run, archived: false })),
    ...Object.entries(state.retainedRuns || {}).map(([ticketId, run]) => ({ ticketId, run, archived: true }))
  ];
  const items = await Promise.all(records.map(async ({ ticketId, run, archived }) => ({
    ticketId,
    runId: run.runId,
    identifier: run.ticket?.identifier || ticketId,
    title: run.ticket?.title || "Untitled run",
    project: run.ticket?.team?.name || run.ticket?.project?.name || "Local",
    status: run.status,
    archived,
    createdAt: run.createdAt || null,
    completedAt: run.completedAt || null,
    bytes: await directorySize(runRoot(dataDir, run)),
    artifactCount: run.artifacts?.length || 0,
    branch: run.workspace?.branch || null,
    worktree: run.workspace?.cwd || null
  })));
  return { items, totalBytes: items.reduce((total, item) => total + item.bytes, 0) };
}

function repositoryWorkspaces(run) {
  const items = [];
  if (run.workspace) items.push(run.workspace);
  for (const repo of run.repositories || []) items.push(repo);
  for (const node of run.plan?.nodes || []) {
    for (const step of node.type === "group" ? node.children : [node]) {
      if (step.workspace) items.push(step.workspace);
      for (const repo of step.workspace?.repositories || []) items.push(repo);
    }
  }
  for (const revision of run.coordination?.revisions || []) for (const step of revision.beforeWork || []) {
    if (step.workspace) items.push(step.workspace);
    for (const repo of step.workspace?.repositories || []) items.push(repo);
  }
  return items;
}

function worktreePaths(run, root) {
  return [...new Set(repositoryWorkspaces(run).map((item) => item?.cwd).filter((path) => path && within(root, path)))].sort((a, b) => b.length - a.length);
}

function sourceCleanupTargets(run) {
  const sources = new Map();
  for (const item of repositoryWorkspaces(run)) {
    if (!item?.sourceCwd) continue;
    const entry = sources.get(item.sourceCwd) || { sourceCwd: item.sourceCwd, branches: new Set(), zeroState: false };
    if (item.branch) entry.branches.add(item.branch);
    if (item.zeroState) entry.zeroState = true;
    sources.set(item.sourceCwd, entry);
  }
  return [...sources.values()];
}

export async function cleanupRetainedRun({ run, dataDir, previewManager, execImpl = exec, rmImpl = rm }) {
  const root = runRoot(dataDir, run);
  const retainedRoot = join(dataDir, "ticket-runs");
  if (!within(retainedRoot, root) || root === resolve(retainedRoot)) throw new Error("Refusing to clean a path outside retained ticket data");
  await previewManager?.stopMatching(`${run.id}:`);
  for (const revision of run.coordination?.revisions || []) for (const record of revision.workPreparation?.repositories || []) {
    const prefix = `refs/agent-plan/coordination/${safeName(run.runId)}/${safeName(revision.id)}/`;
    if (record.cwd && within(root, record.cwd) && record.ref?.startsWith(prefix)) await execImpl("git", ["update-ref", "-d", record.ref], { cwd: record.cwd });
  }
  const paths = worktreePaths(run, root);
  for (const source of sourceCleanupTargets(run)) {
    for (const path of paths) {
      await execImpl("git", ["worktree", "remove", "--force", path], { cwd: source.sourceCwd }).catch((error) => {
        if (!/not a working tree|is not a working tree|does not exist/i.test(error.stderr || error.message)) throw error;
      });
    }
    if (source.zeroState) continue;
    for (const branch of source.branches) {
      await execImpl("git", ["branch", "-D", branch], { cwd: source.sourceCwd }).catch((error) => {
        if (!/not found|not exist|not a valid branch/i.test(error.stderr || error.message)) throw error;
      });
    }
  }
  await rmImpl(root, { recursive: true, force: true });
  const sessionRoot = join(dataDir, "pi-sessions", "tickets");
  const key = (value) => String(value).replace(/[^a-z0-9._-]+/gi, "-");
  const sessions = [join(sessionRoot, key(run.ticket?.id || run.id), safeName(run.runId)),
    ...["", "-requirements", "-ticket-lookahead", "-ui-proposal", ...flattenSteps(run.plan).map((step) => `-${step.id}-review-map`)]
      .map((suffix) => join(sessionRoot, key(`${run.ticket?.id || run.id}-${run.runId}${suffix}`)))];
  for (const path of sessions) {
    if (!within(sessionRoot, path) || path === sessionRoot) throw new Error("Refusing to clean sessions outside run-owned data");
    await rmImpl(path, { recursive: true, force: true });
  }
  return { ticketId: run.id, runId: run.runId, root, sessions };
}

// Keep the run record and remote links; remove only its local resource bodies.
export async function cleanupMergedRun({ state, ticketId, dataDir, stopPreviews = async () => {}, cleanup = cleanupRetainedRun }) {
  const run = state.read().ticketRuns[ticketId];
  if (run?.status !== "completed" || !run.deliveries?.length || run.deliveries.some((item) => item.status !== "integrated" || !item.change?.url)) return null;
  if (run.retentionCleanup?.status === "completed" || run.retentionCleanup?.status === "retained") return run.retentionCleanup;
  const record = { status: "pending", runId: run.runId, requestedAt: run.retentionCleanup?.requestedAt || new Date().toISOString() };
  const save = (patch) => state.update((draft) => {
    const current = draft.ticketRuns[ticketId];
    if (current?.runId === run.runId) current.retentionCleanup = { ...record, ...patch };
  });
  await save({});
  try {
    await stopPreviews(ticketId, "merged_cleanup");
    const removed = await cleanup({ run, dataDir });
    await save({ status: "completed", completedAt: new Date().toISOString(), removed });
  } catch (error) {
    await save({ status: "failed", error: String(error.message), failedAt: new Date().toISOString() });
  }
  return state.read().ticketRuns[ticketId]?.retentionCleanup;
}
