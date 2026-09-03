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
  assert.equal(discoveries, 3);
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
    observe: async () => ++count === 1 ? identity() : identity({ ppid: 99 }),
    signal: async (_pid, signal) => { signals.push(signal); }
  }).cleanup("timeout");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.unresolved[0].reason, "force-identity-mismatch");
});

test("concurrent and repeated cleanup calls share signaling and retain triggers", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signals = 0;
  let observations = 0;
  const service = containment({
    discover: async () => { await gate; return [identity()]; },
    observe: async () => ++observations === 1 ? identity() : null,
    signal: async () => { signals++; }
  });
  const first = service.cleanup("cancel");
  const second = service.cleanup({ trigger: "shutdown", source: "daemon" });
  assert.equal(first, second);
  release();
  const result = await first;
  assert.equal(service.cleanup("worker-exit"), first);
  assert.equal(signals, 1);
  assert.deepEqual(result.triggers.map(({ trigger }) => trigger), ["cancel", "shutdown", "worker-exit"]);
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
  assert.deepEqual(result.unresolved.map(({ pid }) => pid), [41, 42, 43]);
  assert.ok(result.unresolved.every(({ error }) => /deadline exceeded/i.test(error)));
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

test("an unreadable plausible-owned Linux process remains durable uncertainty", async () => {
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
  assert.equal(result.outcome, "incomplete");
  assert.deepEqual(result.unresolved, [{ pid: 51, reason: "discovery-observation-failed", error: "permission denied" }]);
  assert.match(result.diagnostics[0], /could not inspect 1 process/);
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
