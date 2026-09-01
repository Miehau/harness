#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { inspectApp, repoRoot } from "./inspect.js";

const usage = `Usage: node scripts/nav.mjs [--json] [routes|ui|cli|modules|stages]
Prints the live app map from source. No hand-maintained inventory.
`;

function textMap(app) {
  const lines = [
    `${app.package.name} ${app.package.version}`,
    "",
    "CLI  " + (app.cli.join(" | ") || "(none)"),
    "STAGES  " + app.stages.join(" → "),
    "",
    "API"
  ];
  for (const route of app.routes) lines.push(`  ${route.method.padEnd(6)}${route.path}`);
  lines.push("", "UI");
  lines.push(`  title     ${app.ui.title}`);
  lines.push(`  regions   ${app.ui.regions.join(", ")}`);
  lines.push(`  dialogs   ${app.ui.dialogs.join(", ")}`);
  lines.push(`  forms     ${app.ui.forms.join(", ")}`);
  lines.push("", "MODULES");
  lines.push(`  src       ${app.modules.src.join(" ")}`);
  lines.push(`  public    ${app.modules.public.join(" ")}`);
  lines.push(`  tests     ${app.modules.tests.map((name) => name.replace(/\.test\.js$/, "")).join(" ")}`);
  if (app.modules.untested.length) lines.push(`  untested  ${app.modules.untested.join(" ")}`);
  return lines.join("\n") + "\n";
}

export async function runNav(argv = process.argv.slice(2), { stdout = process.stdout, root = repoRoot } = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    stdout.write(usage);
    return 0;
  }
  const json = argv.includes("--json");
  const section = argv.find((arg) => !arg.startsWith("-")) || "all";
  const app = await inspectApp(root);
  const payload = section === "all" ? app : app[section];
  if (payload === undefined) {
    stdout.write(usage);
    return 1;
  }
  stdout.write(json || section !== "all" ? `${JSON.stringify(payload, null, 2)}\n` : textMap(app));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runNav().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
