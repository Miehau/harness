import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectApp, repoRoot } from "../scripts/inspect.js";
import { runNav } from "../scripts/nav.mjs";
import { captureObservability } from "../scripts/capture-observability.mjs";
import { captureFinalProof, captureLiveViewport, cdpConnection, finalProofIdentity, readinessExpression } from "../scripts/capture-final-proof.mjs";
import { runSeed } from "../scripts/seed.mjs";
import { runNode, runTests } from "../scripts/test.mjs";
import { JsonStore } from "../src/store.js";
import { projectInspection } from "../src/inspection.js";
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
  assert.match(styles, /scrollbar-gutter: stable/);
  assert.match(styles, /minmax\(420px, 55%\)/);
  assert.match(app, /run\.workspace\?\.branch\?\.trim\(\)/);
  assert.match(app, /workspace-path-display"\)\.textContent = "Local workspace"/);
  assert.doesNotMatch(app, /workspace-path-display"\)\.textContent = state\.workspace/);
  const html = await readFile(join(repoRoot, "public/index.html"), "utf8");
  assert.match(html, /id="ticket-list"[^>]*aria-label="Tickets and active workers\. Scroll to inspect every worker\."[^>]*tabindex="0"/);
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
    const proof = await writeSeed({ dataDir, cwd, scenario: "proof-review" });
    const proofRun = JSON.parse(await readFile(join(dataDir, "state-v3.json"), "utf8")).ticketRuns[proof.ticketId];
    assert.equal(proofRun.checkpoint.kind, "evidence_review");
    assert.deepEqual(proofRun.stages.filter((stage) => stage.status === "completed").map((stage) => stage.id), ["requirements", "explore", "design", "implement", "verify"]);
    assert.equal(proofRun.artifacts.some((artifact) => artifact.kind === "visual-evidence" && artifact.stageId === "verify"), true);
    const proofInspection = projectInspection(proofRun);
    assert.equal(proofInspection.workers[0].lifecycle, "completed");
    assert.equal(proofInspection.stages.filter((stage) => stage.lifecycle === "completed").length, 5);
    assert.deepEqual(proofInspection.focus, { stageId: "stage:verify", workerId: null, attemptId: null, reason: "final_proof" });
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

test("final proof capture binds desktop and mobile media to the live ticket run", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "agent-plan-final-proof-evidence-"));
  const state = {
    revision: 73,
    ticketRuns: {
      "mea-55": {
        runId: "final-run-17",
        status: "awaiting_evidence_review",
        ticket: { identifier: "MEA-55", title: "Make every workflow step observable and debuggable" },
        checkpoint: { id: "final-proof-review", kind: "evidence_review" }
      }
    }
  };
  try {
    const result = await captureFinalProof({
      evidenceDir, url: "http://127.0.0.1:4317", ticketId: "mea-55", runId: "final-run-17",
      readState: async () => state,
      select: async ({ ticketId }) => { state.selectedTicketId = ticketId; },
      launch: async () => ({ connection: {}, close: async () => {} }),
      captureViewport: async ({ path, width, height, identity }) => {
        await writeFile(path, `PNG ${width}x${height}`);
        return {
          path,
          rendered: {
            ticketIdentifier: identity.ticketIdentifier, ticketTitle: identity.ticketTitle,
            workflow: true, inspector: true, focusedStageId: identity.focusedStageId, focusedInspectorTitle: identity.focusedInspectorTitle, viewport: `${width}x${height}`
          }
        };
      },
      now: () => new Date("2026-09-03T10:08:00.000Z")
    });
    assert.deepEqual(result.captures.map(({ name, width, height }) => [name, width, height]), [
      ["desktop", 1440, 900], ["mobile", 390, 844]
    ]);
    const manifest = JSON.parse(await readFile(join(evidenceDir, "final-proof-manifest.json"), "utf8"));
    assert.deepEqual(manifest.identity, {
      ticketId: "mea-55", ticketIdentifier: "MEA-55", ticketTitle: "Make every workflow step observable and debuggable", runId: "final-run-17", revision: 73,
      checkpointId: "final-proof-review", checkpointKind: "evidence_review", status: "awaiting_evidence_review", focusedStageId: null, focusedInspectorTitle: null
    });
    assert.equal(manifest.capturedAt, "2026-09-03T10:08:00.000Z");
    assert.match(manifest.captures[0].path, /final-mea-55-final-run-17-desktop\.png$/);
    assert.deepEqual(manifest.captures.map(({ rendered }) => rendered.viewport), ["1440x900", "390x844"]);
    assert.equal((await readFile(manifest.captures[1].path, "utf8")), "PNG 390x844");
    assert.throws(() => finalProofIdentity(state, { ticketId: "mea-55", runId: "stale-run" }), /run mismatch/);
    const focused = finalProofIdentity({
      selectedTicketId: "mea-55", ticketRuns: {
        "mea-55": { ...state.ticketRuns["mea-55"], inspectionFocus: { stageId: "stage:verify", workerId: "worker:proof", reason: "active" }, stages: [{ id: "verify", title: "Review & verify" }], plan: { nodes: [{ id: "proof", title: "Run final verification" }] } }
      }
    }, { ticketId: "mea-55", runId: "final-run-17" });
    assert.deepEqual({ stage: focused.focusedStageId, inspector: focused.focusedInspectorTitle }, { stage: "stage:verify", inspector: "Run final verification" });
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("final proof readiness binds selected dashboard DOM anchors without mutating mobile presentation", async () => {
  const expression = readinessExpression({ ticketIdentifier: "MEA-55", ticketTitle: "Observable workflow" });
  const html = await readFile(join(repoRoot, "public/index.html"), "utf8");
  assert.match(expression, /#ticket-header \.eyebrow/);
  assert.match(expression, /#ticket-header h2/);
  assert.match(expression, /\.workflow-stages \.eyebrow/);
  assert.match(expression, /#inspector/);
  assert.match(html, /<section\s+id="ticket-header"(?=[\s>])/);
  assert.match(html, /<section\s+id="inspector"(?=[\s>])/);
  assert.equal(html.includes('id="inspector-panel"'), false);
  assert.equal(expression.includes("style.zoom"), false);
  assert.equal(expression.includes("finalProofScale"), false);

  const visible = (innerText) => ({ innerText, getBoundingClientRect: () => ({ width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 }) });
  const anchors = {
    "#ticket-header .eyebrow": [visible("MEA-55")],
    "#ticket-header h2": [visible("Observable workflow")],
    ".workflow-stages .eyebrow": [visible("WORKFLOW MAP")],
    "#inspector": visible("Selected worker details")
  };
  const rendered = Function("document", "getComputedStyle", `return ${expression}`)(
    {
      querySelectorAll: (selector) => anchors[selector] || [],
      querySelector: (selector) => anchors[selector] || null
    },
    () => ({ visibility: "visible", display: "block" })
  );
  assert.deepEqual(rendered, {
    ticketIdentifier: "MEA-55", ticketTitle: "Observable workflow", workflow: true, inspector: true, focusedStageId: null, focusedInspectorTitle: null,
    frame: { identity: { top: 0, right: 1, bottom: 1, left: 0 }, workflow: { top: 0, right: 1, bottom: 1, left: 0 }, inspector: { top: 0, right: 1, bottom: 1, left: 0 } }
  });
});

test("final proof readiness rejects a stale inspector when active stage focus differs", () => {
  const expression = readinessExpression({ ticketIdentifier: "MEA-55", ticketTitle: "Observable workflow", focusedStageId: "stage:verify", focusedInspectorTitle: "Review & verify" });
  const visible = (innerText, attributes = {}) => ({
    innerText, dataset: attributes.dataset || {}, getAttribute: (name) => attributes[name] || null,
    getBoundingClientRect: () => ({ width: 1, height: 1 })
  });
  const anchors = {
    "#ticket-header .eyebrow": [visible("MEA-55")],
    "#ticket-header h2": [visible("Observable workflow")],
    ".workflow-stages .eyebrow": [visible("WORKFLOW MAP")],
    ".workflow-stage": [visible("Verify", { dataset: { stage: "verify" }, "aria-selected": "false" })],
    "#inspector": visible("Handoff"),
    "#inspector h2": [visible("Handoff")] 
  };
  const render = () => Function("document", "getComputedStyle", `return ${expression}`)(
    { querySelectorAll: (selector) => anchors[selector] || [], querySelector: (selector) => anchors[selector] || null },
    () => ({ visibility: "visible", display: "block" })
  );
  assert.equal(render(), null);
  anchors[".workflow-stage"][0] = visible("Verify", { dataset: { stage: "verify" }, "aria-selected": "true" });
  assert.equal(render(), null);
  anchors["#inspector h2"] = [visible("Review & verify")];
  assert.equal(render().focusedStageId, "stage:verify");
});

test("mobile final proof captures the same rendered CDP page at its natural full-page layout", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "agent-plan-final-proof-mobile-"));
  const path = join(evidenceDir, "mobile.png");
  const calls = [];
  const connection = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Runtime.evaluate") return { result: { value: { ticketIdentifier: "MEA-55", ticketTitle: "Observable workflow", workflow: true, inspector: true, focusedStageId: null, focusedInspectorTitle: null, frame: { identity: { top: 0, right: 390, bottom: 50, left: 0 }, workflow: { top: 100, right: 390, bottom: 200, left: 0 }, inspector: { top: 300, right: 390, bottom: 600, left: 0 } } } } };
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 390, height: 1840 } };
      if (method === "Page.captureScreenshot") return { data: Buffer.from("natural-mobile-proof").toString("base64") };
      return {};
    }
  };
  try {
    const captured = await captureLiveViewport({
      connection, url: "http://127.0.0.1:4317", path, width: 390, height: 844,
      identity: { ticketIdentifier: "MEA-55", ticketTitle: "Observable workflow" }
    });
    assert.equal(captured.rendered.workflow, true);
    assert.equal(await readFile(path, "utf8"), "natural-mobile-proof");
    const screenshot = calls.find(({ method }) => method === "Page.captureScreenshot");
    assert.deepEqual(screenshot.params, {
      format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 390, height: 1840, scale: 1 }
    });
    assert.ok(calls.findIndex(({ method }) => method === "Runtime.evaluate") < calls.findIndex(({ method }) => method === "Page.getLayoutMetrics"));
    assert.ok(calls.findIndex(({ method }) => method === "Page.getLayoutMetrics") < calls.findIndex(({ method }) => method === "Page.captureScreenshot"));
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test("CDP proof transport uses NUL frames and resolves matching responses", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk;
    const request = JSON.parse(written.slice(0, -1));
    input.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\0`);
  });
  const connection = cdpConnection({ input, output, timeoutMs: 100 });
  try {
    assert.deepEqual(await connection.send("Target.createTarget", { url: "about:blank" }), { ready: true });
    assert.match(written, /Target.createTarget/);
    assert.equal(written.endsWith("\0"), true);
  } finally {
    connection.close();
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
