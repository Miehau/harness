import assert from "node:assert/strict";
import test from "node:test";
import {
  PROCESS_OWNERSHIP_ENV,
  ProcessContainment,
  createExecutionOwnership,
  createPlatformAdapter,
  environmentForOwnership,
  sameProcessIdentity
} from "../src/process-containment.js";
import { beginRunCleanup, completeRunCleanup, createTicketRun } from "../src/execution.js";

function ownership() {
  return createExecutionOwnership("execution-1", { randomUUIDImpl: () => "owner-token", now: () => 0 });
}

function identity(overrides = {}) {
  return { pid: 41, ppid: 7, startTime: "100", ownershipToken: "owner-token", ...overrides };
}

function containment(adapter, options = {}) {
  let tick = 0;
  return new ProcessContainment({
    executionId: "execution-1",
    ownership: ownership(),
    adapter: { platform: "test", supported: true, ...adapter },
    graceMs: 5,
    forceWaitMs: 5,
    timeoutMs: 100,
    now: () => tick++,
    sleep: async () => {},
    ...options
  });
}

test("ownership is unique execution evidence and overlays launch environments", () => {
  const first = createExecutionOwnership("a", { randomUUIDImpl: () => "one", now: () => 0 });
  const second = createExecutionOwnership("b", { randomUUIDImpl: () => "two", now: () => 0 });
  assert.notEqual(first.token, second.token);
  assert.deepEqual(environmentForOwnership(first, { PATH: "/bin", [PROCESS_OWNERSHIP_ENV]: "old" }), {
    PATH: "/bin", [PROCESS_OWNERSHIP_ENV]: "one"
  });
  assert.equal(Object.isFrozen(first), true);
});

test("identity requires PID, start time, and ownership while allowing subreaper adoption", () => {
  const expected = identity();
  assert.equal(sameProcessIdentity(expected, identity(), "owner-token"), true);
  assert.equal(sameProcessIdentity(expected, identity({ ppid: 1 }), "owner-token"), true, "init adoption preserves start-time and ownership evidence");
  assert.equal(sameProcessIdentity(expected, identity({ ppid: 8 }), "owner-token"), true, "subreaper adoption preserves stronger immutable identity evidence");
  for (const changed of [
    identity({ pid: 42 }), identity({ startTime: "101" }), identity({ ownershipToken: "other" }),
    identity({ ppid: undefined }), identity({ startTime: undefined }), identity({ startTime: "" })
  ]) assert.equal(sameProcessIdentity(expected, changed, "owner-token"), false);
  for (const incomplete of [identity({ ppid: undefined }), identity({ startTime: undefined }), identity({ startTime: "" })]) {
    assert.equal(sameProcessIdentity(incomplete, incomplete, "owner-token"), false);
  }
});

test("incomplete identity evidence never reaches signaling", async () => {
  for (const incomplete of [identity({ ppid: undefined }), identity({ startTime: "" })]) {
    let signals = 0;
    const result = await containment({
      discover: async () => [incomplete],
      observe: async () => incomplete,
      signal: async () => { signals++; }
    }).cleanup("cancelled");
    assert.equal(signals, 0);
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.unresolved[0].reason, "graceful-identity-mismatch");
  }
});

test("returns promptly without waiting or signaling when cleanup is unnecessary", async () => {
  let sleeps = 0;
  const service = containment({ discover: async () => [], observe: async () => { throw new Error("unused"); }, signal: async () => { throw new Error("unused"); } }, {
    sleep: async () => { sleeps++; }
  });
  const result = await service.cleanup("completed");
  assert.equal(result.outcome, "not-required");
  assert.equal(sleeps, 0);
  assert.deepEqual(result.actions, []);
});

test("a zombie owned process is safe absence rather than an unresolved live target", async () => {
  let signals = 0;
  const adapter = createPlatformAdapter({
    platform: "linux",
    currentUid: 1000,
    procRoot: "/simulated-proc",
    readDirectory: async () => ["51"],
    readFileImpl: async (path) => {
      if (path.endsWith("/status")) return "Name:\tfixture\nUid:\t1000\t1000\t1000\t1000\n";
      if (path.endsWith("/environ")) return Buffer.from(`${PROCESS_OWNERSHIP_ENV}=owner-token\0`);
      return `51 (fixture) Z 1 ${Array(17).fill("0").join(" ")} 123`;
    },
    kill: () => { signals++; }
  });
  const result = await containment(adapter).cleanup("worker-completed");
  assert.equal(result.outcome, "not-required");
  assert.equal(signals, 0);
});

