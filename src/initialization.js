import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeRepository } from "./worktrees.js";
import { initializeJjWorkspace } from "./jj.js";
import { loadProjectConfig, normalizeProjectConfig, runProjectCommand } from "./project-config.js";

const exists = (path) => access(path).then(() => true, () => false);

const verifier = `import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const config = JSON.parse(await readFile(new URL("./project.json", import.meta.url), "utf8"));
const names = ["test", "lint", "typecheck", "check", "build", "ui-test"].filter((name) => config.commands[name]);
if (!names.length) throw new Error("No deterministic checks configured; add project test/build commands before implementation");
for (const name of names) {
  const [command, ...args] = config.commands[name];
  const result = spawnSync(command, args, { cwd: new URL("../", import.meta.url), stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
`;

export async function initializeProject(cwd, { vcsMode = "jj", install = false, verify = false } = {}) {
  const created = [];
  await mkdir(join(cwd, ".agent-plan"), { recursive: true });
  let pkg = {};
  try { pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const configPath = join(cwd, ".agent-plan/project.json");
  if (!(await exists(configPath))) {
    const manager = pkg.packageManager?.split("@")[0] || (await exists(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : await exists(join(cwd, "yarn.lock")) ? "yarn" : await exists(join(cwd, "bun.lock")) || await exists(join(cwd, "bun.lockb")) ? "bun" : "npm");
    if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) throw new Error(`Configure project commands for package manager ${manager}`);
    const commands = { verify: ["node", ".agent-plan/verify.mjs"] };
    for (const name of ["test", "lint", "typecheck", "check", "build", "preview", "dev"]) if (pkg.scripts?.[name]) commands[name] = [manager, "run", name];
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
      const locked = await exists(join(cwd, "package-lock.json")) || await exists(join(cwd, "npm-shrinkwrap.json"));
      commands.install = manager === "npm" ? ["npm", locked ? "ci" : "install"] : [manager, "install"];
    }
    await writeFile(configPath, `${JSON.stringify(normalizeProjectConfig({ commands }), null, 2)}\n`, { flag: "wx" });
    created.push(".agent-plan/project.json");
  }
  // Validate existing choices, never replace them with guessed commands.
  const config = await loadProjectConfig(cwd);
  if (config.commandErrors && Object.keys(config.commandErrors).length) throw new Error(Object.values(config.commandErrors).join("; "));
  const verifyPath = join(cwd, ".agent-plan/verify.mjs");
  if (!(await exists(verifyPath))) {
    await writeFile(verifyPath, verifier, { flag: "wx" });
    created.push(".agent-plan/verify.mjs");
  }
  await initializeRepository(cwd);
  if (vcsMode === "jj") await initializeJjWorkspace(cwd);
  const results = {};
  if (install) results.install = config.commands.install ? await runProjectCommand(cwd, "install") : { status: "not_required" };
  if (verify) results.verify = await runProjectCommand(cwd, "verify");
  return { cwd, created, results };
}
