import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectApp, repoRoot } from "../scripts/inspect.js";
import { runNav } from "../scripts/nav.mjs";
import { captureObservability } from "../scripts/capture-observability.mjs";
import { runSeed } from "../scripts/seed.mjs";
import { runNode, runTests } from "../scripts/test.mjs";
import { JsonStore } from "../src/store.js";
import { writeSeed } from "./helpers.js";

function capture() {
  const chunks = [];
  return { stdout: { write(value) { chunks.push(value); } }, text: () => chunks.join("") };
}

test("test runner treats a signal-terminated child check as a failure", async () => {
  const child = new EventEmitter();
  const code = await runNode(["--check", "fixture.js"], repoRoot, {
    spawnProcess(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["--check", "fixture.js"]);
      assert.equal(options.cwd, repoRoot);
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return child;
    }
  });
  assert.equal(code, 1);
});

test("nav reads API, UI, CLI, and stages from source", async () => {
  const app = await inspectApp();
  assert.ok(app.routes.some((route) => route.method === "GET" && route.path === "/api/health"));
  assert.ok(app.routes.some((route) => route.method === "POST" && route.path === "/api/tickets/:id/approve"));
  assert.ok(app.routes.some((route) => route.method === "POST" && route.path === "/api/tickets/:id/steps/:id/:decision"));
  assert.ok(app.ui.dialogs.includes("workspace-dialog"));
  assert.ok(app.cli.includes("wait"));
  assert.ok(app.cli.includes("select"));
  assert.deepEqual(app.stages, ["requirements", "explore", "design", "implement", "verify", "handoff"]);
  const html = await readFile(join(repoRoot, "public/index.html"), "utf8");
  assert.equal(html.includes("Provider: openai-codex"), false);
});

test("nav CLI prints a map and json", async () => {
  const printed = capture();
  assert.equal(await runNav([], printed), 0);
  assert.match(printed.text(), /GET\s+\/api\/health/);
  const json = capture();
  assert.equal(await runNav(["routes", "--json"], json), 0);
  assert.ok(JSON.parse(json.text()).some((route) => route.path === "/api/state"));
});

test("dashboard source keeps supervision controls semantic and visibly focusable", async () => {
  const [app, styles] = await Promise.all([
    readFile(join(repoRoot, "public/app.js"), "utf8"),
    readFile(join(repoRoot, "public/styles.css"), "utf8")
  ]);
  assert.match(app, /role="tablist"/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /restoreInspectionSelection/);
  assert.match(app, /let deliberateSelection = false/);
  assert.match(app, /Saved selection is intentionally not restored/);
  assert.match(app, /selectedWorkerId = stepId \? `worker:\$\{stepId\}` : null/);
  assert.match(app, /const cachedProjection = inspectionFor\(runFor\(ticketId\)\)/);
  assert.match(app, /hasSelectedStage/);
  assert.match(app, /hasSelectedAttempt/);
  assert.match(app, /\[data-rail-step\], \[data-ticket\], \[data-attempt-select\]/);
  assert.match(app, /focusData && "attemptSelect" in focusData/);
  assert.match(app, /const headerActionKeys = \["startTicket", "resumeTicket"/);
  assert.match(app, /const headerSelector = headerAction/);
  assert.match(app, /function renderInspectorPreservingContext\(\)/);
  assert.match(app, /function liveInspectionSummary\(run, step, attempt, summary\)/);
  assert.match(app, /summary = liveInspectionSummary\(run, step, attempt, summary\)/);
  assert.match(app, /function artifactBodyKey\(ticketId, runId, artifactId\)/);
  assert.match(app, /artifactBodyKey\(run\?\.id, run\?\.runId, artifact\?\.id\)/);
  assert.match(app, /hydrateArtifact\(run, promptArtifact\)/);
  assert.match(app, /data-view-artifact/);
  assert.match(app, /event\.type === "prompt" && activeTab === "prompt"\) renderInspectorPreservingContext\(\)/);
  assert.match(app, /event\.type !== "text_delta"\) renderInspectorPreservingContext\(\)/);
  assert.match(app, /activeTab === "prompt"\) renderInspectorPreservingContext\(\)/);
  assert.match(app, /function truncatedResourceWarning\(resource, tab\)/);
  assert.match(app, /const warning = resource\.state === "truncated" \? truncatedResourceWarning\(resource, tab\) : ""/);
  assert.match(app, /\$\{warning\}<section class="run-events"/);
  assert.match(app, /\$\{warning\}<section class="attempt-checks"/);
  assert.match(app, /\$\{warning\}<section class="attempt-trace"/);
  assert.match(app, /\$\{warning\}<article class="artifact"/);
  assert.match(app, /data-select-artifact="\$\{escapeHtml\(artifact\.id\)\}"/);
  assert.match(app, /workflow is not failed/);
  assert.match(app, /const status = \$\("\.transport-status"\)/);
  assert.match(app, /if \(transportState !== "connected"\) return/);
  assert.match(styles, /button:focus-visible/);
  assert.match(styles, /attempt-truncation-warning/);
  assert.match(styles, /transport-status/);
});

