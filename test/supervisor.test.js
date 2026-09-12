import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke, mockHarness, runAgainstDaemon, seedRun, waitFor, withDaemon } from "./helpers.js";
import { createOrchestratorService, guardOrchestratorUpdate } from "../src/orchestration.js";
import { captureSupervisorEvents, delegatedResumeAllowed, loadSupervisorConfig, projectIdentity, supervisorEventKind } from "../src/supervisor.js";
import { JsonStore } from "../src/store.js";

const token = "supervisor-test-" + "b".repeat(32);
const owner = "owner-test-" + "a".repeat(32);
const rootPath = "/api/orchestrator";
const checkpoint = (id = "question-1") => ({ id, kind: "requirements_review", title: "Approve requirements", createdAt: new Date().toISOString() });
const providerCheckpoint = () => ({ id: "provider-1", kind: "provider_wait", source: "execution", createdAt: new Date(Date.now() - 120000).toISOString() });
async function fixture(fn, { deduplicates = false, transport = async () => ({ status: 204 }), webhook = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supervisor-test-")));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const file = join(root, "private.json");
  const config = { projects: [{ cwd, token, ...(webhook ? { webhook: { url: "https://receiver.example.invalid/events", authorization: "Bearer synthetic-private-value", deduplicates } } : {}) }] };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const opts = { cwd, dataDir: join(root, "data"), apiToken: owner, supervisorConfig: file, supervisorFetch: transport, supervisorTimeoutMs: 30 };
  try { await withDaemon((daemon) => fn(daemon, { root, cwd, file, config, opts, projectId: projectIdentity(cwd) }), opts); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const call = (daemon, method, path, body, as = token) => invoke(daemon, method, path, { body, token: as });
async function seed(daemon, extra = {}) {
  return seedRun(daemon, { status: "awaiting_requirements", checkpoint: checkpoint(), ...extra });
}
const events = (daemon) => daemon.store.read().supervisorEvents || [];

test("supervisor config fails closed without exposing configuration or accepting duplicate credentials", async () => {
  await fixture(async (_daemon, { file, config }) => {
    assert.equal((await loadSupervisorConfig(file, owner)).length, 1);
    assert.deepEqual(await loadSupervisorConfig("", ""), []);
    await assert.rejects(loadSupervisorConfig(file, ""), /private JSON/);
    await chmod(file, 0o644);
    await assert.rejects(loadSupervisorConfig(file, owner), /private JSON/);
    await chmod(file, 0o600);
    for (const change of [
      { ...config, projects: [...config.projects, config.projects[0]] },
      { projects: [{ ...config.projects[0], token: owner }] },
      { projects: [{ ...config.projects[0], webhook: { url: "http://unsafe.invalid", authorization: "Bearer secret-value" } }] },
      { projects: [{ ...config.projects[0], webhook: { url: "https://safe.invalid", authorization: "Bearer value\nInjected: x" } }] },
      { projects: [{ ...config.projects[0], webhook: { url: "https://safe.invalid", authorization: "Bearer secret", deduplicates: "yes" } }] }
    ]) {
      await writeFile(file, JSON.stringify(change));
      await assert.rejects(loadSupervisorConfig(file, owner), (error) => !/secret-value|Injected|unsafe.invalid/.test(error.message));
    }
  });
});

test("disabled delivery has no network traffic and classifies pauses separately from completions", async () => {
  let calls = 0;
  await withDaemon(async (daemon) => {
    await seed(daemon);
    await daemon.supervisor.flush();
    assert.equal(events(daemon).length, 0);
    assert.equal(calls, 0);
    assert.equal((await runAgainstDaemon(daemon, ["orchestrator", "overview"])).json.runs.length, 1);
  }, { supervisorFetch: async () => { calls++; throw new Error("unexpected network"); } });
  assert.equal(supervisorEventKind({ status: "paused", checkpoint: checkpoint() }), null);
  assert.equal(supervisorEventKind({ status: "cancelled", checkpoint: checkpoint() }), null);
  assert.equal(supervisorEventKind({ status: "paused", checkpoint: providerCheckpoint() }), "attention");
});

test("events persist with transitions, suppress stale questions, and transport only minimal identities", async () => {
  const sent = [];
  await fixture(async (daemon, { projectId }) => {
    const id = await seed(daemon);
    const first = events(daemon)[0];
    await daemon.store.update((draft) => { draft.ticketRuns[id].lastError = "token=should-never-leak"; });
    assert.equal(events(daemon).length, 1);
    assert.equal(JSON.parse(await readFile(daemon.store.file, "utf8")).supervisorEvents[0].eventId, first.eventId);
    await daemon.store.update((draft) => { draft.ticketRuns[id].checkpoint = checkpoint("question-2"); });
    assert.equal(events(daemon)[0].delivery, "superseded");
    await daemon.supervisor.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.projectId, projectId);
    assert.equal(sent[0].payload.checkpointId, "question-2");
    assert.equal(sent[0].options.redirect, "manual");
    assert.equal(sent[0].options.headers["Idempotency-Key"], sent[0].payload.eventId);
    assert.doesNotMatch(JSON.stringify(sent[0].payload), /token|should-never-leak|project\/|signature|destination/);
    assert.equal(events(daemon)[1].delivery, "accepted");
    await daemon.store.update((draft) => { draft.ticketRuns[id].status = "running"; draft.ticketRuns[id].checkpoint = null; });
    await daemon.store.update((draft) => { draft.ticketRuns[id].status = "awaiting_requirements"; draft.ticketRuns[id].checkpoint = checkpoint("question-2"); });
    assert.notEqual(events(daemon)[2].eventId, events(daemon)[1].eventId);
    await daemon.store.update((draft) => { draft.ticketRuns[id].status = "completed"; draft.ticketRuns[id].checkpoint = null; });
    await daemon.supervisor.flush();
    assert.equal(sent.at(-1).payload.kind, "completed");
    const inspection = await call(daemon, "GET", rootPath + "/notifications");
    assert.doesNotMatch(inspection.text, /receiver.example|synthetic-private|destination|signature/);
    assert.equal(inspection.json.unresolved, 0);
  }, { transport: async (_url, options) => { sent.push({ payload: JSON.parse(options.body), options }); return { status: 204 }; } });
});

test("delivery retries require receiver deduplication, preserve identity, and stop at the bound", async () => {
  for (const deduplicates of [false, true]) {
    const ids = [];
    await fixture(async (daemon) => {
      await seed(daemon);
      await daemon.supervisor.flush();
      assert.equal(events(daemon)[0].delivery, deduplicates ? "pending" : "unknown");
      if (deduplicates) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await daemon.store.update((draft) => { draft.supervisorEvents[0].nextAttemptAt = new Date(0).toISOString(); });
          await daemon.supervisor.flush();
        }
        assert.equal(events(daemon)[0].delivery, "unknown");
        assert.equal(events(daemon)[0].attempts, 3);
        assert.equal(new Set(ids).size, 1);
      }
      const count = ids.length;
      await daemon.supervisor.flush();
      assert.equal(ids.length, count);
      const retry = await call(daemon, "POST", rootPath + "/notifications", { eventId: events(daemon)[0].eventId, discard: false }, owner);
      assert.equal(retry.status, 200);
      await daemon.supervisor.flush();
      assert.equal(ids.length, count + 1);
    }, { deduplicates, transport: async (_url, options) => { ids.push(JSON.parse(options.body).eventId); throw new Error("secret provider response"); } });
  }
});

