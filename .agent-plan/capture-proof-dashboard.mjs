import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonStore } from "../src/store.js";
import { createTicketRun, localStages } from "../src/execution.js";
import { normalizePlan } from "../src/plan.js";
import { applyProofReports, initializeProofMap, invalidateProof } from "../src/proof-map.js";
import { capturePage } from "../scripts/screenshot.mjs";
import { previewChromiumPath } from "../src/previews.js";

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Not ready: ${url}`);
}

async function captureMobile({ url, out, script }) {
  await waitFor(url);
  const profile = await mkdtemp(join(tmpdir(), "agent-plan-mobile-chrome-"));
  const chrome = spawn(await previewChromiumPath(), ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=390,844", url], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium did not expose DevTools")), 20000);
      const receive = (chunk) => {
        const match = String(chunk).match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
      };
      chrome.stdout.on("data", receive); chrome.stderr.on("data", receive); chrome.once("exit", (code) => reject(new Error(`Chromium exited ${code}`)));
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(targets.find((target) => target.type === "page")?.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen); socket.addEventListener("error", reject); });
    let next = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); if (pending.has(message.id)) pending.get(message.id)(message); });
    const cdp = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++next; pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolveCall(message.result || {})); socket.send(JSON.stringify({ id, method, params })); });
    await cdp("Page.enable"); await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    const viewport = await cdp("Runtime.evaluate", { expression: "({ width: window.innerWidth, height: window.innerHeight })", returnByValue: true });
    if (viewport.result?.value?.width !== 390 || viewport.result?.value?.height !== 844) throw new Error("Mobile viewport metrics were not applied");
    await cdp("Runtime.evaluate", { expression: script });
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    const shot = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(out, Buffer.from(shot.data, "base64"));
    socket.close();
  } finally { chrome.kill("SIGTERM"); }
}

const root = resolve(new URL("..", import.meta.url).pathname);
const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-proof-data-"));
const cwd = await mkdtemp(join(tmpdir(), "agent-plan-proof-cwd-"));
const evidenceDir = process.env.AGENT_PLAN_EVIDENCE_DIR || join(root, ".agent-plan", "evidence");
const port = 46000 + (process.pid % 1000);
const ticket = { id: "proof-presentation", identifier: "T-PROOF", title: "Criterion proof presentation", description: "Representative criterion states for dashboard verification.", source: "local", state: { name: "Ready" } };
const plan = normalizePlan({ title: ticket.title, nodes: [{ id: "proof", title: "Present criterion proof", acceptanceCriteria: ["Verified result", "Failed result", "Blocked result", "Unresolved result", "Stale evidence", "Missing evidence"] }] });
plan.nodes[0].status = "accepted";
const artifactPath = join(dataDir, "proof-artifact.md");
const missingArtifactPath = join(dataDir, "missing-artifact.md");
await mkdir(evidenceDir, { recursive: true });
await writeFile(artifactPath, "Canonical artifact evidence");
await writeFile(missingArtifactPath, "Evidence later removed");
const artifact = { id: "proof-artifact", name: "proof-artifact.md", path: artifactPath, kind: "agent-output", stageId: "verify" };
const missingArtifact = { id: "missing-artifact", name: "missing-artifact.md", path: missingArtifactPath, kind: "agent-output", stageId: "verify" };
const proofContext = { plan, artifacts: [artifact, missingArtifact], finalChecks: { status: "passed", command: "node .agent-plan/verify.mjs", summary: "Canonical final check output", output: "All checks passed." } };
let proofMap = initializeProofMap(plan);
const ids = proofMap.criteria.map((criterion) => criterion.id);
proofMap = applyProofReports(proofMap, [{ criterionId: ids[0], status: "verified", evidence: [{ type: "check", scope: "final" }] }], proofContext);
proofMap = applyProofReports(proofMap, [{ criterionId: ids[1], status: "failed", explanation: { summary: "Regression reproduced." }, evidence: [{ type: "artifact", artifactId: artifact.id }] }], proofContext);
proofMap = applyProofReports(proofMap, [{ criterionId: ids[2], status: "blocked", explanation: { summary: "Awaiting upstream service." }, evidence: [{ type: "artifact", artifactId: artifact.id }] }], proofContext);
proofMap = applyProofReports(proofMap, [{ criterionId: ids[4], status: "verified", evidence: [{ type: "check", scope: "final" }] }], proofContext);
proofMap = invalidateProof(proofMap, [ids[4]], { reason: "Correction changed the validated flow." });
proofMap = applyProofReports(proofMap, [{ criterionId: ids[5], status: "verified", evidence: [{ type: "artifact", artifactId: missingArtifact.id }] }], proofContext);
const store = new JsonStore(join(dataDir, "state-v3.json"), cwd);
await store.init();
await store.update((state) => {
  state.selectedTicketId = ticket.id;
  state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
    runId: "proof-presentation", status: "awaiting_evidence_review", workspace: { cwd }, plan,
    artifacts: [artifact], proofMap, finalChecks: proofContext.finalChecks,
    reviews: [{ round: 1, reviews: [{ role: "deterministic", summary: "Checks passed", checks: proofContext.finalChecks }] }],
    checkpoint: { id: "proof-review", kind: "evidence_review", title: "Review criterion proof before delivery", finalChecks: proofContext.finalChecks, media: [] },
    stages: localStages().map((stage) => stage.id === "verify" ? { ...stage, status: "completed", summary: "Proof review complete" } : stage.id === "handoff" ? { ...stage, status: "blocked", summary: "Review criterion proof before delivery" } : stage)
  });
});
const server = spawn(process.execPath, [join(root, "src/server.js"), "--cwd", cwd, "--port", String(port)], { cwd: root, env: { ...process.env, AGENT_PLAN_DATA_DIR: dataDir }, stdio: "ignore" });
const focusProof = `document.querySelector('.proof-gallery')?.remove(); document.querySelector('.final-review-summaries')?.remove(); document.querySelector('.workflow-stages')?.remove(); document.querySelector('.stage-context')?.remove(); document.querySelector('#ticket-header').style.display = 'none'; document.querySelectorAll('.criterion-proof').forEach((item) => { item.style.padding = '5px'; item.style.gap = '2px'; }); document.querySelector('.criterion-proof-map')?.scrollIntoView({ block: 'start' });`;
try {
  await capturePage({ url: `http://127.0.0.1:${port}`, out: join(evidenceDir, "criterion-proof-dashboard.png"), waitMs: 1800, eval: focusProof });
  await captureMobile({ url: `http://127.0.0.1:${port}`, out: join(evidenceDir, "criterion-proof-dashboard-mobile.png",), script: `document.querySelector('.proof-gallery')?.remove(); document.querySelector('#ticket-header').style.display = 'none'; document.querySelector('.workflow-stages').style.display = 'none'; document.querySelector('.criterion-proof-map')?.scrollIntoView({ block: 'start' });` });
  process.stdout.write(`${evidenceDir}\n`);
} finally {
  server.kill("SIGTERM");
}
