import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { environmentForOwnership } from "./process-containment.js";

const exec = promisify(execFile);

export const projectConfigPath = ".agent-plan/project.json";
const inheritedEnvironment = ["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "USER"];
const blockedExecutables = new Set(["bash", "cmd", "curl", "fish", "git", "mv", "powershell", "pwsh", "rm", "scp", "sh", "ssh", "sudo", "wget", "zsh"]);
const allowedExecutables = new Set(["bun", "bundle", "cargo", "composer", "deno", "dotnet", "go", "gradle", "gradlew", "java", "make", "mvn", "mvnw", "node", "npm", "php", "pnpm", "python", "python3", "pytest", "ruby", "ruff", "swift", "uv", "yarn"]);

function strings(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function safeRelative(cwd, path) {
  const absolute = resolve(cwd, path);
  const local = relative(resolve(cwd), absolute);
  if (!local || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Environment file must stay inside the repository: ${path}`);
  return absolute;
}

function validateCommand(name, argv) {
  if (!/^[a-z][a-z0-9:_-]*$/i.test(name)) throw new Error(`Invalid project command name: ${name}`);
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
    throw new Error(`Project command “${name}” must be a non-empty argv array`);
  }
  const executable = basename(argv[0]);
  if (blockedExecutables.has(executable)) throw new Error(`Project command “${name}” uses blocked executable ${executable}`);
  if (!allowedExecutables.has(executable)) throw new Error(`Project command “${name}” uses executable outside the development allow-list: ${executable}`);
  if (argv[0].includes("..")) throw new Error(`Project command “${name}” escapes the repository`);
  if (["node", "python", "python3"].includes(executable) && argv.slice(1).some((argument) => ["-c", "-e", "--eval", "--print"].includes(argument))) {
    throw new Error(`Project command “${name}” may not evaluate inline code`);
  }
  return argv;
}

export function normalizeProjectConfig(value = {}) {
  const commands = Object.fromEntries(Object.entries(value.commands || {}).map(([name, argv]) => [name, validateCommand(name, Array.isArray(argv) ? argv.map(String) : argv)]));
  const pass = strings(value.environment?.pass);
  for (const name of pass) if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  const files = strings(value.environment?.files);
  const portVariables = strings(value.ports?.variables);
  for (const name of portVariables) if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid port environment variable name: ${name}`);
  return {
    version: 1,
    commands,
    environment: { pass: [...new Set(pass)], files: [...new Set(files)] },
    ports: { variables: [...new Set(portVariables)] }
  };
}

function normalizeLoadedProjectConfig(value = {}) {
  const { commands: declaredCommands = {}, ...settings } = value;
  const config = normalizeProjectConfig(settings);
  const commandErrors = {};
  for (const [name, argv] of Object.entries(declaredCommands)) {
    try { config.commands[name] = validateCommand(name, Array.isArray(argv) ? argv.map(String) : argv); }
    catch (error) { commandErrors[name] = error.message; }
  }
  return Object.keys(commandErrors).length ? { ...config, commandErrors } : config;
}

async function detectedCommands(cwd) {
  try {
    const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    const commands = {};
    for (const name of ["test", "lint", "typecheck", "check", "build", "format"]) if (packageJson.scripts?.[name]) commands[name] = ["npm", "run", name];
    return commands;
  } catch { return {}; }
}

export async function detectPreviewCommand(cwd) {
  try {
    const scripts = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts || {};
    const name = ["preview", "start", "dev"].find((candidate) => scripts[candidate]);
    return name ? { name, command: ["npm", "run", name] } : null;
  } catch { return null; }
}

export async function loadProjectConfig(cwd) {
  try {
    const config = normalizeLoadedProjectConfig(JSON.parse(await readFile(join(cwd, projectConfigPath), "utf8")));
    config.commands = { ...(await detectedCommands(cwd)), ...config.commands };
    return config;
  }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return normalizeProjectConfig({ commands: await detectedCommands(cwd) });
  }
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

async function ignored(cwd, path, execImpl) {
  try { await execImpl("git", ["check-ignore", "--quiet", "--", path], { cwd }); return true; }
  catch { return false; }
}

export async function projectEnvironment(cwd, config, { source = process.env, execImpl = execFileTree } = {}) {
  const available = {};
  for (const file of config.environment.files) {
    const absolute = safeRelative(cwd, file);
    if (!(await ignored(cwd, file, execImpl))) throw new Error(`Allow-listed environment file is not ignored by Git: ${file}`);
    Object.assign(available, parseEnv(await readFile(absolute, "utf8")));
  }
  const environment = {};
  for (const name of [...inheritedEnvironment, ...config.environment.pass]) {
    const value = available[name] ?? source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function redactCommandOutput(value, environment, { truncate = true } = {}) {
  let output = String(value || "");
  for (const secret of Object.values(environment).filter((item) => String(item).length >= 8)) output = output.replaceAll(String(secret), "[REDACTED]");
  return truncate ? output.slice(-100000) : output;
}

export function runManagedCommand(executable, args, { cwd, env, signal, timeout, maxBuffer }) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const append = (key, chunk) => {
      const value = `${key === "stdout" ? stdout : stderr}${chunk}`;
      if (key === "stdout") stdout = value.slice(-maxBuffer);
      else stderr = value.slice(-maxBuffer);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const failed = (message, properties = {}) => {
      const error = Object.assign(new Error(message), { stdout, stderr, ...properties });
      finish(rejectCommand, error);
    };
    // PID-only signaling is unsafe: by the time a deadline callback runs, the
    // ChildProcess PID could identify an unrelated process. Settle promptly
    // and let the execution containment coordinator re-observe token-owned
    // identities before it signals anything.
    const interrupt = (message, properties) => failed(message, properties);
    const abort = () => interrupt(signal?.reason?.message || "Project command aborted", { code: "ABORT_ERR", name: "AbortError" });
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => finish(rejectCommand, error));
    // `exit`, unlike `close`, does not wait for a descendant holding inherited
    // stdout/stderr open. That lets the caller request token-based cleanup as
    // soon as the command deadline expires.
    child.once("exit", (code, childSignal) => {
      if (code === 0 && !childSignal) finish(resolveCommand, { stdout, stderr });
      else failed(`Command failed with ${childSignal || `exit code ${code}`}`, { code, signal: childSignal, killed: Boolean(childSignal) });
    });
    timer = setTimeout(() => interrupt(`Command timed out after ${timeout}ms`, { code: "ETIMEDOUT", signal: "SIGTERM", killed: true }), timeout);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runProjectCommand(cwd, name, { signal, execImpl = exec, source = process.env, args = [], ownership, containment, timeoutMs = 10 * 60 * 1000 } = {}) {
  const config = await loadProjectConfig(cwd);
  if (config.commandErrors?.[name]) throw new Error(config.commandErrors[name]);
  const argv = config.commands[name];
  if (!argv) throw new Error(`Unknown project command “${name}”; add it to ${projectConfigPath}`);
  validateCommand(name, argv);
  if (!Array.isArray(args) || args.length > 8 || args.some((argument) => !/^[a-z0-9][a-z0-9._-]*$/i.test(argument))) throw new Error(`Project command “${name}” received unsafe arguments`);
  const baseEnvironment = await projectEnvironment(cwd, config, { source, execImpl });
  // Ownership augments the deliberately curated command environment; it never
  // substitutes process.env or grants a command access to ambient secrets.
  const environment = ownership ? environmentForOwnership(ownership, baseEnvironment) : baseEnvironment;
  const executable = argv[0].startsWith("./") ? resolve(cwd, argv[0]) : argv[0];
  // Record the launch before spawn, rather than at timeout cleanup: if a
  // prior timeout already settled this execution, worker completion must open
  // a fresh containment cycle for this command's inherited descendants.
  containment?.beginLaunch?.();
  try {
    const runner = execImpl === exec ? runManagedCommand : execImpl;
    const { stdout, stderr } = await runner(executable, [...argv.slice(1), ...args], { cwd, env: environment, signal, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { status: "passed", command: name, output: redactCommandOutput([stdout, stderr].filter(Boolean).join("\n"), environment) };
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT" || (error?.killed === true && error?.signal === "SIGTERM");
    const interrupted = timedOut || signal?.aborted;
    let cleanup;
    let cleanupTrigger;
    if (interrupted && containment) {
      // The tool callback persists this same record after cleanup settles.
      // Timestamp it once here so persistence redelivery deduplicates the
      // containment evidence instead of recording a second timeout request.
      cleanupTrigger = { trigger: signal?.aborted ? "repository-command-aborted" : "repository-command-timeout", command: name, at: new Date().toISOString() };
      try { cleanup = await containment.cleanup(cleanupTrigger); }
      catch (cleanupError) {
        cleanup = { executionId: containment.executionId, outcome: "incomplete", diagnostics: [`Repository-command cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`] };
      }
    }
    if (signal?.aborted) {
      if (cleanup && error && typeof error === "object") error.cleanup = cleanup;
      throw error;
    }
    return { status: "failed", command: name, timedOut, output: redactCommandOutput([error.stdout, error.stderr, error.message].filter(Boolean).join("\n"), environment), ...(cleanup ? { cleanup } : {}), ...(cleanupTrigger ? { cleanupTrigger } : {}) };
  }
}
