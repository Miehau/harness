import assert from "node:assert/strict";
import test from "node:test";
import { GitHubDelivery, GitLabDelivery, parseRemoteRepository, pushTicketBranch, reconcileWithRemote, safeSyncLocal, unmergedPaths } from "../src/delivery.js";

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

test("delivery resolves one final-state merge instead of replaying ticket commits", async () => {
  const calls = [];
  let mergeAttempts = 0;
  const execImpl = async (_file, argv) => {
    calls.push(argv);
    if (argv.includes("--verify")) throw new Error("no active merge");
    if (argv[0] === "rebase") throw new Error("no active rebase");
    if (argv[0] === "merge" && argv.includes("--no-edit") && ++mergeAttempts === 1) throw new Error("conflict");
    if (argv[0] === "diff") return { stdout: "src/a.js\n" };
    if (argv[0] === "rev-parse") return { stdout: "merged\n" };
    return { stdout: "" };
  };
  const resolved = [];
  assert.equal((await reconcileWithRemote("/repo", "main", { execImpl, resolveConflicts: async ({ conflicts }) => resolved.push(...conflicts) })).commit, "merged");
  assert.deepEqual(resolved, ["src/a.js"]);
  assert.equal(calls.filter((argv) => argv.includes("merge") && argv.includes("--continue")).length, 1);
  assert.equal(calls.some((argv) => argv[0] === "rebase" && argv.includes("--abort")), true);
});

test("delivery preserves a partially resolved merge for the next resume", async () => {
  const calls = [];
  const execImpl = async (_file, argv) => {
    calls.push(argv);
    if (argv.includes("--verify")) throw new Error("no active merge");
    if (argv[0] === "rebase") throw new Error("no active rebase");
    if (argv[0] === "merge") throw new Error("conflict");
    if (argv[0] === "diff") return { stdout: "src/a.js\n" };
    return { stdout: "" };
  };
  await assert.rejects(reconcileWithRemote("/repo", "main", {
    execImpl, resolveConflicts: async () => { throw new Error("provider unavailable"); }
  }), /provider unavailable/);
  assert.equal(calls.some((argv) => argv.includes("--abort") && argv.includes("merge")), false);
});

test("delivery resumes an existing merge without restarting it", async () => {
  const calls = [];
  const execImpl = async (_file, argv) => {
    calls.push(argv);
    if (argv.includes("--verify")) return { stdout: "merge-head\n" };
    if (argv[0] === "diff") return { stdout: "src/a.js\n" };
    if (argv[0] === "rev-parse") return { stdout: "merged\n" };
    return { stdout: "" };
  };
  assert.equal((await reconcileWithRemote("/repo", "main", { execImpl, resolveConflicts: async () => {} })).commit, "merged");
  assert.equal(calls.some((argv) => argv[0] === "fetch" || (argv[0] === "rebase" && argv.includes("--abort"))), false);
});

test("unmerged paths expose an interrupted rebase before delivery correction", async () => {
  const execImpl = async () => ({ stdout: "src/server.js\ntest/server.test.js\n" });
  assert.deepEqual(await unmergedPaths("/repo", execImpl), ["src/server.js", "test/server.test.js"]);
});

test("ticket branches use a lease when reconciliation rewrites history", async () => {
  let args;
  await pushTicketBranch("/repo", "ticket", async (_file, argv) => { args = argv; return { stdout: "" }; });
  assert.deepEqual(args, ["push", "--force-with-lease", "--set-upstream", "origin", "ticket"]);
});

test("delivery publishes real bytes, preserves PR prose, retries safely and replaces final proof", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { publishDeliveryEvidence } = await import("../src/delivery.js");
  const dir = await mkdtemp(join(tmpdir(), "delivery-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "desktop.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71]));
  let body = "Original PR description";
  let uploads = 0;
  let failUpdate = true;
  const forge = {
    async description(_change, next) {
      if (next !== undefined) {
        if (failUpdate) { failUpdate = false; throw new Error("temporary PATCH failure"); }
        body = next;
      }
      return body;
    },
    async uploadEvidence(_change, files) {
      uploads++;
      assert.deepEqual(files[0].bytes, Buffer.from([137, 80, 78, 71]));
      return [`![desktop](https://github.com/acme/app/blob/proof-${uploads}/desktop.png?raw=true)`];
    }
  };
  const checks = { status: "passed", summary: "Desktop checks passed", evidence: [{ name: "desktop.png", path }] };
  await assert.rejects(publishDeliveryEvidence(forge, { id: 7 }, checks), /PATCH failure/);
  await publishDeliveryEvidence(forge, { id: 7 }, checks);
  await publishDeliveryEvidence(forge, { id: 7 }, checks);
  assert.equal(uploads, 2);
  assert.match(body, /^Original PR description/);
  assert.match(body, /https:\/\/github.com\/acme\/app\/blob\/proof-2/);
  assert.equal(body.includes(dir), false);
  await publishDeliveryEvidence(forge, { id: 7 }, { ...checks, summary: "Updated final checks passed" });
  assert.equal((body.match(/## Verification evidence/g) || []).length, 1);
  assert.equal(body.includes("proof-2"), false);
  await assert.rejects(publishDeliveryEvidence(forge, { id: 7 }, { ...checks, evidence: [{ name: "missing.png", path: join(dir, "missing.png") }] }), /ENOENT/);
  await assert.rejects(publishDeliveryEvidence(forge, { id: 7 }, { ...checks, status: "failed" }), /failed verification/);
});

test("GitHub stores evidence on an isolated reachable branch and returns immutable image links", async () => {
  const calls = [];
  const delivery = new GitHubDelivery({ repository: "acme/app", token: "token", fetchImpl: async (url, input) => {
    calls.push({ url, input });
    if (url.includes("/git/ref/")) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (url.endsWith("/blobs")) return response({ sha: "blob" });
    if (url.endsWith("/trees")) return response({ sha: "tree" });
    if (url.endsWith("/commits")) return response({ sha: "evidence-commit" });
    if (url.endsWith("/refs")) return response({});
    throw new Error(url);
  } });
  const links = await delivery.uploadEvidence({ id: 7, url: "https://github.com/acme/app/pull/7" }, [{ name: "desktop.png", mediaKind: "image", bytes: Buffer.from("image") }]);
  assert.equal(JSON.parse(calls[0].input.body).content, Buffer.from("image").toString("base64"));
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith("/trees")).input.body).base_tree, undefined);
  assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/commits")).input.body).parents, []);
  assert.equal(JSON.parse(calls.at(-1).input.body).ref, "refs/heads/codex/evidence/pr-7/tree");
  assert.deepEqual(links, ["![desktop.png](https://github.com/acme/app/blob/evidence-commit/desktop.png?raw=true)"]);
});

test("GitLab uploads evidence as multipart data without a JSON content type", async () => {
  const delivery = new GitLabDelivery({ project: "group/app", token: "token", fetchImpl: async (_url, input) => {
    assert.equal(input.headers["content-type"], undefined);
    assert.equal(await input.body.get("file").text(), "image");
    return response({ markdown: "![desktop](/uploads/hash/desktop.png)" });
  } });
  assert.deepEqual(await delivery.uploadEvidence({ id: 7 }, [{ name: "desktop.png", mediaType: "image/png", bytes: Buffer.from("image") }]), ["![desktop](/uploads/hash/desktop.png)"]);
});