test("graceful signal, bounded wait, renewed identity, and force signal are ordered", async () => {
  const events = [];
  let observations = 0;
  const service = containment({
    discover: async () => [identity()],
    observe: async () => {
      events.push(`observe-${++observations}`);
      return observations === 3 ? null : identity();
    },
    signal: async (_pid, signal) => { events.push(signal); }
  }, { sleep: async (ms) => { events.push(`wait-${ms}`); } });
  const result = await service.cleanup("cancelled");
  assert.equal(result.outcome, "complete");
  assert.deepEqual(events, ["observe-1", "SIGTERM", "wait-5", "observe-2", "SIGKILL", "wait-5", "observe-3"]);
  assert.deepEqual(result.actions.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
});

test("a descendant forked during graceful cleanup receives a bounded second cycle", async () => {
  const parent = identity();
  const child = identity({ pid: 42, startTime: "101" });
  const actions = [];
  let state = "parent";
  let discoveries = 0;
  const result = await containment({
    discover: async () => {
      discoveries++;
      return state === "parent" ? [parent] : state === "child" ? [child] : [];
    },
    observe: async (pid) => pid === parent.pid && state === "parent" ? parent : pid === child.pid && state === "child" ? child : null,
    signal: async (pid, signal) => {
      actions.push([pid, signal]);
      if (pid === parent.pid && signal === "SIGTERM") state = "child";
      if (pid === child.pid && signal === "SIGKILL") state = "gone";
    }
  }).cleanup("cancelled");
  assert.equal(result.outcome, "complete");
  assert.equal(discoveries, 3, "each cleanup cycle takes one post-force quiescence snapshot");
  assert.deepEqual(actions, [[41, "SIGTERM"], [42, "SIGTERM"], [42, "SIGKILL"]]);
});

test("PID reuse before graceful signaling is unresolved and never signaled", async () => {
  let signals = 0;
  const result = await containment({
    discover: async () => [identity()],
    observe: async () => identity({ startTime: "reused" }),
    signal: async () => { signals++; }
  }).cleanup("failed");
  assert.equal(signals, 0);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.unresolved[0].reason, "graceful-identity-mismatch");
});

test("identity is renewed before force and a changed target is never force signaled", async () => {
  const signals = [];
  let count = 0;
  const result = await containment({
    discover: async () => [identity()],
    observe: async () => ++count === 1 ? identity() : identity({ startTime: "reused" }),
    signal: async (_pid, signal) => { signals.push(signal); }
  }).cleanup("timeout");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.unresolved[0].reason, "force-identity-mismatch");
});

test("concurrent cleanup shares signaling while timestamp-distinct triggers survive durable settlement", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signals = 0;
  let observations = 0;
  const service = containment({
    discover: async () => { await gate; return [identity()]; },
    observe: async () => ++observations === 1 ? identity() : null,
    signal: async () => { signals++; }
  });
  const firstTrigger = { trigger: "shutdown", source: "daemon", at: "2026-09-03T10:00:01.000Z" };
  const secondTrigger = { trigger: "shutdown", source: "daemon", at: "2026-09-03T10:00:02.000Z" };
  const first = service.cleanup(firstTrigger);
  const second = service.cleanup(secondTrigger);
  assert.equal(first, second);
  release();
  const result = await first;
  assert.equal(signals, 1);
  assert.deepEqual(result.triggers, [firstTrigger, secondTrigger]);

  const run = createTicketRun({ id: "containment-triggers", identifier: "CONTAIN" }, {}, {});
  beginRunCleanup(run, { executionId: "execution-1", at: "2026-09-03T10:00:00.000Z" });
  completeRunCleanup(run, "execution-1", result, { trigger: "worker-exit", at: "2026-09-03T10:00:03.000Z" });
  assert.deepEqual(run.cleanup.executions[0].triggers, [
    { trigger: "worker-launch", at: "2026-09-03T10:00:00.000Z" },
    { trigger: "worker-exit", at: "2026-09-03T10:00:03.000Z" },
    firstTrigger,
    secondTrigger
  ]);
});

