import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runVerification(root, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env };
    delete env.AGENT_PLAN_EVIDENCE_DIR;
    Object.assign(env, environment);
    const child = spawn(process.execPath, [join(root, ".agent-plan", "verify.mjs")], {
      cwd: join(root, "outside-repository"),
      env
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status, signal) => resolveRun({ output, status, signal }));
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "verification-contract-"));
  const contract = await readFile(join(repositoryRoot, ".agent-plan", "verify.mjs"), "utf8");
  await Promise.all([
    mkdir(join(root, ".agent-plan")),
    mkdir(join(root, "scripts")),
    mkdir(join(root, "outside-repository"))
  ]);
  await Promise.all([
    writeFile(join(root, ".agent-plan", "verify.mjs"), contract),
    writeFile(join(root, "scripts", "test.mjs"), `import { appendFile } from "node:fs/promises";

const phase = process.argv.includes("--check") ? "syntax" : "tests";
console.log("fixture " + phase + " diagnostic");
await appendFile(new URL("../phases.log", import.meta.url), phase + "\\n");
if (process.env.FAIL_PHASE === phase) {
  console.error("fixture " + phase + " failure detail");
  process.exitCode = 17;
}
`)
  ]);
  return root;
}

test("verification contract composes repository-local phases and retains failed diagnostics", async () => {
  const project = JSON.parse(await readFile(join(repositoryRoot, ".agent-plan", "project.json"), "utf8"));
  assert.deepEqual(project.commands.verify, ["node", ".agent-plan/verify.mjs"]);
  assert.deepEqual(project.environment, { pass: [], files: [] });
  assert.deepEqual(project.ports, { variables: [] });

  const root = await createFixture();
  try {
    const passed = await runVerification(root);
    assert.equal(passed.status, 0);
    assert.equal(passed.signal, null);
    assert.match(passed.output, /Running node scripts\/test\.mjs/);
    assert.match(passed.output, /Running node scripts\/test\.mjs --check/);
    assert.match(passed.output, /fixture tests diagnostic/);
    assert.match(passed.output, /fixture syntax diagnostic/);
    assert.match(passed.output, /Verification passed/);
    assert.equal(await readFile(join(root, "phases.log"), "utf8"), "tests\nsyntax\n");

    await writeFile(join(root, "phases.log"), "");
    const failed = await runVerification(root, { FAIL_PHASE: "syntax" });
    assert.equal(failed.status, 1);
    assert.equal(failed.signal, null);
    assert.match(failed.output, /Failed node scripts\/test\.mjs --check/);
    assert.match(failed.output, /fixture syntax failure detail/);
    assert.equal(await readFile(join(root, "phases.log"), "utf8"), "tests\nsyntax\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