test("seed writes JsonStore state the daemon can reload", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-seed-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-seed-cwd-"));
  try {
    const empty = await writeSeed({ dataDir, cwd, scenario: "empty" });
    assert.equal(empty.ticketId, null);
    const clarifying = await writeSeed({ dataDir, cwd, scenario: "clarifying" });
    const written = JSON.parse(await readFile(join(dataDir, "state-v3.json"), "utf8"));
    assert.equal(written.ticketRuns[clarifying.ticketId].status, "clarifying");
    assert.equal(written.ticketRuns[clarifying.ticketId].stages[0].id, "requirements");
    const reloaded = await new JsonStore(join(dataDir, "state-v3.json"), cwd).init();
    assert.equal(reloaded.ticketRuns[clarifying.ticketId].status, "interrupted");
    const approval = await writeSeed({ dataDir, cwd, scenario: "plan-approval" });
    const plan = (await new JsonStore(join(dataDir, "state-v3.json"), cwd).init()).ticketRuns[approval.ticketId];
    assert.equal(plan.status, "awaiting_approval");
    assert.equal(plan.checkpoint.kind, "awaiting_approval");
    assert.ok(plan.plan.nodes.length);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("observability seed retains deterministic parallel, failed, corrected, handoff, truncated, and unavailable records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-observability-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-observability-cwd-"));
  try {
    const result = await writeSeed({ dataDir, cwd, scenario: "observability" });
    const run = JSON.parse(await readFile(join(dataDir, "state-v3.json"), "utf8")).ticketRuns[result.ticketId];
    const [foundation, parallel] = run.plan.nodes;
    assert.equal(run.status, "running");
    assert.deepEqual(parallel.children.map((step) => step.status), ["running", "running"]);
    assert.deepEqual(foundation.attempts.map((attempt) => [attempt.attemptId, attempt.status]), [
      ["foundation-original", "failed"], ["foundation-correction", "verified"]
    ]);
    assert.equal(foundation.attempts[0].rawOutput.length, 100000);
    assert.equal(foundation.attempts[1].verification.checks.status, "passed");
    assert.equal(run.stages.find((stage) => stage.id === "verify").status, "completed");
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "handoff"), true);
    assert.equal(run.activeRuns.api.lastEvent, "Waiting for first API event");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("observability capture writes desktop and mobile PNGs and its repository-owned reports", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "agent-plan-observability-evidence-"));
  try {
    const result = await captureObservability({
      evidenceDir,
      withServer: async (fn) => fn("http://127.0.0.1:4317/"),
      capture: async ({ path, width, height }) => {
        await writeFile(path, `PNG ${width}x${height}`);
        return path;
      }
    });
    assert.deepEqual(result.captures.map(({ name, width, height }) => [name, width, height]), [
      ["desktop", 1440, 900], ["mobile", 390, 844]
    ]);
    assert.match(await readFile(join(evidenceDir, "screenshot-capture-report.txt"), "utf8"), /mobile: 390x844/);
    assert.match(await readFile(join(evidenceDir, "observable-workflow-regression-report.txt"), "utf8"), /truncated output/);
    const manifest = JSON.parse(await readFile(join(evidenceDir, "seeded-observability-scenarios.json"), "utf8"));
    assert.equal(manifest.scenario, "observability");
    assert.equal((await readFile(join(evidenceDir, "observability-desktop.png"), "utf8")), "PNG 1440x900");
    assert.equal((await readFile(join(evidenceDir, "observability-mobile.png"), "utf8")), "PNG 390x844");
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("seed and test CLIs list without running the suite", async () => {
  const seed = capture();
  assert.equal(await runSeed(["--list"], seed), 0);
  assert.match(seed.text(), /plan-approval/);
  const list = capture();
  assert.equal(await runTests(["--list"], list), 0);
  assert.match(list.text(), /test\/plan.test.js/);
});
