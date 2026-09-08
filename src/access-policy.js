import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const extraRootModes = new Set(["read-only", "read/write"]);
export const PRIMARY_ROOT_ID = "primary";

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

function pathContained(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

function extraRootId(canonicalPath) {
  return `r-${createHash("sha256").update(String(canonicalPath || "")).digest("hex").slice(0, 8)}`;
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

function cloneRoot(root, fallbackId, fallbackMode) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const path = typeof root.path === "string" ? root.path : "";
  const mode = root.mode === "read/write" || root.mode === "read-only"
    ? root.mode
    : (fallbackMode === "read/write" ? "read/write" : "read-only");
  return {
    id: typeof root.id === "string" && root.id ? root.id : fallbackId,
    path,
    displayPath: typeof root.displayPath === "string" && root.displayPath ? root.displayPath : path,
    mode
  };
}

export function defaultRunAccess({ workspace = null, createdAt = null } = {}) {
  const cwd = workspace?.cwd || null;
  return {
    mode: "restricted",
    primary: cwd ? {
      id: PRIMARY_ROOT_ID,
      path: cwd,
      displayPath: workspace.displayPath || cwd,
      mode: "read/write"
    } : null,
    extraRoots: [],
    frozenAt: createdAt || null
  };
}

export function cloneRunAccess(access, { workspace = null, createdAt = null } = {}) {
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    return defaultRunAccess({ workspace, createdAt });
  }
  return {
    mode: access.mode === "any" ? "any" : "restricted",
    primary: cloneRoot(access.primary, PRIMARY_ROOT_ID, "read/write"),
    extraRoots: Array.isArray(access.extraRoots)
      ? access.extraRoots.map((root) => cloneRoot(root, extraRootId(root?.path || ""), "read-only")).filter(Boolean)
      : [],
    frozenAt: access.frozenAt || createdAt || null
  };
}

// Run access is frozen at ticket-run creation. Later projectPolicies or workspace
// edits must not enlarge that snapshot; revocation is cancel/restart.
//
// File tools enforce this freeze with realpath + path-segment allow-list.
// Named project commands are not a filesystem sandbox: runProjectCommand only
// constrains argv and environment, and subprocesses can still touch arbitrary
// host paths. Do not describe argv/env checks as OS isolation.
export async function freezeRunAccess({ primaryCwd, policy, frozenAt = new Date().toISOString() } = {}) {
  const primaryPath = await canonicalPrimaryPath(primaryCwd);
  const normalized = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : defaultAccessPolicy();
  return cloneRunAccess({
    mode: normalized.mode === "any" ? "any" : "restricted",
    primary: {
      id: PRIMARY_ROOT_ID,
      path: primaryPath,
      displayPath: typeof primaryCwd === "string" && primaryCwd.trim() ? primaryCwd.trim() : primaryPath,
      mode: "read/write"
    },
    extraRoots: Array.isArray(normalized.extraRoots) ? normalized.extraRoots.map((root) => ({
      id: extraRootId(root.path),
      path: root.path,
      mode: root.mode === "read/write" ? "read/write" : "read-only",
      displayPath: root.displayPath || root.path
    })) : [],
    frozenAt
  });
}

export function frozenRoots(access) {
  const roots = [];
  if (access?.primary?.path) {
    roots.push({
      id: access.primary.id || PRIMARY_ROOT_ID,
      path: access.primary.path,
      displayPath: access.primary.displayPath || access.primary.path,
      mode: "read/write",
      kind: "primary"
    });
  }
  for (const root of access?.extraRoots || []) {
    roots.push({
      id: root.id || extraRootId(root.path || ""),
      path: root.path,
      displayPath: root.displayPath || root.path,
      mode: root.mode === "read/write" ? "read/write" : "read-only",
      kind: "extra"
    });
  }
  return roots;
}

function findContainingRoot(access, candidate) {
  if (!candidate) return null;
  for (const root of frozenRoots(access)) {
    if (candidate === root.path || pathContained(candidate, root.path)) return root;
  }
  return null;
}

export async function applyFrozenAccess(access) {
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    throw new Error("Frozen run access is missing");
  }
  if (!access.primary?.path) throw new Error("Frozen run access is missing the primary repository");
  for (const root of frozenRoots(access)) {
    const label = root.kind === "primary" ? "Primary repository" : "Extra root";
    const display = root.displayPath || root.path;
    const canonical = await realDirectory(root.path, label, display);
    if (canonical !== root.path) {
      throw new Error(`${label} ${quote(display)} no longer matches the frozen path`);
    }
  }
  return access;
}