test("durable cleanup preserves timestamp-distinct lifecycle requests", () => {
  const run = createTicketRun({ id: "durable-triggers", identifier: "DURABLE" }, {}, {});
  const earlier = { trigger: "run-cancelled", source: "daemon", at: "2026-09-03T10:00:01.000Z" };
  const later = { trigger: "run-cancelled", source: "daemon", at: "2026-09-03T10:00:02.000Z" };
  const evidence = { executionId: "execution-1", outcome: "not-required", triggers: [later], discovered: [], actions: [], unresolved: [], diagnostics: [] };
  beginRunCleanup(run, { executionId: "execution-1", at: "2026-09-03T10:00:00.000Z" });
  completeRunCleanup(run, "execution-1", evidence, earlier);
  completeRunCleanup(run, "execution-1", evidence, later);
  assert.deepEqual(run.cleanup.executions[0].triggers, [
    { trigger: "worker-launch", at: "2026-09-03T10:00:00.000Z" },
    earlier,
    later
  ]);
});

test("a launch during cleanup queues its own cycle after the active cycle", async () => {
  let release;
  let started;
  const firstDiscovery = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let discoveries = 0;
  const signals = [];
  const service = containment({
    discover: async () => {
      discoveries++;
      if (discoveries === 1) {
        started();
        await gate;
        return [];
      }
      return discoveries === 2 ? [identity()] : [];
    },
    observe: async () => signals.length ? null : identity(),
    signal: async (_pid, signal) => { signals.push(signal); }
  }, { graceMs: 0, forceWaitMs: 0 });

  const first = service.cleanup("preview-exit");
  await firstDiscovery;
  service.beginLaunch();
  const later = service.cleanup("repository-check-exit");
  assert.notEqual(later, first);
  assert.equal(discoveries, 1, "the follow-up cycle must wait for the active cycle");
  release();

  await later;
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(service.record.triggers.map(({ trigger }) => trigger), ["preview-exit", "repository-check-exit"]);
});

test("one cleanup deadline leaves every unscheduled target unresolved", async () => {
  let clock = 0;
  let observations = 0;
  let signals = 0;
  const targets = [identity({ pid: 41 }), identity({ pid: 42 }), identity({ pid: 43 })];
  const result = await containment({
    discover: async () => { clock = 11; return targets; },
    observe: async () => { observations++; return identity(); },
    signal: async () => { signals++; }
  }, { timeoutMs: 10, now: () => clock }).cleanup("shutdown");
  assert.equal(observations, 0);
  assert.equal(signals, 0);
  assert.equal(result.outcome, "incomplete");
  assert.deepEqual(result.unresolved.filter(({ pid }) => pid).map(({ pid }) => pid), [41, 42, 43]);
  assert.ok(result.unresolved.filter(({ pid }) => pid).every(({ error }) => /deadline exceeded/i.test(error)));
  assert.ok(result.unresolved.some(({ reason }) => reason === "post-force-discovery-failed"));
});

