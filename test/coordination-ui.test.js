import test from "node:test";
import assert from "node:assert/strict";
import { coordinationPanel } from "../public/coordination.js";
import { runCli } from "../src/cli.js";

test("coordination displays durable decisions, before/after, message delivery and archived read-only state", () => {
  const before = { nodes: [{ id: "a", title: "Build API", description: "Old assignment", agentId: "api", status: "ready" }] };
  const run = { plan: before, planRevision: 2, coordination: {
    messages: [{ text: "<script>unsafe</script>", from: { stepId: "a", attemptId: "attempt-1" }, to: { stepId: "b" }, state: "uncertain", reason: "Daemon restarted" }],
    conflicts: [{ id: "c", summary: "Shared interface", stepIds: ["a"], status: "open" }],
    decisions: [{ summary: "Use stable IDs", reason: "Avoid migration", planRevision: 2, stepIds: ["a"], conflictIds: ["c"] }],
    revisions: [{ id: "r", status: "proposed", reason: "Sequence API first", baseRevision: 2, affectedStepIds: ["a"], changes: [{ stepId: "a", description: "New assignment" }], before, after: before, workPreparation: { status: "captured", repositories: [{ stepIds: ["a"], files: ["src/a.js"], artifact: { id: "patch-a" } }] } }]
  } };
  const html = coordinationPanel(run);
  for (const text of ["Old assignment", "New assignment", "Use stable IDs", "uncertain", "Daemon restarted", "Build API", "attempt-1", "Accept adjustment", "Record agreement", "latest accepted baseline", "Inspect saved patch", "Acceptance can be retried"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  run.coordination.applyingRevisionId = "r";
  run.coordination.revisions[0].applyError = "Baseline preparation failed";
  const recovering = coordinationPanel(run);
  assert.match(recovering, /Baseline preparation failed/);
  assert.match(recovering, /Retry acceptance/);
  assert.match(recovering, /type="submit" disabled>Save agreement/);
  assert.match(recovering, /type="submit" disabled>Reject adjustment/);
  assert.match(recovering, /type="submit" disabled>Propose adjustment/);
  assert.match(recovering, /data-revision-id="r" >Retry acceptance/);
  const archived = coordinationPanel(run, true);
  assert.ok(!archived.includes("data-coordination-action"));
  assert.ok(!archived.includes("data-coordination-form"));
});

test("coordination CLI sends operator actions through the same endpoints", async () => {
  const calls = [];
  const opts = { env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" }, stdout: { write() {} }, stderr: { write() {} }, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => "{}" };
  } };
  await runCli(["coordination", "show", "ticket"], opts);
  await runCli(["coordination", "propose", "ticket", '{"reason":"Sequence","changes":[]}'], opts);
  await runCli(["coordination", "accept", "ticket", "revision"], opts);
  await runCli(["coordination", "resolve", "ticket", "conflict"], opts);
  await runCli(["coordination", "decide", "ticket", '{"summary":"Agree","conflictIds":["conflict"]}'], opts);
  assert.deepEqual(calls.map((item) => item.url.replace("http://127.0.0.1:4317", "")), ["/api/tickets/ticket/coordination", "/api/tickets/ticket/coordination/revisions", "/api/tickets/ticket/coordination/revisions/revision/accept", "/api/tickets/ticket/coordination/resolve", "/api/tickets/ticket/coordination/decisions"]);
  assert.deepEqual(calls[3].body, { conflictId: "conflict" });
  await assert.rejects(runCli(["coordination", "propose", "ticket", "[]"], opts), /must be an object/);
});

test("dashboard coordination view survives refresh and shows saved agreement after reload", { timeout: 30000 }, async () => {
  const { withDaemon, seedRun, mockHarness, waitFor, invoke } = await import("./helpers.js");
  const { capturePage } = await import("../scripts/screenshot.mjs");
  const { normalizePlan } = await import("../src/plan.js");
  const { once } = await import("node:events");
  await withDaemon(async (daemon) => {
    if (!daemon.server.listening) await once(daemon.server, "listening");
    const plan = normalizePlan({ nodes: [{ id: "api", title: "API worker", status: "ready", agentId: "api-worker", writeScope: "src/api", permission: "write", expectedFiles: ["src/api/index.js"], estimatedChangedLines: 20, acceptanceCriteria: ["API returns stable IDs"] }] });
    const id = await seedRun(daemon, { status: "paused", plan, coordination: { conflicts: [], messages: [], revisions: [], decisions: [{ id: "d", summary: "Keep stable IDs", reason: "Preserve compatibility", stepIds: ["api"], planRevision: 1 }] } });
    await capturePage({ url: `http://127.0.0.1:${daemon.server.address().port}`, interact: async ({ evaluate }) => {
      const check = (expression) => waitFor(async () => assert.equal(await evaluate(expression), true, await evaluate('document.querySelector("#toast")?.textContent + " | " + document.querySelector("#inspector")?.textContent')), { timeoutMs: 5000 });
      await check('Boolean(document.querySelector("[data-tab=coordination]"))');
      await evaluate('document.querySelector("[data-tab=coordination]").click()');
      await check('document.querySelector("#inspector")?.textContent.includes("Keep stable IDs")');
      await evaluate('document.querySelector("[data-coordination-form=conflicts]").closest("details").open = true; document.querySelector("[name=summary]").value = "Draft conflict"');
      await invoke(daemon, "POST", `/api/tickets/${id}/select`, { body: {} });
      await check('document.querySelector("[name=summary]")?.value === "Draft conflict"');
      await evaluate('window.loadedBefore = true; location.reload()');
      await check('!window.loadedBefore && document.querySelector("#inspector")?.textContent.includes("Keep stable IDs")');
      assert.ok(await evaluate('document.querySelector("#inspector").textContent.includes("src/api")'));
      await evaluate('document.querySelector("[data-coordination-form=conflicts]").closest("details").open = true; document.querySelector("[data-coordination-form=conflicts] [name=summary]").value = "Ownership question"; document.querySelector("[name=stepIds] option").selected = true; document.querySelector("[data-coordination-form=conflicts] button").click()');
      await check('document.querySelector("#inspector")?.textContent.includes("Ownership question")');
      await check('Boolean(document.querySelector("[data-coordination-form=decisions]"))');
      await evaluate('{ const form = document.querySelector("[data-coordination-form=decisions]"); form.closest("details").open = true; form.elements.summary.value = "API owns the interface"; form.elements.reason.value = "One owner avoids duplication"; form.querySelector("button").click(); }');
      await check('document.querySelector("#inspector")?.textContent.includes("API owns the interface")');
      await check('!document.querySelector("[data-coordination-form=decisions]")');
      await evaluate('{ const form = document.querySelector("[data-coordination-form=revisions]"); form.closest("details").open = true; form.elements.stepId.value = "api"; form.elements.reason.value = "Assign interface owner"; form.elements.agentId.value = "interface-owner"; form.querySelector("button").click(); }');
      await check('Boolean(document.querySelector("[data-coordination-action=accept]"))');
      await evaluate('document.querySelector("[data-coordination-action=accept]").click()');
      await check('document.querySelector("#inspector")?.textContent.includes("Plan revision 2")');
      assert.equal(daemon.store.read().ticketRuns[id].plan.nodes[0].agentId, "interface-owner");
    } });
  }, { harness: mockHarness(), listen: true });
});
