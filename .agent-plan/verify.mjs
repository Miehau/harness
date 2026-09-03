#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  { name: "node scripts/test.mjs", args: ["scripts/test.mjs"] },
  { name: "node scripts/test.mjs --check", args: ["scripts/test.mjs", "--check"] }
];

function runCheck({ args }) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", (error) => resolveCheck({ error }));
    child.once("exit", (code, signal) => resolveCheck({ code, signal }));
  });
}

let failed = false;
for (const check of checks) {
  process.stdout.write(`Running ${check.name}\n`);
  const result = await runCheck(check);
  if (result.error || result.code !== 0) {
    failed = true;
    process.stderr.write(`Failed ${check.name}${result.error ? `: ${result.error.message}` : result.signal ? `: terminated by ${result.signal}` : ""}\n`);
  }
}

if (failed) process.exitCode = 1;
else process.stdout.write("Verification passed\n");