test("an unreadable Linux process owned by another user is irrelevant", async () => {
  let signals = 0;
  let environmentReads = 0;
  const adapter = createPlatformAdapter({
    platform: "linux",
    currentUid: 1000,
    procRoot: "/simulated-proc",
    readDirectory: async () => ["50"],
    readFileImpl: async (path) => {
      if (path.endsWith("/status")) return "Name:\tprotected\nUid:\t2000\t2000\t2000\t2000\n";
      environmentReads++;
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
    kill: () => { signals++; }
  });
  const result = await containment(adapter).cleanup("shutdown");
  assert.equal(environmentReads, 0);
  assert.equal(signals, 0);
  assert.equal(result.outcome, "not-required");
  assert.deepEqual(result.unresolved, []);
});

test("directory ownership filters foreign Linux processes before environment inspection", async () => {
  let reads = 0;
  const adapter = createPlatformAdapter({
    platform: "linux", currentUid: 1000, procRoot: "/live-proc", readDirectory: async () => ["51"],
    statImpl: async () => ({ uid: 2000 }),
    readFileImpl: async () => { reads++; throw new Error("foreign process must not be inspected further"); }
  });
  const result = await containment(adapter).cleanup("shutdown");
  assert.equal(reads, 0);
  assert.equal(result.outcome, "not-required");
  assert.deepEqual(result.unresolved, []);
});

test("an unreadable Linux ownership status is not an attributable process", async () => {
  let environmentReads = 0;
  const denied = new Error("status permission denied");
  denied.code = "EACCES";
  const adapter = createPlatformAdapter({
    platform: "linux", currentUid: 1000, procRoot: "/simulated-proc", readDirectory: async () => ["51"],
    readFileImpl: async (path) => {
      if (path.endsWith("/status")) throw denied;
      environmentReads++;
      throw new Error("status should establish ownership before environment access");
    }
  });
  const result = await containment(adapter).cleanup("shutdown");
  assert.equal(environmentReads, 0);
  assert.equal(result.outcome, "not-required");
  assert.deepEqual(result.unresolved, []);
});

test("an unreadable same-UID Linux process is not an attributable process", async () => {
  let signals = 0;
  const denied = new Error("permission denied");
  denied.code = "EACCES";
  const adapter = createPlatformAdapter({
    platform: "linux",
    currentUid: 1000,
    procRoot: "/simulated-proc",
    readDirectory: async () => ["51"],
    readFileImpl: async (path) => {
      if (path.endsWith("/status")) return "Name:\tfixture\nUid:\t1000\t1000\t1000\t1000\n";
      if (path.endsWith("/environ")) throw denied;
      return "51 (fixture) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123";
    },
    kill: () => { signals++; }
  });
  const result = await containment(adapter).cleanup("shutdown");
  assert.equal(signals, 0);
  assert.equal(result.outcome, "not-required");
  assert.deepEqual(result.unresolved, []);
});

test("unsupported and discovery failures do not speculate with signals", async () => {
  let signals = 0;
  const unsupported = new ProcessContainment({
    executionId: "execution-1", ownership: ownership(),
    adapter: { platform: "mystery", supported: false, reason: "no safe observer", signal: () => { signals++; } }
  });
  const unsupportedResult = await unsupported.cleanup("shutdown");
  assert.equal(unsupportedResult.outcome, "unsupported");
  assert.match(unsupportedResult.platform.reason, /safe observer/);

  const failed = await containment({
    discover: async () => { throw new Error("observer unavailable"); },
    signal: async () => { signals++; }
  }).cleanup("shutdown");
  assert.equal(failed.outcome, "incomplete");
  assert.equal(failed.unresolved[0].reason, "discovery-failed");
  assert.equal(signals, 0);
});

test("a descendant found after force receives its own bounded cleanup cycle", async () => {
  const parent = identity();
  const child = identity({ pid: 42, ppid: 41, startTime: "101" });
  let discoveries = 0;
  const signals = [];
  const result = await containment({
    // The child appears from the parent's graceful handler and is found by
    // the parent's post-force snapshot before receiving its own cycle.
    discover: async () => [ [parent], [child], [] ][discoveries++] || [],
    observe: async (pid) => {
      if (pid === parent.pid) return signals.includes("parent") ? null : parent;
      return signals.includes("child") ? null : child;
    },
    signal: async (pid, signal) => { if (signal === "SIGTERM") signals.push(pid === parent.pid ? "parent" : "child"); }
  }).cleanup("cancelled");
  assert.equal(result.outcome, "complete");
  assert.equal(discoveries, 3, "cleanup must take a post-force snapshot for each discovered identity");
  assert.deepEqual(result.actions.map(({ pid, signal }) => [pid, signal]), [[41, "SIGTERM"], [42, "SIGTERM"]]);
  assert.deepEqual(result.discovered, [{ pid: 41, ppid: 7, startTime: "100" }, { pid: 42, ppid: 41, startTime: "101" }]);
});

test("a new descendant present in successive post-force snapshots is signaled once", async () => {
  const parent = identity();
  const child = identity({ pid: 42, ppid: 41, startTime: "101" });
  const forced = new Set();
  let discoveries = 0;
  const signals = [];
  const result = await containment({
    discover: async () => [[parent], [child], [child], [], []][discoveries++] || [],
    observe: async (pid) => forced.has(pid) ? null : pid === parent.pid ? parent : child,
    signal: async (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") forced.add(pid);
    }
  }).cleanup("cancelled");
  assert.equal(result.outcome, "complete");
  assert.deepEqual(signals, [[41, "SIGTERM"], [41, "SIGKILL"], [42, "SIGTERM"], [42, "SIGKILL"]]);
  assert.deepEqual(result.discovered, [{ pid: 41, ppid: 7, startTime: "100" }, { pid: 42, ppid: 41, startTime: "101" }]);
});

test("disappearance and ESRCH are safe absence rather than unresolved ownership", async () => {
  const vanishedBeforeSignal = await containment({
    discover: async () => [identity()], observe: async () => null, signal: async () => assert.fail("must not signal")
  }).cleanup("normal-exit");
  assert.equal(vanishedBeforeSignal.outcome, "not-required");

  let observations = 0;
  const vanishedWhileSignaling = await containment({
    discover: async () => [identity()],
    observe: async () => ++observations === 1 ? identity() : null,
    signal: async () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; }
  }).cleanup("normal-exit");
  assert.equal(vanishedWhileSignaling.outcome, "complete");
  assert.equal(vanishedWhileSignaling.actions[0].status, "already-exited");
});
