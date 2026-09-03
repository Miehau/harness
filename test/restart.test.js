import test from "node:test";
import assert from "node:assert/strict";
import { invoke, seedRun, withDaemon } from "./helpers.js";

test("fresh restart keeps a free-text local ticket out of the fixture path", async () => {
  await withDaemon(async (daemon) => {
    const ticket = {
      id: "local-text-1", identifier: "TEXT-1", title: "Add verification",
      description: "Reuse existing checks.", source: "local",
      state: { name: "Free text", type: "local" }, team: { name: "Local" }
    };
    const id = await seedRun(daemon, { ticket, status: "awaiting_requirements" });
    const response = await invoke(daemon, "POST", `/api/tickets/${id}/restart`, {
      body: { target: "fresh", confirmed: true }
    });

    assert.equal(response.status, 202);
    const deadline = Date.now() + 3000;
    let restarted;
    while (Date.now() < deadline) {
      restarted = daemon.store.read().ticketRuns[id];
      if (restarted.checkpoint?.kind === "requirements_review") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(restarted.ticket.description, "Reuse existing checks.");
    assert.equal(restarted.checkpoint.kind, "requirements_review");
    assert.equal(restarted.checkpoint.title, "Approve ticket requirements");
  });
});
