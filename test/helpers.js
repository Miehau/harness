import { spawn } from "node:child_process";
import { runCli } from "../src/cli.js";
import { invoke, mockHarness } from "../scripts/harness.js";

export { invoke, mockHarness, seedRun, withDaemon } from "../scripts/harness.js";
export { sampleTicket, scenarios, writeSeed } from "../scripts/seed-state.js";

export function daemonFetch(daemon) {
  return async (url, options = {}) => {
    const parsed = new URL(url, "http://127.0.0.1:4317");
    const result = await invoke(daemon, options.method || "GET", parsed.pathname + parsed.search, {
      body: options.body ? JSON.parse(options.body) : undefined
    });
    return {
      ok: result.status < 400,
      status: result.status,
      async text() { return result.text; }
    };
  };
}

export function fixtureHarness({ launcher, mode = "long-lived", eventFile, onLaunch = () => {} } = {}) {
  if (!launcher) throw new TypeError("fixture launcher is required");
  return {
    ...mockHarness(),
    async runStep({ containment, signal }) {
      const child = spawn(process.execPath, [launcher, mode, eventFile || ""], {
        env: containment.environment(), stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve, reject) => child.once("exit", (code) => code ? reject(new Error(stderr || `Fixture launcher exited ${code}`)) : resolve()));
      const launched = new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          try { resolve(JSON.parse(output.slice(0, newline))); }
          catch (error) { reject(error); }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code && !output) reject(new Error(stderr || `Fixture launcher exited ${code}`));
        });
      });
      const launchedProcess = await launched;
      onLaunch(launchedProcess);
      if (mode === "normal-exit") {
        await exited;
        return completedFixtureReport();
      }
      await new Promise((_, reject) => {
        const abort = () => reject(signal.reason || new Error("Fixture worker cancelled"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
    async verifyStep() { return { summary: "Fixture verification", findings: [], rawOutput: "", sessionFile: null }; },
    async generateCommitMessage() { return "test: fixture cleanup\n\nWhy: exercise containment\nRequirement: REQ-052"; }
  };
}

function completedFixtureReport() {
  return {
    prompt: "fixture worker", rawOutput: "fixture complete", output: "fixture complete", reviewNotes: [], sessionFile: null,
    report: { status: "completed", summary: "Fixture completed", artifact: "fixture complete" }
  };
}

export async function waitFor(assertion, { timeoutMs = 1_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let failure;
  while (Date.now() < deadline) {
    try { return await assertion(); }
    catch (error) { failure = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw failure || new Error(`Condition did not become true within ${timeoutMs}ms`);
}

export async function stopFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await waitFor(() => {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    throw new Error(`Fixture process ${pid} is still running`);
  }, { timeoutMs: 1_000 });
}

export async function runAgainstDaemon(daemon, argv) {
  const chunks = [];
  const errors = [];
  const code = await runCli(argv, {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317", AGENT_PLAN_POLL_MS: "10" },
    fetchImpl: daemonFetch(daemon),
    stdout: { write(value) { chunks.push(value); } },
    stderr: { write(value) { errors.push(value); } }
  });
  const stdout = chunks.join("");
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = null; }
  return { code, stdout, stderr: errors.join(""), json };
}
