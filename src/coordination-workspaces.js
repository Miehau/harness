import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseWriteScopeEntry } from "./access-policy.js";
import { persistArtifact, safeName } from "./artifacts.js";
import { findNode, flattenSteps } from "./plan.js";
import { workerWriteScope } from "./pi-prompts.js";
import { snapshotTree, restoreTree, snapshotProofRootMap } from "./git.js";
import { gitRepositoriesForStep } from "./worktrees.js";

const exec = promisify(execFile);
const git = async (cwd, args, options = {}) => (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, ...options })).stdout;

function inScope(repo, file, scope) {
  return String(scope || "").split(",").map(parseWriteScopeEntry).filter(Boolean).some((entry) => {
    if (entry.kind === "root" && entry.rootId !== (repo.id || "primary")) return false;
    const path = entry.kind === "absolute" ? resolve(repo.sourceCwd || repo.cwd, file) : file;
    const prefix = entry.kind === "absolute" ? entry.path : entry.relativePath;
    return !prefix || prefix === "*" || prefix === "**" || path === prefix || path.startsWith(`${prefix}/`);
  });
}

async function restorationTree(repo, afterTree, paths) {
  if (!paths.size) return afterTree;
  const directory = await mkdtemp(join(tmpdir(), "agent-plan-revision-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
  try {
    await git(repo.cwd, ["read-tree", afterTree], { env });
    for (const [file, tree] of paths) await git(repo.cwd, ["reset", tree, "--", file], { env });
    return (await git(repo.cwd, ["write-tree"], { env })).trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Called after affected attempts stop, under the run's mutation lock. Persist must commit the supplied journal before resolving. */
export async function prepareRevisionWork({ run, revision, dataDir, persist }) {
  if (typeof persist !== "function") throw new Error("Revision work preservation requires a durable persist callback");
  if (revision.status !== "proposed" || revision.baseRevision !== (run.planRevision || 1)) throw new Error("Revision is no longer current");
  const targetDirectories = new Set(revision.affectedStepIds.flatMap((id) => {
    const step = findNode(run.plan, id);
    return step?.permission === "write" ? gitRepositoriesForStep(run, step).map((repo) => resolve(repo.cwd)) : [];
  }));
  for (const step of flattenSteps(run.plan)) {
    const active = run.activeRuns?.[step.id] || step.activeAttempt?.status === "active" || ["running", "fixing", "verifying"].includes(step.status);
    if (active && gitRepositoriesForStep(run, step).some((repo) => targetDirectories.has(resolve(repo.cwd)))) throw new Error(`Stop worker sharing revision workspace before preservation: ${step.id}`);
  }
  const sharedDirectories = new Set(gitRepositoriesForStep(run).map((repo) => resolve(repo.cwd)));
  let journal = revision.workPreparation;
  if (!journal) {
    const repositories = new Map();
    for (const id of revision.affectedStepIds) {
      const step = findNode(run.plan, id);
      if (!step || step.permission !== "write") continue;
      if (run.activeRuns?.[id] || step.activeAttempt?.status === "active") throw new Error(`Stop affected worker before preserving work: ${id}`);
      if (step.baseProofRoots && Object.keys(step.baseProofRoots).length) {
        const current = await snapshotProofRootMap(run, step);
        if (JSON.stringify(current) !== JSON.stringify(step.baseProofRoots)) throw new Error("Non-Git work changed; preserve and restore those files before accepting this revision");
      }
      for (const repo of gitRepositoriesForStep(run, step)) {
        const baseline = step.baseTrees?.[repo.id] || (repo.id === "primary" ? step.baseTree || step.workspace?.baseTree : null);
        if (!baseline) continue;
        const cwd = resolve(repo.cwd);
        let record = repositories.get(cwd);
        if (!record) {
          record = { repo, cwd, stepIds: [], isolated: !sharedDirectories.has(cwd), afterTree: await snapshotTree(cwd), bases: {}, paths: new Map() };
          if (!record.afterTree) throw new Error(`Git snapshot unavailable: ${cwd}`);
          repositories.set(cwd, record);
        }
        record.stepIds.push(id);
        record.bases[id] = baseline;
        const changed = (await git(cwd, ["diff", "--name-only", "-z", baseline, record.afterTree])).split("\0").filter(Boolean);
        for (const file of changed.filter((file) => inScope(repo, file, workerWriteScope(step)))) {
          if (record.paths.has(file) && record.paths.get(file) !== baseline) throw new Error(`Conflicting restoration baselines for ${file}`);
          record.paths.set(file, baseline);
        }
      }
    }
    const records = [];
    for (const [index, record] of [...repositories.values()].entries()) {
      const { repo, paths, ...snapshot } = record;
      snapshot.restoreTree = record.isolated ? record.afterTree : await restorationTree(repo, record.afterTree, paths);
      snapshot.files = [...paths.keys()];
      snapshot.ref = `refs/agent-plan/coordination/${safeName(run.runId)}/${safeName(revision.id)}/${index}`;
      // A ref retains binary contents even when Git garbage collection runs; the patch is the reviewable artifact.
      await git(record.cwd, ["update-ref", snapshot.ref, record.afterTree]);
      const patches = [];
      for (const [stepId, baseline] of Object.entries(record.bases)) {
        patches.push(`# Step ${stepId}; baseline ${baseline}; snapshot ${record.afterTree}\n${await git(record.cwd, ["diff", "--binary", "--full-index", baseline, record.afterTree])}`);
      }
      snapshot.artifact = await persistArtifact(dataDir, run.ticket || { id: run.id }, { name: `revision-${index}.patch`, content: patches.join("\n"), runId: run.runId, stageId: "implement", kind: "coordination-work", storageKey: `${revision.id}-${index}` });
      records.push(snapshot);
    }
    journal = { status: "captured", createdAt: new Date().toISOString(), repositories: records };
    await persist(structuredClone(journal));
  }
  for (const record of journal.repositories) {
    if (record.isolated) continue;
    const current = await snapshotTree(record.cwd);
    if (current === record.restoreTree) continue;
    if (current !== record.afterTree) throw new Error(`Workspace changed after revision capture: ${record.cwd}; refusing to overwrite new work`);
    if (await restoreTree(record.cwd, record.restoreTree) !== record.restoreTree) throw new Error(`Unable to restore revision baseline: ${record.cwd}`);
  }
  const prepared = { ...journal, status: "prepared", preparedAt: journal.preparedAt || new Date().toISOString() };
  await persist(structuredClone(prepared));
  return prepared;
}
