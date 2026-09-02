import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertScopedWrite, diffTrees, normalizeReviewMap, normalizeReviewNotes, outsideWriteScope, restoreTree, reviewNoteFeedback, snapshotTree } from "../src/git.js";

const exec = promisify(execFile);

test("tree snapshots isolate one run without modifying the real index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-git-test-"));
  try {
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n");
    await exec("git", ["add", "tracked.txt"], { cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });

    await writeFile(join(cwd, "tracked.txt"), "pre-existing dirty state\n");
    const before = await snapshotTree(cwd);
    await writeFile(join(cwd, "tracked.txt"), "changed by this run\n");
    await writeFile(join(cwd, "artifact.md"), "run artifact\n");
    const after = await snapshotTree(cwd);
    const diff = await diffTrees(cwd, before, after);

    assert.deepEqual(diff.files.sort(), ["artifact.md", "tracked.txt"]);
    assert.equal(diff.changedLines, 3);
    assert.match(diff.patch, /pre-existing dirty state/);
    assert.match(diff.patch, /changed by this run/);
    const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd });
    assert.equal(stdout, "");
  } finally {
    await rm(cwd, { recursive: true });
  }
});

test("restores an exact recorded tree for a programmatic restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-restore-test-"));
  try {
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
    await exec("git", ["add", "tracked.txt"], { cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
    const checkpoint = await snapshotTree(cwd);
    await writeFile(join(cwd, "tracked.txt"), "later\n");
    await writeFile(join(cwd, "later.txt"), "discard me\n");
    assert.equal(await restoreTree(cwd, checkpoint), checkpoint);
    assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "checkpoint\n");
    await assert.rejects(readFile(join(cwd, "later.txt"), "utf8"), /ENOENT/);
  } finally { await rm(cwd, { recursive: true }); }
});

test("semantic review maps keep only real hunks and cover omissions", () => {
  const patch = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@ first\n-old\n+new\n@@ -5 +5 @@ second\n-before\n+after";
  const map = normalizeReviewMap({ groups: [{ title: "First behavior", items: [{ fileIndex: 0, hunks: [0, 99] }, { fileIndex: 4, hunks: [0] }] }] }, patch);
  assert.deepEqual(map.groups.map((group) => [group.title, group.items.map((item) => item.hunk)]), [["First behavior", [0]], ["Other changes", [1]]]);
});

test("review notes bind to changed lines, relocate, and become stale after rewrites", () => {
  const first = { after: "tree-1", patch: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n keep\n+guard" };
  const [note] = normalizeReviewNotes([{ id: "rn-lock", path: "a.js", side: "RIGHT", startLine: 2, kind: "invariant", text: "Only one refresh may run." }], first);
  assert.deepEqual([note.id, note.startLine, note.endLine, note.status], ["rn-lock", 2, 2, "current"]);
  assert.deepEqual(normalizeReviewNotes([{ path: "missing.js", side: "RIGHT", startLine: 2, text: "Invalid" }], first), []);

  const shifted = { after: "tree-2", patch: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,3 @@\n keep\n+prep\n+guard" };
  const [relocated] = normalizeReviewNotes([], shifted, [note]);
  assert.deepEqual([relocated.startLine, relocated.endLine, relocated.status], [3, 3, "current"]);

  const rewritten = { after: "tree-3", patch: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n keep\n+different" };
  assert.equal(normalizeReviewNotes([], rewritten, [relocated])[0].status, "stale");
});

test("selected review notes become one focused rewrite request", () => {
  const notes = [
    { id: "rn-one", path: "a.js", side: "RIGHT", startLine: 2, endLine: 4, status: "current", text: "The block now serializes refreshes." },
    { id: "rn-two", path: "b.js", side: "LEFT", startLine: 8, endLine: 9, status: "current", text: "The old fallback is removed." }
  ];
  const prompt = reviewNoteFeedback(notes, [
    { id: "rn-one", feedback: "Make the locking easier to scan." },
    { id: "rn-two", feedback: "Explain why the fallback can go." }
  ]);
  assert.match(prompt, /rn-one at a\.js RIGHT lines 2-4/);
  assert.match(prompt, /rn-two at b\.js LEFT lines 8-9/);
  assert.match(prompt, /Make the locking easier to scan/);
  assert.match(prompt, /Explain why the fallback can go/);
  assert.match(prompt, /call review_note for each selected ID \(rn-one, rn-two\)/);
  assert.equal(reviewNoteFeedback(notes, [{ id: undefined, feedback: "ignored" }], "Apply the general fix"), "Apply the general fix");
  assert.throws(() => reviewNoteFeedback(notes, ["rn-missing"], "Fix it"), /stale or no longer exists/);
  assert.throws(() => reviewNoteFeedback(notes, ["rn-one"]), /Describe the requested rewrite/);
});

test("blocks paths outside write scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-scope-test-"));
  try {
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n");
    await exec("git", ["add", "tracked.txt"], { cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
    await mkdir(join(cwd, "src"));
    assert.equal(await assertScopedWrite(cwd, "src/app.js", "src,test"), join(cwd, "src", "app.js"));
    await assert.rejects(assertScopedWrite(cwd, "README.md", "src,test"), /Write blocked outside scope/);
    assert.deepEqual(outsideWriteScope(["src/app.js", "README.md"], "src,test"), ["README.md"]);
    assert.deepEqual(outsideWriteScope(["src/app.js"], ""), ["src/app.js"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
