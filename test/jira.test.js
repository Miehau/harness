import assert from "node:assert/strict";
import test from "node:test";
import { JiraClient, jiraDescriptionText, jiraUnresolvedBlockers } from "../src/jira.js";

test("reports an explicit unconfigured state without a network request", async () => {
  let called = false;
  const client = new JiraClient({ baseUrl: "", email: "", apiToken: "", epicKey: "", fetchImpl: async () => { called = true; } });
  assert.deepEqual(await client.tickets(), { configured: false, viewer: null, tickets: [] });
  assert.equal(called, false);
});

test("rejects an invalid Jira epic key before searching", async () => {
  let called = false;
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "token", epicKey: "APP",
    fetchImpl: async () => { called = true; }
  });
  await assert.rejects(client.tickets(), /APP-42/);
  assert.equal(called, false);
});

test("normalizes Jira Cloud issues and sends environment credentials", async () => {
  const requests = [];
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net/", email: "dev@example.com", apiToken: "token", epicKey: "APP-42",
    fetchImpl: async (url, input = {}) => {
      requests.push({ url, input });
      if (url.endsWith("/myself")) return { ok: true, json: async () => ({ accountId: "me", displayName: "Dev" }) };
      return { ok: true, json: async () => ({ issues: [{
        id: "100", key: "APP-1", fields: {
          summary: "Ship flow", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Build it" }] }] },
          priority: { id: "2", name: "High" }, updated: "2026-08-27", labels: ["feature"], issuelinks: [],
          status: { id: "s", name: "Ready", statusCategory: { key: "new" } },
          project: { id: "p", key: "APP", name: "App" }, assignee: { accountId: "a", displayName: "Ada", emailAddress: "ada@example.com" }
        }
      }] }) };
    }
  });
  const result = await client.tickets();
  assert.equal(result.viewer.name, "Dev");
  assert.deepEqual(result.tickets[0], {
    id: "jira:100", nativeId: "100", provider: "jira", identifier: "APP-1", title: "Ship flow", description: "Build it",
    priority: 2, priorityName: "High", url: "https://example.atlassian.net/browse/APP-1", updatedAt: "2026-08-27",
    state: { id: "s", name: "Ready", type: "unstarted", color: "#6554c0" },
    team: { id: "p", key: "APP", name: "App" }, assignee: { id: "a", name: "Ada", email: "ada@example.com" },
    labels: [{ id: "feature", name: "feature" }]
  });
  assert.equal(requests[0].input.headers.authorization, `Basic ${Buffer.from("dev@example.com:token").toString("base64")}`);
  assert.match(JSON.parse(requests.find(({ url }) => url.endsWith("/search/jql")).input.body).jql, /parent = "APP-42"/);
});

test("filters issues with unresolved explicit Jira blockers", async () => {
  const status = (key) => ({ statusCategory: { key } });
  const issue = (id, issuelinks = []) => ({ id, key: `APP-${id}`, fields: { summary: id, status: status("new"), project: {}, labels: [], issuelinks } });
  const blockedBy = (key) => ({ type: { inward: "is blocked by", outward: "blocks" }, inwardIssue: { fields: { status: status(key) } } });
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "token", epicKey: "APP-42",
    fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith("/myself") ? {} : { issues: [issue("1"), issue("2", [blockedBy("indeterminate")]), issue("3", [blockedBy("done")])] } })
  });
  assert.deepEqual((await client.tickets()).tickets.map(({ identifier }) => identifier), ["APP-1", "APP-3"]);
  assert.equal(jiraUnresolvedBlockers(issue("2", [blockedBy("new")])).length, 1);
});

test("extracts readable text from Atlassian document format", () => {
  assert.equal(jiraDescriptionText({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "Two" }] }
  ] }).trim(), "One\nTwo");
});

test("uses Jira comment documents and workflow transitions", async () => {
  const requests = [];
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "token", epicKey: "APP-42",
    fetchImpl: async (url, input = {}) => {
      requests.push({ url, input });
      if (url.includes("/comment") && input.method === "POST") return { ok: true, json: async () => ({ id: "c1", created: "now", body: JSON.parse(input.body).body }) };
      if (url.includes("/comment")) return { ok: true, json: async () => ({ comments: [{ id: "c2", created: "later", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Answer: yes" }] }] } }] }) };
      if (input.method === "POST") return { ok: true, text: async () => "" };
      return { ok: true, json: async () => ({ transitions: [{ id: "21", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }] }) };
    }
  });
  const ticket = { identifier: "APP-1", provider: "jira" };
  assert.equal((await client.comment(ticket, "Question")).id, "c1");
  assert.match((await client.comments(ticket))[0].body, /Answer: yes/);
  assert.equal((await client.transition(ticket, "in_progress")).name, "In Progress");
  assert.deepEqual(JSON.parse(requests.at(-1).input.body), { transition: { id: "21" } });
});
