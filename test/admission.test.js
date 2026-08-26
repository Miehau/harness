import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidates, occupiedTicketIds, ticketReady } from "../src/admission.js";

const ticket = (id, name = "Ready", priority = null, type = "unstarted") => ({ id, priority, state: { name, type } });

test("only unblocked ready-column tickets are eligible for automatic admission", () => {
  assert.equal(ticketReady(ticket("ready")), true);
  assert.equal(ticketReady(ticket("backlog", "Backlog")), false);
  assert.equal(ticketReady(ticket("active", "In progress", 1, "started")), false);
});

test("pending approval reserves capacity and admission follows ticket priority", () => {
  const state = { ticketRuns: {
    pending: { id: "pending", status: "awaiting_approval" },
    old: { id: "old", status: "completed" }
  } };
  assert.deepEqual([...occupiedTicketIds(state)], ["pending"]);
  assert.deepEqual(admissionCandidates([ticket("low", "Ready", 4), ticket("high", "Ready", 1)], state, 2).map(({ id }) => id), ["high"]);
});
