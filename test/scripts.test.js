import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectApp } from "../scripts/inspect.js";
import { runNav } from "../scripts/nav.mjs";
import { runSeed } from "../scripts/seed.mjs";
import { runTests } from "../scripts/test.mjs";
import { JsonStore } from "../src/store.js";
import { writeSeed } from "./helpers.js";

function capture() {
  const chunks = [];
  return { stdout: { write(value) { chunks.push(value); } }, text: () => chunks.join("") };
}

test("nav reads API, UI, CLI, and stages from source", async () => {
  const app = await inspectApp();
  assert.ok(app.routes.some((route) => route.method === "GET" && route.path === "/api/health"));
  assert.ok(app.routes.some((route) => route.method === "POST" && route.path === "/api/tickets/:id/approve"));
  assert.ok(app.routes.some((route) => route.method === "POST" && route.path === "/api/tickets/:id/steps/:id/:decision"));
  assert.ok(app.ui.dialogs.includes("workspace-dialog"));
  assert.ok(app.cli.includes("wait"));
  assert.deepEqual(app.stages, ["requirements", "explore", "design", "implement", "verify", "handoff"]);
});

test("nav CLI prints a map and json", async () => {
  const printed = capture();
  assert.equal(await runNav([], printed), 0);
  assert.match(printed.text(), /GET\s+\/api\/health/);
  const json = capture();
  assert.equal(await runNav(["routes", "--json"], json), 0);
  assert.ok(JSON.parse(json.text()).some((route) => route.path === "/api/state"));
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

test("seed and test CLIs list without running the suite", async () => {
  const seed = capture();
  assert.equal(await runSeed(["--list"], seed), 0);
  assert.match(seed.text(), /plan-approval/);
  const list = capture();
  assert.equal(await runTests(["--list"], list), 0);
  assert.match(list.text(), /test\/plan.test.js/);
});