test("restart recovers ambiguous sends and creates an interrupted-run notification without rerouting old events", async () => {
  await fixture(async (daemon, { opts, file, config }) => {
    const id = await seed(daemon);
    await daemon.store.update((draft) => { draft.supervisorEvents[0].delivery = "attempting"; draft.supervisorEvents[0].attempts = 1; });
    await daemon.close();
    await withDaemon(async (restarted) => {
      assert.equal(events(restarted)[0].delivery, "unknown");
      await restarted.store.update((draft) => { draft.ticketRuns[id].status = "running"; draft.ticketRuns[id].checkpoint = null; });
    }, opts);
    await withDaemon(async (restarted) => {
      assert.equal(restarted.store.read().ticketRuns[id].status, "interrupted");
      assert.equal(events(restarted).at(-1).status, "interrupted");
    }, opts);
    config.projects[0].webhook.url = "https://new-receiver.example.invalid/events";
    await writeFile(file, JSON.stringify(config));
    await withDaemon(async (restarted) => {
      assert.equal(events(restarted).at(-2).delivery, "discarded");
      assert.equal(events(restarted).at(-2).reason, "destination_changed");
      assert.equal(events(restarted).at(-1).delivery, "pending");
      assert.notEqual(events(restarted).at(-2).eventId, events(restarted).at(-1).eventId);
    }, opts);
  });
});

