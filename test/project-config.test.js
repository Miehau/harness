import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, normalizeProjectConfig, projectEnvironment, runProjectCommand } from "../src/project-config.js";
import { PROCESS_OWNERSHIP_ENV, ProcessContainment, createExecutionOwnership } from "../src/process-containment.js";

test("detects conventional package commands when no contract exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-config-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js", build: "node build.js", dev: "node dev.js" } }));
    assert.deepEqual((await loadProjectConfig(root)).commands, { test: ["npm", "run", "test"], build: ["npm", "run", "build"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps conventional test commands available beside an explicit contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-config-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node tests.js" } }));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { verify: ["node", "verify.js"] } }));
    assert.deepEqual((await loadProjectConfig(root)).commands, { test: ["npm", "run", "test"], verify: ["node", "verify.js"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects shell escapes and inline code evaluators", () => {
  assert.throws(() => normalizeProjectConfig({ commands: { bad: ["bash", "-lc", "rm -rf ."] } }), /blocked executable/);
  assert.throws(() => normalizeProjectConfig({ commands: { bad: ["node", "-e", "process.exit()"] } }), /inline code/);
});

test("an invalid declaration does not poison unrelated project commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-isolation-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: {
      "git-status": ["git", "status"],
      check: [process.execPath, "check.mjs"]
    } }));
    await writeFile(join(root, "check.mjs"), "console.log('checked')\n");

    const config = await loadProjectConfig(root);
    assert.deepEqual(Object.keys(config.commands), ["check"]);
    assert.match(config.commandErrors["git-status"], /blocked executable git/);
    assert.equal((await runProjectCommand(root, "check")).output.trim(), "checked");
    await assert.rejects(runProjectCommand(root, "git-status"), /Project command “git-status” uses blocked executable git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("passes only explicit environment values and redacts them from command output", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-env-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".env.local"), "LOCAL_TOKEN=local-secret-value\n");
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({
      commands: { test: ["npm", "test"] }, environment: { pass: ["API_TOKEN", "LOCAL_TOKEN"], files: [".env.local"] }
    }));
    const calls = [];
    const execImpl = async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "git") return { stdout: "" };
      return { stdout: `${options.env.API_TOKEN} ${options.env.LOCAL_TOKEN}`, stderr: "" };
    };
    const config = await loadProjectConfig(root);
    const env = await projectEnvironment(root, config, { source: { PATH: "/bin", API_TOKEN: "daemon-secret-value", UNLISTED: "hidden" }, execImpl });
    assert.equal(env.UNLISTED, undefined);
    assert.equal(env.LOCAL_TOKEN, "local-secret-value");
    const result = await runProjectCommand(root, "test", {
      source: { PATH: "/bin", API_TOKEN: "daemon-secret-value" }, execImpl, ownership: { token: "worker-owner" }
    });
    assert.equal(result.output, "[REDACTED] [REDACTED]");
    assert.equal(calls.at(-1).options.env.UNLISTED, undefined);
    assert.equal(calls.at(-1).options.env[PROCESS_OWNERSHIP_ENV], "worker-owner");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runs a named argv command without a shell or unlisted daemon secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, "check.mjs"), "console.log([process.env.UNLISTED || 'isolated', process.env.AGENT_PLAN_EXECUTION_OWNER].join(':'))\n");
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { check: [process.execPath, "check.mjs"] } }));
    const result = await runProjectCommand(root, "check", {
      source: { PATH: process.env.PATH, UNLISTED: "must-not-leak" }, ownership: { token: "cmd" }
    });
    assert.equal(result.status, "passed");
    assert.equal(result.output.trim(), "isolated:cmd");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("classifies a command timeout while retaining its normal failed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-timeout-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { check: ["node", "check.mjs"] } }));
    const timeout = new Error("timed out");
    timeout.code = "ETIMEDOUT";
    const result = await runProjectCommand(root, "check", {
      ownership: { token: "timeout-owner" }, execImpl: async () => { throw timeout; }
    });
    assert.equal(result.status, "failed");
    assert.equal(result.timedOut, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("returns at the timeout even when a fixture descendant holds command pipes open", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-pipe-timeout-"));
  let parent;
  let descendant;
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { check: [process.execPath, "parent.mjs", "pids"] } }));
    await writeFile(join(root, "held.mjs"), "setInterval(() => {}, 1000);\n");
    await writeFile(join(root, "parent.mjs"), `import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const child = spawn(process.execPath, [new URL("./held.mjs", import.meta.url).pathname], { stdio: "inherit" });
await writeFile(process.argv[2], [process.pid, child.pid].join(":"));
setInterval(() => {}, 1000);
`);
    let cleanupTrigger;
    const started = Date.now();
    const result = await runProjectCommand(root, "check", {
      source: { PATH: process.env.PATH }, ownership: { token: "timeout-owner" }, timeoutMs: 500,
      containment: { executionId: "timeout-command", cleanup: async (trigger) => { cleanupTrigger = trigger; return { outcome: "complete" }; } }
    });
    assert.ok(Date.now() - started < 1_500, "timeout must not wait for inherited stdio to close");
    assert.equal(result.timedOut, true);
    assert.strictEqual(result.cleanupTrigger, cleanupTrigger);
    assert.equal(cleanupTrigger.trigger, "repository-command-timeout");
    assert.equal(cleanupTrigger.command, "check");
    assert.match(cleanupTrigger.at, /^\d{4}-\d{2}-\d{2}T/);
    [parent, descendant] = (await readFile(join(root, "pids"), "utf8")).split(":").map(Number);
    assert.doesNotThrow(() => process.kill(parent, 0), "the managed runner must leave signaling to containment");
  } finally {
    for (const pid of [parent, descendant]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a command launched after timeout cleanup receives a later worker-exit containment cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-late-launch-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({
      commands: { timeout: ["node", "timeout.mjs"], later: ["node", "later.mjs"] }
    }));
    const ownership = createExecutionOwnership("late-launch", { randomUUIDImpl: () => "late-owner", now: () => 0 });
    const targets = new Map();
    const signals = [];
    const containment = new ProcessContainment({
      executionId: ownership.executionId, ownership, graceMs: 0, forceWaitMs: 0, timeoutMs: 100,
      adapter: {
        platform: "test", supported: true,
        discover: async () => ({ processes: [...targets.values()], unresolved: [] }),
        observe: async (pid) => targets.get(pid) || null,
        signal: async (pid, signal) => { signals.push([pid, signal]); targets.delete(pid); }
      }
    });
    let calls = 0;
    const execImpl = async () => {
      if (calls++ === 0) {
        targets.set(41, { pid: 41, ppid: 7, startTime: "100", ownershipToken: ownership.token });
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      targets.set(42, { pid: 42, ppid: 7, startTime: "101", ownershipToken: ownership.token });
      return { stdout: "later command completed", stderr: "" };
    };

    const timedOut = await runProjectCommand(root, "timeout", { ownership, containment, execImpl });
    assert.equal(timedOut.timedOut, true);
    const later = await runProjectCommand(root, "later", { ownership, containment, execImpl });
    assert.equal(later.status, "passed");
    const completed = await containment.cleanup("worker-completed");

    assert.deepEqual(signals, [[41, "SIGTERM"], [42, "SIGTERM"]]);
    assert.deepEqual(completed.discovered, [
      { pid: 41, ppid: 7, startTime: "100" },
      { pid: 42, ppid: 7, startTime: "101" }
    ]);
    assert.deepEqual(completed.triggers.map(({ trigger }) => trigger), ["repository-command-timeout", "worker-completed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves abort errors after applying an ownership marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-abort-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { check: ["node", "check.mjs"] } }));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let environment;
    await assert.rejects(runProjectCommand(root, "check", {
      signal: controller.signal, ownership: { token: "aborted-owner" },
      execImpl: async (_file, _args, options) => {
        environment = options.env;
        throw new Error("cancelled");
      }
    }), /cancelled/);
    assert.equal(environment[PROCESS_OWNERSHIP_ENV], "aborted-owner");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("allows bounded word arguments for focused commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { test: ["node", "tests.mjs"] } }));
    let called;
    const execImpl = async (_executable, args) => { called = args; return { stdout: "ok", stderr: "" }; };
    await runProjectCommand(root, "test", { args: ["process-containment"], execImpl, source: {} });
    assert.deepEqual(called, ["tests.mjs", "process-containment"]);
    await assert.rejects(runProjectCommand(root, "test", { args: ["--watch"], execImpl }), /unsafe arguments/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trusted command environment keeps generated evidence outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-evidence-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { capture: ["node", "capture.mjs"] } }));
    let environment;
    await runProjectCommand(root, "capture", {
      source: {}, environment: { AGENT_PLAN_EVIDENCE_DIR: "/run-owned/evidence" },
      execImpl: async (_executable, _args, options) => { environment = options.env; return { stdout: "ok", stderr: "" }; }
    });
    assert.equal(environment.AGENT_PLAN_EVIDENCE_DIR, "/run-owned/evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
