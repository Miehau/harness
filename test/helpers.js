import { runCli } from "../src/cli.js";
import { invoke } from "../scripts/harness.js";

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
