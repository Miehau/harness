import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { frozenRoots, parseWriteScopeEntry, PRIMARY_ROOT_ID, resolveAccessPath, writeScopeAllows } from "./access-policy.js";

const exec = promisify(execFile);

async function git(cwd, args, options = {}) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trimEnd();
}

export async function isGitRepository(cwd) {
  try {
    return await realpath(await git(cwd, ["rev-parse", "--show-toplevel"])) === await realpath(cwd);
  } catch {
    return false;
  }
}

export async function snapshotTree(cwd) {
  if (!(await isGitRepository(cwd))) return null;
  const directory = await mkdtemp(join(tmpdir(), "agent-plan-index-"));
  const index = join(directory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    try { await git(cwd, ["read-tree", "HEAD"], { env }); }
    catch { await git(cwd, ["read-tree", "--empty"], { env }); }
    await git(cwd, ["add", "-A"], { env });
    return await git(cwd, ["write-tree"], { env });
  } finally {
    await rm(directory, { recursive: true }).catch(() => {});
  }
}

export async function restoreTree(cwd, tree) {
  if (!tree || !(await isGitRepository(cwd))) throw new Error("A recorded Git tree is required to restart code");
  await git(cwd, ["read-tree", "--reset", "-u", tree]);
  await git(cwd, ["clean", "-fd", "-e", ".jj/"]);
  return snapshotTree(cwd);
}

export async function diffTrees(cwd, before, after) {
  if (!before || !after) return { available: false, patch: "", stat: "", files: [] };
  const [patch, stat, names, numstat] = await Promise.all([
    git(cwd, ["diff", "--binary", "--no-color", "--no-ext-diff", "--find-renames", before, after]),
    git(cwd, ["diff", "--stat", before, after]),
    git(cwd, ["diff", "--name-only", before, after]),
    git(cwd, ["diff", "--numstat", "--find-renames", before, after])
  ]);
  const fileStats = numstat.split("\n").filter(Boolean).map((line) => {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const additions = Number(rawAdditions);
    const deletions = Number(rawDeletions);
    return {
      path: pathParts.at(-1) || "",
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: rawAdditions === "-" || rawDeletions === "-"
    };
  });
  return {
    available: true,
    before,
    after,
    patch: patch.slice(0, 600_000),
    truncated: patch.length > 600_000,
    stat,
    files: names.split("\n").filter(Boolean),
    fileStats,
    additions: fileStats.reduce((total, file) => total + file.additions, 0),
    deletions: fileStats.reduce((total, file) => total + file.deletions, 0),
    changedLines: fileStats.reduce((total, file) => total + file.additions + file.deletions, 0)
  };
}

export function diffOutline(patch = "") {
  return String(patch).split(/^diff --git /m).slice(1).map((block, fileIndex) => {
    const full = `diff --git ${block}`;
    const header = full.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const hunks = [...full.matchAll(/^@@[^\n]*$/gm)].map((match, hunk) => ({ hunk, header: match[0] }));
    return {
      fileIndex,
      file: header?.[2] || `Changed file ${fileIndex + 1}`,
      hunks: hunks.length ? hunks : [{ hunk: 0, header: "File metadata or binary change" }]
    };
  });
}

export function normalizeReviewMap(raw, patch) {
  const outline = diffOutline(patch);
  const assigned = new Set();
  const groups = [];
  for (const candidate of Array.isArray(raw?.groups) ? raw.groups : []) {
    const items = [];
    for (const item of Array.isArray(candidate?.items) ? candidate.items : []) {
      if (item.fileIndex === undefined || item.fileIndex === null || item.fileIndex === "") continue;
      const file = outline[Number(item.fileIndex)];
      if (!file) continue;
      const requested = Array.isArray(item.hunks) ? item.hunks : [item.hunk];
      for (const value of requested) {
        const hunk = Number(value);
        if (!Number.isInteger(hunk) || hunk < 0 || hunk >= file.hunks.length) continue;
        const key = `${file.fileIndex}:${hunk}`;
        if (assigned.has(key)) continue;
        assigned.add(key);
        items.push({ file: file.file, fileIndex: file.fileIndex, hunk });
      }
    }
    if (items.length) groups.push({ title: String(candidate.title || "Related changes").slice(0, 80), summary: String(candidate.summary || "").slice(0, 240), items });
  }
  const remaining = outline.flatMap((file) => file.hunks.map(({ hunk }) => ({ file: file.file, fileIndex: file.fileIndex, hunk }))).filter((item) => !assigned.has(`${item.fileIndex}:${item.hunk}`));
  if (remaining.length) groups.push({ title: groups.length ? "Other changes" : "All changes", summary: "Hunks not assigned by the semantic map.", items: remaining });
  return { groups, generatedAt: new Date().toISOString() };
}

