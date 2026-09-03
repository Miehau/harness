import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { visualEvidenceMedia } from "./artifacts.js";
import { createProcessContainment } from "./process-containment.js";
import { detectPreviewCommand, loadProjectConfig, projectEnvironment, redactCommandOutput, runManagedCommand } from "./project-config.js";

const exec = promisify(execFile);

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
  let launchError = null;
  const onError = (error) => { launchError = error; };
  child.once?.("error", onError);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Preview process exited with code ${child.exitCode}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())));
      try { if ((await fetchImpl(url, { signal: controller.signal })).ok) return; } catch {}
      finally { clearTimeout(timer); }
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(500, Math.max(0, deadline - Date.now()))));
    }
    throw new Error(`Preview did not become ready within ${Math.round(timeoutMs / 1000)} seconds`);
  } finally {
    child.removeListener?.("error", onError);
  }
}

function cleanupFailure(containment, error) {
  return {
    executionId: containment.executionId,
    outcome: "incomplete",
    diagnostics: [`Preview cleanup failed: ${error instanceof Error ? error.message : String(error)}`]
  };
}

function cleanupPreview(preview, trigger) {
  // Every lifecycle caller reaches containment so it can retain its trigger,
  // while containment itself guarantees that only its first caller signals.
  const observed = Promise.resolve()
    .then(() => preview.onCleanup ? preview.onCleanup(trigger) : preview.containment.cleanup(trigger))
    .catch((error) => cleanupFailure(preview.containment, error))
    .then(async (record) => {
      preview.public.cleanup = record;
      preview.public.status = ["incomplete", "unsupported"].includes(record.outcome) ? `cleanup_${record.outcome}` : "stopped";
      // The public object is only in-memory; let the owning daemon make the
      // settled result durable after the status has been derived.
      await preview.onCleanupSettled?.(record);
      return record;
    });
  // Containment deduplicates signaling; callers still need their own observed
  // promise so a later exit/shutdown trigger reaches durable persistence.
  if (!preview.cleanup) preview.cleanup = observed;
  return observed;
}

function settledWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

export class PreviewManager {
  constructor({ dataDir, spawnImpl = spawn, execImpl = runManagedCommand, fetchImpl = fetch, portImpl = availablePort, containmentFactory = createProcessContainment, readyTimeoutMs = 60000, probeTimeoutMs = 2000, captureTimeoutMs = 60_000 } = {}) {
    this.dataDir = dataDir;
    this.spawn = spawnImpl;
    this.exec = execImpl;
    this.fetch = fetchImpl;
    this.port = portImpl;
    this.containmentFactory = containmentFactory;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.captureTimeoutMs = captureTimeoutMs;
    this.active = new Map();
    this.pending = new Map();
    this.stopped = new Map();
    this.ports = new Set();
  }

