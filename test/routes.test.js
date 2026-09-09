import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createRoutes } from "../src/routes.js";

function response() {
  return {
    headers: null,
    content: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(content = "") { this.content = content; }
  };
}

function request(method, payload = null) {
  const stream = new PassThrough();
  stream.method = method;
  if (payload === null) stream.end();
  else stream.end(JSON.stringify(payload));
  return stream;
}

function operations(overrides = {}) {
  const call = (name) => async (...args) => ({ name, args });
  const group = (names) => Object.fromEntries(names.map((name) => [name, call(name)]));
  return {
    inspection: group(["state", "ticketRun", "checkOutput", "diffOutput", "reviewPacket", "ticketInspection", "runHistories", "runInspection", "models", "skills", "openArtifact", "operatorPreview", "attemptDetail", "artifactMedia", "artifactContent", "artifact", "sessionTrace", "steering", "stageOutput", "stagePrompts", "ticketSources", "events", "ticketSkills"]),
    tickets: group(["createReviewMap", "beginMany", "begin", "select", "bindWorkflow", "continueWorkflow", "resume", "restartFixer", "restart", "cancel", "pause", "clarify", "editPlan", "approvePlan", "finishHandoff", "changeEvidence", "expandStepScope", "waiveStep", "decideStep"]),
    workspace: group(["pick", "accessPolicy", "saveAccessPolicy", "set", "loadLocal"]),
    previews: group(["start", "stop"]),
    steering: group(["submit"]),
    settings: group(["trackerSettings", "saveTrackerSettings", "clearQueue", "forgetRun", "retention", "cleanupRetention", "saveStageProfiles", "saveTicketStageProfile"]),
    ...overrides
  };
}

test("routes decode parameters and delegate preview actions without daemon access", async () => {
  const calls = [];
  const groups = operations({
    previews: {
      async stop(ticketId) { calls.push(["stop", ticketId]); },
      async start(ticketId) { calls.push(["start", ticketId]); return { status: "running" }; }
    },
    inspection: {
      ...operations().inspection,
      async operatorPreview(ticketId) { calls.push(["preview", ticketId]); return null; }
    }
  });
  const route = createRoutes({ version: "test", ...groups });
  const result = response();
  await route(request("POST", { action: "stop" }), result, new URL("http://local/api/tickets/a%20ticket/preview"));

  assert.deepEqual(calls, [["stop", "a ticket"], ["preview", "a ticket"]]);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.content), { ticketId: "a ticket", preview: null });
});

test("routes preserve inspection query parsing and media response headers", async () => {
  const calls = [];
  const groups = operations({
    inspection: {
      ...operations().inspection,
      async checkOutput(ticketId, options) { calls.push([ticketId, options]); return { status: "passed" }; },
      async artifactMedia(input) { return { mediaType: "image/png", content: Buffer.from(input.artifactId) }; }
    }
  });
  const route = createRoutes({ version: "test", ...groups });
  const checks = response();
  await route(request("GET"), checks, new URL("http://local/api/tickets/ticket/proof/check-output?scope=attempt&stepId=step&attemptId=a"));
  assert.deepEqual(calls, [["ticket", { scope: "attempt", stepId: "step", attemptId: "a", reviewId: null }]]);
  assert.deepEqual(JSON.parse(checks.content), { status: "passed" });

  const media = response();
  await route(request("GET"), media, new URL("http://local/api/tickets/ticket/artifacts/proof%20image/media"));
  assert.equal(media.status, 200);
  assert.equal(media.headers["content-type"], "image/png");
  assert.equal(media.content.toString(), "proof image");
});