test("timeouts release the sender and store; redirects are failed and never retried automatically", async () => {
  await fixture(async (daemon) => {
    await seed(daemon);
    const started = Date.now();
    await daemon.supervisor.flush();
    assert.ok(Date.now() - started < 1000);
    assert.equal(events(daemon)[0].delivery, "unknown");
    await daemon.store.update((draft) => { draft.notice = "store remains usable"; });
    assert.equal(daemon.store.read().notice, "store remains usable");
  }, { transport: () => new Promise(() => {}) });
  await fixture(async (daemon) => {
    await seed(daemon);
    await daemon.supervisor.flush();
    assert.equal(events(daemon)[0].httpStatus, 302);
    assert.equal(events(daemon)[0].delivery, "failed");
  }, { deduplicates: true, transport: async () => ({ status: 302 }) });
});

test("bot credentials are restricted by project, route, method, and authority even after a workspace switch", async () => {
  await fixture(async (daemon, { root }) => {
    const id = await seed(daemon, { artifacts: [{ id: "text", name: "report", kind: "agent-output", content: "redacted report" }] });
    const run = daemon.store.read().ticketRuns[id];
    assert.equal((await call(daemon, "GET", `${rootPath}/tickets/${id}/runs/${run.runId}`)).status, 200);
    assert.equal((await call(daemon, "GET", `/api/tickets/${id}/runs/${run.runId}/artifacts/text/content`)).status, 200);
    for (const [method, path] of [["GET", "/api/state"], ["GET", "/api/events"], ["POST", `/api/tickets/${id}/resume`], ["POST", rootPath + "/tickets"], ["POST", rootPath + "/policy"], ["POST", rootPath + "/notifications"], ["POST", "/api/workspace"], ["GET", "/api/tracker-settings"]]) {
      assert.equal((await call(daemon, method, path, {})).status, 403, path);
    }
    assert.equal((await call(daemon, "GET", rootPath + "/overview", undefined, "wrong")).status, 401);
    const forged = { action: "answer", requestId: "forged", expected: { runId: run.runId, status: run.status, checkpointId: run.checkpoint.id }, authority: { mode: "user", actor: "owner" }, input: { answers: "yes" } };
    assert.equal((await call(daemon, "POST", `${rootPath}/tickets/${id}/actions`, forged)).status, 400);
    const other = join(root, "other"); await mkdir(other);
    await daemon.store.update((draft) => { draft.workspace.cwd = other; });
    const otherId = await seedRun(daemon, { ticket: { id: "other", title: "Other project", source: "local" } });
    assert.equal((await call(daemon, "GET", `${rootPath}/tickets/${otherId}/runs/run-1`)).status, 403);
    assert.equal((await call(daemon, "GET", rootPath + "/overview")).json.runs.length, 1);
    assert.equal((await call(daemon, "GET", "/api/state", undefined, owner)).status, 200);
  }, { webhook: false });
});

test("digest input is bounded, redacted, time-filtered and honest about retention", async () => {
  await fixture(async (daemon) => {
    await seed(daemon, { ticket: { id: "active", title: "token=private-value", source: "local" } });
    await seed(daemon, { ticket: { id: "completed", title: "Completed", source: "local" }, status: "completed", checkpoint: null });
    await daemon.store.update((draft) => { draft.ticketRuns.completed.supervisorObservation.at = "2020-01-01T00:00:00.000Z"; });
    const view = (await call(daemon, "GET", rootPath + '/overview?since=2026-01-01T00:00:00Z&limit=1')).json;
    assert.equal(view.total, 1);
    assert.equal(view.runs[0].title, "[redacted]");
    assert.equal(view.runs[0].metrics.cost.state, "unavailable");
    assert.equal(view.historyComplete, false);
    assert.equal((await call(daemon, "GET", rootPath + "/overview?limit=500")).status, 400);
    assert.equal((await call(daemon, "GET", rootPath + "/overview?since=bad")).status, 400);
  }, { webhook: false });
});

