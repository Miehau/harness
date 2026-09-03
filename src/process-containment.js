import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

export const PROCESS_OWNERSHIP_ENV = "AGENT_PLAN_EXECUTION_OWNER";
export const gracefulSignal = "SIGTERM";
export const forceSignal = "SIGKILL";

function iso(value) { return new Date(value).toISOString(); }
function message(error) { return error instanceof Error ? error.message : String(error); }

/** Create the capability that must be inherited by every process in one execution. */
export function createExecutionOwnership(executionId, { randomUUIDImpl = randomUUID, now = Date.now } = {}) {
  if (!executionId || typeof executionId !== "string") throw new TypeError("executionId is required");
  const token = randomUUIDImpl();
  if (!token || typeof token !== "string") throw new TypeError("ownership token generator must return a non-empty string");
  const ownership = {
    executionId,
    token,
    createdAt: iso(now()),
    environment: Object.freeze({ [PROCESS_OWNERSHIP_ENV]: "" })
  };
  ownership.environment = Object.freeze({ [PROCESS_OWNERSHIP_ENV]: ownership.token });
  return Object.freeze(ownership);
}

export function environmentForOwnership(ownership, environment = {}) {
  if (!ownership?.token) throw new TypeError("valid execution ownership is required");
  return { ...environment, [PROCESS_OWNERSHIP_ENV]: ownership.token };
}

/** Identity is deliberately stricter than a PID: all immutable observations and ownership must agree. */
export function sameProcessIdentity(expected, observed, token) {
  return Boolean(expected && observed
    && typeof token === "string" && token.length > 0
    && Number.isInteger(expected.pid) && expected.pid > 0
    && expected.pid === observed.pid
    && Number.isInteger(expected.ppid) && expected.ppid >= 0
    && Number.isInteger(observed.ppid) && observed.ppid >= 0
    && expected.ppid === observed.ppid
    && typeof expected.startTime === "string" && expected.startTime.trim().length > 0
    && typeof observed.startTime === "string" && observed.startTime.trim().length > 0
    && expected.startTime === observed.startTime
    && expected.ownershipToken === token
    && observed.ownershipToken === token);
}

async function linuxOwnerUid(pid, procRoot, readFileImpl) {
  let status;
  try { status = await readFileImpl(`${procRoot}/${pid}/status`, "utf8"); }
  catch (error) {
    // Permission to inspect an arbitrary process is not evidence that it could
    // belong to this daemon. Disappearance and protected foreign entries are
    // both excluded until positive same-user evidence is available.
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
  const match = String(status).match(/^Uid:\s+(\d+)(?:\s+\d+){3}\s*$/m);
  if (!match) throw new Error(`Malformed process ownership for PID ${pid}`);
  return Number(match[1]);
}

async function linuxIdentity(pid, token, procRoot, readFileImpl) {
  let environment;
  let stat;
  try {
    [environment, stat] = await Promise.all([
      readFileImpl(`${procRoot}/${pid}/environ`),
      readFileImpl(`${procRoot}/${pid}/stat`, "utf8")
    ]);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  const owned = environment.toString().split("\0").includes(`${PROCESS_OWNERSHIP_ENV}=${token}`);
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !startTime) throw new Error(`Malformed process identity for PID ${pid}`);
  return { pid, ppid, startTime, ownershipToken: owned ? token : null };
}

/**
 * The built-in adapter is intentionally supported only where environment and
 * kernel start identity can be read without interpreting process names/argv.
 */
export function createPlatformAdapter({
  platform = process.platform,
  procRoot = "/proc",
  readDirectory = readdir,
  readFileImpl = readFile,
  kill = process.kill.bind(process),
  currentUid = typeof process.getuid === "function" ? process.getuid() : null
} = {}) {
  if (platform !== "linux") {
    return Object.freeze({
      platform,
      supported: false,
      reason: `Safe process identity discovery is not available on ${platform}`
    });
  }
  if (!Number.isInteger(currentUid) || currentUid < 0) {
    return Object.freeze({
      platform,
      supported: false,
      reason: "Safe process discovery requires the daemon user identity"
    });
  }
  return Object.freeze({
    platform,
    supported: true,
    async discover(token) {
      const entries = await readDirectory(procRoot);
      const processes = [];
      const unresolved = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        // Token-bearing children inherit the daemon's real UID. Establish that
        // relationship before treating an unreadable environment as relevant;
        // protected processes owned by other users are not cleanup uncertainty.
        const ownerUid = await linuxOwnerUid(pid, procRoot, readFileImpl);
        if (ownerUid !== currentUid) continue;
        let identity;
        try { identity = await linuxIdentity(pid, token, procRoot, readFileImpl); }
        catch (error) {
          if (["EACCES", "EPERM"].includes(error.code)) {
            unresolved.push({ pid, reason: "discovery-observation-failed", error: message(error) });
            continue;
          }
          throw error;
        }
        if (identity?.ownershipToken === token) processes.push(identity);
      }
      return { processes, unresolved };
    },
    observe(pid, token) { return linuxIdentity(pid, token, procRoot, readFileImpl); },
    async signal(pid, signal) { kill(pid, signal); }
  });
}

