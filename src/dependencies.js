import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const manifests = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const pending = new Map();

export async function dependencyState(cwd, config) {
  if (!config.commands.install) return { required: false };
  const { stdout: gitPath } = await exec("git", ["rev-parse", "--git-path", "agent-plan-dependencies.json"], { cwd });
  const marker = resolve(cwd, gitPath.trim());
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 8 * 1024 * 1024 });
  const paths = [...new Set(stdout.split("\0").filter((path) => manifests.has(basename(path)) && !path.split("/").includes("node_modules")))].sort();
  const hash = createHash("sha256").update(JSON.stringify(config.commands.install));
  for (const path of paths) {
    hash.update(path);
    try { hash.update(await readFile(join(cwd, path))); }
    catch (error) { if (error.code !== "ENOENT") throw error; hash.update("missing"); }
  }
  const fingerprint = hash.digest("hex");
  let previous;
  try { previous = JSON.parse(await readFile(marker, "utf8")); } catch {}
  let installed = true;
  for (const path of previous?.dependencyDirectories || []) {
    try { if (!(await lstat(join(cwd, path))).isDirectory()) installed = false; } catch { installed = false; }
  }
  return { required: previous?.fingerprint !== fingerprint || !installed, fingerprint, marker };
}

async function dependencyDirectories(cwd, prefix = "") {
  const found = [];
  for (const entry of await readdir(join(cwd, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.name === "node_modules") found.push(path);
    else if (entry.isDirectory() && ![".git", ".jj"].includes(entry.name)) found.push(...await dependencyDirectories(cwd, path));
  }
  return found;
}

export async function prepareDependencies(cwd, config, install, { force = false } = {}) {
  if (!config.commands.install) return { status: "not_required" };
  const key = resolve(cwd);
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const state = await dependencyState(cwd, config);
    if (!force && !state.required) return { status: "ready" };
    const { stdout: tracked } = await exec("git", ["ls-files", "-z"], { cwd });
    if (tracked.split("\0").some((path) => path.split("/").includes("node_modules"))) throw new Error("Dependency setup will not remove tracked node_modules; remove them from version control first");
    await rm(state.marker, { force: true });
    // Remove only dependency directories; rm unlinks symlinks rather than following
    // shared source-checkout packages. Installation always starts with private files.
    for (const path of await dependencyDirectories(cwd)) await rm(join(cwd, path), { recursive: true, force: true });
    const result = await install();
    if (result.status !== "passed") throw new Error(`Dependency setup failed: ${result.output || result.status}`);
    const after = await dependencyState(cwd, config);
    await mkdir(dirname(after.marker), { recursive: true });
    await writeFile(after.marker, JSON.stringify({ fingerprint: after.fingerprint, dependencyDirectories: await dependencyDirectories(cwd) }));
    return result;
  })();
  pending.set(key, work);
  try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
}
