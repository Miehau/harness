import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizePlan } from "../src/plan.js";
import { ProcessContainment, createExecutionOwnership, createPlatformAdapter } from "../src/process-containment.js";
import { fixtureHarness, invoke, seedRun, stopFixtureProcess, waitFor, withDaemon } from "./helpers.js";

const fixtureLauncher = fileURLToPath(new URL("../fixtures/process-cleanup/launcher.mjs", import.meta.url));
const linuxOnly = process.platform !== "linux";

function fixtureTicket(id) {
  return {
    id, identifier: id.toUpperCase(), title: "Fixture process cleanup", description: "Exercise owned fixture cleanup",
    source: "fixture", state: { name: "Fixture", type: "fixture" }, team: { name: "Fixtures" }
  };
}

function fixturePlan() {
  return normalizePlan({
    title: "Fixture cleanup", summary: "Terminate only fixture descendants.",
    nodes: [{
      id: "fixture-worker", title: "Run fixture worker", description: "Launch an owned fixture descendant.",
      role: "implementation", permission: "read", contextPolicy: "seeded", harness: "pi", skills: [],
      references: ["fixtures/process-cleanup/launcher.mjs"], expectedArtifacts: ["fixture-result.md"],
      acceptanceCriteria: ["The fixture process is cleaned up"], requirementIds: ["REQ-052-01"], capabilityIds: ["CAP-052-03"], deltaIds: ["DELTA-052-05"]
    }]
  });
}

function containmentFactory(records, options = {}) {
  return (input) => {
    const containment = new ProcessContainment({ ...input, graceMs: 80, forceWaitMs: 30, timeoutMs: 1_000, ...options });
    records.push(containment);
    return containment;
  };
}

async function events(file) {
  return (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
}

function assertExited(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Fixture descendant ${pid} is still running`);
}

async function launchOwnedFixture(mode, eventFile, ownership) {
  return new Promise((resolve, reject) => {
    const launcher = spawn(process.execPath, [fixtureLauncher, mode, eventFile], {
      env: { ...process.env, ...ownership.environment }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let stderr = "";
    launcher.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(output.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    launcher.stderr.on("data", (chunk) => { stderr += chunk; });
    launcher.once("error", reject);
    launcher.once("exit", (code) => {
      if (code && !output) reject(new Error(stderr || `Fixture launcher exited ${code}`));
    });
  });
}

async function ownedTarget(adapter, ownership, pid) {
  return waitFor(async () => {
    const target = (await adapter.discover(ownership.token)).processes.find((process) => process.pid === pid);
    assert.ok(target, `fixture ${pid} was not discovered as owned`);
    return target;
  });
}

async function removeEventFile(file) {
  await rm(file, { force: true });
}

test("daemon cancellation cleans an owned descendant once and exposes durable cleanup evidence", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-cancel-${randomUUID()}.log`);
  const containments = [];
  let pid;
  const harness = fixtureHarness({ launcher: fixtureLauncher, eventFile, onLaunch: (value) => { pid = value.pid; } });
  harness.containmentFactory = containmentFactory(containments);
  try {
    await withDaemon(async (daemon, { cwd }) => {
      const id = await seedRun(daemon, {
        ticket: fixtureTicket("fixture-cancel"), status: "awaiting_approval", workspace: { cwd }, plan: fixturePlan(),
        checkpoint: { id: "approve", kind: "awaiting_approval", title: "Approve fixture" }
      });
      assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: {} })).status, 202);
      await waitFor(async () => {
        assert.ok(pid);
        assert.match((await events(eventFile)).join("\n"), /started/);
      });

      const cancelled = await invoke(daemon, "POST", `/api/tickets/${id}/cancel`, { body: {} });
      assert.deepEqual(cancelled.json, { cancelled: true, ticketId: id });
      await waitFor(() => assertExited(pid));

      const inspector = await invoke(daemon, "GET", `/api/tickets/${id}/run`);
      const cleanup = inspector.json.cleanup;
      assert.equal(cleanup.executions.length, 1);
      assert.ok(["complete", "incomplete"].includes(cleanup.outcome));
      const execution = cleanup.executions[0];
      assert.equal(execution.actions.filter((action) => action.signal === "SIGTERM").length, 1);
      assert.ok(execution.actions.filter((action) => action.signal === "SIGKILL").length <= 1);
      assert.ok(execution.triggers.some(({ trigger }) => trigger === "run-cancelled"));
      assert.ok(execution.triggers.some(({ trigger }) => trigger === "worker-aborted"));
      if (execution.outcome === "incomplete") assert.ok(execution.unresolved.every((item) => item.pid === pid || !item.pid));
      assert.match((await events(eventFile)).join("\n"), /graceful/);
    }, { harness });
  } finally {
    await stopFixtureProcess(pid);
    await removeEventFile(eventFile);
  }
});

