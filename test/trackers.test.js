import assert from "node:assert/strict";
import test from "node:test";
import { TrackerHub } from "../src/trackers.js";

test("combines configured tracker tickets without hiding a healthy source failure", async () => {
  const hub = new TrackerHub([
    { provider: "linear", configured: true, tickets: async () => ({ configured: true, viewer: { name: "Lin" }, tickets: [{ id: "1" }] }) },
    { provider: "jira", configured: true, tickets: async () => { throw new Error("Jira unavailable"); } }
  ]);
  const result = await hub.tickets();
  assert.equal(result.configured, true);
  assert.deepEqual(result.tickets, [{ id: "1" }]);
  assert.equal(result.viewer.name, "linear: Lin");
  assert.equal(result.sources[1].error, "Jira unavailable");
});

test("routes lifecycle writes to the ticket provider", async () => {
  const calls = [];
  const hub = new TrackerHub([{ provider: "jira", configured: true,
    tickets: async () => ({ configured: true, tickets: [] }),
    comment: async (_ticket, body) => calls.push(["comment", body]),
    comments: async () => [{ body: "Answer: yes" }],
    transition: async (_ticket, state) => calls.push(["transition", state])
  }]);
  const ticket = { provider: "jira" };
  await hub.comment(ticket, "hello");
  assert.equal((await hub.comments(ticket))[0].body, "Answer: yes");
  await hub.transition(ticket, "done");
  assert.deepEqual(calls, [["comment", "hello"], ["transition", "done"]]);
});
