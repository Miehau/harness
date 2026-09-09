import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectReadiness } from "../src/readiness.js";
import { invoke, mockHarness, runAgainstDaemon, waitFor, withDaemon } from "./helpers.js";

test("readiness inspects without mutation and separates machine prerequisites from project capabilities", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "readiness-"));
  const calls = [];
  const options = { cwd, vcsMode: "git", validateModels: async () => {}, execImpl: async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] !== "--version") throw new Error("No baseline");
  } };
  try {
    assert.equal((await inspectReadiness({ ...options, phase: "planning" })).ready, true);
    const report = await inspectReadiness({ ...options, visual: true });
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((c) => c.id === "capture-proof").status, "action_needed");
    assert.equal(report.checks.find((c) => c.id === "jj").status, "not_required");
    assert.ok(calls.every(([cmd]) => cmd === "git"));
    assert.deepEqual(await readdir(cwd), []);
    const missing = await inspectReadiness({ ...options, phase: "planning", vcsMode: "jj", nodeVersion: "22.18.0", validateModels: async () => { throw new Error("Authenticate Pi"); }, execImpl: async () => { throw new Error("ENOENT"); } });
    assert.deepEqual(missing.checks.filter((c) => c.status === "action_needed").map((c) => c.id), ["node", "git", "jj", "models"]);
    await mkdir(join(cwd, ".agent-plan"));
    await writeFile(join(cwd, ".agent-plan/project.json"), JSON.stringify({ commands: { verify: ["node", "verify.mjs"] } }));
    const configured = await inspectReadiness({ ...options, execImpl: async () => {} });
    assert.equal(configured.ready, true);
    assert.equal(configured.checks.find((c) => c.id === "verify").executed, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("doctor and API expose the same readiness report and exit nonzero for incomplete setup", async () => {
  await withDaemon(async (daemon) => {
    const api = await invoke(daemon, "GET", "/api/workspace/readiness?visual=1");
    const cli = await runAgainstDaemon(daemon, ["doctor", "--visual"]);
    assert.equal(api.status, 200);
    assert.deepEqual(cli.json, api.json);
    assert.equal(cli.code, api.json.ready ? 0 : 1);
  });
});

test("missing model authentication blocks requirements before a paid call", async () => {
  let called = false;
  await withDaemon(async (daemon) => {
    const result = await runAgainstDaemon(daemon, ["new", "text", "Readiness regression"]);
    const id = result.json.ticketId;
    await waitFor(() => assert.equal(daemon.store.read().ticketRuns[id].status, "failed"));
    const run = daemon.store.read().ticketRuns[id];
    assert.equal(called, false);
    assert.equal(run.status, "failed");
    assert.match(run.lastError, /Project setup required.*Authenticate Pi/);
  }, { harness: {
    ...mockHarness(),
    inspectModels: async () => { throw new Error("Authenticate Pi"); },
    clarifyRequirements: async () => { called = true; throw new Error("Must not call model"); }
  } });
});
