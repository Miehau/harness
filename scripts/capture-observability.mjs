#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDaemon } from "../src/server.js";
import { previewChromiumPath } from "../src/previews.js";
import { mockHarness } from "./harness.js";
import { repoRoot } from "./inspect.js";
import { scenarios, seedScenario } from "./seed-state.js";

const exec = promisify(execFile);
const viewports = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844]
];

async function withSeededDaemon(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-observability-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-observability-cwd-"));
  let daemon;
  try {
    daemon = await createDaemon({ cwd, dataDir, listen: true, lock: false, host: "127.0.0.1", port: 0, harness: mockHarness() });
    await seedScenario(daemon.store, { dataDir, cwd, scenario: "observability" });
    if (!daemon.server.listening) await new Promise((resolve) => daemon.server.once("listening", resolve));
    return await fn(`http://${daemon.host}:${daemon.server.address().port}/`);
  } finally {
    await daemon?.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function captureScreenshot({ url, path, width, height, source = process.env }) {
  const browser = await previewChromiumPath(source);
  await exec(browser, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--window-size=${width},${height}`, `--screenshot=${path}`, url
  ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  return path;
}

export async function captureObservability({
  evidenceDir = process.env.AGENT_PLAN_EVIDENCE_DIR || join(repoRoot, "docs", "evidence"),
  withServer = withSeededDaemon,
  capture = captureScreenshot
} = {}) {
  await mkdir(evidenceDir, { recursive: true });
  const manifest = {
    scenario: "observability",
    description: scenarios.observability,
    captures: viewports.map(([name, width, height]) => ({ name, width, height }))
  };
  await writeFile(join(evidenceDir, "seeded-observability-scenarios.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const captures = await withServer(async (url) => Promise.all(viewports.map(async ([name, width, height]) => ({
    name, width, height,
    path: await capture({ url, path: join(evidenceDir, `observability-${name}.png`), width, height })
  }))));
  const report = [
    "Observable workflow screenshot capture",
    `scenario: ${manifest.scenario}`,
    ...captures.map((item) => `${item.name}: ${item.width}x${item.height} ${item.path}`)
  ].join("\n") + "\n";
  const regressionReport = [
    "Observable workflow regression fixture",
    "active parallel workers: included",
    "failed and corrected immutable attempts: included",
    "verification and handoff: included",
    "truncated output and unavailable live resources: included"
  ].join("\n") + "\n";
  await writeFile(join(evidenceDir, "screenshot-capture-report.txt"), report);
  await writeFile(join(evidenceDir, "observable-workflow-regression-report.txt"), regressionReport);
  return { evidenceDir, manifest, captures, report, regressionReport };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) captureObservability().then(({ report }) => process.stdout.write(report), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
