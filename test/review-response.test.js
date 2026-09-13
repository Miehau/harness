import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReviewResponse } from "../src/review-response.js";
import { PiHarness } from "../src/pi-harness.js";

test("review contract lists all missing coverage and rejects malformed citations", () => {
  const context = { role: "requirements", criteria: [{ id: "a" }, { id: "b" }, { id: "old", scope: "step" }], artifacts: [] };
  assert.throws(() => validateReviewResponse({ summary: "Reviewed", findings: [], criterionResults: [] }, context), /a: expected one verdict.*b: expected one verdict/);
  assert.throws(() => validateReviewResponse({ summary: "Reviewed", findings: [], criterionResults: [{ criterionId: "a", status: "verified", evidence: [{ type: "artifact" }] }] }, context), /exact current artifactId/);
  const results = ["a", "b"].map((criterionId) => ({ criterionId, status: "blocked", evidence: [] }));
  assert.doesNotThrow(() => validateReviewResponse({ summary: "Reviewed", findings: [], criterionResults: results }, context));
  for (const criterionResults of [[null], [{ criterionId: "a", status: "verified", evidence: 4 }], [{ criterionId: "a", status: "verified", evidence: [null] }]]) {
    assert.throws(() => validateReviewResponse({ summary: "Reviewed", findings: [], criterionResults }, context), (error) => error.code === "MODEL_RESPONSE_ERROR");
  }
});

test("repair stays in the same session; completed roles survive sibling failure and invalidate on changed inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = {};
  let sessions = 0;
  const harness = new PiHarness({ dataDir: root });
  harness.sdk = async () => ({
    SessionManager: { create: () => ({}) },
    createAgentSession: async () => {
      sessions++;
      let role;
      return { session: {
        state: { messages: [] }, setSessionName(name) { role = name.split(":")[1]; }, subscribe() { return () => {}; }, dispose() {},
        async prompt(prompt) {
          calls[role] = (calls[role] || 0) + 1;
          if (role === "integration") throw new Error("Provider unavailable");
          const repair = calls[role] === 2;
          if (repair) assert.match(prompt, /Repair only the listed contract errors/);
          const criterionResults = calls[role] === 1 ? [] : [{ criterionId: "a", status: "verified", evidence: [{ type: "check", scope: "final" }] }];
          this.state.messages.push({ role: "assistant", content: [{ type: "text", text: JSON.stringify({ summary: "Reviewed", findings: [], criterionResults }) }] });
        }
      } };
    }
  });
  const input = { cwd: root, ticket: { id: "T" }, plan: { nodes: [] }, proofMap: { criteria: [{ id: "a" }] }, diff: { after: "tree-one" }, checks: { status: "passed" }, runId: "run", round: 1, role: "requirements" };
  await harness.reviewTicket(input);
  assert.equal(sessions, 1);
  assert.equal(calls.requirements, 2);
  await assert.rejects(harness.reviewTicket({ ...input, role: "integration" }), /Provider unavailable/);
  await harness.reviewTicket(input);
  assert.equal(calls.requirements, 2, "successful sibling is reused without another model call");
  await harness.reviewTicket({ ...input, diff: { after: "tree-two" } });
  assert.equal(calls.requirements, 3);
  await harness.reviewTicket({ ...input, operatorFeedback: "New constraint" });
  assert.equal(calls.requirements, 4);
});

test("a malformed summary cannot let a repair discard an unresolved finding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-findings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new PiHarness({ dataDir: root });
  let calls = 0;
  harness.sdk = async () => ({ SessionManager: { create: () => ({}) }, createAgentSession: async () => ({ session: {
    state: { messages: [] }, setSessionName() {}, subscribe() { return () => {}; }, dispose() {},
    async prompt() {
      const result = ++calls === 1 ? { findings: [{ severity: "high", claim: "Missing behavior" }] } : { summary: "All good", findings: [] };
      this.state.messages.push({ role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] });
    }
  } }) });
  await assert.rejects(harness.reviewTicket({ cwd: root, ticket: { id: "T" }, plan: { nodes: [] }, runId: "run", round: 1, role: "integration" }), /dropped an unresolved finding/);
  assert.equal(calls, 2);
});