const resumeInput = (run, requestId = "resume-request") => ({ action: "resume", requestId, expected: { runId: run.runId, status: run.status, checkpointId: run.checkpoint.id }, authority: { mode: "delegated", actor: "GrokBot", reason: "Owner enabled provider recovery" }, input: {} });
test("delegation is checked inside the write and request receipts prevent duplicate execution", async () => {
  await fixture(async (daemon, { projectId, cwd }) => {
    const id = await seed(daemon, { status: "paused", checkpoint: providerCheckpoint() });
    const run = daemon.store.read().ticketRuns[id];
    const input = resumeInput(run);
    assert.equal((await call(daemon, "POST", `${rootPath}/tickets/${id}/actions`, input)).status, 400);
    let policy = (await call(daemon, "GET", rootPath + "/policy")).json;
    policy = (await call(daemon, "POST", rootPath + "/policy", { expectedRevision: policy.revision, maxProviderResumes: 1 }, owner)).json;
    assert.equal((await call(daemon, "POST", rootPath + "/policy", { expectedRevision: "0", maxProviderResumes: 3 }, owner)).status, 400);
    let calls = 0;
    const service = createOrchestratorService({ dataDir: daemon.dataDir, state: { read: () => daemon.store.read() }, tickets: {
      resume: async () => { await daemon.store.update((draft) => guardOrchestratorUpdate(draft, () => { calls++; })); }
    } });
    const results = await Promise.all([service.act(id, input, projectId), service.act(id, input, projectId)]);
    assert.equal(calls, 1);
    assert.ok(results.every((view) => view.decisions[0].outcome === "consumed"));
    const saved = daemon.store.read().ticketRuns[id].orchestratorDecisions[0];
    assert.equal(saved.policyRevision, policy.revision);
    assert.equal(saved.supervisorProject, projectId);
    assert.equal((await service.act(id, { authority: input.authority, requestId: input.requestId, expected: input.expected, input: input.input, action: input.action }, projectId)).decisionReceipt.replayed, true);
    await assert.rejects(service.act(id, { ...input, authority: { ...input.authority, reason: "changed" } }, projectId), /different content/);
    await assert.rejects(service.act(id, resumeInput(run, "second"), projectId), /not delegated/);
    const restored = new JsonStore(daemon.store.file, cwd); await restored.init();
    const replay = createOrchestratorService({ state: { read: () => restored.read() }, tickets: { resume() { throw new Error("must not replay"); } } });
    assert.equal((await replay.act(id, input, projectId)).decisionReceipt.replayed, true);
  }, { webhook: false });
});

test("revocation wins a queued decision; invalid causes, future retry times and user pauses cannot auto-resume", async () => {
  await fixture(async (daemon, { projectId }) => {
    const id = await seed(daemon, { status: "paused", checkpoint: providerCheckpoint() });
    await call(daemon, "POST", rootPath + "/policy", { expectedRevision: "0", maxProviderResumes: 1 }, owner);
    const run = daemon.store.read().ticketRuns[id];
    const state = daemon.store.read();
    for (const invalid of [
      { ...run, status: "failed" }, { ...run, checkpoint: null }, { ...run, checkpoint: { ...run.checkpoint, source: "supervisor" } },
      { ...run, checkpoint: { ...run.checkpoint, createdAt: new Date().toISOString() } },
      { ...run, checkpoint: { ...run.checkpoint, retryAt: "2099-01-01T00:00:00Z" } },
      { ...run, checkpoint: { ...run.checkpoint, retryAt: "unclear" } },
      { ...run, recovery: { uncertainExternalActions: true } }
    ]) assert.equal(delegatedResumeAllowed(state, invalid, projectId), false);
    const service = createOrchestratorService({ state: { read: () => daemon.store.read() }, tickets: { resume: async () => {
      await daemon.store.update((draft) => { draft.supervisorPolicies[projectId].maxProviderResumes = 0; });
      await daemon.store.update((draft) => guardOrchestratorUpdate(draft, () => { throw new Error("must not mutate"); }));
    } } });
    await assert.rejects(service.act(id, resumeInput(run), projectId), /not delegated/);
    assert.equal(daemon.store.read().ticketRuns[id].orchestratorDecisions, undefined);
  }, { webhook: false });
});

