import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureTicketProof } from "../scripts/capture-ticket-proof.mjs";

test("stable journey bindings survive criterion wording changes and reject missing or duplicate mappings", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "journey-map-"));
  const scenario = { id: "open-panel", commands: [["workspace", "open"]], assertions: [{ selector: "#workspace-dialog", text: "Repository" }] };
  const options = { url: "http://127.0.0.1:1", ticketId: "ticket", runId: "run", evidenceDir, scenarios: [scenario],
    criteria: [{ id: "ac-panel", text: "Reworded acceptance criterion", journeyId: "open-panel" }], journey: async () => {} };
  try {
    const result = await captureTicketProof(options);
    assert.equal(result.captures.length, 2);
    assert.deepEqual(result.captures[0].criterionIds, ["ac-panel"]);
    assert.equal(result.captures[0].journeyId, "open-panel");
    await assert.rejects(captureTicketProof({ ...options, scenarios: [scenario, scenario] }), /unique/);
    await assert.rejects(captureTicketProof({ ...options, criteria: [{ ...options.criteria[0], journeyId: "missing" }] }), /Define one UI CLI scenario/);
  } finally { await rm(evidenceDir, { recursive: true, force: true }); }
});
