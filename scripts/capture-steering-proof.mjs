#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDaemon } from "../src/server.js";
import { createTicketRun, localStages } from "../src/execution.js";
import { normalizePlan } from "../src/plan.js";
import { acknowledgeSteering, claimNextSteering, markSteeringDelivered, submitSteering } from "../src/steering.js";
import { mockHarness, sampleTicket } from "./harness.js";
import { previewChromiumPath } from "../src/previews.js";

const knownCriteria = new Set([
  "criterion-f4faf9f08b411a3f",
  "criterion-7574042b85f60417",
  "criterion-2348cf5af7ea07ef",
  "criterion-f9a363ef01919851"
]);
const desktopCriteria = new Set(["criterion-f4faf9f08b411a3f", "criterion-7574042b85f60417", "criterion-2348cf5af7ea07ef", "criterion-f9a363ef01919851"]);
const liveInstruction = "Preserve FIFO steering behavior.";
const acknowledgedInstruction = "Make worker acknowledgment states remain visible.";
const queuedInstruction = "Queued proof: waiting for Pi.";
const claimedInstruction = "Claimed proof: Pi delivery in progress.";
const failedInstruction = "Failed proof: worker ended first.";
const rejectedInstruction = "Rejected proof: empty instruction.";

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

async function stopBrowser(chrome) {
  if (chrome.exitCode !== null || chrome.signalCode) return;
  const exited = new Promise((resolveExit) => chrome.once("exit", resolveExit));
  chrome.kill("SIGTERM");
  const didExit = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
  if (!didExit && chrome.exitCode === null && !chrome.signalCode) {
    chrome.kill("SIGKILL");
    await Promise.race([exited, sleep(1000)]);
  }
}

function pageTextIncludes(text) {
  return `(document.body?.textContent || '').toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})`;
}

function recordIncludes(state, texts) {
  const checks = texts.map((text) => `(record.textContent || '').toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})`).join(" && ");
  return `Array.from(document.querySelectorAll('.steering-record.steering-${state}')).some((record) => ${checks || "true"})`;
}

function visibleSteeringStates(states) {
  return `(() => {
    const states = ${JSON.stringify(states)};
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    return states.every((state) => Array.from(document.querySelectorAll('.steering-record.steering-' + state)).some((record) => {
      const rect = record.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width;
    }));
  })()`;
}

function collectCriterionIds(value, ids = []) {
  if (typeof value === "string") ids.push(value);
  else if (Array.isArray(value)) for (const item of value) collectCriterionIds(item, ids);
  else if (value && typeof value === "object") {
    if (value.id || value.criterionId) ids.push(value.id || value.criterionId);
    for (const [key, item] of Object.entries(value)) {
      if (knownCriteria.has(key)) ids.push(key);
      collectCriterionIds(item, ids);
    }
  }
  return ids;
}

function selectedCriterionIds() {
  if (!process.env.AGENT_PLAN_CAPTURE_CRITERIA) return [];
  let parsed;
  try { parsed = JSON.parse(process.env.AGENT_PLAN_CAPTURE_CRITERIA); }
  catch (error) { throw new Error(`AGENT_PLAN_CAPTURE_CRITERIA must be JSON: ${error.message}`); }
  return [...new Set(collectCriterionIds(parsed).filter((id) => knownCriteria.has(id)))];
}

