import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { safeName } from "./artifacts.js";
import { isGitRepository } from "./git.js";

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

export async function createZeroStateWorkspace({ cwd, ticket, runId, allowFiles = false }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const branch = `codex/${slug}-${runSlug.slice(0, 8)}`;
  await mkdir(cwd, { recursive: true });
  const entries = await readdir(cwd);
  if (!allowFiles && entries.some((entry) => entry !== ".git")) throw new Error(`Local zero-state working directory must be empty: ${cwd}`);
  if (!(await isGitRepository(cwd))) await git(cwd, ["init", "-q", "-b", "main"]);
  if (!entries.includes(".gitignore")) await writeFile(join(cwd, ".gitignore"), "node_modules/\ncoverage/\n.env*\n!.env.example\n*.log\n.DS_Store\n", "utf8");
  try { await git(cwd, ["rev-parse", "HEAD"]); }
  catch {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "--allow-empty", "-qm", "Zero-state baseline"], { env: identity });
  }
  if (await git(cwd, ["branch", "--show-current"]) !== branch) {
    try { await git(cwd, ["checkout", "-qb", branch]); }
    catch { await git(cwd, ["checkout", "-q", branch]); }
  }
  return { sourceCwd: cwd, cwd, branch, zeroState: true, baselineTree: await git(cwd, ["rev-parse", "HEAD^{tree}"]) };
}

export async function repairZeroStateWorkspace({ cwd, ticket, runId, previousCwd }) {
  let recovered = false;
  if (previousCwd === cwd) {
    try { await access(cwd); recovered = true; } catch {}
  }
  const workspace = await createZeroStateWorkspace({ cwd, ticket, runId, allowFiles: previousCwd === cwd });
  if (previousCwd && previousCwd !== cwd) {
    try {
      await cp(previousCwd, cwd, { recursive: true, force: true, filter: (path) => basename(path) !== ".git" });
      recovered = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { workspace, recovered };
}

export async function commitWorkspace(cwd, message) {
  await git(cwd, ["add", "-A"]);
  if (!(await git(cwd, ["status", "--porcelain"]))) return null;
  await git(cwd, ["commit", "-qm", message], { env: identity });
  return git(cwd, ["rev-parse", "HEAD"]);
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