function normalizeDiscovery(value) {
  if (Array.isArray(value)) return { processes: value, diagnostics: [], unresolved: [] };
  return {
    processes: value?.processes || [],
    diagnostics: value?.diagnostics || [],
    unresolved: value?.unresolved || []
  };
}

function triggerEntry(trigger, at) {
  if (typeof trigger === "string") return { trigger, at };
  return { ...(trigger || { trigger: "unspecified" }), at };
}

/**
 * One instance belongs to one execution. cleanup() is idempotent: all callers
 * share the same promise, while later lifecycle triggers remain in the record.
 */
export class ProcessContainment {
  constructor({
    executionId,
    ownership = createExecutionOwnership(executionId),
    adapter = createPlatformAdapter(),
    graceMs = 2_000,
    forceWaitMs = 1_000,
    timeoutMs = 5_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    if (!ownership?.token) throw new TypeError("valid execution ownership is required");
    this.executionId = executionId || ownership.executionId;
    this.ownership = ownership;
    this.adapter = adapter;
    this.graceMs = Math.max(0, graceMs);
    this.forceWaitMs = Math.max(0, forceWaitMs);
    this.timeoutMs = Math.max(1, timeoutMs);
    this.now = now;
    this.sleep = sleep;
    this.promise = null;
    this.record = null;
    this.deadlineAt = null;
  }

  environment(environment = {}) { return environmentForOwnership(this.ownership, environment); }

  cleanup(trigger = "unspecified") {
    const at = iso(this.now());
    if (this.record) this.record.triggers.push(triggerEntry(trigger, at));
    else {
      this.record = {
        executionId: this.executionId,
        outcome: "running",
        platform: { name: this.adapter.platform || "unknown", supported: Boolean(this.adapter.supported) },
        startedAt: at,
        completedAt: null,
        triggers: [triggerEntry(trigger, at)],
        discovered: [],
        actions: [],
        unresolved: [],
        diagnostics: []
      };
    }
    if (!this.promise) this.promise = this.#run();
    return this.promise;
  }

  async #bounded(operation, label) {
    const remaining = this.deadlineAt - this.now();
    if (remaining <= 0) throw new Error(`Cleanup deadline exceeded before ${label}`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cleanup deadline exceeded during ${label}`)), remaining);
    });
    try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
    finally { clearTimeout(timer); }
  }

  #unresolved(identity, reason, error) {
    this.record.unresolved.push({
      ...(identity?.pid ? { pid: identity.pid, identity: { ppid: identity.ppid, startTime: identity.startTime } } : {}),
      reason,
      ...(error ? { error: message(error) } : {})
    });
  }

  async #observe(identity, phase) {
    let observed;
    try { observed = await this.#bounded(() => this.adapter.observe(identity.pid, this.ownership.token), `${phase} observation`); }
    catch (error) { this.#unresolved(identity, `${phase}-observation-failed`, error); return { safe: false }; }
    if (!observed) return { safe: false, gone: true };
    if (!sameProcessIdentity(identity, observed, this.ownership.token)) {
      this.#unresolved(identity, `${phase}-identity-mismatch`);
      return { safe: false };
    }
    return { safe: true, observed };
  }

  async #send(identity, signal, phase) {
    const checked = await this.#observe(identity, phase);
    if (!checked.safe) return checked;
    const action = { pid: identity.pid, signal, at: iso(this.now()), status: "sent" };
    this.record.actions.push(action);
    try { await this.#bounded(() => this.adapter.signal(identity.pid, signal), `${phase} signal`); }
    catch (error) {
      if (error?.code === "ESRCH") { action.status = "already-exited"; return { safe: false, gone: true }; }
      action.status = "failed";
      action.error = message(error);
      this.#unresolved(identity, `${phase}-signal-failed`, error);
      return { safe: false };
    }
    return { safe: true };
  }

  async #run() {
    this.deadlineAt = this.now() + this.timeoutMs;
    if (!this.adapter.supported) {
      this.record.outcome = "unsupported";
      this.record.platform.reason = this.adapter.reason || "Platform adapter cannot safely identify owned processes";
      return this.#finish();
    }

    let discovery;
    try { discovery = normalizeDiscovery(await this.#bounded(() => this.adapter.discover(this.ownership.token), "process discovery")); }
    catch (error) {
      this.#unresolved(null, "discovery-failed", error);
      this.record.diagnostics.push(`Process discovery failed: ${message(error)}`);
      this.record.outcome = "incomplete";
      return this.#finish();
    }
    this.record.diagnostics.push(...discovery.diagnostics.map(String));
    for (const unresolved of discovery.unresolved) {
      this.record.unresolved.push({
        ...(Number.isInteger(unresolved?.pid) && unresolved.pid > 0 ? { pid: unresolved.pid } : {}),
        reason: unresolved?.reason || "discovery-observation-failed",
        ...(unresolved?.error ? { error: String(unresolved.error) } : {})
      });
    }
    if (discovery.unresolved.length) {
      this.record.diagnostics.push(`Process discovery could not inspect ${discovery.unresolved.length} process(es)`);
    }
    // Copy adapter values once: the evidence used for later PID-reuse checks
    // must not be mutable while the graceful wait is in progress.
    const targets = discovery.processes.map(({ pid, ppid, startTime, ownershipToken }) => Object.freeze({
      pid, ppid, startTime, ownershipToken
    }));
    this.record.discovered = targets.map(({ pid, ppid, startTime }) => ({ pid, ppid, startTime }));
    if (!targets.length) {
      this.record.outcome = this.record.unresolved.length ? "incomplete" : "not-required";
      return this.#finish();
    }

    const awaiting = [];
    for (const identity of targets) {
      const sent = await this.#send(identity, gracefulSignal, "graceful");
      if (sent.safe) awaiting.push(identity);
    }
    if (awaiting.length && this.graceMs) {
      try { await this.#bounded(() => this.sleep(Math.min(this.graceMs, this.timeoutMs)), "grace period"); }
      catch (error) {
        for (const identity of awaiting) this.#unresolved(identity, "grace-wait-failed", error);
        this.record.outcome = "incomplete";
        return this.#finish();
      }
    }

    const forced = [];
    for (const identity of awaiting) {
      const sent = await this.#send(identity, forceSignal, "force");
      if (sent.safe) forced.push(identity);
    }
    if (forced.length && this.forceWaitMs) {
      try { await this.#bounded(() => this.sleep(Math.min(this.forceWaitMs, this.timeoutMs)), "force period"); }
      catch (error) {
        for (const identity of forced) this.#unresolved(identity, "force-wait-failed", error);
        this.record.outcome = "incomplete";
        return this.#finish();
      }
    }
    for (const identity of forced) {
      const final = await this.#observe(identity, "final");
      if (final.safe) this.#unresolved(identity, "still-running-after-force");
    }

    this.record.outcome = this.record.unresolved.length ? "incomplete" : "complete";
    return this.#finish();
  }

  #finish() {
    this.record.completedAt = iso(this.now());
    return this.record;
  }
}

export function createProcessContainment(options) { return new ProcessContainment(options); }
