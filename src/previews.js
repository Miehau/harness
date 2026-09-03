import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { detectPreviewCommand, loadProjectConfig, projectEnvironment } from "./project-config.js";
import { visualEvidenceMedia } from "./artifacts.js";
import { execFileTree, signalProcessTree } from "./process-tree.js";

const screenshotScript = fileURLToPath(new URL("../scripts/screenshot.mjs", import.meta.url));
const snapshotServerScript = fileURLToPath(new URL("../scripts/preview-snapshot-server.mjs", import.meta.url));
const activeStepSelector = ".step.status-running[data-step], .step.status-fixing[data-step], .step.status-verifying[data-step], .step.status-interrupted[data-step], .step.status-needs_attention[data-step], .step.status-review_ready[data-step]";

export function availablePort(host = "127.0.0.1") {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function chromiumPath(source = process.env) {
  const candidates = [
    source.CHROMIUM_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ].filter(Boolean);
  for (const candidate of candidates) try { await access(candidate); return candidate; } catch {}
  throw new Error("Chromium was not found; set CHROMIUM_PATH for visual evidence capture");
}

function commandExecutable(cwd, command) {
  return command[0].startsWith("./") ? resolve(cwd, command[0]) : command[0];
}

async function isAgentPlanWorkspace(cwd) {
  try { return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).name === "agent-plan-workspace"; }
  catch { return false; }
}

async function waitUntilReady(url, child, fetchImpl, timeoutMs = 60000, probeTimeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview process exited with code ${child.exitCode}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())));
    try { if ((await fetchImpl(url, { signal: controller.signal })).ok) return; } catch {}
    finally { clearTimeout(timer); }
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Preview did not become ready within ${Math.round(timeoutMs / 1000)} seconds`);
}

export class PreviewManager {
  constructor({ dataDir, spawnImpl = spawn, execImpl = execFileTree, fetchImpl = fetch, portImpl = availablePort, readyTimeoutMs = 60000, probeTimeoutMs = 2000, captureTimeoutMs = 15000 } = {}) {
    this.dataDir = dataDir;
    this.spawn = spawnImpl;
    this.exec = execImpl;
    this.fetch = fetchImpl;
    this.port = portImpl;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.captureTimeoutMs = captureTimeoutMs;
    this.active = new Map();
    this.ports = new Set();
  }

  async reservePort() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = await this.port();
      if (!this.ports.has(port)) { this.ports.add(port); return port; }
    }
    throw new Error("Could not allocate a unique preview port");
  }

  async ensure({ id, cwd, seedState = null }) {
    const existing = this.active.get(id);
    if (existing?.child.exitCode === null && existing.cwd === cwd && !seedState) return existing.public;
    // A seeded preview is a proof fixture for one exact run snapshot. Restart
    // it for the next gate instead of rendering new worktree code against old
    // status, selection, or inspector state.
    if (existing) this.stop(id);
    const config = await loadProjectConfig(cwd);
    const configuredName = config.commands.preview ? "preview" : config.commands.dev ? "dev" : null;
    const conventional = configuredName ? null : await detectPreviewCommand(cwd);
    const commandName = configuredName || conventional?.name;
    if (!commandName) return null;
    const command = configuredName ? config.commands[configuredName] : conventional.command;
    const port = await this.reservePort();
    const portVariables = config.ports.variables.length ? config.ports.variables : ["PORT"];
    const environment = await projectEnvironment(cwd, config);
    for (const name of portVariables) environment[name] = String(port);
    environment.HOST = "127.0.0.1";
    if (this.dataDir) {
      environment.AGENT_PLAN_DATA_DIR = join(this.dataDir, "preview-state", id.replace(/[^a-z0-9._-]+/gi, "-"));
      if (seedState) {
        await mkdir(environment.AGENT_PLAN_DATA_DIR, { recursive: true });
        await writeFile(join(environment.AGENT_PLAN_DATA_DIR, "state-v3.json"), JSON.stringify(seedState, null, 2));
      }
    }
    let previewCommand = command;
    if (seedState && environment.AGENT_PLAN_DATA_DIR && await isAgentPlanWorkspace(cwd)) {
      const seedFile = join(environment.AGENT_PLAN_DATA_DIR, "proof-state.json");
      await writeFile(seedFile, JSON.stringify(seedState, null, 2));
      previewCommand = [process.execPath, snapshotServerScript, join(cwd, "src/server.js"), cwd, environment.AGENT_PLAN_DATA_DIR, "127.0.0.1", String(port), seedFile];
    }
    const child = this.spawn(commandExecutable(cwd, previewCommand), previewCommand.slice(1), { cwd, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr].filter(Boolean)) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-50000); });
    const url = `http://127.0.0.1:${port}`;
    try { await waitUntilReady(url, child, this.fetch, this.readyTimeoutMs, this.probeTimeoutMs); }
    catch (error) { this.ports.delete(port); signalProcessTree(child); throw new Error(`${error.message}\n${output}`.trim()); }
    const publicPreview = { id, cwd, command: commandName, port, url, startedAt: new Date().toISOString() };
    const activePreview = { child, cwd, get output() { return output; }, public: publicPreview };
    this.active.set(id, activePreview);
    child.once("exit", () => {
      if (this.active.get(id) === activePreview) this.active.delete(id);
      this.ports.delete(port);
    });
    return publicPreview;
  }

  async capture(id, { source = process.env } = {}) {
    const preview = this.active.get(id);
    if (!preview) throw new Error("Preview is not running");
    const directory = join(this.dataDir, "visual-evidence", id.replace(/[^a-z0-9._-]+/gi, "-"));
    // Each capture owns its files so artifacts saved by prior review rounds remain
    // immutable even after a correction triggers re-verification.
    const captureDirectory = join(directory, "captures", randomUUID());
    await mkdir(captureDirectory, { recursive: true });
    const evidence = [];
    for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
      const path = join(captureDirectory, `${name}.png`);
      try {
        await this.exec(process.execPath, [screenshotScript, "--url", preview.public.url, "--out", path, "--width", String(width), "--height", String(height), "--wait-ms", "1200", "--click", activeStepSelector], {
          env: { ...process.env, ...source }, timeout: this.captureTimeoutMs, maxBuffer: 2 * 1024 * 1024
        });
      } catch (error) {
        if (!/timed out/i.test(error.message)) throw error;
        try { await access(path); } catch { throw error; }
      }
      evidence.push({ name: `${name}.png`, path, ...visualEvidenceMedia(path), viewport: { width, height }, url: preview.public.url });
    }
    return evidence;
  }

  stop(id) {
    const preview = this.active.get(id);
    if (!preview) return false;
    signalProcessTree(preview.child);
    this.active.delete(id);
    this.ports.delete(preview.public.port);
    return true;
  }

  stopMatching(prefix) {
    let stopped = 0;
    for (const id of [...this.active.keys()]) if (id.startsWith(prefix) && this.stop(id)) stopped++;
    return stopped;
  }

  stopAll() {
    let stopped = 0;
    for (const id of [...this.active.keys()]) if (this.stop(id)) stopped++;
    return stopped;
  }

  list() { return [...this.active.values()].map((preview) => preview.public); }
}

export const previewChromiumPath = chromiumPath;