test("bounded settled receipts never evict pending events", () => {
  const draft = { ticketRuns: {}, supervisorEvents: Array.from({ length: 205 }, (_, i) => ({ eventId: String(i), delivery: "accepted" })) };
  draft.supervisorEvents.push({ eventId: "pending", delivery: "unknown", projectId: "p", destination: "d", kind: "completed" });
  captureSupervisorEvents(draft, [{ projectId: "p", destination: "d" }]);
  assert.equal(draft.supervisorEvents.length, 201);
  assert.ok(draft.supervisorHistoryPrunedAt);
  assert.equal(draft.supervisorEvents.at(-1).delivery, "unknown");
});

test("HTTP bot resume uses the normal pipeline and stops again for owner approval", async () => {
  await fixture(async (daemon) => {
    const id = await seed(daemon, { status: "paused", checkpoint: providerCheckpoint() });
    const run = daemon.store.read().ticketRuns[id];
    await call(daemon, "POST", rootPath + "/policy", { expectedRevision: "0", maxProviderResumes: 1 }, owner);
    const input = resumeInput(run, "token_123456789abcdef");
    const result = await call(daemon, "POST", `${rootPath}/tickets/${id}/actions`, input);
    assert.equal(result.status, 202, result.text);
    await waitFor(async () => assert.equal(daemon.store.read().ticketRuns[id].status, "awaiting_requirements"), { timeoutMs: 5000 });
    const next = (await call(daemon, "GET", `${rootPath}/tickets/${id}/runs/${run.runId}`)).json;
    assert.deepEqual(next.actions, []);
    assert.deepEqual(next.delegatedActions, []);
    assert.equal(next.decisions[0].requestId, input.requestId);
    const replay = await call(daemon, "POST", `${rootPath}/tickets/${id}/actions`, input);
    assert.equal(replay.status, 202);
    assert.equal(replay.json.decisionReceipt.replayed, true);
    const approve = { action: "answer", requestId: "approve", expected: next.expected, authority: input.authority, input: { answers: "" } };
    assert.equal((await call(daemon, "POST", `${rootPath}/tickets/${id}/actions`, approve)).status, 400);
    assert.equal(daemon.store.read().ticketRuns[id].status, "awaiting_requirements");
    const ownerApproval = await call(daemon, "GET", `${rootPath}/tickets/${id}/runs/${run.runId}`, undefined, owner);
    assert.ok(ownerApproval.json.actions.includes("answer"));
  }, { webhook: false });
});

test("crashed deduplicating delivery retries the same event; failed persistence cannot enqueue phantom alerts", async () => {
  const sent = [];
  await fixture(async (daemon, { opts }) => {
    const id = await seed(daemon);
    const eventId = events(daemon)[0].eventId;
    await daemon.store.update((draft) => { draft.supervisorEvents[0].delivery = "attempting"; draft.supervisorEvents[0].attempts = 1; });
    await daemon.close();
    await withDaemon(async (restarted) => {
      assert.equal(events(restarted)[0].delivery, "pending");
      await restarted.supervisor.flush();
      assert.equal(sent[0], eventId);
      assert.equal(events(restarted)[0].attempts, 2);
      const before = events(restarted);
      const save = restarted.store.save.bind(restarted.store);
      restarted.store.save = async () => { throw new Error("disk full"); };
      await assert.rejects(restarted.store.update((draft) => { draft.ticketRuns[id].checkpoint = checkpoint("lost"); }), /disk full/);
      restarted.store.save = save;
      assert.deepEqual(events(restarted), before);
      await restarted.supervisor.flush();
      assert.equal(sent.length, 1);
    }, opts);
  }, { deduplicates: true, transport: async (_url, options) => { sent.push(JSON.parse(options.body).eventId); return { status: 204 }; } });
});

test("an in-flight notification retains transport evidence when its checkpoint is superseded", async () => {
  let target;
  let count = 0;
  await fixture(async (daemon) => {
    target = daemon;
    await seed(daemon);
    await daemon.supervisor.flush();
    assert.equal(events(daemon)[0].delivery, "superseded");
    assert.equal(events(daemon)[0].transportResult, "accepted");
    assert.equal(events(daemon)[0].httpStatus, 204);
    assert.equal(count, 1);
  }, { transport: async () => {
    count++;
    await target.store.update((draft) => { const run = Object.values(draft.ticketRuns)[0]; run.status = "running"; run.checkpoint = null; });
    return { status: 204 };
  } });
});

