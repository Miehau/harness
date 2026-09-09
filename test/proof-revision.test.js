import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertProofRevision, captureProofRevision } from "../src/proof-revision.js";

const runFile = promisify(execFile);

async function gitDirectory(prefix, file, content) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await runFile("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, file), content);
  return cwd;
}

test("proof revisions bind every Git repository and writable non-Git root by content", async () => {
  const primary = await gitDirectory("agent-plan-proof-primary-", "primary.txt", "one\n");
  const secondary = await gitDirectory("agent-plan-proof-secondary-", "secondary.txt", "one\n");
  const notes = await mkdtemp(join(tmpdir(), "agent-plan-proof-notes-"));
  await mkdir(join(notes, "nested"));
  await writeFile(join(notes, "nested", "note.txt"), "one\n");
  const run = {
    workspace: { cwd: primary },
    repositories: [
      { id: "primary", kind: "primary", cwd: primary },
      { id: "secondary", kind: "extra", cwd: secondary }
    ],
    access: {
      mode: "restricted", primary: { id: "primary", path: primary },
      extraRoots: [{ id: "notes", path: notes, mode: "read/write" }]
    }
  };
  const revision = await captureProofRevision(run);
  assert.equal(revision.version, 1);
  assert.deepEqual(Object.keys(revision.repositories).sort(), ["primary", "secondary"]);
  assert.deepEqual(Object.keys(revision.roots), ["notes"]);
  await assert.doesNotReject(assertProofRevision(run, revision));

  await writeFile(join(secondary, "secondary.txt"), "two\n");
  await assert.rejects(assertProofRevision(run, revision), /repository secondary changed/);
  await writeFile(join(secondary, "secondary.txt"), "one\n");
  await writeFile(join(notes, "nested", "note.txt"), "two\n");
  await assert.rejects(assertProofRevision(run, revision), /proof root notes changed/);
});

test("legacy final-proof records remain valid without a revision binding", async () => {
  assert.deepEqual(await assertProofRevision({}, null), { legacy: true });
});

test("proof revisions fail closed for missing repositories and roots", async () => {
  const primary = await gitDirectory("agent-plan-proof-missing-", "primary.txt", "one\n");
  const run = {
    workspace: { cwd: primary },
    repositories: [{ id: "primary", kind: "primary", cwd: primary }],
    access: { mode: "restricted", extraRoots: [{ id: "missing", path: join(primary, "absent"), mode: "read/write" }] }
  };
  await assert.rejects(captureProofRevision(run), /Proof root is missing/);
  await assert.rejects(captureProofRevision({ ...run, access: { mode: "restricted", extraRoots: [] } }, { repositoryIds: ["secondary"] }), /repository secondary/);
});

test("any-mode absolute write scopes are proof roots", async () => {
  const primary = await gitDirectory("agent-plan-proof-any-", "primary.txt", "one\n");
  const external = await mkdtemp(join(tmpdir(), "agent-plan-proof-external-"));
  await writeFile(join(external, "note.txt"), "one\n");
  const run = {
    workspace: { cwd: primary },
    repositories: [{ id: "primary", kind: "primary", cwd: primary }],
    access: { mode: "any", extraRoots: [] },
    plan: { nodes: [{ id: "external", permission: "write", writeScope: external }] }
  };
  const revision = await captureProofRevision(run);
  assert.equal(Object.keys(revision.roots).length, 1);
  await writeFile(join(external, "note.txt"), "two\n");
  await assert.rejects(assertProofRevision(run, revision), /proof root ext-/);
});
