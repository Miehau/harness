import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd, args, options = {}) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trimEnd();
}

export async function isGitRepository(cwd) {
  try {
    return await realpath(await git(cwd, ["rev-parse", "--show-toplevel"])) === await realpath(cwd);
  } catch {
    return false;
  }
}

export async function snapshotTree(cwd) {
  if (!(await isGitRepository(cwd))) return null;
  const directory = await mkdtemp(join(tmpdir(), "agent-plan-index-"));
  const index = join(directory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    try { await git(cwd, ["read-tree", "HEAD"], { env }); }
    catch { await git(cwd, ["read-tree", "--empty"], { env }); }
    await git(cwd, ["add", "-A"], { env });
    return await git(cwd, ["write-tree"], { env });
  } finally {
    await rm(directory, { recursive: true }).catch(() => {});
  }
}

export async function diffTrees(cwd, before, after) {
  if (!before || !after) return { available: false, patch: "", stat: "", files: [] };
  const [patch, stat, names] = await Promise.all([
    git(cwd, ["diff", "--binary", "--no-color", "--no-ext-diff", "--find-renames", before, after]),
    git(cwd, ["diff", "--stat", before, after]),
    git(cwd, ["diff", "--name-only", before, after])
  ]);
  return {
    available: true,
    before,
    after,
    patch: patch.slice(0, 600_000),
    truncated: patch.length > 600_000,
    stat,
    files: names.split("\n").filter(Boolean)
  };
}

export async function applyPatch(cwd, patch) {
  if (!String(patch || "").trim()) return;
  const directory = await mkdtemp(join(tmpdir(), "agent-plan-patch-"));
  const file = join(directory, "step.patch");
  try {
    await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
    await git(cwd, ["apply", "--whitespace=nowarn", file]);
  } finally {
    await rm(directory, { recursive: true }).catch(() => {});
  }
}

export function outsideWriteScope(files, writeScope) {
  if (writeScope === "**" || writeScope === "*") return [];
  const prefixes = String(writeScope || "").split(",")
    .map((scope) => scope.trim().replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/^\.\//, ""))
    .filter(Boolean);
  return files.filter((file) => !prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
}

export async function assertScopedWrite(cwd, inputPath, writeScope) {
  const root = resolve(cwd);
  const absolute = resolve(root, String(inputPath || "").replace(/^@/, ""));
  const repositoryPath = relative(root, absolute).split(sep).join("/");
  if (!repositoryPath || isAbsolute(repositoryPath) || repositoryPath === ".." || repositoryPath.startsWith("../") || outsideWriteScope([repositoryPath], writeScope).length) {
    throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${inputPath}`);
  }

  let existing = absolute;
  while (true) {
    try { await access(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT" || existing === root) throw error;
      existing = dirname(existing);
    }
  }
  const [realRoot, realExisting] = await Promise.all([realpath(root), realpath(existing)]);
  const escaped = relative(realRoot, realExisting);
  if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith(`..${sep}`)) throw new Error(`Write blocked through a symlink outside the workspace: ${inputPath}`);
  return absolute;
}