async function existingAncestor(absolute) {
  let existing = absolute;
  while (true) {
    try {
      await lstat(existing);
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

async function canonicalizeScopePath(absolute) {
  const ancestor = await existingAncestor(absolute);
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) {
    return ancestor === absolute ? ancestor : resolve(ancestor, relative(ancestor, absolute));
  }
  const realExisting = await realpath(ancestor);
  return ancestor === absolute ? realExisting : resolve(realExisting, relative(ancestor, absolute));
}

function posixRelative(from, to) {
  const value = relative(from, to).split(sep).join("/");
  if (isAbsolute(value) || value === ".." || value.startsWith("../")) return null;
  return value;
}

export async function resolveAccessPath(access, inputPath, { cwd, intent = "read" } = {}) {
  await applyFrozenAccess(access);
  const raw = String(inputPath || "").replace(/^@/, "");
  if (malformedPath(raw)) throw new Error("Path is missing or malformed");
  const base = cwd || access.primary?.path;
  if (!isAbsolute(raw) && (typeof base !== "string" || !base)) throw new Error("Path must be absolute when no workspace root is available");
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const writing = intent !== "read";
  const ancestor = writing ? await existingAncestor(absolute) : absolute;
  let realExisting;
  try {
    realExisting = await realpath(ancestor);
  } catch (error) {
    let isLink = false;
    try { isLink = (await lstat(ancestor)).isSymbolicLink(); } catch {}
    if (isLink) throw new Error(`Path ${quote(raw)} is outside the frozen directory allow-list`);
    throw error;
  }
  const intendedReal = writing && ancestor !== absolute
    ? resolve(realExisting, relative(ancestor, absolute))
    : realExisting;
  const root = findContainingRoot(access, realExisting);
  if (access.mode !== "any" && !root) {
    throw new Error(`Path ${quote(raw)} is outside the frozen directory allow-list`);
  }
  if (root) {
    const escaped = relative(root.path, realExisting);
    if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith(`..${sep}`)) {
      throw new Error(`Path ${quote(raw)} is outside the frozen directory allow-list`);
    }
  }
  if (writing && root?.mode === "read-only") {
    throw new Error(`Write blocked in read-only extra root ${quote(root.displayPath || root.path)}: ${raw}`);
  }
  const relativePath = root ? posixRelative(root.path, intendedReal) ?? posixRelative(root.path, absolute) : null;
  return { absolute, realPath: intendedReal, root, relativePath, intent };
}

function stripScopePath(value) {
  return String(value || "").trim().replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/^\.\//, "");
}

export function parseWriteScopeEntry(entry) {
  const trimmed = stripScopePath(entry);
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return { kind: "absolute", path: resolve(trimmed) };
  const qualified = trimmed.match(/^root:([^:]+):(.*)$/);
  if (qualified) {
    const relativePath = stripScopePath(qualified[2]);
    return {
      kind: "root",
      rootId: qualified[1],
      relativePath: relativePath === "*" || relativePath === "**" ? "" : relativePath
    };
  }
  return { kind: "root", rootId: PRIMARY_ROOT_ID, relativePath: trimmed };
}

function relativeInScope(relativePath, prefix) {
  if (relativePath == null) return false;
  if (!prefix) return true;
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

export async function writeScopeAllows(resolved, writeScope) {
  const raw = String(writeScope || "").trim();
  if (raw === "*" || raw === "**") return resolved?.root?.id === PRIMARY_ROOT_ID;
  for (const entry of raw.split(",").map(parseWriteScopeEntry).filter(Boolean)) {
    if (entry.kind === "absolute") {
      const target = resolved?.realPath;
      if (!target) continue;
      let scopeReal;
      try { scopeReal = await canonicalizeScopePath(entry.path); }
      catch { continue; }
      if (target === scopeReal || pathContained(target, scopeReal)) return true;
      continue;
    }
    if (entry.kind === "root" && resolved?.root?.id === entry.rootId && relativeInScope(resolved.relativePath, entry.relativePath)) {
      return true;
    }
  }
  return false;
}
