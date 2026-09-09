import { createHash } from "node:crypto";
import { extraProofRoots, snapshotProofPath, snapshotTree } from "./git.js";
import { flattenSteps } from "./plan.js";
import { gitRepositoriesForStep } from "./worktrees.js";

function rootDigest(snapshot) {
  if (snapshot?.error) throw new Error("Proof root could not be snapshotted");
  if (snapshot?.missing) throw new Error("Proof root is missing");
  const files = Object.entries(snapshot?.files || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, file]) => [path, file.hash || null, Number(file.size) || 0, Boolean(file.binary)]);
  return createHash("sha256").update(JSON.stringify({ missing: Boolean(snapshot?.missing), files })).digest("hex");
}

function proofRoots(run) {
  const roots = new Map();
  for (const root of [extraProofRoots(run), ...flattenSteps(run?.plan).map((step) => extraProofRoots(run, step))].flat()) {
    const key = `${root.id}:${root.path}`;
    if (!roots.has(key)) roots.set(key, root);
  }
  return [...roots.values()];
}

function sameKeys(left = {}, right = {}) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function validTree(tree) {
  return typeof tree === "string" && /^[0-9a-f]{40}$/i.test(tree);
}

function validDigest(digest) {
  return typeof digest === "string" && /^[0-9a-f]{64}$/i.test(digest);
}

export async function captureProofRevision(run, { repositoryIds = null } = {}) {
  const selected = repositoryIds && new Set(repositoryIds);
  const repositories = {};
  const found = new Set();
  for (const repository of gitRepositoriesForStep(run)) {
    const id = repository.id || "primary";
    if (selected && !selected.has(id)) continue;
    found.add(id);
    const tree = await snapshotTree(repository.cwd);
    if (!tree) throw new Error(`Proof revision is unavailable for repository ${id}`);
    repositories[id] = tree;
  }
  for (const id of selected || []) {
    if (!found.has(id)) throw new Error(`Proof revision is unavailable for repository ${id}`);
  }
  const roots = {};
  for (const root of proofRoots(run)) roots[root.id] = rootDigest(await snapshotProofPath(root.path));
  return { version: 1, repositories, roots };
}

export async function assertProofRevision(run, expected, { repositoryIds = null } = {}) {
  // Runs created before revision binding retain their historical approval contract.
  if (!expected) return { legacy: true };
  if (expected.version !== 1) throw new Error("Final proof revision is unsupported");
  const actual = await captureProofRevision(run, { repositoryIds });
  const ids = repositoryIds ? [...new Set(repositoryIds)] : Object.keys(expected.repositories || {});
  for (const id of ids) {
    if (!validTree(expected.repositories?.[id]) || !validTree(actual.repositories[id]) || actual.repositories[id] !== expected.repositories[id]) {
      throw new Error(`Final proof is stale: repository ${id} changed after review`);
    }
  }
  if (!repositoryIds && !sameKeys(expected.repositories, actual.repositories)) throw new Error("Final proof is stale: repository set changed after review");
  if (!sameKeys(expected.roots, actual.roots)) throw new Error("Final proof is stale: proof root set changed after review");
  for (const [id, digest] of Object.entries(expected.roots || {})) {
    if (!validDigest(digest) || !validDigest(actual.roots[id]) || actual.roots[id] !== digest) throw new Error(`Final proof is stale: proof root ${id} changed after review`);
  }
  return { legacy: false };
}
