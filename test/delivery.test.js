import assert from "node:assert/strict";
import test from "node:test";
import { GitHubDelivery, GitLabDelivery, parseRemoteRepository, rebaseOntoRemote, safeSyncLocal } from "../src/delivery.js";

function response(value) { return { ok: true, text: async () => JSON.stringify(value) }; }

test("parses HTTPS and SSH remote repository identities", () => {
  assert.deepEqual(parseRemoteRepository("git@github.com:acme/app.git"), { host: "github.com", path: "acme/app" });
  assert.deepEqual(parseRemoteRepository("https://gitlab.com/group/app.git"), { host: "gitlab.com", path: "group/app" });
});

test("GitHub waits for checks and feedback then squash-merges", async () => {
  const calls = [];
  const fetchImpl = async (url, input = {}) => {
    calls.push({ url, input });
    if (url.endsWith("/pulls") && input.method === "POST") return response({ number: 7, html_url: "https://github.com/acme/app/pull/7", head: { sha: "abc" } });
    if (url.endsWith("/pulls/7") && input.method !== "PUT") return response({ head: { sha: "abc" }, mergeable: true, mergeable_state: "clean", draft: false, merged: false });
    if (url.endsWith("/reviews")) return response([]);
    if (url.endsWith("/comments")) return response([]);
    if (url.endsWith("/check-runs")) return response({ check_runs: [{ status: "completed", conclusion: "success" }] });
    if (url.endsWith("/status")) return response({ state: "success" });
    return response({ merged: true, sha: "merged" });
  };
  const delivery = new GitHubDelivery({ repository: "acme/app", token: "token", fetchImpl });
  const change = await delivery.create({ branch: "ticket", base: "main", title: "Ticket", body: "Body" });
  assert.equal((await delivery.status(change)).ready, true);
  assert.equal((await delivery.merge(change, "Ticket")).commit, "merged");
  assert.equal(JSON.parse(calls.at(-1).input.body).merge_method, "squash");
});

test("GitHub exposes failed check logs as actionable feedback", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/pulls/7")) return response({ head: { sha: "abc" }, mergeable: true, mergeable_state: "blocked", draft: false, merged: false });
    if (url.endsWith("/reviews") || url.endsWith("/comments")) return response([]);
    if (url.endsWith("/check-runs")) return response({ check_runs: [{ id: 99, name: "verify", status: "completed", conclusion: "failure", details_url: "https://ci/99" }] });
    if (url.endsWith("/actions/jobs/99/logs")) return response("noise\nnot ok 3 - cleanup remains durable\n  expected: complete\n  actual: incomplete");
    if (url.endsWith("/status")) return response({ statuses: [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const status = await new GitHubDelivery({ repository: "acme/app", token: "token", fetchImpl }).status({ id: 7 });
  assert.equal(status.checks, "failed");
  assert.equal(status.feedback[0].id, "check:99");
  assert.match(status.feedback[0].body, /not ok 3.*expected: complete.*actual: incomplete/s);
});

test("GitLab treats unresolved review discussions as feedback", async () => {
  const delivery = new GitLabDelivery({ project: "group/app", token: "token", fetchImpl: async (url) =>
    response(url.endsWith("/discussions") ? [{ notes: [{ id: 2, body: "Fix this", resolvable: true, resolved: false, system: false }] }] : {
      sha: "abc", state: "opened", detailed_merge_status: "mergeable", blocking_discussions_resolved: false, head_pipeline: { status: "success" }
    })
  });
  const status = await delivery.status({ id: 3 });
  assert.equal(status.ready, false);
  assert.equal(status.feedback[0].body, "Fix this");
});

test("safe local sync skips dirty work and only fast-forwards an ancestor", async () => {
  const args = [];
  const execImpl = async (_file, argv) => { args.push(argv); return { stdout: argv[0] === "status" ? " M local.txt\n" : "" }; };
  assert.deepEqual(await safeSyncLocal("/repo", "main", execImpl), { status: "skipped", reason: "opened repository has local changes" });
  assert.equal(args.some((argv) => argv[0] === "merge"), false);
});

test("rebase conflict resolution is scoped and continues automatically", async () => {
  const calls = [];
  let rebaseAttempts = 0;
  const execImpl = async (_file, argv) => {
    calls.push(argv);
    if (argv[0] === "rebase" && ++rebaseAttempts === 1) throw new Error("conflict");
    if (argv[0] === "diff") return { stdout: "src/a.js\n" };
    if (argv[0] === "rev-parse") return { stdout: "rebased\n" };
    return { stdout: "" };
  };
  const resolved = [];
  assert.equal((await rebaseOntoRemote("/repo", "main", { execImpl, resolveConflicts: async ({ conflicts }) => resolved.push(...conflicts) })).commit, "rebased");
  assert.deepEqual(resolved, ["src/a.js"]);
  assert.equal(calls.some((argv) => argv.includes("--continue")), true);
});
