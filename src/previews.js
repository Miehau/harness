import { execFile, spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { detectPreviewCommand, loadProjectConfig, projectEnvironment } from "./project-config.js";
import { visualEvidenceMedia } from "./artifacts.js";

const exec = promisify(execFile);

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
  constructor({ dataDir, spawnImpl = spawn, execImpl = exec, fetchImpl = fetch, portImpl = availablePort, readyTimeoutMs = 60000, probeTimeoutMs = 2000 } = {}) {
    this.dataDir = dataDir;
    this.spawn = spawnImpl;
    this.exec = execImpl;
    this.fetch = fetchImpl;
    this.port = portImpl;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
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
    if (existing?.child.exitCode === null && existing.cwd === cwd) return existing.public;
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
    const child = this.spawn(commandExecutable(cwd, command), command.slice(1), { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr].filter(Boolean)) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-50000); });
    const url = `http://127.0.0.1:${port}`;
    try { await waitUntilReady(url, child, this.fetch, this.readyTimeoutMs, this.probeTimeoutMs); }
    catch (error) { this.ports.delete(port); child.kill("SIGTERM"); throw new Error(`${error.message}\n${output}`.trim()); }
    const publicPreview = { id, cwd, command: commandName, port, url, startedAt: new Date().toISOString() };
    this.active.set(id, { child, cwd, get output() { return output; }, public: publicPreview });
    child.once("exit", () => { this.active.delete(id); this.ports.delete(port); });
    return publicPreview;
  }

  async capture(id, { source = process.env } = {}) {
    const preview = this.active.get(id);
    if (!preview) throw new Error("Preview is not running");
    const browser = await chromiumPath(source);
    const directory = join(this.dataDir, "visual-evidence", id.replace(/[^a-z0-9._-]+/gi, "-"));
    const profile = join(directory, "chromium-profile");
    await mkdir(directory, { recursive: true });
    const evidence = [];
    for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
      const path = join(directory, `${name}.png`);
      await this.exec(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${profile}-${name}`, `--window-size=${width},${height}`, `--screenshot=${path}`, preview.public.url], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      evidence.push({ name: `${name}.png`, path, ...visualEvidenceMedia(path), viewport: { width, height }, url: preview.public.url });
    }
    return evidence;
  }

  stop(id) {
    const preview = this.active.get(id);
    if (!preview) return false;
    preview.child.kill("SIGTERM");
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