test("daemon shutdown bounds and cleans a stubborn owned descendant", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-shutdown-${randomUUID()}.log`);
  const containments = [];
  let pid;
  const harness = fixtureHarness({ launcher: fixtureLauncher, mode: "stubborn", eventFile, onLaunch: (value) => { pid = value.pid; } });
  harness.containmentFactory = containmentFactory(containments);
  try {
    await withDaemon(async (daemon, { cwd }) => {
      const id = await seedRun(daemon, {
        ticket: fixtureTicket("fixture-shutdown"), status: "awaiting_approval", workspace: { cwd }, plan: fixturePlan(),
        checkpoint: { id: "approve", kind: "awaiting_approval", title: "Approve fixture" }
      });
      assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: {} })).status, 202);
      await waitFor(async () => {
        assert.ok(pid);
        assert.match((await events(eventFile)).join("\n"), /started/);
      });

      const started = Date.now();
      await daemon.close({ exit: false });
      assert.ok(Date.now() - started < 2_000, "shutdown must remain bounded while the fixture ignores SIGTERM");
      await waitFor(() => assertExited(pid), { timeoutMs: 2_000 });

      const execution = daemon.store.read().ticketRuns[id].cleanup.executions[0];
      assert.ok(execution.triggers.some(({ trigger }) => trigger === "daemon-shutdown"));
      assert.deepEqual(execution.actions.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
      assert.match((await events(eventFile)).join("\n"), /graceful/);
    }, { harness });
  } finally {
    await stopFixtureProcess(pid);
    await removeEventFile(eventFile);
  }
});

test("identity mismatch leaves the fixture process unsignaled", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-identity-${randomUUID()}.log`);
  const ownership = createExecutionOwnership("identity-fixture");
  const adapter = createPlatformAdapter();
  let pid;
  try {
    ({ pid } = await launchOwnedFixture("identity-change", eventFile, ownership));
    const target = await ownedTarget(adapter, ownership, pid);
    const containment = new ProcessContainment({
      executionId: ownership.executionId, ownership, graceMs: 30, forceWaitMs: 10, timeoutMs: 500,
      adapter: {
        ...adapter,
        async discover() { return { processes: [target], unresolved: [] }; },
        async observe() { return { ...target, startTime: `${target.startTime}-replacement` }; },
        async signal() { assert.fail("identity mismatch must not signal the fixture"); }
      }
    });
    const result = await containment.cleanup("identity-safety-test");
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.unresolved[0].reason, "graceful-identity-mismatch");
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.doesNotMatch((await events(eventFile)).join("\n"), /graceful/);
  } finally {
    await stopFixtureProcess(pid);
    await removeEventFile(eventFile);
  }
});

