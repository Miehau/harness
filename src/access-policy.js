import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

const extraRootModes = new Set(["read-only", "read/write"]);

export function defaultAccessPolicy() {
  return { mode: "restricted", extraRoots: [] };
}

function quote(value) {
  return `“${value}”`;
}

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function malformedPath(value) {
  return typeof value !== "string" || !value.trim() || value.includes("\0");
}

function assertPolicyObject(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`Access policy must be an object with optional mode and extraRoots, not ${describeValue(input)}`);
  }
}

function assertPolicyFields(raw) {
  if (Object.hasOwn(raw, "mode")) {
    if (typeof raw.mode !== "string") {
      throw new Error(`Access mode must be restricted or any, not ${describeValue(raw.mode)}`);
    }
    if (raw.mode !== "restricted" && raw.mode !== "any") {
      throw new Error(`Unknown access mode ${quote(raw.mode)}. Use restricted or any.`);
    }
  }
  if (Object.hasOwn(raw, "extraRoots") && !Array.isArray(raw.extraRoots)) {
    throw new Error(`extraRoots must be an array of { path, mode } entries, not ${describeValue(raw.extraRoots)}`);
  }
}

async function realDirectory(target, label, display = target) {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} ${quote(display)} does not exist`);
    throw new Error(`${label} ${quote(display)} is not accessible (${error.message})`);
  }
  if (!info.isDirectory()) throw new Error(`${label} ${quote(display)} is not a directory`);
  try {
    return await realpath(target);
  } catch (error) {
    throw new Error(`${label} ${quote(display)} is not accessible (${error.message})`);
  }
}

export async function canonicalPrimaryPath(primaryCwd) {
  if (malformedPath(primaryCwd)) throw new Error("Primary repository path is missing or malformed");
  const trimmed = primaryCwd.trim();
  if (!isAbsolute(trimmed)) throw new Error(`Primary repository path must be absolute: ${trimmed}`);
  return realDirectory(resolve(trimmed), "Primary repository");
}

function pathSegmentOverlap(left, right) {
  if (left === right) return false;
  const leftPrefix = left.endsWith(sep) ? left : `${left}${sep}`;
  const rightPrefix = right.endsWith(sep) ? right : `${right}${sep}`;
  return right.startsWith(leftPrefix) || left.startsWith(rightPrefix);
}

function extraRootEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Extra root at index ${index} must be an object with path and mode`);
  }
  const displayPath = typeof entry.displayPath === "string" && entry.displayPath.trim()
    ? entry.displayPath
    : (typeof entry.path === "string" ? entry.path : "");
  if (malformedPath(entry.path)) throw new Error(`Malformed extra root path ${quote(displayPath || entry.path)}`);
  if (!Object.hasOwn(entry, "mode") || entry.mode == null || entry.mode === "") {
    throw new Error(`Missing extra root mode for ${quote(displayPath || entry.path)}. Use read-only or read/write.`);
  }
  if (typeof entry.mode !== "string" || !extraRootModes.has(entry.mode)) {
    throw new Error(`Unknown extra root mode ${quote(entry.mode)} for ${quote(displayPath || entry.path)}. Use read-only or read/write.`);
  }
  return { path: entry.path.trim(), mode: entry.mode, displayPath: displayPath || entry.path.trim() };
}

export async function normalizeProjectPolicy(input = {}, { primaryCwd } = {}) {
  assertPolicyObject(input);
  assertPolicyFields(input);
  const primary = await canonicalPrimaryPath(primaryCwd);
  const extraRoots = [];
  const byPath = new Map();
  for (const [index, rawEntry] of (input.extraRoots || []).entries()) {
    const entry = extraRootEntry(rawEntry, index);
    const absolute = isAbsolute(entry.path) ? resolve(entry.path) : resolve(primary, entry.path);
    const canonical = await realDirectory(absolute, "Extra root", entry.displayPath);
    if (canonical === primary) {
      throw new Error(`Primary repository ${quote(entry.displayPath)} is implied and cannot be stored as an extra root`);
    }
    if (pathSegmentOverlap(primary, canonical)) {
      throw new Error(`Extra root ${quote(entry.displayPath)} overlaps the primary repository ${quote(primary)}`);
    }
    const existing = byPath.get(canonical);
    if (existing) {
      if (existing.mode !== entry.mode) {
        throw new Error(`Extra roots ${quote(existing.displayPath)} and ${quote(entry.displayPath)} resolve to the same path but use different modes (${existing.mode} vs ${entry.mode})`);
      }
      continue;
    }
    const root = { path: canonical, mode: entry.mode, displayPath: entry.displayPath };
    byPath.set(canonical, root);
    extraRoots.push(root);
  }
  for (let left = 0; left < extraRoots.length; left++) {
    for (let right = left + 1; right < extraRoots.length; right++) {
      if (!pathSegmentOverlap(extraRoots[left].path, extraRoots[right].path)) continue;
      throw new Error(`Extra roots ${quote(extraRoots[left].displayPath)} and ${quote(extraRoots[right].displayPath)} overlap (ancestor/descendant)`);
    }
  }
  return { mode: input.mode === "any" ? "any" : "restricted", extraRoots };
}

export function storedProjectPolicy(state, canonicalPrimary) {
  const stored = state?.projectPolicies?.[canonicalPrimary];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaultAccessPolicy();
  return {
    mode: stored.mode === "any" ? "any" : "restricted",
    extraRoots: Array.isArray(stored.extraRoots)
      ? stored.extraRoots.map((root) => ({ path: root.path, mode: root.mode, displayPath: root.displayPath }))
      : []
  };
}

export async function readProjectPolicy(state, primaryCwd) {
  return storedProjectPolicy(state, await canonicalPrimaryPath(primaryCwd));
}

export function writeProjectPolicy(state, canonicalPrimary, policy) {
  if (!state.projectPolicies || typeof state.projectPolicies !== "object" || Array.isArray(state.projectPolicies)) {
    state.projectPolicies = {};
  }
  state.projectPolicies[canonicalPrimary] = {
    mode: policy.mode === "any" ? "any" : "restricted",
    extraRoots: (policy.extraRoots || []).map((root) => ({
      path: root.path,
      mode: root.mode,
      displayPath: root.displayPath
    }))
  };
}
