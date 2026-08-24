import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { safeName } from "./artifacts.js";

const exec = promisify(execFile);

async function git(cwd, args, options = {}) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024, ...options });
  return stdout.trim();
}

const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent Plan Workspace",
  GIT_AUTHOR_EMAIL: "agent-plan@local",
  GIT_COMMITTER_NAME: "Agent Plan Workspace",
  GIT_COMMITTER_EMAIL: "agent-plan@local"
};

export async function createZeroStateWorkspace({ dataDir, ticket, runId }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const cwd = join(dataDir, "ticket-runs", slug, "runs", runSlug, "worktree");
  const branch = `codex/${slug}-${runSlug.slice(0, 8)}`;
  await mkdir(cwd, { recursive: true });
  try { await git(cwd, ["rev-parse", "--is-inside-work-tree"]); }
  catch {
    await git(cwd, ["init", "-q", "-b", "main"]);
    await git(cwd, ["commit", "--allow-empty", "-qm", "Zero-state baseline"], { env: identity });
    await git(cwd, ["checkout", "-qb", branch]);
  }
  return { sourceCwd: cwd, cwd, branch, zeroState: true };
}

export async function createParallelWorktrees({ sourceCwd, dataDir, ticket, runId, steps, tree }) {
  const parent = await git(sourceCwd, ["rev-parse", "HEAD"]);
  const commit = await git(sourceCwd, ["commit-tree", tree, "-p", parent, "-m", "Parallel ticket baseline"], { env: identity });
  const listed = await git(sourceCwd, ["worktree", "list", "--porcelain"]);
  const root = join(dataDir, "ticket-runs", safeName(ticket.identifier || ticket.id), "runs", safeName(runId), "parallel");
  return Promise.all(steps.map(async (step) => {
    const cwd = join(root, safeName(step.id));
    await mkdir(dirname(cwd), { recursive: true });
    if (!listed.split("\n\n").some((block) => block.includes(`worktree ${cwd}`))) {
      await git(sourceCwd, ["worktree", "add", "-q", "--detach", cwd, commit]);
    }
    return [step.id, { cwd, isolated: true, baseTree: tree }];
  }));
}

export async function ensureTicketWorktree({ sourceCwd, dataDir, ticket, runId }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const worktree = join(dataDir, "ticket-runs", slug, "runs", runSlug, "worktree");
  const suggested = String(ticket.branchName || "").trim();
  const branch = `${suggested || `codex/${slug}`}-${runSlug.slice(0, 8)}`;
  await mkdir(dirname(worktree), { recursive: true });
  const existing = await git(sourceCwd, ["worktree", "list", "--porcelain"]);
  if (!existing.split("\n\n").some((block) => block.includes(`worktree ${worktree}`))) {
    let branchExists = true;
    try { await git(sourceCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); }
    catch { branchExists = false; }
    await git(sourceCwd, branchExists
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  }
  return { sourceCwd, cwd: worktree, branch };
}
