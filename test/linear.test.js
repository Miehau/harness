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
