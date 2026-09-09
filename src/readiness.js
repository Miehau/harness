import { dependencyState } from "./dependencies.js";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { previewChromiumPath } from "./previews.js";
import { detectPreviewCommand, loadProjectConfig } from "./project-config.js";

const exec = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);

// Inspection never runs project commands or makes a paid model request.
export async function inspectReadiness({ cwd, vcsMode = "jj", visual = false, phase = "project", validateModels, execImpl = exec, nodeVersion = process.versions.node }) {
  if (!["git", "jj"].includes(vcsMode)) throw new Error("VCS must be git or jj");
  const checks = [];
  const add = (id, ready, summary, action = "", executed = false) => checks.push({ id, status: ready === null ? "not_required" : ready ? "ready" : "action_needed", summary, action: ready ? "" : action, executed });
  const [major, minor] = nodeVersion.split(".").map(Number);
  add("node", major > 22 || major === 22 && minor >= 19, `Node ${nodeVersion}`, "Install Node 22.19 or later", true);
  for (const command of ["git", "jj"]) {
    if (command === "jj" && vcsMode === "git") { add(command, null, "Git compatibility mode"); continue; }
    try {
      await execImpl(command, ["--version"], { cwd, timeout: 5000 });
      add(command, true, `${command} is available`, "", true);
    } catch { add(command, false, `${command} is unavailable`, `Install ${command} and make it available in PATH`, true); }
  }
  try {
    if (!validateModels) throw new Error("Model inspection unavailable");
    await validateModels();
    add("models", true, "Configured models and local authentication checked; provider acceptance is not tested", "", true);
  } catch (error) { add("models", false, "Configured models or authentication need attention", error.message, true); }
  if (phase !== "planning") {
    try {
      await execImpl("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeout: 5000 });
      add("repository", true, "Repository has a baseline", "", true);
    } catch { add("repository", false, "Repository has no usable baseline", "Initialize the project repository", true); }
    let config;
    try { config = await loadProjectConfig(cwd); }
    catch { add("configuration", false, "Project configuration is invalid", "Repair .agent-plan/project.json"); }
    if (config) {
      const configured = await exists(join(cwd, ".agent-plan/project.json"));
      add("configuration", configured, configured ? "Project contract found" : "Project contract missing", "Initialize .agent-plan/project.json");
      let pkg;
      try { pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") add("manifest", false, "Cannot read package.json", "Repair the package manifest"); }
      const needsDependencies = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).length > 0;
      const installed = await exists(join(cwd, "node_modules"));
      add("dependencies", needsDependencies ? installed : null, needsDependencies ? installed ? "node_modules exists; lockfile consistency not verified" : "Project dependencies are missing" : "No Node dependencies declared", "Configure and run the project install command");
      if (config.commands.install) {
        try {
          const dependencies = await dependencyState(cwd, config);
          add("dependency-preparation", !dependencies.required, dependencies.required ? "Dependencies need preparation for current manifests" : "Dependency preparation matches current manifests", "Run agent-plan init --install");
        } catch { add("dependency-preparation", false, "Dependency preparation cannot be inspected", "Initialize the repository, then run agent-plan init --install"); }
      }
      for (const name of ["verify", ...(visual ? ["ui", "ui-test", "capture-proof", "test-capture-proof"] : [])]) {
        const valid = Boolean(config.commands[name]) && !config.commandErrors?.[name];
        add(name, valid, valid ? `${name} declared; not executed` : `${name} command missing or invalid`, `Configure commands.${name} in .agent-plan/project.json`);
      }
      if (visual) {
        const preview = config.commands.preview || config.commands.dev || await detectPreviewCommand(cwd);
        add("preview", Boolean(preview), "Preview command discovered; not started", "Configure commands.preview or commands.dev");
        try { await previewChromiumPath(); add("browser", true, "Chromium is available; no browser journey executed", "", true); }
        catch (error) { add("browser", false, "Chromium is unavailable", error.message, true); }
      }
      else add("browser", null, "Browser readiness applies to UI tickets only");
    }
  }
  return { cwd, vcsMode, phase, visual, ready: checks.every((check) => check.status !== "action_needed"), checks };
}
