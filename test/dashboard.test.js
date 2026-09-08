import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { normalizePlan } from "../src/plan.js";
import { capturePage } from "../scripts/screenshot.mjs";
import { invoke, mockHarness, seedRun, withDaemon, waitFor } from "./helpers.js";

// Exercise actual forms, browser validation, SSE deltas and persisted artifacts.
test("dashboard closes dialogs, streams clarify/explore, shows artifacts and clears TEXT tasks", { timeout: 60000 }, async () => {
  let clarifyEvent, finishClarify, exploreEvent, finishExplore;
  const harness = {
    ...mockHarness(),
    async clarifyRequirements({ onEvent }) {
      clarifyEvent = onEvent;
      await new Promise((resolve) => { finishClarify = resolve; });
      return { artifact: "# Requirements\n\nKeep the new project simple.", questions: [], sessionFile: null };
    },
    async exploreTicket({ onEvent }) {
      exploreEvent = onEvent;
      await new Promise((resolve) => { finishExplore = resolve; });
      return { artifact: "# Exploration\n\nThe new repository is ready.", questions: ["Use the proposed structure?"], sessionFile: null };
    },
    async lookAheadTickets() { return { artifact: "# Look ahead\n\nNo related tasks." }; }
  };
  await withDaemon(async (daemon) => {
    if (!daemon.server.listening) await once(daemon.server, "listening");
    const url = `http://127.0.0.1:${daemon.server.address().port}`;
    await capturePage({
      url,
      interact: async ({ evaluate }) => {
        const check = async (expression) => waitFor(async () => assert.equal(await evaluate(expression), true), { timeoutMs: 5000 });
        await check('Boolean(document.querySelector("#free-text-open"))');
        // Empty required fields and invalid input must never block Close.
        for (const id of ["workspace", "tracker", "free-text", "local-load", "plan", "restart"]) {
          await evaluate(`document.querySelector('#${id}-dialog').showModal(); document.querySelector('#${id}-dialog [data-close-dialog]').click()`);
          assert.equal(await evaluate(`document.querySelector('#${id}-dialog').open`), false);
        }
        await evaluate(`document.querySelector('#free-text-open').click(); document.querySelector('[name=description]').value = 'Browser regression task'; document.querySelector('#free-text-form button[type=submit]').click()`);
        await check('!document.querySelector("#free-text-dialog").open');
        await waitFor(() => assert.ok(clarifyEvent));
        assert.equal(daemon.store.read().ticketRuns[daemon.store.read().selectedTicketId].status, "clarifying");
        clarifyEvent({ type: "text_delta", delta: "Shaping the requested feature." });
        await check('document.querySelector("#plan-tree [data-stage-output]")?.textContent.includes("Shaping the requested feature.")');
        await evaluate('location.reload()');
        await check('document.querySelector("#plan-tree [data-stage-output]")?.textContent.includes("Shaping the requested feature.")');
        finishClarify();
        await check('Boolean(document.querySelector("[data-clarify]"))');
        await check('document.querySelector("#plan-tree .stage-artifacts")?.textContent.includes("requirements-draft.md")');
        await evaluate(`const artifact = [...document.querySelectorAll('[data-select-artifact]')].find(el => el.textContent.includes('requirements-draft.md')); artifact.click()`);
        await check('document.querySelector("#plan-tree .artifact-preview")?.textContent.includes("Keep the new project simple.")');
        await evaluate(`document.querySelector('[data-clarify] button[type=submit]').click()`);
        await waitFor(() => assert.ok(exploreEvent), { timeoutMs: 5000 });
        await check('document.querySelector("#inspector h2")?.textContent.includes("Explor")');
        exploreEvent({ type: "text_delta", delta: "Inspecting the initialized repository." });
        await check('document.querySelector("#plan-tree [data-stage-output]")?.textContent.includes("Inspecting the initialized repository.")');
        if (process.env.AGENT_PLAN_DASHBOARD_PROOF) await capturePage({
          url, out: `${process.env.AGENT_PLAN_DASHBOARD_PROOF}-stream.png`,
          interact: async ({ evaluate: inspect }) => {
            exploreEvent({ type: "text_delta", delta: "Mapping the implementation and tests before proposing changes." });
            await waitFor(async () => assert.match(await inspect('document.querySelector("#plan-tree [data-stage-output]")?.textContent || ""'), /Mapping the implementation/));
          }
        });
        finishExplore();
        await check('document.querySelector("#plan-tree .stage-artifacts")?.textContent.includes("implementation-delta.md")');
        await check('document.querySelector("#plan-tree .artifact-preview")?.textContent.includes("The new repository is ready.")');
        await evaluate('location.reload()');
        await check('document.querySelector("#plan-tree [data-stage-output]")?.textContent.includes("Inspecting the initialized repository.")');
        if (process.env.AGENT_PLAN_DASHBOARD_PROOF) await capturePage({ url, out: `${process.env.AGENT_PLAN_DASHBOARD_PROOF}-artifacts.png` });
        await evaluate(`document.querySelector('#clear-queue').click(); document.querySelector('#clear-queue').click()`);
        await check('document.querySelectorAll(".ticket-card").length === 0');
        assert.equal(Object.keys(daemon.store.read().retainedRuns).length, 1);
        await evaluate('location.reload()');
        await check('document.querySelector("#ticket-list")?.textContent.includes("No tickets")');
        assert.equal(await evaluate('document.querySelectorAll(".ticket-card").length'), 0);
      }
    });
  }, { harness, listen: true });
});


test("selected implementation worker streams in the main window and survives reload", { timeout: 30000 }, async () => {
  let emit;
  const harness = { ...mockHarness(), async runStep({ onEvent, signal }) {
    emit = onEvent;
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  await withDaemon(async (daemon) => {
    if (!daemon.server.listening) await once(daemon.server, "listening");
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build feature", status: "review_ready", permission: "write", writeScope: "src", attempts: [] }] });
    const id = await seedRun(daemon, { status: "awaiting_step_review", plan, checkpoint: { id: "review", kind: "step_review", stepId: "build", title: "Review" } });
    const work = invoke(daemon, "POST", `/api/tickets/${id}/steps/build/changes`, { body: { feedback: "Implement the feature" } });
    await waitFor(() => assert.ok(emit));
    try {
      await capturePage({ url: `http://127.0.0.1:${daemon.server.address().port}`, interact: async ({ evaluate }) => {
        const check = (expression) => waitFor(async () => assert.equal(await evaluate(expression), true), { timeoutMs: 5000 });
        await check('Boolean(document.querySelector("[data-worker-output]"))');
        emit({ type: "text_delta", delta: "Implementing the feature now." });
        await check('document.querySelector("#plan-tree [data-worker-output]")?.textContent.includes("Implementing the feature now.")');
        await evaluate('location.reload()');
        await check('document.querySelector("#plan-tree [data-worker-output]")?.textContent.includes("Implementing the feature now.")');
        emit({ type: "text_delta", delta: " Checking the result." });
        await check('document.querySelector("#plan-tree [data-worker-output]")?.textContent.includes("Implementing the feature now. Checking the result.")');
      } });
    } finally {
      await invoke(daemon, "POST", `/api/tickets/${id}/cancel`, { body: {} });
      await work;
    }
  }, { harness, listen: true });
});
