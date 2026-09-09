import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { normalizePlan } from "../src/plan.js";
import { invoke, seedRun, withDaemon } from "../test/helpers.js";
import { runJourney, runUi, validateJourney } from "./ui.mjs";
import { captureTicketProof } from "../scripts/capture-ticket-proof.mjs";
import { prepareVisualEvidence } from "../src/visual-evidence.js";

test("UI CLI validates commands and exercises real task navigation and creation", { timeout: 60000 }, async () => {
  assert.throws(() => validateJourney([["tasks", "remove", "unknown"]]), /Unknown UI command/);
  assert.throws(() => validateJourney([["tasks", "open"]]), /Unknown UI command/);
  await assert.rejects(runUi(["tasks", "list", "--wat"]), /Invalid option/);
  await withDaemon(async (daemon, { dataDir }) => {
    const id = await seedRun(daemon, { plan: normalizePlan({ nodes: [{ id: "build", title: "Build something" }] }) });
    await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${daemon.server.address().port}`;
    const screenshot = join(dataDir, "cli-journey.png");
    const video = join(dataDir, "cli-journey.webm");
    // A fast read-only journey must still wait for the recorder's first frame.
    const shortVideo = join(dataDir, "short-journey.webm");
    await runJourney({ url, video: shortVideo, commands: [["tasks", "list"]] });
    assert.deepEqual((await readFile(shortVideo)).subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const result = await runJourney({ url, screenshot, video,
      commands: [["tasks", "list"], ["tasks", "open", id], ["stage", "requirements"], ["tab", "details"]],
      assertions: [{ selector: "#ticket-header", text: daemon.store.read().ticketRuns[id].ticket.title }]
    });
    assert.ok((await readFile(video)).length > 1000);
    const decoded = await prepareVisualEvidence([{ name: "cli-journey.webm", path: video, mediaKind: "video", mediaType: "video/webm" }], {
      evidenceDir: dataDir, run: (command, args) => promisify(execFile)(command, args, { timeout: 30000 })
    });
    const frames = decoded.filter((item) => item.videoPath === video);
    assert.ok(frames.length > 0 && frames.length <= 8);
    assert.deepEqual((await readFile(frames[0].path)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(result.results[0].some((item) => item.id === id));
    assert.equal(result.results[1].selected, id);
    assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.rejects(runJourney({ url, commands: [["click", "This button does not exist"]] }), /Missing, disabled or ambiguous/);
    const added = await runJourney({ url, commands: [["tasks", "add", "UI CLI test task"]], assertions: [{ selector: "#ticket-header h2", text: "UI CLI test task" }] });
    assert.equal(added.results[0].added, "UI CLI test task");
    assert.ok(Object.values(daemon.store.read().ticketRuns).some((run) => run.ticket.title === "UI CLI test task"));
    const criterion = { id: "criterion-select", text: "Selected task title is visible", requiresVideoEvidence: true, journeyId: "selected-task" };
    const scenario = { id: "selected-task", criterion: "Original wording before revision", commands: [["tasks", "open", "$ticketId"]], assertions: [{ selector: "#ticket-header h2", text: daemon.store.read().ticketRuns[id].ticket.title }] };
    await assert.rejects(captureTicketProof({ url, ticketId: id, runId: "run-1", evidenceDir: dataDir, criteria: [criterion], scenarios: [] }), /Define one UI CLI scenario/);
    const manifest = await captureTicketProof({ url, ticketId: id, runId: "run-1", evidenceDir: dataDir, criteria: [criterion], scenarios: [scenario] });
    assert.equal(manifest.captures.length, 4);
    assert.equal(manifest.captures.filter((item) => item.path.endsWith(".webm")).length, 2);
    assert.deepEqual(manifest.captures[0].criterionIds, [criterion.id]);
    assert.deepEqual(manifest.captures[0].commands, [["tasks", "open", id]]);
    assert.deepEqual(manifest.captures[0].assertions, scenario.assertions);
    assert.equal(manifest.identity.runId, "run-1");
  });
});

test("UI CLI opens the workspace policy dialog and reports invalid extra roots", { timeout: 60000 }, async () => {
  assert.throws(() => validateJourney([["workspace", "extra-root", "/tmp/x", "write-only"]]), /Unknown UI command/);
  assert.doesNotThrow(() => validateJourney([["workspace", "open"]], [{ selector: ".extra-root-path", value: "/tmp/x" }]));
  await withDaemon(async (daemon) => {
    const extra = await mkdtemp(join(tmpdir(), "agent-plan-ui-extra-"));
    try {
      const saved = await invoke(daemon, "POST", "/api/workspace/access-policy", {
        body: { extraRoots: [{ path: extra, mode: "read-only" }] }
      });
      assert.equal(saved.status, 200);
      await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${daemon.server.address().port}`;
      const opened = await runJourney({
        url,
        commands: [["workspace", "open"]],
        assertions: [
          { selector: "#workspace-dialog", text: "Primary repository (not removable)" },
          { selector: "#access-mode-status", text: "Restricted" },
          { selector: "#access-policy-form", text: "read-only" }
        ]
      });
      assert.ok(opened.commands);
      const scenarios = JSON.parse(await readFile(new URL("./ui-scenarios.json", import.meta.url), "utf8"));
      const savedRootsScenario = scenarios.find((scenario) => scenario.criterion === "The workspace dialog shows primary, extra roots as saved, and the effective restricted or Any access mode.");
      assert.ok(savedRootsScenario, "ticket-bound proof scenario persists and reloads an extra root");
      const savedRoots = await runJourney({
        url,
        commands: savedRootsScenario.commands.map((command) => command.map((arg) => arg === "$evidenceRoot" ? extra : arg)),
        assertions: savedRootsScenario.assertions.map((assertion) => ({
          ...assertion,
          value: assertion.value === "$evidenceRoot" ? extra : assertion.value
        }))
      });
      assert.ok(savedRoots.assertions);
      assert.ok(!scenarios.some((scenario) => /Two store primaries|operator CLI/.test(scenario.criterion)), "UI screenshots do not claim persistence or CLI equivalence");
      const invalidScenario = scenarios.find((scenario) => scenario.criterion.startsWith("Invalid extra roots"));
      const invalid = await runJourney({ url, commands: invalidScenario.commands, assertions: invalidScenario.assertions });
      assert.ok(invalid.assertions);
      const keyboard = await runJourney({
        url,
        commands: [
          ["workspace", "open"],
          ["workspace", "extra-root", "docs", "read-only"],
          ["workspace", "keyboard"]
        ],
        assertions: [
          { selector: "#access-mode-status", text: "Effective mode" },
          { selector: "#save-access-policy", text: "Save access policy" }
        ]
      });
      assert.ok(keyboard.assertions);
      const previous = await invoke(daemon, "GET", "/api/workspace/access-policy");
      assert.equal(previous.json.mode, "restricted");
      assert.equal(previous.json.extraRoots.length, 1);
      assert.equal(previous.json.extraRoots[0].displayPath, extra);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

test("journeys reject covered controls and broken keyboard navigation, retaining failure evidence", { timeout: 60000 }, async () => {
  const { capturePage } = await import("../scripts/screenshot.mjs");
  await withDaemon(async (daemon, { dataDir }) => {
    await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${daemon.server.address().port}`;
    const inject = (script) => (options) => capturePage({ ...options, interact: async (browser) => {
      await browser.evaluate(script);
      await options.interact(browser);
    } });
    const screenshot = join(dataDir, "covered.png");
    await assert.rejects(runJourney({ url, screenshot, commands: [["workspace", "open"]],
      capture: inject('document.body.insertAdjacentHTML("beforeend", \'<div style="position:fixed;inset:0;z-index:999999;background:white"></div>\')')
    }), /covered/);
    assert.ok((await readFile(screenshot)).length > 100);
    assert.match(JSON.parse(await readFile(`${screenshot}.failure.json`, "utf8")).error, /covered/);
    await assert.rejects(runJourney({ url, commands: [["workspace", "open"], ["workspace", "keyboard"]],
      capture: inject('document.querySelector("#access-any").tabIndex = -1')
    }), /Keyboard cannot reach.*access-any/);
  });
});
