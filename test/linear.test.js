import test from "node:test";
import assert from "node:assert/strict";
import { LinearClient } from "../src/linear.js";

test("reports an explicit unconfigured state without a network request", async () => {
  let called = false;
  const client = new LinearClient({ apiKey: "", fetchImpl: async () => { called = true; } });
  assert.deepEqual(await client.tickets(), { configured: false, viewer: null, tickets: [] });
  assert.equal(called, false);
});

test("normalizes Linear tickets and labels", async () => {
  const client = new LinearClient({
    apiKey: "secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "me", name: "Michal" }, issues: { nodes: [{ id: "1", identifier: "MM-1", title: "Cook", state: { type: "started" }, labels: { nodes: [{ id: "l", name: "Feature" }] } }] } } })
    })
  });
  const result = await client.tickets();
  assert.equal(result.configured, true);
  assert.equal(result.tickets[0].provider, "linear");
  assert.deepEqual(result.tickets[0].labels, [{ id: "l", name: "Feature" }]);
});

test("requests backlog, todo, and in-progress workflow types", async () => {
  let request;
  const client = new LinearClient({
    apiKey: "secret",
    fetchImpl: async (_url, input) => {
      request = JSON.parse(input.body);
      return { ok: true, json: async () => ({ data: { viewer: { id: "me", name: "Michal" }, issues: { nodes: [] } } }) };
    }
  });
  await client.tickets();
  assert.match(request.query, /\["backlog", "unstarted", "started"\]/);
});

test("hides tickets with unresolved blockers", async () => {
  const ticket = (id, inverseRelations = { nodes: [] }) => ({ id, identifier: `MM-${id}`, title: id, labels: { nodes: [] }, inverseRelations });
  const blocks = (state) => ({ nodes: [{ type: "blocks", issue: { state: { type: state } } }] });
  const client = new LinearClient({
    apiKey: "secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "me" }, issues: { nodes: [
        ticket("ready"), ticket("blocked", blocks("started")), ticket("unblocked", blocks("completed"))
      ] } } })
    })
  });
  assert.deepEqual((await client.tickets()).tickets.map(({ id }) => id), ["ready", "unblocked"]);
});

test("writes comments, reads answers, and moves an issue through its workflow", async () => {
  const requests = [];
  const client = new LinearClient({
    apiKey: "secret",
    fetchImpl: async (_url, input) => {
      const request = JSON.parse(input.body);
      requests.push(request);
      if (request.query.includes("AgentPlanComments")) return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ id: "answer", body: "Answer: yes" }] } } } }) };
      if (request.query.includes("AgentPlanComment")) return { ok: true, json: async () => ({ data: { commentCreate: { success: true, comment: { id: "c1", body: request.variables.body } } } }) };
      if (request.query.includes("AgentPlanStates")) return { ok: true, json: async () => ({ data: { workflowStates: { nodes: [{ id: "started", name: "In Progress", type: "started" }] } } }) };
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) };
    }
  });
  const ticket = { id: "issue", provider: "linear", team: { id: "team" } };
  assert.equal((await client.comment(ticket, "Question")).id, "c1");
  assert.equal((await client.comments(ticket))[0].body, "Answer: yes");
  assert.equal((await client.transition(ticket, "in_progress")).id, "started");
  assert.deepEqual(requests.at(-1).variables, { issueId: "issue", stateId: "started" });
});
