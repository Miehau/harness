import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidates } from "../src/admission.js";
import { GitLabDelivery } from "../src/delivery.js";
import { JiraClient } from "../src/jira.js";
import { TrackerHub } from "../src/trackers.js";

function response(value) { return { ok: true, text: async () => value == null ? "" : JSON.stringify(value) }; }

test("adapter lifecycle admits a dependency-ready Jira ticket and closes it after GitLab squash merge", async () => {
  const trackerWrites = [];
  const jira = new JiraClient({
    baseUrl: "https://example.atlassian.net", email: "agent@example.com", apiToken: "token", projectKey: "APP",
    fetchImpl: async (url, input = {}) => {
      if (url.endsWith("/myself")) return response({ accountId: "agent", displayName: "Agent" });
      if (url.endsWith("/search/jql")) return response({ issues: [
        { id: "1", key: "APP-1", fields: { summary: "Blocked", priority: { id: "1" }, status: { name: "Ready", statusCategory: { key: "new" } }, project: { name: "App" }, labels: [], issuelinks: [{ type: { inward: "is blocked by" }, inwardIssue: { fields: { status: { statusCategory: { key: "new" } } } } }] } },
        { id: "2", key: "APP-2", fields: { summary: "Ship UI", priority: { id: "2" }, status: { id: "ready", name: "Ready", statusCategory: { key: "new" } }, project: { name: "App" }, labels: [], issuelinks: [] } }
      ] });
      if (url.endsWith("/transitions") && input.method !== "POST") return response({ transitions: [{ id: "done", to: { name: "Done", statusCategory: { key: "done" } } }] });
      trackerWrites.push({ url, input });
      return input.method === "POST" && url.endsWith("/comment") ? response({ id: "comment", body: JSON.parse(input.body).body }) : response(null);
    }
  });
  const hub = new TrackerHub([jira]);
  const source = await hub.tickets();
  const [ticket] = admissionCandidates(source.tickets, { ticketRuns: {} }, 2);
  assert.equal(ticket.identifier, "APP-2");

  const forgeWrites = [];
  const gitlab = new GitLabDelivery({ project: "acme/app", token: "token", fetchImpl: async (url, input = {}) => {
    forgeWrites.push({ url, input });
    if (url.endsWith("/merge_requests") && input.method === "POST") return response({ iid: 9, web_url: "https://gitlab.com/acme/app/-/merge_requests/9", sha: "head" });
    if (url.endsWith("/discussions")) return response([]);
    if (url.endsWith("/merge") && input.method === "PUT") return response({ state: "merged", squash_commit_sha: "squashed" });
    return response({ sha: "head", state: "opened", detailed_merge_status: "mergeable", blocking_discussions_resolved: true, head_pipeline: { status: "success" } });
  }});
  const change = await gitlab.create({ branch: "codex/app-2", base: "main", title: "APP-2: Ship UI", body: "Verified" });
  assert.equal((await gitlab.status(change)).ready, true);
  assert.equal((await gitlab.merge(change)).commit, "squashed");
  await hub.comment(ticket, `Merged after checks: ${change.url}`);
  await hub.transition(ticket, "done");

  assert.equal(JSON.parse(forgeWrites.find(({ url }) => url.endsWith("/merge_requests")).input.body).squash, true);
  assert.equal(JSON.parse(forgeWrites.find(({ url }) => url.endsWith("/merge")).input.body).squash, true);
  assert.equal(trackerWrites.filter(({ input }) => input.method === "POST").length, 2);
});