function changedRows(patch = "") {
  return String(patch).split(/^diff --git /m).slice(1).flatMap((block, fileIndex) => {
    const full = `diff --git ${block}`;
    const header = full.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = header?.[2] || `Changed file ${fileIndex + 1}`;
    let oldLine = null;
    let newLine = null;
    const rows = [];
    for (const line of full.split("\n").slice(1)) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      } else if (oldLine !== null && line.startsWith("+") && !line.startsWith("+++")) {
        rows.push({ path, side: "RIGHT", line: newLine++, text: line.slice(1) });
      } else if (oldLine !== null && line.startsWith("-") && !line.startsWith("---")) {
        rows.push({ path, side: "LEFT", line: oldLine++, text: line.slice(1) });
      } else if (oldLine !== null && !line.startsWith("\\")) {
        oldLine++;
        newLine++;
      }
    }
    return rows;
  });
}

function noteAnchor(rows) {
  return createHash("sha256").update(rows.map((row) => row.text).join("\n")).digest("hex");
}

function currentReviewNote(candidate, rows, revision) {
  const path = String(candidate?.path || "").replace(/^b\//, "");
  const side = String(candidate?.side || "RIGHT").toUpperCase();
  const startLine = Number(candidate?.startLine);
  const endLine = Number(candidate?.endLine ?? startLine);
  const text = String(candidate?.text || "").trim().slice(0, 500);
  if (!path || !["LEFT", "RIGHT"].includes(side) || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 400 || !text) return null;
  const anchored = rows.filter((row) => row.path === path && row.side === side && row.line >= startLine && row.line <= endLine);
  if (!anchored.length) return null;
  const kind = ["intent", "invariant", "risk", "test"].includes(candidate.kind) ? candidate.kind : "intent";
  const id = /^rn-[a-z0-9_-]{1,64}$/i.test(candidate.id || "")
    ? candidate.id
    : `rn-${createHash("sha256").update(`${path}:${side}:${startLine}:${endLine}:${text}`).digest("hex").slice(0, 10)}`;
  return { id, path, side, startLine, endLine, kind, text, status: "current", revision: revision || null, anchorHash: noteAnchor(anchored), anchorCount: anchored.length };
}

function relocateReviewNote(note, rows, revision) {
  if (note.revision && revision && note.revision === revision) return note;
  const candidates = rows.filter((row) => row.path === note.path && row.side === note.side);
  const count = Number(note.anchorCount || 0);
  const matches = [];
  for (let index = 0; count && index + count <= candidates.length; index++) {
    const slice = candidates.slice(index, index + count);
    if (noteAnchor(slice) === note.anchorHash) matches.push(slice);
  }
  if (matches.length !== 1) return { ...note, status: "stale", revision: revision || null };
  return { ...note, startLine: matches[0][0].line, endLine: matches[0].at(-1).line, status: "current", revision: revision || null };
}

export function normalizeReviewNotes(raw = [], diff = {}, existing = []) {
  const rows = changedRows(diff.patch);
  const revision = diff.after || null;
  const fresh = new Map((Array.isArray(raw) ? raw : []).map((candidate) => currentReviewNote(candidate, rows, revision)).filter(Boolean).map((note) => [note.id, note]));
  const notes = (Array.isArray(existing) ? existing : []).map((note) => fresh.get(note.id) || relocateReviewNote(note, rows, revision));
  const known = new Set(notes.map((note) => note.id));
  for (const note of fresh.values()) if (!known.has(note.id)) notes.push(note);
  return notes.sort((left, right) => Number(right.status === "current") - Number(left.status === "current")).slice(0, 8);
}

export function reviewNoteFeedback(notes = [], requests = [], feedback = "") {
  const requested = new Map((Array.isArray(requests) ? requests : [requests]).map((request) => {
    const id = String(request && typeof request === "object" ? request.id ?? "" : request ?? "").trim();
    return [id, String(request?.feedback || "").trim()];
  }).filter(([id]) => id));
  const selected = [...requested].map(([id, request]) => ({ note: notes.find((note) => note.id === id && note.status === "current"), request })).filter(({ note }) => note);
  const guidance = String(feedback || "").trim();
  if (selected.length !== requested.size) throw new Error("A selected review note is stale or no longer exists");
  if (!selected.length) {
    if (!guidance) throw new Error("Describe the changes you want");
    return guidance;
  }
  if (selected.some(({ request }) => !request && !guidance)) throw new Error("Describe the requested rewrite for each selected note");
  return [
    "Apply these selected code-change requests:",
    ...selected.map(({ note, request }) => `- ${note.id} at ${note.path} ${note.side} lines ${note.startLine}-${note.endLine}\n  Current explanation: ${note.text}\n  Reviewer request: ${request || guidance}`),
    `After rewriting, call review_note for each selected ID (${selected.map(({ note }) => note.id).join(", ")}) with its updated exact changed-line range.`
  ].filter(Boolean).join("\n\n");
}

export async function applyPatch(cwd, patch) {
  if (!String(patch || "").trim()) return;
  const directory = await mkdtemp(join(tmpdir(), "agent-plan-patch-"));
  const file = join(directory, "step.patch");
  try {
    await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
    await git(cwd, ["apply", "--whitespace=nowarn", file]);
  } finally {
    await rm(directory, { recursive: true }).catch(() => {});
  }
}

export function outsideWriteScope(files, writeScope) {
  if (writeScope === "**" || writeScope === "*") return [];
  const prefixes = String(writeScope || "").split(",")
    .map((scope) => scope.trim().replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/^\.\//, ""))
    .filter(Boolean);
  return files.filter((file) => !prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
}

export async function assertScopedWrite(cwd, inputPath, writeScope, options = {}) {
  if (options?.access) {
    const resolved = await resolveAccessPath(options.access, inputPath, { cwd, intent: "write" });
    if (!await writeScopeAllows(resolved, writeScope)) {
      throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${inputPath}`);
    }
    return resolved.absolute;
  }
  const root = resolve(cwd);
  const absolute = resolve(root, String(inputPath || "").replace(/^@/, ""));
  const repositoryPath = relative(root, absolute).split(sep).join("/");
  if (!repositoryPath || isAbsolute(repositoryPath) || repositoryPath === ".." || repositoryPath.startsWith("../") || outsideWriteScope([repositoryPath], writeScope).length) {
    throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${inputPath}`);
  }

  let existing = absolute;
  while (true) {
    try { await access(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT" || existing === root) throw error;
      existing = dirname(existing);
    }
  }
  const [realRoot, realExisting] = await Promise.all([realpath(root), realpath(existing)]);
  const escaped = relative(realRoot, realExisting);
  if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith(`..${sep}`)) throw new Error(`Write blocked through a symlink outside the workspace: ${inputPath}`);
  return absolute;
}

const skippedProofDirs = new Set([".git", ".jj", "node_modules"]);
const PROOF_PATCH_LIMIT = 600_000;
const PROOF_FILE_LIMIT = 2_000;
const PROOF_TEXT_LIMIT = 256_000;

export function repositoryIdentity(repo = {}) {
  const repositoryId = repo.repositoryId || repo.id || PRIMARY_ROOT_ID;
  return {
    repositoryId,
    displayPath: repo.displayPath || repo.sourceCwd || repo.path || repositoryId,
    kind: repo.kind || repo.evidenceKind || (repositoryId === PRIMARY_ROOT_ID ? "primary" : "extra")
  };
}

export function labelDiff(diff, repo, extras = {}) {
  return {
    ...(diff && typeof diff === "object" ? diff : { available: false, files: [], patch: "", stat: "" }),
    ...repositoryIdentity(repo),
    evidenceKind: extras.evidenceKind || extras.kind || (repo?.kind === "nongit" || repo?.kind === "external" ? repo.kind : "git")
  };
}

export function labelRepositoryDiffs(repos = [], diffs = {}) {
  return (repos || []).map((repo) => {
    const id = repo.id || PRIMARY_ROOT_ID;
    return labelDiff(diffs[id] || { available: false, files: [], patch: "", stat: "" }, repo, { evidenceKind: "git" });
  });
}

export function extraProofRoots(run, step = null) {
  const gitIds = new Set((run?.repositories || []).map((repo) => repo.id || PRIMARY_ROOT_ID));
  const roots = [];
  for (const root of frozenRoots(run?.access).filter((item) => item.kind === "extra" && item.mode === "read/write")) {
    if (gitIds.has(root.id)) continue;
    roots.push({
      id: root.id,
      displayPath: root.displayPath || root.path,
      path: root.path,
      kind: "nongit",
      mode: "read/write"
    });
  }
  if (run?.access?.mode !== "any" || !step) return roots;
  for (const entry of String(step.writeScope || "").split(",").map((item) => parseWriteScopeEntry(item)).filter(Boolean)) {
    if (entry.kind !== "absolute") continue;
    const contained = frozenRoots(run.access).some((root) => {
      const path = root.path;
      return entry.path === path || entry.path.startsWith(`${path}${sep}`) || path.startsWith(`${entry.path}${sep}`);
    });
    if (contained) continue;
    roots.push({
      id: `ext-${createHash("sha256").update(entry.path).digest("hex").slice(0, 8)}`,
      displayPath: entry.path,
      path: entry.path,
      kind: "external",
      mode: "read/write"
    });
  }
  return roots;
}

function qualifyProofPath(repositoryId, path) {
  return !repositoryId || repositoryId === PRIMARY_ROOT_ID ? path : `root:${repositoryId}:${path}`;
}

function fileHunk(path, beforeText, afterText) {
  const beforeLines = String(beforeText ?? "").split("\n");
  const afterLines = String(afterText ?? "").split("\n");
  if (beforeText == null) return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${afterLines.length} @@\n${afterLines.map((line) => `+${line}`).join("\n")}\n`;
  if (afterText == null) return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${beforeLines.length} +0,0 @@\n${beforeLines.map((line) => `-${line}`).join("\n")}\n`;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${beforeLines.map((line) => `-${line}`).join("\n")}\n${afterLines.map((line) => `+${line}`).join("\n")}\n`;
}

async function recordProofFile(files, rel, absolute) {
  const buf = await readFile(absolute);
  const binary = buf.includes(0);
  files[rel] = {
    hash: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
    binary,
    content: binary || buf.length > PROOF_TEXT_LIMIT ? null : buf.toString("utf8")
  };
}

export async function snapshotDirectory(root) {
  const files = {};
  let error = null;
  async function walk(dir, rel) {
    if (error) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (caught) {
      error = caught.message;
      return;
    }
    for (const entry of entries) {
      if (error) return;
      if (skippedProofDirs.has(entry.name) || entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, nextRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (Object.keys(files).length >= PROOF_FILE_LIMIT) {
        error = "output_limit: non-Git proof snapshot exceeded 2000 files";
        return;
      }
      try { await recordProofFile(files, nextRel, abs); }
      catch (caught) { error = caught.message; }
    }
  }
  await walk(root, "");
  return { root, files, error };
}

export async function snapshotProofPath(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return snapshotDirectory(target);
    const files = {};
    await recordProofFile(files, basename(target), target);
    return { root: target, files, error: null };
  } catch (caught) {
    if (caught.code === "ENOENT") return { root: target, files: {}, error: null, missing: true };
    return { root: target, files: {}, error: caught.message };
  }
}

export function diffFileSnapshots(before = {}, after = {}) {
  const beforeFiles = before?.files || {};
  const afterFiles = after?.files || {};
  const names = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].sort();
  const files = [];
  const fileStats = [];
  const parts = [];
  let additions = 0;
  let deletions = 0;
  let error = before?.error || after?.error || null;
  for (const name of names) {
    const left = beforeFiles[name];
    const right = afterFiles[name];
    if (left?.hash && right?.hash && left.hash === right.hash) continue;
    files.push(name);
    if (left?.binary || right?.binary || (left && left.content == null && !left.missing) || (right && right.content == null && !right.missing)) {
      parts.push(`diff --git a/${name} b/${name}\nBinary file ${name} changed\n`);
      fileStats.push({ path: name, additions: 0, deletions: 0, binary: true });
      continue;
    }
    const hunk = fileHunk(name, left ? left.content : null, right ? right.content : null);
    const plus = right ? String(right.content || "").split("\n").length : 0;
    const minus = left ? String(left.content || "").split("\n").length : 0;
    additions += plus;
    deletions += minus;
    fileStats.push({ path: name, additions: plus, deletions: minus, binary: false });
    parts.push(hunk);
  }
  const patch = parts.join("");
  if (patch.length > PROOF_PATCH_LIMIT) {
    error = error || "output_limit: non-Git or external proof exceeded the retained size";
  }
  return {
    available: files.length > 0,
    files,
    fileStats,
    patch: patch.length > PROOF_PATCH_LIMIT ? "" : patch,
    truncated: patch.length > PROOF_PATCH_LIMIT,
    stat: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
    additions,
    deletions,
    changedLines: additions + deletions,
    error
  };
}

export function aggregateProofDiffs(labeled = []) {
  const records = (labeled || []).filter(Boolean);
  const files = [];
  const fileStats = [];
  const patchParts = [];
  const errors = [];
  let additions = 0;
  let deletions = 0;
  let available = false;
  for (const diff of records) {
    const id = diff.repositoryId || PRIMARY_ROOT_ID;
    if (diff.error) errors.push(`${diff.displayPath || id}: ${diff.error}`);
    if (diff.truncated) errors.push(`${diff.displayPath || id}: output_limit: repository diff exceeded the retained size`);
    if (diff.available || (diff.files || []).length || diff.patch) available = true;
    for (const file of diff.files || []) files.push(qualifyProofPath(id, file));
    for (const row of diff.fileStats || []) fileStats.push({ ...row, path: qualifyProofPath(id, row.path) });
    additions += Number(diff.additions || 0);
    deletions += Number(diff.deletions || 0);
    if (diff.patch) patchParts.push(`# repository ${id} (${diff.displayPath || id})\n${diff.patch}`);
    else if ((diff.files || []).length) errors.push(`${diff.displayPath || id}: output_limit: changed files were recorded without a retained patch`);
  }
  const patch = patchParts.join("\n");
  const truncated = patch.length > PROOF_PATCH_LIMIT;
  if (truncated) errors.push("output_limit: combined proof diff exceeded the retained size; per-repository records remain");
  return {
    available,
    files,
    fileStats,
    patch: truncated ? patch.slice(0, PROOF_PATCH_LIMIT) : patch,
    truncated,
    stat: records.map((diff) => `${diff.displayPath || diff.repositoryId}: ${diff.stat || `${(diff.files || []).length} files`}`).join("\n"),
    additions,
    deletions,
    changedLines: additions + deletions,
    repositories: records,
    error: errors[0] || null,
    errors: errors.length ? errors : undefined
  };
}

export function combineRepositoryChecks(results = []) {
  const records = (results || []).filter(Boolean);
  if (!records.length) return { status: "skipped", command: null, summary: "No repository changes require a deterministic check.", output: "", repositories: [], failedRepositories: [] };
  const failed = records.filter((item) => item.status === "failed");
  const failedRepositories = failed.map((item) => ({
    repositoryId: item.repositoryId || PRIMARY_ROOT_ID,
    displayPath: item.displayPath || item.repositoryId || PRIMARY_ROOT_ID,
    status: item.status
  }));
  if (records.length === 1) {
    return { ...records[0], repositories: records, failedRepositories };
  }
  return {
    status: failed.length ? "failed" : (records.every((item) => item.status === "passed") ? "passed" : records[0].status || "unknown"),
    command: records.map((item) => `${item.displayPath || item.repositoryId}: ${item.command || ""}`).join("\n"),
    summary: failed.length
      ? `Repository checks failed in ${failed.map((item) => item.displayPath || item.repositoryId).join(", ")}`
      : records.map((item) => item.summary).filter(Boolean).join("\n"),
    output: records.map((item) => `## ${item.displayPath || item.repositoryId} (${item.repositoryId || PRIMARY_ROOT_ID})\n${item.output || ""}`).join("\n\n"),
    evidence: records.flatMap((item) => item.evidence || []),
    durationMs: records.reduce((total, item) => total + (Number(item.durationMs) || 0), 0),
    repositories: records,
    failedRepositories
  };
}
