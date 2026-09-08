import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFrozenAccess,
  canonicalPrimaryPath,
  defaultAccessPolicy,
  freezeRunAccess,
  normalizeProjectPolicy,
  PRIMARY_ROOT_ID,
  resolveAccessPath,
  storedProjectPolicy,
  writeProjectPolicy,
  writeScopeAllows
} from "../src/access-policy.js";
import { assertScopedWrite } from "../src/git.js";

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

test("frozen run access stays restricted after settings enable Any access", async () => {
  const { root, primary, extra } = await makeLayout();
  try {
    const key = await canonicalPrimaryPath(primary);
    const state = { workspace: { cwd: primary }, projectPolicies: {} };
    writeProjectPolicy(state, key, await normalizeProjectPolicy({
      extraRoots: [{ path: extra, mode: "read/write" }]
    }, { primaryCwd: primary }));
    const access = await freezeRunAccess({ primaryCwd: primary, policy: storedProjectPolicy(state, key) });
    writeProjectPolicy(state, key, { mode: "any", extraRoots: [] });
    assert.equal(access.mode, "restricted");
    assert.equal(access.extraRoots.length, 1);
    assert.equal(storedProjectPolicy(state, key).mode, "any");
    const nextRun = await freezeRunAccess({ primaryCwd: primary, policy: storedProjectPolicy(state, key) });
    assert.equal(nextRun.mode, "any");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolver denies unlisted siblings, read-only writes, traversal, and symlink escapes", async () => {
  const { root, primary, extra } = await makeLayout();
  const sibling = join(root, "sibling");
  const outside = join(root, "outside");
  try {
    await mkdir(sibling);
    await mkdir(outside);
    await writeFile(join(sibling, "notes.txt"), "unlisted");
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(extra, "notes.txt"), "shared");
    await writeFile(join(primary, "src.js"), "ok");
    const escape = join(primary, "escape");
    await symlink(outside, escape);
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read-only", displayPath: "shared-docs" }]
      }, { primaryCwd: primary })
    });

    const allowed = await resolveAccessPath(access, join(primary, "src.js"), { intent: "read" });
    assert.equal(allowed.root.id, PRIMARY_ROOT_ID);
    const extraRead = await resolveAccessPath(access, join(extra, "notes.txt"), { intent: "read" });
    assert.equal(extraRead.root.mode, "read-only");

    await assert.rejects(
      () => resolveAccessPath(access, join(sibling, "notes.txt"), { intent: "read" }),
      /outside the frozen directory allow-list/
    );
    await assert.rejects(
      () => resolveAccessPath(access, join(primary, "..", "sibling", "notes.txt"), { cwd: primary, intent: "read" }),
      /outside the frozen directory allow-list/
    );
    await assert.rejects(
      () => resolveAccessPath(access, join(extra, "notes.txt"), { intent: "write" }),
      /read-only extra root “shared-docs”/
    );
    await assert.rejects(
      () => resolveAccessPath(access, join(escape, "secret.txt"), { intent: "read" }),
      /outside the frozen directory allow-list/
    );
    await assert.rejects(
      () => resolveAccessPath(access, join(escape, "created.txt"), { intent: "write" }),
      /outside the frozen directory allow-list/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolver keeps /repo and /repo-two distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-resolve-prefix-"));
  const repo = join(root, "repo");
  const repoTwo = join(root, "repo-two");
  try {
    await mkdir(repo);
    await mkdir(repoTwo);
    await writeFile(join(repoTwo, "secret.txt"), "nope");
    const access = await freezeRunAccess({ primaryCwd: repo, policy: defaultAccessPolicy() });
    await assert.rejects(
      () => resolveAccessPath(access, join(repoTwo, "secret.txt"), { intent: "read" }),
      /outside the frozen directory allow-list/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applying a frozen policy whose extra root is gone fails closed and names that root", async () => {
  const { root, primary, extra } = await makeLayout();
  try {
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read-only", displayPath: "shared-docs" }]
      }, { primaryCwd: primary })
    });
    await rm(extra, { recursive: true, force: true });
    await assert.rejects(() => applyFrozenAccess(access), /Extra root “shared-docs” does not exist/);
    await assert.rejects(
      () => resolveAccessPath(access, join(primary, "src.js"), { intent: "read" }),
      /shared-docs/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeScope is repository-qualified and Any-access outside roots needs an explicit absolute target", async () => {
  const { root, primary, extra } = await makeLayout();
  const outside = join(root, "outside");
  try {
    await mkdir(outside);
    await mkdir(join(primary, "src"));
    await mkdir(join(extra, "src"));
    await writeFile(join(primary, "src", "foo.js"), "a");
    await writeFile(join(extra, "src", "foo.js"), "b");
    await writeFile(join(outside, "target.js"), "c");
    const access = await freezeRunAccess({
      primaryCwd: primary,
      policy: await normalizeProjectPolicy({
        extraRoots: [{ path: extra, mode: "read/write" }]
      }, { primaryCwd: primary })
    });
    const extraId = access.extraRoots[0].id;
    const primaryWrite = await resolveAccessPath(access, join(primary, "src", "foo.js"), { intent: "write" });
    const extraWrite = await resolveAccessPath(access, join(extra, "src", "foo.js"), { intent: "write" });
    assert.equal(await writeScopeAllows(primaryWrite, "src"), true);
    assert.equal(await writeScopeAllows(extraWrite, "src"), false, "unqualified legacy scope is primary-only");
    assert.equal(await writeScopeAllows(extraWrite, `root:${extraId}:src`), true);
    assert.equal(await writeScopeAllows(primaryWrite, `root:${extraId}:src`), false);
    assert.equal(await writeScopeAllows(primaryWrite, "*"), true);
    assert.equal(await writeScopeAllows(primaryWrite, "**"), true);
    assert.equal(await writeScopeAllows(extraWrite, "*"), false, "legacy wildcards stay primary-only");
    assert.equal(await writeScopeAllows(extraWrite, "**"), false, "legacy wildcards stay primary-only");
    assert.equal(await writeScopeAllows(extraWrite, `root:${extraId}:*`), true);
    assert.equal(await writeScopeAllows(extraWrite, `root:${extraId}:**`), true);

    const anyAccess = await freezeRunAccess({
      primaryCwd: primary,
      policy: { mode: "any", extraRoots: access.extraRoots }
    });
    const outsideWrite = await resolveAccessPath(anyAccess, join(outside, "target.js"), { intent: "write" });
    assert.equal(outsideWrite.root, null);
    assert.equal(await writeScopeAllows(outsideWrite, "src"), false);
    assert.equal(await writeScopeAllows(outsideWrite, "**"), false, "broad scope does not cover unlisted Any-access paths");
    assert.equal(await writeScopeAllows(outsideWrite, join(outside, "target.js")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write guard denies dangling symlinks and missing destinations under a symlink ancestor", async () => {
  const { root, primary } = await makeLayout();
  const outside = join(root, "outside");
  try {
    await mkdir(outside);
    const dangling = join(primary, "dangling.txt");
    await symlink(join(outside, "missing.txt"), dangling);
    const missingDir = join(outside, "missing-dir");
    const link = join(primary, "link");
    await symlink(missingDir, link);
    const access = await freezeRunAccess({ primaryCwd: primary, policy: defaultAccessPolicy() });

    await assert.rejects(
      () => resolveAccessPath(access, dangling, { intent: "write" }),
      /outside the frozen directory allow-list/
    );
    await assert.rejects(
      () => assertScopedWrite(primary, dangling, "**", { access }),
      /outside the frozen directory allow-list|Write blocked/
    );
    await assert.rejects(
      () => resolveAccessPath(access, join(link, "created.txt"), { intent: "write" }),
      /outside the frozen directory allow-list/
    );
    await assert.rejects(
      () => assertScopedWrite(primary, join(link, "created.txt"), "**", { access }),
      /outside the frozen directory allow-list|Write blocked/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absolute writeScope uses the resolved target, not a lexical alias", async () => {
  const { root, primary } = await makeLayout();
  try {
    const hidden = join(primary, "private");
    const alias = join(primary, "public-alias");
    await mkdir(hidden);
    await writeFile(join(hidden, "secret.txt"), "secret");
    await symlink(hidden, alias);
    const access = await freezeRunAccess({ primaryCwd: primary, policy: defaultAccessPolicy() });
    const throughAlias = await resolveAccessPath(access, join(alias, "secret.txt"), { intent: "write" });
    assert.equal(throughAlias.relativePath, "private/secret.txt");
    assert.equal(await writeScopeAllows(throughAlias, "public-alias"), false);
    assert.equal(await writeScopeAllows(throughAlias, alias), false);
    assert.equal(await writeScopeAllows(throughAlias, "private"), true);
    assert.equal(await writeScopeAllows(throughAlias, hidden), true);
    assert.equal(await writeScopeAllows(throughAlias, join(hidden, "secret.txt")), true);

    const anyAccess = await freezeRunAccess({ primaryCwd: primary, policy: { mode: "any", extraRoots: [] } });
    const anyThroughAlias = await resolveAccessPath(anyAccess, join(alias, "secret.txt"), { intent: "write" });
    assert.equal(await writeScopeAllows(anyThroughAlias, alias), false);
    assert.equal(await writeScopeAllows(anyThroughAlias, hidden), true);

    const outside = join(root, "outside");
    const realOutside = join(outside, "real");
    const outsideAlias = join(outside, "alias");
    await mkdir(realOutside, { recursive: true });
    await writeFile(join(realOutside, "secret.txt"), "out");
    await symlink(realOutside, outsideAlias);
    const anyOutside = await resolveAccessPath(anyAccess, join(outsideAlias, "secret.txt"), { intent: "write" });
    assert.equal(anyOutside.root, null);
    assert.equal(await writeScopeAllows(anyOutside, outsideAlias), false);
    assert.equal(await writeScopeAllows(anyOutside, realOutside), true);

    const created = await resolveAccessPath(access, join(hidden, "new.txt"), { intent: "write" });
    assert.equal(await writeScopeAllows(created, hidden), true);
    assert.equal(
      await assertScopedWrite(primary, join(hidden, "new.txt"), hidden, { access }),
      join(hidden, "new.txt")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
