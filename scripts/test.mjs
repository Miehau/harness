#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectApp, repoRoot } from "./inspect.js";

const usage = `Usage: node scripts/test.mjs [filter...] [--list] [--map] [--check] [--watch] [-- ...]
Runs node --test. Filter matches test file names. Extra args after -- go to node --test.
`;

async function testFiles(root = repoRoot) {
  return (await readdir(join(root, "test")))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join("test", name));
}

function parse(argv) {
  const flags = new Set();
  const positionals = [];
  const passthrough = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") flags.add("help");
    else if (arg.startsWith("--")) flags.add(arg.slice(2));
    else positionals.push(arg);
  }
  return { flags, positionals, passthrough };
}

export function runNode(args, cwd, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runTests(argv = process.argv.slice(2), { stdout = process.stdout, root = repoRoot } = {}) {
  const { flags, positionals, passthrough } = parse(argv);
  if (flags.has("help")) {
    stdout.write(usage);
    return 0;
  }
  const files = await testFiles(root);
  const matched = positionals.length
    ? files.filter((file) => positionals.some((query) => file.includes(query)))
    : files;
  if (flags.has("list")) {
    stdout.write(`${matched.join("\n")}\n`);
    return 0;
  }
  if (flags.has("map")) {
    const app = await inspectApp(root);
    stdout.write(app.modules.src.map((name) => {
      const test = `test/${name.replace(/\.js$/, ".test.js")}`;
      const covered = app.modules.tests.includes(name.replace(/\.js$/, ".test.js"));
      return `${covered ? "ok" : "  "}  src/${name}  ${covered ? test : "(no matching test)"}`;
    }).join("\n") + "\n");
    return 0;
  }
  if (flags.has("check")) {
    const targets = [
      ...(await readdir(join(root, "src"))).filter((name) => name.endsWith(".js")).map((name) => join("src", name)),
      ...(await readdir(join(root, "public"))).filter((name) => name.endsWith(".js")).map((name) => join("public", name)),
      ...(await readdir(join(root, "scripts"))).filter((name) => /\.(mjs|js)$/.test(name)).map((name) => join("scripts", name))
    ];
    let failed = 0;
    for (const file of targets) {
      const code = await runNode(["--check", file], root);
      if (code) failed = code;
    }
    return failed;
  }
  if (!matched.length) {
    stdout.write(`No tests matched: ${positionals.join(", ")}\n`);
    return 1;
  }
  const args = ["--test", ...passthrough];
  if (flags.has("watch")) args.push("--watch");
  args.push(...matched);
  return runNode(args, root);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runTests().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