test("CLI exposes digest windows, receipt pagination and owner policy edits", async () => {
  await withDaemon(async (daemon) => {
    await seed(daemon);
    const overview = (await runAgainstDaemon(daemon, ["orchestrator", "overview", '{"limit":1}'])).json;
    assert.equal(overview.runs.length, 1);
    assert.equal((await runAgainstDaemon(daemon, ["orchestrator", "notifications", '{"offset":100}'])).json.events.length, 0);
    const policy = (await runAgainstDaemon(daemon, ["orchestrator", "policy"])).json;
    const updated = (await runAgainstDaemon(daemon, ["orchestrator", "policy", JSON.stringify({ expectedRevision: policy.revision, maxProviderResumes: 1 })])).json;
    assert.equal(updated.maxProviderResumes, 1);
    assert.notEqual(updated.revision, policy.revision);
  });
});

test("old unresolved failures remain in digests and archived provider waits offer no actions", async () => {
  await fixture(async (daemon, { projectId }) => {
    const id = await seed(daemon, { status: "failed", checkpoint: null });
    await daemon.store.update((draft) => {
      draft.ticketRuns[id].supervisorObservation.at = "2020-01-01T00:00:00Z";
      const archived = structuredClone(draft.ticketRuns[id]);
      Object.assign(archived, { runId: "old-run", status: "paused", checkpoint: providerCheckpoint(), supervisorObservation: { at: new Date().toISOString() } });
      draft.retainedRuns["old-run"] = archived;
      draft.supervisorPolicies = { [projectId]: { revision: "policy", maxProviderResumes: 1 } };
    });
    const view = (await call(daemon, "GET", rootPath + "/overview")).json;
    assert.equal(view.total, 2);
    assert.equal(view.runs.find((run) => run.runId === "run-1").status, "failed");
    assert.deepEqual(view.runs.find((run) => run.runId === "old-run").delegatedActions, []);
  }, { webhook: false });
});

test("local outbound-only configuration needs no owner or bot token but cannot enable unprotected bot access", async () => {
  const sent = [];
  await fixture(async (daemon, { file, config, opts }) => {
    await daemon.close();
    delete config.projects[0].token;
    await writeFile(file, JSON.stringify(config));
    assert.equal((await loadSupervisorConfig(file, "")).length, 1);
    assert.equal((await loadSupervisorConfig(file, "", "::1")).length, 1);
    await assert.rejects(loadSupervisorConfig(file, "", "0.0.0.0"), /owner API token/);
    await withDaemon(async (local) => {
      await seed(local);
      await local.supervisor.flush();
      assert.equal(sent.length, 1);
      assert.equal((await invoke(local, "GET", "/api/state")).status, 200);
    }, { ...opts, apiToken: "" });
    config.projects[0].token = token;
    await writeFile(file, JSON.stringify(config));
    await assert.rejects(loadSupervisorConfig(file, ""), /owner API token/);
  }, { transport: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 204 }; } });
});

test("harness webhook delivers across projects without extending project bot access", async () => {
  const sent = [];
  await fixture(async (daemon, { file, config, opts, root, projectId }) => {
    await daemon.close();
    config.webhook = config.projects[0].webhook;
    delete config.projects[0].webhook;
    await writeFile(file, JSON.stringify(config));
    const other = join(root, "other");
    await mkdir(other);
    await withDaemon(async (local) => {
      await seed(local);
      const id = await seed(local, { ticket: { id: "other", title: "Other", source: "local" }, access: { primary: { path: other } }, submission: { workspaceCwd: other } });
      await local.supervisor.flush();
      assert.deepEqual(new Set(sent.map(x => x.projectId)), new Set([projectId, projectIdentity(other)]));
      assert.equal(local.supervisor.notifications(projectIdentity(other)).configured, true);
      const run = local.store.read().ticketRuns[id];
      assert.equal((await call(local, "GET", `${rootPath}/tickets/${id}/runs/${run.runId}`)).status, 403);
      assert.equal((await call(local, "GET", `${rootPath}/overview`)).json.runs.length, 1);
    }, opts);
    await writeFile(file, JSON.stringify({ webhook: config.webhook }));
    assert.equal((await loadSupervisorConfig(file, "")).length, 1);
  }, { transport: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 204 }; } });
});
