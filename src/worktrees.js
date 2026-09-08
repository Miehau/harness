import { execFile } from "node:child_process";
import { access as fsAccess, cp, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { PRIMARY_ROOT_ID, frozenRoots } from "./access-policy.js";
import { safeName } from "./artifacts.js";
import { diffTrees, isGitRepository, outsideWriteScope, restoreTree, snapshotTree } from "./git.js";

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

async function linkInstalledDependencies(sourceCwd, targetCwd) {
  const candidates = ["node_modules"];
  for (const entry of await readdir(sourceCwd, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules") candidates.push(join(entry.name, "node_modules"));
  }
  for (const dependencyPath of candidates) {
    try {
      const source = join(sourceCwd, dependencyPath);
      const target = join(targetCwd, dependencyPath);
      await fsAccess(source);
      await fsAccess(dirname(target));
      await git(sourceCwd, ["check-ignore", "-q", relative(sourceCwd, source)]);
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        try { await symlink(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? "dir" : "file"); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
    } catch {}
  }
}

export async function needsLocalWorkspaceRepair(ticket, workspace) {
  return ticket?.source === "local" && !(workspace?.cwd && await isGitRepository(workspace.cwd));
}

async function initializeRepository(cwd) {
  const initialized = await isGitRepository(cwd);
  const entries = await readdir(cwd);
  if (!initialized) await git(cwd, ["init", "-q", "-b", "main"]);
  if (!entries.includes(".gitignore")) await writeFile(join(cwd, ".gitignore"), "node_modules/\ncoverage/\n.env*\n!.env.example\n*.log\n.DS_Store\n", "utf8");
  try { await git(cwd, ["rev-parse", "HEAD"]); }
  catch {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "--allow-empty", "-qm", "Zero-state baseline"], { env: identity });
  }
}

export async function createZeroStateWorkspace({ cwd, ticket, runId, allowFiles = false }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const branch = `codex/${slug}-${runSlug.slice(0, 8)}`;
  await mkdir(cwd, { recursive: true });
  const entries = await readdir(cwd);
  const initialized = await isGitRepository(cwd);
  if (!initialized && !allowFiles && entries.some((entry) => entry !== ".git")) throw new Error(`Local zero-state working directory must be empty: ${cwd}`);
  await initializeRepository(cwd);
  if (await git(cwd, ["branch", "--show-current"]) !== branch) {
    try { await git(cwd, ["checkout", "-qb", branch]); }
    catch { await git(cwd, ["checkout", "-q", branch]); }
  }
  return { sourceCwd: cwd, cwd, branch, zeroState: true, baselineTree: await git(cwd, ["rev-parse", "HEAD^{tree}"]) };
}

export async function repairZeroStateWorkspace({ cwd, ticket, runId, previousCwd }) {
  let recovered = false;
  if (previousCwd === cwd) {
    try { await fsAccess(cwd); recovered = true; } catch {}
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
  if (dependencyCwd) await linkInstalledDependencies(dependencyCwd, integrationCwd);
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

function pathContained(child, parent) {
  if (!child || !parent) return false;
  const left = resolve(child);
  const right = resolve(parent);
  if (left === right) return true;
  const prefix = right.endsWith(sep) ? right : `${right}${sep}`;
  return left.startsWith(prefix);
}

function repositoryRecord(root, workspace, kind = root.kind || "extra") {
  return {
    id: root.id || PRIMARY_ROOT_ID,
    kind,
    sourceCwd: workspace.sourceCwd,
    cwd: workspace.cwd,
    branch: workspace.branch,
    displayPath: root.displayPath || workspace.sourceCwd,
    mode: root.mode === "read-only" ? "read-only" : "read/write"
  };
}

async function createLinkedWorktree(sourceCwd, worktree, branch) {
  if (!(await isGitRepository(sourceCwd))) await initializeRepository(sourceCwd);
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
  await linkInstalledDependencies(sourceCwd, worktree);
  return { sourceCwd, cwd: worktree, branch };
}

async function createParallelForSource({ sourceCwd, dataDir, ticket, runId, steps, tree, subdir, dependencyCwd, gitCwd }) {
  const repoCwd = gitCwd || sourceCwd;
  const parent = await git(repoCwd, ["rev-parse", "HEAD"]);
  const commit = await git(repoCwd, ["commit-tree", tree, "-p", parent, "-m", "Parallel ticket baseline"], { env: identity });
  const root = join(dataDir, "ticket-runs", safeName(ticket.identifier || ticket.id), "runs", safeName(runId), subdir);
  return Promise.all(steps.map(async (step) => {
    const cwd = join(root, safeName(step.id));
    await mkdir(dirname(cwd), { recursive: true });
    if (!(await isGitRepository(cwd))) {
      await git(sourceCwd, ["worktree", "add", "-q", "--detach", cwd, commit]);
    } else await restoreTree(cwd, tree);
    await linkInstalledDependencies(dependencyCwd || sourceCwd, cwd);
    return [step.id, { cwd, isolated: true, baseTree: tree }];
  }));
}

async function canonicalizeExisting(absolute) {
  let existing = resolve(absolute);
  while (true) {
    try {
      const realExisting = await realpath(existing);
      return existing === resolve(absolute) ? realExisting : resolve(realExisting, relative(existing, resolve(absolute)));
    } catch (error) {
      if (error.code !== "ENOENT") return resolve(absolute);
      const parent = dirname(existing);
      if (parent === existing) return resolve(absolute);
      existing = parent;
    }
  }
}

export async function mapConfiguredPath(repositories, inputPath, cwd) {
  const raw = String(inputPath || "").replace(/^@/, "");
  if (!raw || !repositories?.length) return inputPath;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd || ".", raw);
  const canonical = await canonicalizeExisting(absolute);
  for (const repo of repositories) {
    if (!repo.sourceCwd || !repo.cwd) continue;
    const source = await canonicalizeExisting(repo.sourceCwd);
    const mapped = await canonicalizeExisting(repo.cwd);
    if (source === mapped) continue;
    if (canonical === source || pathContained(canonical, source)) {
      const relativePath = relative(source, canonical);
      return relativePath && relativePath !== "." ? join(mapped, relativePath) : mapped;
    }
  }
  return inputPath;
}

export function gitRepositoriesForStep(run, step = null) {
  const byId = new Map();
  for (const list of [step?.workspace?.repositories, run?.repositories, run?.workspace?.repositories]) {
    for (const repo of list || []) {
      if (!repo?.cwd) continue;
      const id = repo.id || PRIMARY_ROOT_ID;
      if (byId.has(id)) continue;
      byId.set(id, {
        ...repo,
        id,
        cwd: id === PRIMARY_ROOT_ID || repo.kind === "primary"
          ? (step?.workspace?.cwd || repo.cwd)
          : repo.cwd
      });
    }
  }
  if (byId.size) return [...byId.values()];
  const cwd = step?.workspace?.cwd || run?.workspace?.cwd;
  if (!cwd) return [];
  return [{
    id: PRIMARY_ROOT_ID,
    kind: "primary",
    sourceCwd: run.workspace?.sourceCwd || cwd,
    cwd,
    branch: run.workspace?.branch || null,
    displayPath: run.workspace?.displayPath || run.workspace?.sourceCwd || cwd,
    mode: "read/write"
  }];
}

export function qualifyRepositoryFiles(repo, files = []) {
  const id = repo?.id || PRIMARY_ROOT_ID;
  if (id === PRIMARY_ROOT_ID) return [...files];
  return files.map((file) => `root:${id}:${file}`);
}

export function filesOutsideWriteScope(repo, files, writeScope) {
  const qualified = qualifyRepositoryFiles(repo, files);
  const scope = String(writeScope || "");
  if (scope === "*" || scope === "**") {
    return (repo?.id || PRIMARY_ROOT_ID) === PRIMARY_ROOT_ID ? [] : qualified;
  }
  return outsideWriteScope(qualified, scope);
}

export async function snapshotRepositoryTrees(repos) {
  const trees = {};
  for (const repo of repos || []) trees[repo.id || PRIMARY_ROOT_ID] = await snapshotTree(repo.cwd);
  return trees;
}

export async function restoreRepositoryTrees(repos, trees, { commits = {} } = {}) {
  let primary = null;
  for (const repo of repos || []) {
    const id = repo.id || PRIMARY_ROOT_ID;
    const commit = id === PRIMARY_ROOT_ID ? null : commits[id];
    if (commit) {
      await git(repo.cwd, ["reset", "--hard", commit]);
      await git(repo.cwd, ["clean", "-fd", "-e", ".jj/"]);
      continue;
    }
    const tree = trees?.[id] || (id === PRIMARY_ROOT_ID ? trees?.primary : null);
    if (!tree) continue;
    let restored = await restoreTree(repo.cwd, tree);
    if (restored !== tree) {
      await git(repo.cwd, ["checkout", "-f", tree, "--", "."]);
      await git(repo.cwd, ["clean", "-fd", "-e", ".jj/"]);
      restored = await snapshotTree(repo.cwd);
    }
    if (id === PRIMARY_ROOT_ID) primary = restored;
  }
  return primary;
}

export async function diffRepositoryTrees(repos, before, after) {
  const diffs = {};
  for (const repo of repos || []) {
    const id = repo.id || PRIMARY_ROOT_ID;
    diffs[id] = await diffTrees(repo.cwd, before?.[id], after?.[id]);
  }
  return diffs;
}

export function mergeRepositoryDiff(repos, diffs) {
  const primary = diffs?.[PRIMARY_ROOT_ID] || diffs?.[(repos || [])[0]?.id] || { available: false, files: [], patch: "", stat: "" };
  const extraFiles = (repos || [])
    .filter((repo) => (repo.id || PRIMARY_ROOT_ID) !== PRIMARY_ROOT_ID)
    .flatMap((repo) => qualifyRepositoryFiles(repo, diffs?.[repo.id]?.files || []));
  if (!extraFiles.length) return primary;
  return { ...primary, files: [...(primary.files || []), ...extraFiles], available: true };
}

export async function createParallelWorktrees({ sourceCwd, dataDir, ticket, runId, steps, tree, repositories = [] }) {
  const primaryPairs = await createParallelForSource({
    sourceCwd, dataDir, ticket, runId, steps, tree, subdir: "parallel"
  });
  const extrasByStep = Object.fromEntries(steps.map((step) => [step.id, []]));
  for (const repo of repositories.filter((item) => item.id && item.id !== PRIMARY_ROOT_ID && item.cwd && item.sourceCwd)) {
    const extraTree = await snapshotTree(repo.cwd);
    const pairs = await createParallelForSource({
      sourceCwd: repo.sourceCwd,
      dataDir, ticket, runId, steps, tree: extraTree,
      subdir: join("repos", safeName(repo.id), "parallel"),
      dependencyCwd: repo.sourceCwd,
      gitCwd: repo.cwd
    });
    for (const [stepId, workspace] of pairs) {
      extrasByStep[stepId].push({
        ...repo,
        cwd: workspace.cwd,
        isolated: true,
        baseTree: extraTree
      });
    }
  }
  return primaryPairs.map(([stepId, workspace]) => [stepId, {
    ...workspace,
    repositories: [
      { id: PRIMARY_ROOT_ID, kind: "primary", sourceCwd, cwd: workspace.cwd, isolated: true, baseTree: tree },
      ...extrasByStep[stepId]
    ]
  }]);
}

export async function ensureTicketWorktree({ sourceCwd, dataDir, ticket, runId, access: runAccess = null }) {
  const slug = safeName(ticket.identifier || ticket.id);
  const runSlug = safeName(runId);
  const worktree = join(dataDir, "ticket-runs", slug, "runs", runSlug, "worktree");
  const suggested = String(ticket.branchName || "").trim();
  const branch = `${suggested || `codex/${slug}`}-${runSlug.slice(0, 8)}`;
  const primary = await createLinkedWorktree(sourceCwd, worktree, branch);
  const repositories = [repositoryRecord({
    id: PRIMARY_ROOT_ID,
    kind: "primary",
    displayPath: runAccess?.primary?.displayPath || sourceCwd,
    mode: "read/write"
  }, primary, "primary")];
  for (const root of frozenRoots(runAccess).filter((item) => item.kind === "extra" && item.mode === "read/write")) {
    try { await fsAccess(root.path); }
    catch {
      throw new Error(`Frozen read/write Git root ${root.id} (${root.displayPath || root.path}) is missing`);
    }
    if (!(await isGitRepository(root.path))) continue;
    const extraWorktree = join(dataDir, "ticket-runs", slug, "runs", runSlug, "repos", safeName(root.id), "worktree");
    const extra = await createLinkedWorktree(root.path, extraWorktree, `${branch}-${safeName(root.id)}`);
    repositories.push({ ...repositoryRecord(root, extra, "extra"), baselineTree: await snapshotTree(extra.cwd) });
  }
  repositories[0].baselineTree = await snapshotTree(primary.cwd);
  return { ...primary, repositories };
}