function sendCdp(socket) {
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return (method, params = {}) => new Promise((resolveCdp, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolveCdp(message.result || {}));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function launchBrowser(url, { width, height, mobile = false }) {
  const profile = await mkdtemp(join(tmpdir(), "agent-plan-steering-chrome-"));
  const chrome = spawn(await previewChromiumPath(), [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  try {
    const debugPort = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium did not expose DevTools")), 20000);
      const onData = (chunk) => {
        const match = String(chunk).match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      };
      chrome.stderr.on("data", onData);
      chrome.stdout.on("data", onData);
      chrome.once("exit", (code) => reject(new Error(`Chromium exited ${code}`)));
    });
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page) throw new Error("No Chromium page target");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveSocket, reject) => {
      socket.addEventListener("open", resolveSocket);
      socket.addEventListener("error", () => reject(new Error("DevTools websocket failed")));
    });
    const cdp = sendCdp(socket);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    if (mobile) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true });
    }
    await cdp("Page.navigate", { url });
    const browser = {
      async evaluate(expression) {
        const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
        return result.result?.value;
      },
      async waitFor(expression, label, timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        let lastError = null;
        while (Date.now() < deadline) {
          try { if (await this.evaluate(`Boolean(${expression})`)) return; }
          catch (error) { lastError = error; }
          await sleep(100);
        }
        const body = await this.evaluate("document.body?.innerText || ''").catch(() => "");
        throw new Error(`${label}${lastError ? `: ${lastError.message}` : ""}\n${body.slice(0, 2000)}`);
      },
      async submitInstruction(instruction) {
        await this.evaluate(`(() => {
          const form = document.querySelector(".steering-form");
          if (!form) throw new Error("Missing steering form");
          const textarea = form.querySelector('textarea[name="instruction"]');
          textarea.value = ${JSON.stringify(instruction)};
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          form.requestSubmit();
          return true;
        })()`);
      },
      async reload() {
        await cdp("Page.reload", { ignoreCache: true });
      },
      async setViewport(nextViewport) {
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: nextViewport.width,
          height: nextViewport.height,
          deviceScaleFactor: nextViewport.mobile ? 2 : 1,
          mobile: Boolean(nextViewport.mobile)
        });
      },
      async focusSteeringPanel() {
        await this.evaluate(`(() => {
          document.documentElement.style.scrollBehavior = 'auto';
          const panel = document.querySelector('.steering-panel');
          if (!panel) throw new Error('Missing steering panel');
          panel.scrollIntoView({ block: 'start', inline: 'nearest' });
          const inspector = document.querySelector('.inspector');
          if (inspector) inspector.scrollTop = Math.max(0, panel.offsetTop - 8);
          return true;
        })()`);
        await sleep(250);
      },
      async screenshot(path) {
        const shot = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
        await writeFile(path, Buffer.from(shot.data, "base64"));
      },
      async close() {
        socket?.close();
        await stopBrowser(chrome);
        await rm(profile, { recursive: true, force: true });
      }
    };
    await browser.waitFor("document.readyState === 'complete' && document.querySelector('.steering-form')", "Dashboard did not render the steering form");
    return browser;
  } catch (error) {
    socket?.close();
    await stopBrowser(chrome);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

function addProofRecord(run, { id, state, sequence, instruction, reason, createdAt, eventType = state, claim = null }) {
  const record = {
    id: `steer-${id}`,
    instruction,
    author: "dashboard",
    ticketId: run.id,
    runId: run.runId,
    stepId: "ledger",
    attemptId: "archived",
    sequence,
    state,
    reason,
    reasonCode: `${state}_proof`,
    createdAt,
    updatedAt: createdAt,
    claim: claim || { attempts: 0, maxAttempts: 3, claimId: null, claimedAt: null, expiresAt: null },
    events: [{ type: eventType, at: createdAt, reason, code: `${state}_proof` }]
  };
  run.steering.records.push(record);
  run.steering.nextSequence = Math.max(run.steering.nextSequence, sequence + 1);
  return record;
}

async function seedSteeringRun(daemon, cwd) {
  const at = Date.parse("2026-09-08T12:00:00.000Z");
  const plan = normalizePlan({ title: "Durable active-worker steering", nodes: [{
    id: "ledger", title: "Maintain steering ledger", permission: "write", writeScope: "src/steering.js",
    expectedFiles: ["src/steering.js"],
    acceptanceCriteria: [
      "FIFO steering behavior remains durable for the active worker.",
      "Steering delivery and worker acknowledgment states remain visible after refresh."
    ]
  }] });
  Object.assign(plan.nodes[0], {
    status: "running",
    agentId: "pi-worker-proof",
    activeAttempt: { id: "live", status: "active", workerRunId: "worker", startedAt: new Date(at).toISOString() }
  });
  const ticket = sampleTicket({
    id: "steer-proof", identifier: "STEER-PROOF", title: "Durable active-worker steering proof",
    description: "Seeded local dashboard state for active-worker steering proof.", source: "local",
    state: { name: "Local fixture", type: "local" }, team: { name: "Local" }
  });
  await daemon.store.update((state) => {
    const run = createTicketRun(ticket, state.stageProfiles, {
      runId: "run-proof", status: "running", workspace: { cwd }, plan,
      activeRuns: { ledger: {
        runId: "worker", attemptId: "live", startedAt: new Date(at).toISOString(),
        lastEventAt: new Date(at + 1000).toISOString(), lastEvent: "Pi worker session active", warning: false,
        piSessionState: "active"
      } },
      stages: localStages().map((stage) => stage.id === "implement"
        ? { ...stage, status: "active", summary: "Pi worker session active for steering" }
        : stage)
    });
    const acked = submitSteering(run, { instruction: acknowledgedInstruction, author: "dashboard" }, {
      stepId: "ledger", now: at - 60000, idFactory: () => "acknowledged"
    });
    if (!acked.accepted || !acked.record) throw new Error(`Seeded acknowledged steering was not accepted: ${acked.validation?.reason || acked.reason || "unknown reason"}`);
    const claim = claimNextSteering(run, acked.record, { now: at - 59000, idFactory: () => "acknowledged" });
    if (!claim) throw new Error("Seeded acknowledged steering could not be claimed for delivery.");
    markSteeringDelivered(run, claim.id, claim.claim.claimId, {
      now: at - 58000,
      evidence: { source: "capture-proof-seed", session: "mock-pi", accepted: true }
    });
    acknowledgeSteering(run, claim.id, {
      now: at - 57000,
      evidence: { source: "worker_report", summary: "Seeded worker acknowledged the delivered steering.", acknowledgedSteerIds: [claim.id] }
    });
    addProofRecord(run, {
      id: "queued-proof",
      state: "queued",
      sequence: 20,
      instruction: queuedInstruction,
      reason: "Waiting for the bound worker attempt.",
      createdAt: new Date(at - 50000).toISOString(),
      eventType: "accepted"
    });
    addProofRecord(run, {
      id: "claimed-proof",
      state: "claimed",
      sequence: 21,
      instruction: claimedInstruction,
      reason: "Pi delivery is in progress.",
      createdAt: new Date(at - 49000).toISOString(),
      eventType: "claimed",
      claim: {
        attempts: 1,
        maxAttempts: 3,
        claimId: "claim-claimed-proof",
        claimedAt: new Date(at - 48000).toISOString(),
        expiresAt: "2099-09-08T12:00:30.000Z"
      }
    });
    addProofRecord(run, {
      id: "failed-proof",
      state: "failed",
      sequence: 22,
      instruction: failedInstruction,
      reason: "The bound Pi worker session ended before this steering delivery settled.",
      createdAt: new Date(at - 47000).toISOString(),
      eventType: "failed"
    });
    run.steeringRejections = [{
      id: "steer-rejection-proof",
      instruction: rejectedInstruction,
      author: "dashboard",
      code: "instruction_required",
      reason: "A steering instruction is required.",
      createdAt: new Date(at - 46000).toISOString()
    }];
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = run;
  });
}

async function preflightSeededLifecycle() {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-steering-preflight-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-steering-preflight-cwd-"));
  const harness = {
    ...mockHarness(),
    async steer(delivery) {
      return { source: "capture-proof-preflight", session: "mock-pi", steerId: delivery.steerId, acceptedAt: new Date().toISOString() };
    }
  };
  const daemon = await createDaemon({ cwd, dataDir, listen: true, lock: false, host: "127.0.0.1", port: 0, harness });
  try {
    if (!daemon.server.listening) await new Promise((resolveListen) => daemon.server.once("listening", resolveListen));
    await seedSteeringRun(daemon, cwd);
    const run = daemon.store.read().ticketRuns["steer-proof"];
    const record = run?.steering?.records?.find((item) => item.instruction === acknowledgedInstruction);
    if (!record) throw new Error("Preflight did not persist the seeded acknowledged steering record.");
    if (record.state !== "acknowledged") throw new Error(`Preflight seeded steering stopped at ${record.state}; expected acknowledged.`);
    const events = record.events?.map((event) => event.type) || [];
    for (const eventType of ["accepted", "claimed", "delivered", "acknowledged"]) {
      if (!events.includes(eventType)) throw new Error(`Preflight seeded steering missed ${eventType}.`);
    }
    await runJourney(`http://${daemon.host}:${daemon.server.address().port}/`, join(cwd, "steering-preflight.png"), { width: 1440, height: 900, mobile: false });
    process.stdout.write("Capture-proof steering preflight passed.\n");
  } finally {
    await daemon.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function runJourney(url, outputPath, viewport) {
  const browser = await launchBrowser(url, viewport);
  try {
    const targetText = "steer-proof · run run-proof · step ledger · attempt live";
    await browser.waitFor(pageTextIncludes(targetText), "Active steering target was not visible");
    await browser.waitFor(recordIncludes("acknowledged", ["Worker acknowledged delivery", acknowledgedInstruction, "Acknowledged"]), "Seeded acknowledged lifecycle was not visible");
    await browser.waitFor(recordIncludes("queued", ["Queued for Pi delivery", queuedInstruction, "Submitted"]), "Queued lifecycle record was not visible");
    await browser.waitFor(recordIncludes("claimed", ["Pi delivery in progress", claimedInstruction, "Claimed"]), "Claimed lifecycle record was not visible");
    await browser.waitFor(recordIncludes("failed", ["Delivery failed", failedInstruction, "bound Pi worker session ended"]), "Failed lifecycle record was not visible");
    await browser.waitFor(recordIncludes("rejected", ["Rejected before acceptance", rejectedInstruction, "A steering instruction is required"]), "Rejected lifecycle record was not visible");
    await browser.submitInstruction(liveInstruction);
    await browser.waitFor(recordIncludes("delivered", ["Delivered to Pi · awaiting acknowledgment", liveInstruction, "Delivered"]), "Delivered lifecycle was not visible after form submission");
    await browser.reload();
    await browser.waitFor(pageTextIncludes(targetText), "Active target did not survive refresh");
    await browser.waitFor([recordIncludes("delivered", [liveInstruction]), recordIncludes("acknowledged", [acknowledgedInstruction]), recordIncludes("queued", [queuedInstruction]), recordIncludes("claimed", [claimedInstruction]), recordIncludes("failed", [failedInstruction]), recordIncludes("rejected", [rejectedInstruction])].join(" && "), "Steering lifecycle history did not survive refresh");
    await browser.waitFor(`${pageTextIncludes(liveInstruction)} && ${pageTextIncludes(acknowledgedInstruction)}`, "Submitted and acknowledged steering instructions were not visibly separated");
    await browser.waitFor(`document.querySelectorAll('.steering-record').length >= 6`, "Expected queued, claimed, failed, rejected, delivered, and acknowledged steering records");
    await browser.setViewport(viewport.mobile ? { width: viewport.width, height: 3400, mobile: true } : { width: viewport.width, height: 1700, mobile: false });
    await browser.focusSteeringPanel();
    await browser.waitFor(visibleSteeringStates(["delivered", "acknowledged", "queued", "claimed", "failed", "rejected"]), "All durable steering lifecycle records were not fully visible in the proof viewport");
    await browser.screenshot(outputPath);
  } finally {
    await browser.close();
  }
}

function captureEntry(path, criterionIds, viewport, commands, assertions) {
  return criterionIds.length ? { path, criterionIds, viewport, commands, assertions } : null;
}

async function main() {
  if (process.argv.includes("--preflight")) {
    await preflightSeededLifecycle();
    return;
  }
  const evidenceDir = process.env.AGENT_PLAN_EVIDENCE_DIR;
  if (!evidenceDir) throw new Error("AGENT_PLAN_EVIDENCE_DIR is required for capture-proof");
  const absoluteEvidenceDir = resolve(evidenceDir);
  const selected = selectedCriterionIds();
  const selectedKnown = selected.filter((id) => knownCriteria.has(id));
  await mkdir(absoluteEvidenceDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-steering-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-steering-cwd-"));
  const harness = {
    ...mockHarness(),
    async steer(delivery) {
      return { source: "capture-proof", session: "mock-pi", steerId: delivery.steerId, acceptedAt: new Date().toISOString() };
    }
  };
  const daemon = await createDaemon({ cwd, dataDir, listen: true, lock: false, host: "127.0.0.1", port: 0, harness });
  if (!daemon.server.listening) await new Promise((resolveListen) => daemon.server.once("listening", resolveListen));
  const url = `http://${daemon.host}:${daemon.server.address().port}/`;
  const desktopPath = join(absoluteEvidenceDir, "steering-dashboard-desktop.png");
  const captures = [];
  try {
    await seedSteeringRun(daemon, cwd);
    await runJourney(url, desktopPath, { width: 1440, height: 900, mobile: false });
    const desktopIds = selectedKnown.filter((id) => desktopCriteria.has(id));
    const sharedAssertions = [
      "Active worker steering form shows ticket, run, step, and attempt target.",
      "Submitting the dashboard form creates a delivered steering record against the isolated mock Pi session.",
      "A browser refresh preserves the active target and durable steering history.",
      "History distinguishes Delivered to Pi · awaiting acknowledgment from Worker acknowledged delivery.",
      "Queued, claimed, rejected, failed, delivered, and acknowledged dashboard records each show their reason and timestamp context.",
      "The submitted correction and the seeded acknowledged correction remain visible as separate steering records."
    ];
    captures.push(captureEntry(desktopPath, desktopIds, { width: 1440, height: 1700 }, [
      "seed isolated local steering run",
      "open dashboard in desktop Chromium",
      "submit focused steering instruction from the dashboard",
      "reload dashboard, scroll the steering panel into view, and capture lifecycle screenshot"
    ], sharedAssertions));
    const manifest = {
      source: "live-ticket-run",
      identity: {
        ticketId: process.env.AGENT_PLAN_CAPTURE_TICKET_ID || null,
        runId: process.env.AGENT_PLAN_CAPTURE_RUN_ID || null
      },
      captures: captures.filter(Boolean)
    };
    await writeFile(join(absoluteEvidenceDir, "final-proof-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Wrote steering dashboard proof to ${absoluteEvidenceDir}\n`);
  } finally {
    await daemon.close({ exit: false });
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
