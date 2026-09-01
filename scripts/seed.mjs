#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scenarios, writeSeed } from "./seed-state.js";
import { repoRoot } from "./inspect.js";

const usage = `Usage: node scripts/seed.mjs [scenario] [--data-dir DIR] [--cwd DIR] [--json] [--start] [--list]
Writes state-v3.json the daemon actually loads. Scenarios: ${Object.keys(scenarios).join(", ")}.
`;

function parse(argv) {
  const flags = new Set();
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--data-dir" || arg === "--cwd") options[arg.slice(2)] = argv[++index];
    else if (arg.startsWith("--")) flags.add(arg.slice(2));
    else positionals.push(arg);
  }
  return { flags, options, positionals };
}

export async function runSeed(argv = process.argv.slice(2), { stdout = process.stdout, env = process.env } = {}) {
  const { flags, options, positionals } = parse(argv);
  if (flags.has("help") || positionals[0] === "help") {
    stdout.write(usage);
    return 0;
  }
  if (flags.has("list")) {
    stdout.write(flags.has("json")
      ? `${JSON.stringify(scenarios, null, 2)}\n`
      : Object.entries(scenarios).map(([name, detail]) => `${name.padEnd(16)}${detail}`).join("\n") + "\n");
    return 0;
  }
  const scenario = positionals[0] || "clarifying";
  const dataDir = options["data-dir"] || env.AGENT_PLAN_DATA_DIR || await mkdtemp(join(tmpdir(), "agent-plan-seed-data-"));
  const cwd = options.cwd || env.AGENT_PLAN_CWD || await mkdtemp(join(tmpdir(), "agent-plan-seed-cwd-"));
  const result = await writeSeed({ dataDir, cwd, scenario });
  if (flags.has("json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    stdout.write(`scenario  ${result.scenario}\n`);
    stdout.write(`ticket    ${result.ticketId || "(none)"}\n`);
    stdout.write(`dataDir   ${result.dataDir}\n`);
    stdout.write(`cwd       ${result.cwd}\n`);
    stdout.write(`state     ${result.stateFile}\n`);
    stdout.write(`start     AGENT_PLAN_DATA_DIR=${result.dataDir} npm start -- --cwd ${result.cwd}\n`);
  }
  if (flags.has("start")) {
    const child = spawn(process.execPath, [join(repoRoot, "src/server.js"), "--cwd", result.cwd], {
      env: { ...env, AGENT_PLAN_DATA_DIR: result.dataDir },
      stdio: "inherit"
    });
    return await new Promise((resolve) => child.on("exit", (code) => resolve(code || 0)));
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runSeed().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
