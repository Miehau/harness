#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  { name: "node scripts/test.mjs", args: ["scripts/test.mjs"] },
  { name: "node scripts/test.mjs --check", args: ["scripts/test.mjs", "--check"] },
  { name: "node --test .agent-plan/ui.test.mjs", args: ["--test", ".agent-plan/ui.test.mjs"] }
];

function runCheck({ args }) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", (error) => resolveCheck({ error }));
    child.once("exit", (code, signal) => resolveCheck({ code, signal }));
  });
}

let failed = false;
const liveProof = process.env.AGENT_PLAN_EVIDENCE_DIR && process.env.AGENT_PLAN_CAPTURE_TICKET_ID && process.env.AGENT_PLAN_CAPTURE_RUN_ID && process.env.AGENT_PLAN_CAPTURE_URL;
if (liveProof) {
  process.stdout.write("Capturing ticket-bound verify evidence\n");
  const capture = await runCheck({ args: ["scripts/capture-ticket-proof.mjs"] });
  if (capture.error || capture.code !== 0) {
    failed = true;
    process.stderr.write(`Failed ticket-bound verify capture${capture.error ? `: ${capture.error.message}` : ""}\n`);
  }
}
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
