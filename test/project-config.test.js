import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, normalizeProjectConfig, projectEnvironment, runProjectCommand } from "../src/project-config.js";

test("detects conventional package commands when no contract exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-config-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js", build: "node build.js", dev: "node dev.js" } }));
    assert.deepEqual((await loadProjectConfig(root)).commands, { test: ["npm", "run", "test"], build: ["npm", "run", "build"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects shell escapes and inline code evaluators", () => {
  assert.throws(() => normalizeProjectConfig({ commands: { bad: ["bash", "-lc", "rm -rf ."] } }), /blocked executable/);
  assert.throws(() => normalizeProjectConfig({ commands: { bad: ["node", "-e", "process.exit()"] } }), /inline code/);
});

test("an invalid declaration does not poison unrelated project commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-isolation-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: {
      "git-status": ["git", "status"],
      check: [process.execPath, "check.mjs"]
    } }));
    await writeFile(join(root, "check.mjs"), "console.log('checked')\n");

    const config = await loadProjectConfig(root);
    assert.deepEqual(Object.keys(config.commands), ["check"]);
    assert.match(config.commandErrors["git-status"], /blocked executable git/);
    assert.equal((await runProjectCommand(root, "check")).output.trim(), "checked");
    await assert.rejects(runProjectCommand(root, "git-status"), /Project command “git-status” uses blocked executable git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("passes only explicit environment values and redacts them from command output", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-env-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".env.local"), "LOCAL_TOKEN=local-secret-value\n");
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({
      commands: { test: ["npm", "test"] }, environment: { pass: ["API_TOKEN", "LOCAL_TOKEN"], files: [".env.local"] }
    }));
    const calls = [];
    const execImpl = async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "git") return { stdout: "" };
      return { stdout: `${options.env.API_TOKEN} ${options.env.LOCAL_TOKEN}`, stderr: "" };
    };
    const config = await loadProjectConfig(root);
    const env = await projectEnvironment(root, config, { source: { PATH: "/bin", API_TOKEN: "daemon-secret-value", UNLISTED: "hidden" }, execImpl });
    assert.equal(env.UNLISTED, undefined);
    assert.equal(env.LOCAL_TOKEN, "local-secret-value");
    const result = await runProjectCommand(root, "test", { source: { PATH: "/bin", API_TOKEN: "daemon-secret-value" }, execImpl });
    assert.equal(result.output, "[REDACTED] [REDACTED]");
    assert.equal(calls.at(-1).options.env.UNLISTED, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runs a named argv command without a shell or unlisted daemon secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-command-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, "check.mjs"), "console.log(process.env.UNLISTED || 'isolated')\n");
    await writeFile(join(root, ".agent-plan", "project.json"), JSON.stringify({ commands: { check: [process.execPath, "check.mjs"] } }));
    const result = await runProjectCommand(root, "check", { source: { PATH: process.env.PATH, UNLISTED: "must-not-leak" } });
    assert.equal(result.status, "passed");
    assert.equal(result.output.trim(), "isolated");
  } finally { await rm(root, { recursive: true, force: true }); }
});
