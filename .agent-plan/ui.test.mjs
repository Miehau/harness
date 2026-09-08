import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePlan } from "../src/plan.js";
import { seedRun, withDaemon } from "../test/helpers.js";
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
    const criterion = { id: "criterion-select", text: "Selected task title is visible", requiresVideoEvidence: true };
    const scenario = { criterion: criterion.text, commands: [["tasks", "open", "$ticketId"]], assertions: [{ selector: "#ticket-header h2", text: daemon.store.read().ticketRuns[id].ticket.title }] };
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
