import test from "node:test";
import assert from "node:assert/strict";
import { invoke, seedRun, withDaemon } from "./helpers.js";

test("a stopped run can override one stage profile without rewriting its audit", async () => {
  await withDaemon(async (daemon) => {
    const id = await seedRun(daemon, { status: "needs_attention" });
    const changed = await invoke(daemon, "POST", `/api/tickets/${encodeURIComponent(id)}/stage-profiles/verification`, {
      body: { model: "gpt-5.6-terra", thinking: "high" }
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.profile.model, "gpt-5.6-terra");
    assert.equal(changed.json.profile.thinking, "high");

    const state = await invoke(daemon, "GET", "/api/state");
    assert.equal(state.json.ticketRuns[id].stageProfiles.verification.model, "gpt-5.6-terra");
    assert.equal(state.json.ticketRuns[id].stageProfiles.implementation.model, "gpt-5.6-terra");
  });
});
