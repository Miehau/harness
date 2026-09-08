#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewChromiumPath } from "../src/previews.js";
import { repoRoot } from "./inspect.js";

const captureTimeoutMs = 45000;
const cdpRequestTimeoutMs = 15000;
export const viewports = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844]
];

function required(value, name) {
  if (!value) throw new Error(`Final proof requires ${name}`);
  return value;
}

function safeName(value) {
  return String(value).trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function readLiveState({ url, fetchImpl = fetch }) {
  const response = await fetchImpl(`${url.replace(/\/$/, "")}/api/state`);
  if (!response.ok) throw new Error(`Could not inspect final proof state (${response.status})`);
  return response.json();
}

function focusedInspectorTitle(run) {
  const focus = run?.inspectionFocus;
  if (!focus?.stageId) return null;
  const stageId = focus.stageId.replace(/^stage:/, "");
  const stepId = focus.workerId?.replace(/^worker:/, "");
  const steps = (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children || [] : [node]);
  return steps.find((step) => step.id === stepId)?.title || run.stages?.find((stage) => stage.id === stageId)?.title || null;
}

export function finalProofIdentity(state, { ticketId, runId }) {
  const run = state?.ticketRuns?.[ticketId] || state?.retainedRuns?.[ticketId];
  if (!run) throw new Error(`Final proof ticket ${ticketId} is not present in the inspected state`);
  if (run.runId !== runId) throw new Error(`Final proof run mismatch: expected ${runId}, received ${run.runId || "none"}`);
  if (state.selectedTicketId !== ticketId) throw new Error(`Final proof ticket ${ticketId} is not selected in the inspected state`);
  const ticketTitle = run.ticket?.title?.trim();
  if (!ticketTitle) throw new Error(`Final proof ticket ${ticketId} has no visible title`);
  return {
    ticketId,
    ticketIdentifier: run.ticket?.identifier || ticketId,
    ticketTitle,
    runId,
    revision: state.revision,
    checkpointId: run.checkpoint?.id || null,
    checkpointKind: run.checkpoint?.kind || null,
    status: run.status,
    focusedStageId: run.inspectionFocus?.stageId || null,
    focusedInspectorTitle: focusedInspectorTitle(run)
  };
}

async function selectLiveTicket({ url, ticketId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${url.replace(/\/$/, "")}/api/tickets/${encodeURIComponent(ticketId)}/select`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  if (!response.ok) throw new Error(`Could not select final proof ticket ${ticketId} (${response.status})`);
}

/**
 * Chrome's --remote-debugging-pipe uses NUL-delimited JSON, not a
 * length-prefixed protocol. Deadlines reject stalled requests so a broken pipe
 * cannot leave canonical verification running indefinitely.
 */
export function cdpConnection({ input, output, timeoutMs = cdpRequestTimeoutMs }) {
  let nextId = 1;
  let buffered = Buffer.alloc(0);
  let closedError = null;
  const pending = new Map();
  const fail = (error) => {
    if (closedError) return;
    closedError = error instanceof Error ? error : new Error(String(error));
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(closedError); }
    pending.clear();
  };
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    let delimiter;
    while ((delimiter = buffered.indexOf(0)) !== -1) {
      const frame = buffered.subarray(0, delimiter).toString("utf8");
      buffered = buffered.subarray(delimiter + 1);
      if (!frame) continue;
      let message;
      try { message = JSON.parse(frame); } catch { fail(new Error("Chrome CDP pipe returned invalid JSON")); return; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`Chrome CDP ${request.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
      else request.resolve(message.result);
    }
  };
  const onError = (error) => fail(error);
  const onClose = () => fail(new Error("Chrome CDP pipe closed"));
  input.on("data", onData);
  input.once("error", onError);
  input.once("end", onClose);
  output.once("error", onError);
  return {
    send(method, params = {}, sessionId) {
      if (closedError) return Promise.reject(closedError);
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome CDP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { method, resolve: resolveRequest, reject, timer });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        try { output.write(`${JSON.stringify(message)}\0`); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    close(error = new Error("Chrome CDP connection closed")) {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onClose);
      output.off("error", onError);
      fail(error);
    }
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function launchChrome(source = process.env, { spawnImpl = spawn } = {}) {
  const browser = await previewChromiumPath(source);
  const child = spawnImpl(browser, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-pipe"
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  if (!child.stdio?.[3] || !child.stdio?.[4]) throw new Error("Chrome did not provide a remote debugging pipe");
  const connection = cdpConnection({ input: child.stdio[4], output: child.stdio[3] });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  return {
    connection,
    async close() {
      connection.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
    }
  };
}

export function readinessExpression(identity) {
  return `(() => {
    const expected = ${JSON.stringify({ identifier: identity.ticketIdentifier, title: identity.ticketTitle, focusedStageId: identity.focusedStageId || null, focusedInspectorTitle: identity.focusedInspectorTitle || null })};
    const rendered = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const matching = (selector, needle) => [...document.querySelectorAll(selector)].find((element) =>
      rendered(element) && element.innerText?.trim().toLowerCase().includes(needle.toLowerCase()));
    const bounds = (element) => {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      return { top, right, bottom, left };
    };
    // These exact elements are checked immediately before capture. Mobile proof
    // captures the natural full page, which includes both separated anchors.
    const identifier = matching("#ticket-header .eyebrow", expected.identifier);
    const title = matching("#ticket-header h2", expected.title);
    const workflow = matching(".workflow-stages .eyebrow", "Workflow map");
    const inspector = document.querySelector("#inspector");
    const inspectorTitle = expected.focusedInspectorTitle ? matching("#inspector h2", expected.focusedInspectorTitle) : null;
    const focusedStage = expected.focusedStageId
      ? [...document.querySelectorAll(".workflow-stage")].find((element) => element.dataset.stage === expected.focusedStageId.replace(/^stage:/, ""))
      : null;
    if (!identifier || !title || !workflow || !rendered(inspector) || !inspector.innerText.trim()) return null;
    if (expected.focusedStageId && (!focusedStage || focusedStage.getAttribute("aria-selected") !== "true")) return null;
    if (expected.focusedInspectorTitle && !inspectorTitle) return null;
    return {
      ticketIdentifier: expected.identifier, ticketTitle: expected.title, workflow: true, inspector: true, focusedStageId: expected.focusedStageId, focusedInspectorTitle: expected.focusedInspectorTitle,
      frame: { identity: bounds(title), workflow: bounds(workflow), inspector: bounds(inspector) }
    };
  })()`;
}

export function assertCaptureFrame(rendered, width, height) {
  const anchors = Object.values(rendered?.frame || {});
  if (anchors.length !== 3 || anchors.some(({ top, right, bottom, left }) => !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom) || !Number.isFinite(left) || top < 0 || left < 0 || bottom > height || right > width)) {
    throw new Error("Final proof anchors are not all inside the screenshot frame");
  }
}

async function waitForRenderedDashboard(connection, sessionId, identity, timeoutMs = captureTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await connection.send("Runtime.evaluate", { expression: readinessExpression(identity), returnByValue: true }, sessionId);
      if (response.result?.value) return response.result.value;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Final proof dashboard did not render selected ${identity.ticketIdentifier} workflow within ${Math.round(timeoutMs / 1000)} seconds${lastError ? ` (${lastError.message})` : ""}`);
}

export async function captureLiveViewport({ connection, url, path, width, height, identity }) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  let sessionId;
  try {
    ({ sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true }));
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 480 }, sessionId);
    await connection.send("Page.navigate", { url }, sessionId);
    const rendered = await waitForRenderedDashboard(connection, sessionId, identity);
    const fullPage = width <= 480;
    let captureHeight = height;
    const options = { format: "png", captureBeyondViewport: fullPage };
    if (fullPage) {
      // The 390px layout naturally separates identity and workflow by a fold.
      // Capture its same-page CSS layout, rather than changing zoom or scale, so
      // the saved evidence visibly contains both checked anchors.
      const metrics = await connection.send("Page.getLayoutMetrics", {}, sessionId);
      const content = metrics.cssContentSize || metrics.contentSize;
      if (!content?.width || !content?.height) throw new Error("Chrome did not return mobile final-proof layout metrics");
      captureHeight = Math.max(height, Math.ceil(content.height));
      options.clip = { x: 0, y: 0, width, height: captureHeight, scale: 1 };
    }
    assertCaptureFrame(rendered, width, captureHeight);
    const screenshot = await connection.send("Page.captureScreenshot", options, sessionId);
    if (!screenshot.data) throw new Error(`Chrome did not return a ${width}x${height} screenshot`);
    await writeFile(path, Buffer.from(screenshot.data, "base64"));
    return { path, rendered };
  } finally {
    if (sessionId) await connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    await connection.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

export async function captureFinalProof({
  evidenceDir = process.env.AGENT_PLAN_EVIDENCE_DIR || join(repoRoot, "docs", "evidence"),
  url = process.env.AGENT_PLAN_CAPTURE_URL,
  ticketId = process.env.AGENT_PLAN_CAPTURE_TICKET_ID,
  runId = process.env.AGENT_PLAN_CAPTURE_RUN_ID,
  readState = readLiveState,
  select = selectLiveTicket,
  launch = launchChrome,
  captureViewport = captureLiveViewport,
  now = () => new Date()
} = {}) {
  url = required(url, "AGENT_PLAN_CAPTURE_URL");
  ticketId = required(ticketId, "AGENT_PLAN_CAPTURE_TICKET_ID");
  runId = required(runId, "AGENT_PLAN_CAPTURE_RUN_ID");
  await select({ url, ticketId });
  // The selection endpoint has committed before it responds; read its projection only
  // afterwards so the browser and manifest are tied to the requested ticket/run.
  const identity = finalProofIdentity(await readState({ url }), { ticketId, runId });
  const capturedAt = now().toISOString();
  const base = `final-${safeName(identity.ticketIdentifier)}-${safeName(runId)}`;
  await mkdir(evidenceDir, { recursive: true });
  const chrome = await launch();
  let captures;
  try {
    captures = [];
    for (const [name, width, height] of viewports) {
      const path = join(evidenceDir, `${base}-${name}.png`);
      // The same CDP page checks selection/readiness and immediately produces
      // this PNG, preventing a separately launched screenshot from drifting.
      const captured = await captureViewport({ connection: chrome.connection, url, path, width, height, identity });
      captures.push({ name, width, height, rendered: captured.rendered, path: captured.path });
    }
  } finally {
    await chrome.close();
  }
  const manifest = { version: 1, source: "live-ticket-run", url, capturedAt, identity, captures };
  await writeFile(join(evidenceDir, "final-proof-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { evidenceDir, manifest, captures };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) captureFinalProof().then(({ manifest, captures }) => {
  process.stdout.write(`Final proof: ${manifest.identity.ticketIdentifier} · ${manifest.identity.runId} · revision ${manifest.identity.revision}\n`);
  for (const item of captures) process.stdout.write(`${item.name}: ${item.width}x${item.height} ${item.path}\n`);
}, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
