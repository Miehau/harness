import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { safeName } from "./artifacts.js";
import { diffTrees, isGitRepository, snapshotTree } from "./git.js";

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

export async function needsLocalWorkspaceRepair(ticket, workspace) {
  return ticket?.source === "local" && !(workspace?.cwd && await isGitRepository(workspace.cwd));
}

export async function createZeroStateWorkspace({ cwd, ticket, runId, allowFiles = false }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const branch = `codex/${slug}-${runSlug.slice(0, 8)}`;
  await mkdir(cwd, { recursive: true });
  const entries = await readdir(cwd);
  const initialized = await isGitRepository(cwd);
  if (!initialized && !allowFiles && entries.some((entry) => entry !== ".git")) throw new Error(`Local zero-state working directory must be empty: ${cwd}`);
  if (!initialized) await git(cwd, ["init", "-q", "-b", "main"]);
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

export async function cherryPickCommit(cwd, commit) {
  try {
    await git(cwd, ["cherry-pick", commit], { env: identity });
  } catch (error) {
    await git(cwd, ["cherry-pick", "--abort"]).catch(() => {});
    throw error;
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function integrateBranch({ sourceCwd, branch, integrationCwd, dependencyCwd, resolveConflicts, verify }) {
  if (await git(sourceCwd, ["status", "--porcelain"])) throw new Error(`Cannot integrate ${branch}: the working directory has uncommitted changes`);
  const sourceHead = await git(sourceCwd, ["rev-parse", "HEAD"]);
  const sourceTree = await git(sourceCwd, ["rev-parse", "HEAD^{tree}"]);
  const listed = await git(sourceCwd, ["worktree", "list", "--porcelain"]);
  if (listed.split("\n\n").some((block) => block.includes(`worktree ${integrationCwd}`))) await git(sourceCwd, ["worktree", "remove", "--force", integrationCwd]);
  await rm(integrationCwd, { recursive: true, force: true });
  await mkdir(dirname(integrationCwd), { recursive: true });
  await git(sourceCwd, ["worktree", "add", "-q", "--detach", integrationCwd, sourceHead]);
  if (dependencyCwd) {
    try {
      await access(join(dependencyCwd, "node_modules"));
      await git(integrationCwd, ["check-ignore", "-q", "node_modules"]);
      await symlink(join(dependencyCwd, "node_modules"), join(integrationCwd, "node_modules"), "dir");
    } catch {}
  }
  let conflicts = [];
  try {
    try {
      await git(integrationCwd, ["merge", "--no-edit", branch], { env: identity });
    } catch (error) {
      conflicts = (await git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      if (!conflicts.length || !resolveConflicts) throw error;
      await resolveConflicts({ cwd: integrationCwd, conflicts });
      await git(integrationCwd, ["add", "-A"]);
      const unresolved = (await git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      if (unresolved.length) throw new Error(`Conflict resolver left unresolved files: ${unresolved.join(", ")}`);
      await git(integrationCwd, ["diff", "--cached", "--check"]);
      let mergePending = false;
      try { await git(integrationCwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); mergePending = true; } catch {}
      if (mergePending) {
        await git(integrationCwd, ["commit", "--allow-empty", "-m", `Merge ${branch}\n\nWhy: Resolve merge-queue conflicts after independent verification.`], { env: identity });
      }
    }
    await verify?.({ cwd: integrationCwd, conflicts });
    if (await git(integrationCwd, ["status", "--porcelain"])) throw new Error("Post-merge verification left uncommitted changes in the integration worktree");
    await git(integrationCwd, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    if (await git(sourceCwd, ["status", "--porcelain"])) throw new Error("The working directory changed while its merge was being verified");
    if ((await git(sourceCwd, ["rev-parse", "HEAD"])) !== sourceHead) throw new Error("The working directory advanced while its merge was being verified; retry the queue item");
    const commit = await git(integrationCwd, ["rev-parse", "HEAD"]);
    await git(sourceCwd, ["merge", "--ff-only", commit], { env: identity });
    const deliveredTree = await git(sourceCwd, ["rev-parse", "HEAD^{tree}"]);
    return { commit, conflicts, diff: await diffTrees(sourceCwd, sourceTree, deliveredTree) };
  } finally {
    await git(sourceCwd, ["worktree", "remove", "--force", integrationCwd]).catch(() => {});
    await rm(integrationCwd, { recursive: true, force: true });
  }
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
    const baselineTree = await snapshotTree(sourceCwd);
    let head = null;
    let headTree = null;
    try {
      head = await git(sourceCwd, ["rev-parse", "HEAD"]);
      headTree = await git(sourceCwd, ["rev-parse", "HEAD^{tree}"]);
    } catch {}
    const start = head && baselineTree === headTree ? head : await git(sourceCwd, ["commit-tree", baselineTree, ...(head ? ["-p", head] : []), "-m", "Ticket workspace snapshot"], { env: identity });
    await git(sourceCwd, branchExists
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", "-b", branch, worktree, start]);
  }
  return { sourceCwd, cwd: worktree, branch };
}