test("stubborn fixture receives graceful termination before renewed validation and force", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-stubborn-${randomUUID()}.log`);
  const ownership = createExecutionOwnership("stubborn-fixture");
  const adapter = createPlatformAdapter();
  let pid;
  try {
    ({ pid } = await launchOwnedFixture("stubborn", eventFile, ownership));
    const target = await ownedTarget(adapter, ownership, pid);
    let observations = 0;
    const containment = new ProcessContainment({
      executionId: ownership.executionId, ownership, graceMs: 80, forceWaitMs: 20, timeoutMs: 750,
      adapter: {
        ...adapter,
        async discover() { return { processes: [target], unresolved: [] }; },
        async observe(...input) { observations++; return adapter.observe(...input); }
      }
    });
    const started = Date.now();
    const result = await containment.cleanup("stubborn-fixture-test");
    assert.ok(Date.now() - started >= 70, "force escalation must wait for the bounded grace period");
    assert.deepEqual(result.actions.map((action) => action.signal), ["SIGTERM", "SIGKILL"]);
    assert.ok(observations >= 3, "identity is observed before each signal and after force");
    assert.ok(["complete", "incomplete"].includes(result.outcome));
    if (result.outcome === "incomplete") assert.ok(result.unresolved.every((item) => item.pid === pid || !item.pid));
    assert.match((await events(eventFile)).join("\n"), /graceful/);
    await waitFor(() => assertExited(pid));
  } finally {
    await stopFixtureProcess(pid);
    await removeEventFile(eventFile);
  }
});

test("a fixture descendant forked during graceful cleanup receives a second cleanup cycle", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-fork-${randomUUID()}.log`);
  const ownership = createExecutionOwnership("fork-fixture");
  const adapter = createPlatformAdapter();
  let parentPid;
  let childPid;
  try {
    ({ pid: parentPid } = await launchOwnedFixture("fork-on-graceful", eventFile, ownership));
    const containment = new ProcessContainment({
      executionId: ownership.executionId, ownership, adapter, graceMs: 80, forceWaitMs: 20, timeoutMs: 750
    });
    const result = await containment.cleanup("fork-fixture-test");
    await waitFor(async () => {
      const pids = (await events(eventFile)).filter((line) => / started /.test(line)).map((line) => Number(line.split(" ").at(-1)));
      assert.equal(pids.length, 2);
      childPid = pids.find((pid) => pid !== parentPid);
      assert.ok(childPid);
    });
    assert.equal(result.outcome, "complete");
    assert.deepEqual(result.actions.filter((action) => action.pid === childPid).map((action) => action.signal), ["SIGTERM"]);
    await waitFor(() => assertExited(childPid));
  } finally {
    await stopFixtureProcess(childPid);
    await stopFixtureProcess(parentPid);
    await removeEventFile(eventFile);
  }
});

test("normal fixture completion records not-required without waiting for a grace period", { skip: linuxOnly }, async () => {
  const eventFile = join(tmpdir(), `agent-plan-fixture-normal-${randomUUID()}.log`);
  const containments = [];
  const harness = fixtureHarness({ launcher: fixtureLauncher, mode: "normal-exit", eventFile });
  harness.containmentFactory = containmentFactory(containments, { graceMs: 300 });
  try {
    await withDaemon(async (daemon, { cwd }) => {
      const id = await seedRun(daemon, {
        ticket: fixtureTicket("fixture-normal"), status: "awaiting_approval", workspace: { cwd }, plan: fixturePlan(),
        checkpoint: { id: "approve", kind: "awaiting_approval", title: "Approve fixture" }
      });
      const started = Date.now();
      assert.equal((await invoke(daemon, "POST", `/api/tickets/${id}/approve`, { body: {} })).status, 202);
      await waitFor(() => {
        const execution = daemon.store.read().ticketRuns[id].cleanup.executions[0];
        assert.equal(execution.outcome, "not-required");
      });
      assert.ok(Date.now() - started < 250, "no-owned-process cleanup must not consume the configured grace period");
      const inspector = await invoke(daemon, "GET", `/api/tickets/${id}/run`);
      assert.equal(inspector.json.cleanup.outcome, "not-required");
      assert.equal(inspector.json.cleanup.executions[0].actions.length, 0);
      const completed = (await events(eventFile)).find((line) => / completed /.test(line));
      assert.ok(completed);
      await waitFor(() => assertExited(Number(completed.split(" ").at(-1))));
    }, { harness });
  } finally {
    await removeEventFile(eventFile);
  }
});
