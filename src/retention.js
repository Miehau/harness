import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
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
  previewManager?.stopMatching(`${run.id}:`);
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
  return { ticketId: run.id, runId: run.runId, root };
}
