import test from "node:test";
import assert from "node:assert/strict";
import { inFlightMergeStatuses, inFlightRunStatuses, stepStatusList, terminalRunStatuses } from "../src/run-status.js";

test("named status lists keep the production string values", () => {
  assert.ok(inFlightRunStatuses.includes("clarifying"));
  assert.ok(inFlightRunStatuses.includes("waiting_for_merge"));
  assert.ok(inFlightMergeStatuses.includes("addressing_feedback"));
  assert.ok(terminalRunStatuses.includes("interrupted"));
  assert.ok(stepStatusList.includes("review_ready"));
  assert.equal(new Set(inFlightRunStatuses).size, inFlightRunStatuses.length);
});
