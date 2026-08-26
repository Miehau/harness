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

function worktreePaths(run, root) {
  const paths = [run.workspace?.cwd];
  for (const node of run.plan?.nodes || []) {
    for (const step of node.type === "group" ? node.children : [node]) paths.push(step.workspace?.cwd);
  }
  return [...new Set(paths.filter((path) => path && within(root, path)))].sort((a, b) => b.length - a.length);
}

export async function cleanupRetainedRun({ run, dataDir, previewManager, execImpl = exec, rmImpl = rm }) {
  const root = runRoot(dataDir, run);
  const retainedRoot = join(dataDir, "ticket-runs");
  if (!within(retainedRoot, root) || root === resolve(retainedRoot)) throw new Error("Refusing to clean a path outside retained ticket data");
  previewManager?.stopMatching(`${run.id}:`);
  const sourceCwd = run.workspace?.sourceCwd;
  if (sourceCwd) {
    for (const path of worktreePaths(run, root)) {
      await execImpl("git", ["worktree", "remove", "--force", path], { cwd: sourceCwd }).catch((error) => {
        if (!/not a working tree|is not a working tree|does not exist/i.test(error.stderr || error.message)) throw error;
      });
    }
    if (run.workspace?.branch && !run.workspace?.zeroState) {
      await execImpl("git", ["branch", "-D", run.workspace.branch], { cwd: sourceCwd }).catch((error) => {
        if (!/not found|not exist|not a valid branch/i.test(error.stderr || error.message)) throw error;
      });
    }
  }
  await rmImpl(root, { recursive: true, force: true });
  return { ticketId: run.id, runId: run.runId, root };
}
