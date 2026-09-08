import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPrimaryPath,
  defaultAccessPolicy,
  normalizeProjectPolicy,
  storedProjectPolicy,
  writeProjectPolicy
} from "../src/access-policy.js";

async function makeLayout() {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-access-"));
  const primary = join(root, "project");
  const repo = join(root, "repo");
  const repoTwo = join(root, "repo-two");
  const nested = join(repo, "src");
  const extra = join(root, "shared");
  const file = join(root, "notes.txt");
  await mkdir(primary);
  await mkdir(nested, { recursive: true });
  await mkdir(repoTwo);
  await mkdir(extra);
  await writeFile(file, "not a directory");
  return { root, primary, repo, repoTwo, nested, extra, file };
}

test("missing policy is restricted primary-only and any is never inferred", () => {
  assert.deepEqual(defaultAccessPolicy(), { mode: "restricted", extraRoots: [] });
  assert.deepEqual(storedProjectPolicy({ workspace: { cwd: "/tmp/project" } }, "/tmp/project"), {
    mode: "restricted", extraRoots: []
  });
});

test("saves /repo and /repo-two and rejects ancestor or descendant overlap", async () => {
  const { root, primary, repo, repoTwo, nested } = await makeLayout();
  try {
    const allowed = await normalizeProjectPolicy({
      extraRoots: [
        { path: repo, mode: "read-only" },
        { path: repoTwo, mode: "read/write" }
      ]
    }, { primaryCwd: primary });
    assert.equal(allowed.mode, "restricted");
    assert.equal(allowed.extraRoots.length, 2);
    assert.equal(allowed.extraRoots[0].path, await realpath(repo));
    assert.equal(allowed.extraRoots[1].path, await realpath(repoTwo));
    assert.equal(allowed.extraRoots[1].mode, "read/write");

    await assert.rejects(
      () => normalizeProjectPolicy({
        extraRoots: [
          { path: repo, mode: "read-only" },
          { path: nested, mode: "read-only" }
        ]
      }, { primaryCwd: primary }),
      (error) => {
        assert.match(error.message, /overlap \(ancestor\/descendant\)/);
        assert.match(error.message, /repo/);
        assert.match(error.message, /src/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-mode duplicates collapse and conflicting modes fail", async () => {
  const { root, primary, extra } = await makeLayout();
  try {
    const link = join(root, "shared-link");
    await symlink(extra, link);
    const collapsed = await normalizeProjectPolicy({
      extraRoots: [
        { path: extra, mode: "read-only", displayPath: extra },
        { path: `${extra}/`, mode: "read-only" },
        { path: link, mode: "read-only", displayPath: "shared-link" }
      ]
    }, { primaryCwd: primary });
    assert.equal(collapsed.extraRoots.length, 1);
    assert.equal(collapsed.extraRoots[0].path, await realpath(extra));
    assert.equal(collapsed.extraRoots[0].displayPath, extra);

    await assert.rejects(
      () => normalizeProjectPolicy({
        extraRoots: [
          { path: extra, mode: "read-only" },
          { path: link, mode: "read/write" }
        ]
      }, { primaryCwd: primary }),
      /same path but use different modes \(read-only vs read\/write\)/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relative extra roots resolve against the primary directory, not caller cwd", async () => {
  const { root, primary, extra } = await makeLayout();
  const elsewhereRoot = await mkdtemp(join(tmpdir(), "agent-plan-elsewhere-"));
  const elsewhere = join(elsewhereRoot, "cwd");
  const decoy = join(elsewhereRoot, "shared");
  const previous = process.cwd();
  try {
    await mkdir(elsewhere);
    await mkdir(decoy);
    process.chdir(elsewhere);
    const relative = await normalizeProjectPolicy({
      extraRoots: [{ path: join("..", "shared"), mode: "read/write" }]
    }, { primaryCwd: primary });
    assert.equal(relative.extraRoots.length, 1);
    assert.equal(relative.extraRoots[0].path, await realpath(extra));
    assert.notEqual(relative.extraRoots[0].path, await realpath(decoy));
    assert.equal(relative.extraRoots[0].displayPath, join("..", "shared"));
    process.chdir(primary);
    const fromPrimary = await normalizeProjectPolicy({
      extraRoots: [{ path: join("..", "shared"), mode: "read/write" }]
    }, { primaryCwd: primary });
    assert.equal(fromPrimary.extraRoots[0].path, relative.extraRoots[0].path);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
    await rm(elsewhereRoot, { recursive: true, force: true });
  }
});

test("rejects missing paths, files, unknown modes, and implied primary extras", async () => {
  const { root, primary, extra, file } = await makeLayout();
  try {
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: join(root, "missing"), mode: "read-only" }] }, { primaryCwd: primary }),
      /Extra root .*missing.* does not exist/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: file, mode: "read-only" }] }, { primaryCwd: primary }),
      /Extra root .*notes\.txt.* is not a directory/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: extra, mode: "write-only" }] }, { primaryCwd: primary }),
      /Unknown extra root mode “write-only” for .* Use read-only or read\/write/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: extra }] }, { primaryCwd: primary }),
      /Missing extra root mode for .* Use read-only or read\/write/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ mode: "*" }, { primaryCwd: primary }),
      /Unknown access mode “\*”\. Use restricted or any/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: "**", mode: "read-only" }] }, { primaryCwd: primary }),
      /does not exist/
    );
    await assert.rejects(
      () => normalizeProjectPolicy({ extraRoots: [{ path: primary, mode: "read/write" }] }, { primaryCwd: primary }),
      /implied and cannot be stored as an extra root/
    );
    const any = await normalizeProjectPolicy({ mode: "any" }, { primaryCwd: primary });
    assert.equal(any.mode, "any");
    assert.deepEqual(any.extraRoots, []);
    const restricted = await normalizeProjectPolicy({ extraRoots: [] }, { primaryCwd: primary });
    assert.equal(restricted.mode, "restricted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed policy shapes and field types are rejected; omitted fields keep defaults", async () => {
  const { root, primary } = await makeLayout();
  try {
    const omitted = await normalizeProjectPolicy({}, { primaryCwd: primary });
    assert.deepEqual(omitted, { mode: "restricted", extraRoots: [] });
    const modeOnly = await normalizeProjectPolicy({ mode: "restricted" }, { primaryCwd: primary });
    assert.deepEqual(modeOnly, { mode: "restricted", extraRoots: [] });

    await assert.rejects(() => normalizeProjectPolicy(null, { primaryCwd: primary }), /must be an object.*not null/);
    await assert.rejects(() => normalizeProjectPolicy([], { primaryCwd: primary }), /must be an object.*not array/);
    await assert.rejects(() => normalizeProjectPolicy("restricted", { primaryCwd: primary }), /must be an object.*not string/);
    await assert.rejects(() => normalizeProjectPolicy(true, { primaryCwd: primary }), /must be an object.*not boolean/);
    await assert.rejects(() => normalizeProjectPolicy({ mode: null }, { primaryCwd: primary }), /Access mode must be restricted or any, not null/);
    await assert.rejects(() => normalizeProjectPolicy({ extraRoots: null }, { primaryCwd: primary }), /extraRoots must be an array.*not null/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extra roots overlapping the primary are rejected and name both paths", async () => {
  const { root, primary } = await makeLayout();
  try {
    const nested = join(primary, "src");
    await mkdir(nested);
    await assert.rejects(
      () => normalizeProjectPolicy({
        extraRoots: [{ path: nested, mode: "read-only" }]
      }, { primaryCwd: primary }),
      (error) => {
        assert.match(error.message, /overlaps the primary repository/);
        assert.match(error.message, /src/);
        return true;
      }
    );
    await assert.rejects(
      () => normalizeProjectPolicy({
        extraRoots: [{ path: root, mode: "read/write" }]
      }, { primaryCwd: primary }),
      (error) => {
        assert.match(error.message, /overlaps the primary repository/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extra root /repo-two is allowed when the primary is /repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-prefix-"));
  const repo = join(root, "repo");
  const repoTwo = join(root, "repo-two");
  try {
    await mkdir(repo);
    await mkdir(repoTwo);
    const allowed = await normalizeProjectPolicy({
      extraRoots: [{ path: repoTwo, mode: "read-only" }]
    }, { primaryCwd: repo });
    assert.equal(allowed.extraRoots.length, 1);
    assert.equal(allowed.extraRoots[0].path, await realpath(repoTwo));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeProjectPolicy replaces only the canonical primary key", async () => {
  const { root, primary, extra } = await makeLayout();
  try {
    const key = await canonicalPrimaryPath(primary);
    const state = { workspace: { cwd: primary } };
    writeProjectPolicy(state, key, await normalizeProjectPolicy({
      extraRoots: [{ path: extra, mode: "read-only" }]
    }, { primaryCwd: primary }));
    assert.equal(Object.keys(state.projectPolicies).length, 1);
    assert.equal(state.projectPolicies[key].extraRoots[0].path, await realpath(extra));
    assert.deepEqual(storedProjectPolicy(state, "/other/primary"), defaultAccessPolicy());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