  async reservePort() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = await this.port();
      if (!this.ports.has(port)) { this.ports.add(port); return port; }
    }
    throw new Error("Could not allocate a unique preview port");
  }

  async ensure({ id, cwd, seedState = null, containment, onCleanup = null, onCleanupSettled = null } = {}) {
    const existing = this.active.get(id);
    if (existing?.child.exitCode === null && existing.cwd === cwd && !seedState) return existing.public;
    // A seeded preview is a proof fixture for one exact run snapshot. Restart
    // it for the next gate instead of rendering new worktree code against old
    // status, selection, or inspector state.
    if (existing) this.stop(id);
    this.stopped.delete(id);
    const config = await loadProjectConfig(cwd);
    const configuredName = config.commands.preview ? "preview" : config.commands.dev ? "dev" : null;
    const conventional = configuredName ? null : await detectPreviewCommand(cwd);
    const commandName = configuredName || conventional?.name;
    if (!commandName) return null;
    const command = configuredName ? config.commands[configuredName] : conventional.command;
    const port = await this.reservePort();
    const previewContainment = containment || this.containmentFactory({ executionId: `preview:${id}` });
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
    const launchEnvironment = previewContainment.environment(environment);
    let child;
    let output = "";
    const url = `http://127.0.0.1:${port}`;
    try {
      // Apply the marker after all repository-controlled values are assembled,
      // preserving the allow-list and avoiding any ambient environment merge.
      // A previous shared cleanup may have settled, so register this launch
      // before the child can inherit the ownership marker.
      previewContainment.beginLaunch?.();
      child = this.spawn(commandExecutable(cwd, previewCommand), previewCommand.slice(1), {
        cwd, env: launchEnvironment, stdio: ["ignore", "pipe", "pipe"]
      });
      for (const stream of [child.stdout, child.stderr].filter(Boolean)) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-50000); });
      await waitUntilReady(url, child, this.fetch, this.readyTimeoutMs, this.probeTimeoutMs);
    } catch (error) {
      this.ports.delete(port);
      let cleanup;
      try { cleanup = await previewContainment.cleanup({ trigger: "preview-launch-failed", previewId: id, error: error instanceof Error ? error.message : String(error) }); }
      catch (cleanupError) { cleanup = cleanupFailure(previewContainment, cleanupError); }
      const detail = `${error.message}\n${redactCommandOutput(output, launchEnvironment)}\nPreview cleanup: ${cleanup.outcome}`.trim();
      throw new Error(detail);
    }
    const publicPreview = { id, cwd, command: commandName, port, url, status: "running", cleanup: null, startedAt: new Date().toISOString() };
    const preview = { child, cwd, containment: previewContainment, onCleanup, onCleanupSettled, get output() { return output; }, public: publicPreview, cleanup: null };
    this.active.set(id, preview);
    child.once("exit", () => {
      if (this.active.get(id) === preview) {
        this.active.delete(id);
        this.stopped.set(id, preview.public);
      } else if (!this.active.has(id)) this.stopped.set(id, preview.public);
      this.ports.delete(port);
      this.trackCleanup(id, cleanupPreview(preview, { trigger: "preview-exit", previewId: id }));
    });
    return publicPreview;
  }

  async capture(id, { source = process.env, signal } = {}) {
    const preview = this.active.get(id);
    if (!preview) throw new Error("Preview is not running");
    const containment = preview.containment || this.containmentFactory({ executionId: `preview:${id}` });
    const directory = join(this.dataDir, "visual-evidence", id.replace(/[^a-z0-9._-]+/gi, "-"));
    // Each capture owns its files so artifacts saved by prior review rounds remain
    // immutable even after a correction triggers re-verification.
    const captureDirectory = join(directory, "captures", randomUUID());
    await mkdir(captureDirectory, { recursive: true });
    const evidence = [];
    for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
      const path = join(captureDirectory, `${name}.png`);
      // Chromium inherits the preview's ownership token through the screenshot
      // helper; each invocation must open a fresh containment cycle if an
      // earlier cleanup already settled.
      containment.beginLaunch?.();
      try {
        await this.exec(process.execPath, [screenshotScript, "--url", preview.public.url, "--out", path, "--width", String(width), "--height", String(height), "--wait-ms", "1200", "--click", activeStepSelector], {
          signal, env: containment.environment(source), timeout: this.captureTimeoutMs, maxBuffer: 2 * 1024 * 1024
        });
      } catch (error) {
        const timedOut = error?.code === "ETIMEDOUT" || (error?.killed === true && error?.signal === "SIGTERM") || /timed out/i.test(error.message);
        if (timedOut || signal?.aborted) {
          // The managed runner only reports the deadline; containment must
          // rediscover the inherited token before any process is signaled.
          try {
            await containment.cleanup({
              trigger: signal?.aborted ? "chromium-capture-aborted" : "chromium-capture-timeout",
              previewId: id,
              capture: name
            });
          } catch { /* The enclosing preview lifecycle persists incomplete cleanup evidence. */ }
        }
        // A completed screenshot remains useful even when only helper teardown
        // exceeded its bound; otherwise surface the capture failure.
        if (timedOut && !signal?.aborted) {
          try { await access(path); } catch { throw error; }
        } else throw error;
      }
      evidence.push({ name: `${name}.png`, path, ...visualEvidenceMedia(path), viewport: { width, height }, url: preview.public.url });
    }
    return evidence;
  }

  trackCleanup(id, promise) {
    this.pending.set(id, promise);
    promise.finally(() => {
      if (this.pending.get(id) === promise) this.pending.delete(id);
    });
    return promise;
  }

  stop(id, trigger = { trigger: "preview-stop" }) {
    const preview = this.active.get(id);
    if (!preview) return false;
    this.active.delete(id);
    this.stopped.set(id, preview.public);
    this.ports.delete(preview.public.port);
    preview.public.status = "stopping";
    // PID-only child.kill is unsafe after process replacement or descendant
    // forks. The containment service rediscoveres the exact owned identities.
    this.trackCleanup(id, cleanupPreview(preview, { ...trigger, previewId: id }));
    return true;
  }

  stopMatching(prefix, trigger) {
    let stopped = 0;
    for (const id of [...this.active.keys()]) if (id.startsWith(prefix) && this.stop(id, trigger)) stopped++;
    return stopped;
  }

  stopAll(trigger) {
    let stopped = 0;
    for (const id of [...this.active.keys()]) if (this.stop(id, trigger)) stopped++;
    return stopped;
  }

  previewState(id) { return this.active.get(id)?.public || this.stopped.get(id) || null; }

  async settleMatching(prefix, timeoutMs) {
    const pending = [...this.pending.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, promise]) => promise);
    await Promise.all(pending.map((promise) => settledWithin(promise, timeoutMs)));
  }

  async settleAll(timeoutMs) {
    await Promise.all([...this.pending.values()].map((promise) => settledWithin(promise, timeoutMs)));
  }

  list() { return [...this.active.values()].map((preview) => preview.public); }
}

export const previewChromiumPath = chromiumPath;
