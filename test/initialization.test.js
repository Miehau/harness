import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeProject } from "../src/initialization.js";
import { runProjectCommand } from "../src/project-config.js";
import { dependencyState, prepareDependencies } from "../src/dependencies.js";
import { invoke, runAgainstDaemon, withDaemon } from "./helpers.js";

test("initialization preserves existing choices and fails empty verification honestly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "init-project-"));
  try {
    const first = await initializeProject(cwd, { vcsMode: "git", verify: true });
    assert.deepEqual(first.created, [".agent-plan/project.json", ".agent-plan/verify.mjs"]);
    assert.equal(first.results.verify.status, "failed");
    assert.match(first.results.verify.output, /No deterministic checks/);
    const before = await readFile(join(cwd, ".agent-plan/project.json"), "utf8");
    const second = await initializeProject(cwd, { vcsMode: "git" });
    assert.deepEqual(second.created, []);
    assert.equal(await readFile(join(cwd, ".agent-plan/project.json"), "utf8"), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("dependency changes install privately and invalidate the manifest fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "init-deps-"));
  const cwd = join(root, "project");
  try {
    await mkdir(cwd);
    await initializeProject(cwd, { vcsMode: "git" });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { sample: "1" } }));
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "shared", "keep.txt"), "source untouched");
    await symlink(join(root, "shared"), join(cwd, "node_modules"));
    await writeFile(join(cwd, "install.mjs"), 'import {mkdir,writeFile} from "node:fs/promises"; await mkdir("node_modules", {recursive:true}); await writeFile("node_modules/installed", "yes");');
    const config = { commands: { install: ["node", "install.mjs"], test: ["node", "test.mjs"] } };
    await writeFile(join(cwd, "test.mjs"), 'import {readFile} from "node:fs/promises"; await readFile("node_modules/installed");');
    await writeFile(join(cwd, ".agent-plan/project.json"), JSON.stringify(config));
    assert.equal((await runProjectCommand(cwd, "test")).status, "passed");
    assert.equal(await readFile(join(root, "shared", "keep.txt"), "utf8"), "source untouched");
    assert.equal((await dependencyState(cwd, config)).required, false);
    await writeFile(join(cwd, "package-lock.json"), "changed");
    assert.equal((await dependencyState(cwd, config)).required, true);
    assert.equal((await runProjectCommand(cwd, "test")).status, "passed");
    assert.equal((await dependencyState(cwd, config)).required, false);
    await assert.rejects(prepareDependencies(cwd, config, async () => {
      await mkdir(join(cwd, "node_modules"), { recursive: true });
      return { status: "failed", output: "partial installation" };
    }, { force: true }), /partial installation/);
    assert.equal((await dependencyState(cwd, config)).required, true);
    await rm(join(cwd, "node_modules"), { recursive: true });
    assert.equal((await dependencyState(cwd, config)).required, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("init CLI and API establish the selected workspace and preserve reruns", async () => {
  await withDaemon(async (daemon) => {
    const result = await runAgainstDaemon(daemon, ["init"]);
    assert.equal(result.code, 0);
    assert.equal(result.json.created.length, 2);
    const again = await invoke(daemon, "POST", "/api/workspace/init", { body: {} });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.created, []);
    assert.equal((await invoke(daemon, "POST", "/api/workspace/init", { body: { install: "yes" } })).status, 400);
  });
});
