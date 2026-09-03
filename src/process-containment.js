import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";

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

/** Identity is deliberately stricter than a PID: start evidence and ownership must agree. */
export function sameProcessIdentity(expected, observed, token) {
  return Boolean(expected && observed
    && typeof token === "string" && token.length > 0
    && Number.isInteger(expected.pid) && expected.pid > 0
    && expected.pid === observed.pid
    && Number.isInteger(expected.ppid) && expected.ppid >= 0
    && Number.isInteger(observed.ppid) && observed.ppid >= 0
    // PPID is durable audit evidence but is not stable identity evidence: a
    // child can be adopted by any configured subreaper, not just PID 1. PID,
    // kernel start time, and the inherited ownership token still prove the
    // target is the same owned process without trusting a mutable parent link.
    && typeof expected.startTime === "string" && expected.startTime.trim().length > 0
    && typeof observed.startTime === "string" && observed.startTime.trim().length > 0
    && expected.startTime === observed.startTime
    && expected.ownershipToken === token
    && observed.ownershipToken === token);
}

async function linuxOwnerUid(pid, procRoot, readFileImpl, directoryStat) {
  // /proc/PID directory ownership is kernel-provided ownership evidence. Use
  // it as a prefilter on the live adapter so inaccessible foreign processes do
  // not turn an otherwise empty owned cleanup into an unresolved result.
  if (directoryStat) {
    try {
      const metadata = await directoryStat(`${procRoot}/${pid}`);
      if (Number.isInteger(metadata?.uid) && metadata.uid >= 0) return { uid: metadata.uid };
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
      throw error;
    }
  }
  let status;
  try { status = await readFileImpl(`${procRoot}/${pid}/status`, "utf8"); }
  catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    // Same UID is only a cheap prefilter, not ownership evidence. If /proc
    // denies the token read, this process cannot be attributed and must not
    // turn an otherwise empty owned cleanup into an unrelated warning.
    if (["EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
  const match = String(status).match(/^Uid:\s+(\d+)(?:\s+\d+){3}\s*$/m);
  if (!match) throw new Error(`Malformed process ownership for PID ${pid}`);
  return { uid: Number(match[1]) };
}

async function linuxIdentity(pid, token, procRoot, readFileImpl) {
  let environment;
  try { environment = await readFileImpl(`${procRoot}/${pid}/environ`); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  // Most same-UID processes are unrelated. Read their inexpensive ownership
  // capability first, reserving stat parsing for a positively token-owned
  // target. This keeps each repeated quiescence snapshot bounded in busy CI
  // environments without treating a missing token as attribution evidence.
  const owned = environment.toString().split("\0").includes(`${PROCESS_OWNERSHIP_ENV}=${token}`);
  if (!owned) return null;
  let stat;
  try { stat = await readFileImpl(`${procRoot}/${pid}/stat`, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  // A zombie has already exited and cannot receive a signal. Treat it exactly
  // as an entry that vanished between discovery and observation, rather than
  // retaining stale /proc evidence as a live unresolved target.
  if (fields[0] === "Z") return null;
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
  statImpl = null,
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
  // Keep injected /proc fixtures self-contained: production's real /proc gets
  // the inexpensive directory-owner prefilter, while fixture adapters retain
  // their explicit status-file behavior unless they opt in with statImpl.
  const directoryStat = statImpl || (procRoot === "/proc" ? stat : null);
  return Object.freeze({
    platform,
    supported: true,
    async discover(token) {
      const entries = await readDirectory(procRoot);
      // Discovery is repeated around each termination phase. Inspecting /proc
      // serially can consume the whole cleanup deadline on a busy CI host,
      // leaving an otherwise live, owned fixture unsignaled. Each entry remains
      // independently attributed by UID, token, and start time; concurrency
      // only bounds observation time and does not broaden attribution.
      const inspected = await Promise.all(entries.map(async (entry) => {
        if (!/^\d+$/.test(entry)) return null;
        const pid = Number(entry);
        // Token-bearing children inherit the daemon's real UID. A same-UID
        // process still is not attributable until its token is readable.
        const owner = await linuxOwnerUid(pid, procRoot, readFileImpl, directoryStat);
        if (owner?.uid !== currentUid) return null;
        try {
          const identity = await linuxIdentity(pid, token, procRoot, readFileImpl);
          return identity?.ownershipToken === token ? { process: identity } : null;
        } catch (error) {
          // An unreadable environment cannot prove this same-UID process owns
          // the token. Do not report arbitrary host processes as unresolved.
          if (["EACCES", "EPERM"].includes(error.code)) return null;
          throw error;
        }
      }));
      const processes = [];
      const unresolved = [];
      for (const item of inspected) {
        if (item?.process) processes.push(item.process);
        if (item?.unresolved) unresolved.push(item.unresolved);
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
  return { ...(trigger || { trigger: "unspecified" }), at: trigger?.at ?? at };
}

/**
 * One instance belongs to one execution. cleanup() is idempotent for each set
 * of controlled launches: all callers share its promise, while a command begun
 * after that promise settles opens one later, serialized containment cycle.
 */
export class ProcessContainment {
  constructor({
    executionId,
    ownership = createExecutionOwnership(executionId),
    adapter = createPlatformAdapter(),
    graceMs = 2_000,
    forceWaitMs = 1_000,
    timeoutMs = 5_000,
    maxCycles = 2,
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
    this.maxCycles = Number.isFinite(maxCycles) ? Math.max(1, Math.floor(maxCycles)) : 2;
    this.now = now;
    this.sleep = sleep;
    this.promise = null;
    this.record = null;
    this.launches = 0;
    this.cleanedLaunches = 0;
    this.scheduledLaunches = null;
  }

  environment(environment = {}) { return environmentForOwnership(this.ownership, environment); }

  /** Mark a controlled command before it can inherit this execution's token. */
  beginLaunch() {
    this.launches++;
    return this.launches;
  }

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
    // A settled cleanup cannot cover a command launched afterwards. Chain any
    // later cycle behind the current promise: concurrent lifecycle callers
    // still share one signaling sequence, and each queued cycle gets its own
    // deadline instead of mutating the active cycle's deadline.
    if (!this.promise) {
      this.scheduledLaunches = this.launches;
      this.promise = this.#run(this.scheduledLaunches);
    } else if (this.scheduledLaunches < this.launches) {
      const launches = this.launches;
      this.scheduledLaunches = launches;
      this.promise = this.promise.then(
        () => this.#run(launches),
        () => this.#run(launches)
      );
    }
    return this.promise;
  }

  async #bounded(operation, label, deadlineAt) {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new Error(`Cleanup deadline exceeded before ${label}`);
    let timer;
    let doReject;
    const timeout = new Promise((_, reject) => {
      doReject = reject;
      timer = setTimeout(() => reject(new Error(`Cleanup deadline exceeded during ${label}`)), remaining);
    });
    timeout.catch(() => {});
    try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
    finally { clearTimeout(timer); if (doReject) doReject(new Error("cleared")); }
  }

  #unresolved(identity, reason, error) {
    const hasCompleteIdentity = Number.isInteger(identity?.pid) && identity.pid > 0
      && Number.isInteger(identity.ppid) && identity.ppid >= 0
      && typeof identity.startTime === "string" && identity.startTime.trim().length > 0;
    this.record.unresolved.push({
      ...(identity?.pid ? { pid: identity.pid } : {}),
      ...(hasCompleteIdentity ? { identity: { ppid: identity.ppid, startTime: identity.startTime } } : {}),
      reason,
      ...(error ? { error: message(error) } : {})
    });
  }

  async #observe(identity, phase, deadlineAt) {
    let observed;
    try { observed = await this.#bounded(() => this.adapter.observe(identity.pid, this.ownership.token), `${phase} observation`, deadlineAt); }
    catch (error) { this.#unresolved(identity, `${phase}-observation-failed`, error); return { safe: false }; }
    if (!observed) return { safe: false, gone: true };
    if (!sameProcessIdentity(identity, observed, this.ownership.token)) {
      this.#unresolved(identity, `${phase}-identity-mismatch`);
      return { safe: false };
    }
    return { safe: true, observed };
  }

  async #send(identity, signal, phase, deadlineAt) {
    const checked = await this.#observe(identity, phase, deadlineAt);
    if (!checked.safe) return checked;
    const action = { pid: identity.pid, signal, at: iso(this.now()), status: "sent" };
    this.record.actions.push(action);
    try { await this.#bounded(() => this.adapter.signal(identity.pid, signal), `${phase} signal`, deadlineAt); }
    catch (error) {
      if (error?.code === "ESRCH") { action.status = "already-exited"; return { safe: false, gone: true }; }
      action.status = "failed";
      action.error = message(error);
      this.#unresolved(identity, `${phase}-signal-failed`, error);
      return { safe: false };
    }
    return { safe: true };
  }

  async #run(launches) {
    const deadlineAt = this.now() + this.timeoutMs;
    this.record.outcome = "running";
    this.record.completedAt = null;
    if (!this.adapter.supported) {
      this.record.outcome = "unsupported";
      this.record.platform.reason = this.adapter.reason || "Platform adapter cannot safely identify owned processes";
      return this.#finish(launches);
    }

    const discovery = async (phase) => {
      let found;
      try { found = normalizeDiscovery(await this.#bounded(() => this.adapter.discover(this.ownership.token), `${phase} process discovery`, deadlineAt)); }
      catch (error) {
        this.#unresolved(null, phase === "initial" ? "discovery-failed" : `${phase}-discovery-failed`, error);
        this.record.diagnostics.push(`${phase === "initial" ? "Process" : phase} discovery failed: ${message(error)}`);
        return null;
      }
      this.record.diagnostics.push(...found.diagnostics.map(String));
      for (const unresolved of found.unresolved) this.#unresolved(
        Number.isInteger(unresolved?.pid) && unresolved.pid > 0 ? { pid: unresolved.pid } : null,
        unresolved?.reason || "discovery-observation-failed",
        unresolved?.error
      );
      if (found.unresolved.length) this.record.diagnostics.push(`Process discovery could not inspect ${found.unresolved.length} process(es)`);
      return found.processes.map(({ pid, ppid, startTime, ownershipToken }) => Object.freeze({ pid, ppid, startTime, ownershipToken }));
    };
    const keyFor = (identity) => `${identity?.pid}:${identity?.ppid}:${identity?.startTime}`;
    const terminate = async (targets) => {
      const awaiting = [];
      for (const identity of targets) {
        const sent = await this.#send(identity, gracefulSignal, "graceful", deadlineAt);
        if (sent.safe) awaiting.push(identity);
      }
      if (awaiting.length && this.graceMs) {
        try { await this.#bounded(() => this.sleep(Math.min(this.graceMs, this.timeoutMs)), "grace period", deadlineAt); }
        catch (error) {
          for (const identity of awaiting) this.#unresolved(identity, "grace-wait-failed", error);
          return null;
        }
      }
      // Revalidate and escalate the original identities before doing another
      // full /proc scan. A scan may be slow on a busy host, but it must never
      // consume the interval between graceful termination and the bounded
      // force escalation of a still-owned process.
      const forced = [];
      for (const identity of awaiting) {
        const sent = await this.#send(identity, forceSignal, "force", deadlineAt);
        if (sent.safe) forced.push(identity);
      }
      // Even when a graceful target exits before force, reserve the same short
      // bounded observation window for a SIGTERM handler that is still forking
      // a token-inheriting descendant. The post-force snapshot then gives that
      // new identity its own cleanup cycle without delaying no-target cleanup.
      if (awaiting.length && this.forceWaitMs) {
        try { await this.#bounded(() => this.sleep(Math.min(this.forceWaitMs, this.timeoutMs)), "force period", deadlineAt); }
        catch (error) {
          for (const identity of awaiting) this.#unresolved(identity, "force-wait-failed", error);
          return null;
        }
      }
      for (const identity of forced) {
        const final = await this.#observe(identity, "final", deadlineAt);
        if (final.safe) this.#unresolved(identity, "still-running-after-force");
      }
      // This quiescence snapshot covers descendants created by graceful
      // handlers as well as processes that appeared during force escalation.
      const afterForce = await discovery("post-force");
      if (!afterForce) return null;
      return afterForce;
    };
    let pending = await discovery("initial");
    if (!pending) {
      this.record.outcome = "incomplete";
      return this.#finish(launches);
    }
    const remembered = new Set(this.record.discovered.map(({ pid, ppid, startTime }) => `${pid}:${ppid}:${startTime}`));
    const remember = ({ pid, ppid, startTime }) => {
      const key = `${pid}:${ppid}:${startTime}`;
      if (!remembered.has(key)) {
        remembered.add(key);
        this.record.discovered.push({ pid, ppid, startTime });
      }
    };
    for (const identity of pending) remember(identity);
    if (!pending.length) {
      this.record.outcome = this.record.unresolved.length ? "incomplete" : "not-required";
      return this.#finish(launches);
    }

    // A SIGTERM handler can fork an inheriting child after any snapshot. Each
    // newly observed identity therefore receives a full graceful/force cycle;
    // completion requires a post-force snapshot with no unhandled identities.
    const handled = new Set(pending.map(keyFor));
    let quiescent = false;
    while (pending.length) {
      const observed = await terminate(pending);
      if (!observed) break;
      // The post-graceful and post-force snapshots can contain the same new
      // identity. Collapse both immutable keys before scheduling so one cleanup
      // cycle can never issue duplicate graceful or force signals.
      const newlyObserved = new Map();
      for (const identity of observed) {
        const key = keyFor(identity);
        if (!handled.has(key)) newlyObserved.set(key, identity);
      }
      pending = [...newlyObserved.values()];
      for (const identity of pending) {
        handled.add(keyFor(identity));
        remember(identity);
      }
      if (!pending.length) quiescent = true;
    }
    if (!quiescent && !this.record.unresolved.length) {
      this.#unresolved(null, "quiescence-not-observed-before-deadline");
      this.record.diagnostics.push("Process cleanup ended without a bounded quiescent discovery");
    }

    // Discovery can catch a process while it is exiting. When every candidate
    // vanishes before a signal is sent, cleanup did no work and must retain the
    // same fast, successful outcome as an initially empty discovery.
    this.record.outcome = this.record.unresolved.length ? "incomplete" : this.record.actions.length ? "complete" : "not-required";
    return this.#finish(launches);

  }

  #finish(launches) {
    this.cleanedLaunches = Math.max(this.cleanedLaunches, launches);
    this.record.completedAt = iso(this.now());
    return this.record;
  }
}

export function createProcessContainment(options) { return new ProcessContainment(options); }
