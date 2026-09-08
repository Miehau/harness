#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney, validateJourney } from "../.agent-plan/ui.mjs";
import { ticketProofManifest } from "../src/visual-evidence.js";

const viewports = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844]
];

async function ticketIdentity(url, ticketId, runId) {
  try {
    const state = await (await fetch(`${url.replace(/\/$/, "")}/api/state`)).json();
    const run = state.ticketRuns?.[ticketId];
    return {
      ticketIdentifier: run?.ticket?.identifier || ticketId,
      ticketTitle: run?.ticket?.title || null
    };
  } catch {
    return { ticketIdentifier: ticketId, ticketTitle: null };
  }
}

export async function captureTicketProof({
  url = process.env.AGENT_PLAN_CAPTURE_URL,
  ticketId = process.env.AGENT_PLAN_CAPTURE_TICKET_ID,
  runId = process.env.AGENT_PLAN_CAPTURE_RUN_ID,
  evidenceDir = process.env.AGENT_PLAN_EVIDENCE_DIR,
  criteria = JSON.parse(process.env.AGENT_PLAN_CAPTURE_CRITERIA || "[]"),
  scenarios,
  journey = runJourney
} = {}) {
  if (!url) throw new Error("Ticket-bound proof requires AGENT_PLAN_CAPTURE_URL");
  if (!ticketId) throw new Error("Ticket-bound proof requires AGENT_PLAN_CAPTURE_TICKET_ID");
  if (!runId) throw new Error("Ticket-bound proof requires AGENT_PLAN_CAPTURE_RUN_ID");
  if (!evidenceDir) throw new Error("Ticket-bound proof requires AGENT_PLAN_EVIDENCE_DIR");
  if (!Array.isArray(criteria) || !criteria.length) throw new Error("Ticket-bound proof requires current AGENT_PLAN_CAPTURE_CRITERIA");
  scenarios ||= JSON.parse(await readFile(new URL("../.agent-plan/ui-scenarios.json", import.meta.url), "utf8"));
  if (!Array.isArray(scenarios)) throw new Error("UI scenarios must be an array");
  const selected = criteria.map((criterion) => {
    const matches = scenarios.filter((scenario) => scenario.criterion === criterion.text);
    if (matches.length !== 1) throw new Error(`Define one UI CLI scenario for acceptance criterion: ${criterion.text}`);
    const scenario = matches[0];
    validateJourney(scenario.commands, scenario.assertions);
    if (!scenario.assertions?.length) throw new Error(`UI scenario needs assertions: ${criterion.text}`);
    return { criterion, scenario };
  });
  await mkdir(evidenceDir, { recursive: true });
  const evidenceRoot = join(evidenceDir, "saved-extra-root");
  await mkdir(evidenceRoot, { recursive: true });
  const replaceFixture = (value) => value === "$evidenceRoot" ? evidenceRoot : value;
  const identity = await ticketIdentity(url, ticketId, runId);
  const captures = [];
  for (const [index, { criterion, scenario }] of selected.entries()) for (const [name, width, height] of viewports) {
    const filename = `criterion-${index + 1}-${name}.png`;
    const videoName = criterion.requiresVideoEvidence || scenario.video === true ? `criterion-${index + 1}-${name}.webm` : null;
    const commands = scenario.commands.map((command) => command.map((arg) => arg === "$ticketId" ? ticketId : replaceFixture(arg)));
    const assertions = scenario.assertions.map((assertion) => Object.fromEntries(
      Object.entries(assertion).map(([key, value]) => [key, replaceFixture(value)])
    ));
    await journey({ url, screenshot: join(evidenceDir, filename), width, height, commands, assertions, video: videoName ? join(evidenceDir, videoName) : null });
    captures.push({ name, path: filename, width, height, criterionIds: [criterion.id], commands, assertions });
    if (videoName) captures.push({ name, path: videoName, width, height, criterionIds: [criterion.id], commands, assertions });
  }
  const manifest = ticketProofManifest({
    ticketId, runId, ...identity, captures, capturedAt: new Date().toISOString()
  });
  await writeFile(join(evidenceDir, "final-proof-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) {
  captureTicketProof().then((manifest) => {
    process.stdout.write(`Captured ticket-bound proof for ${manifest.identity.ticketId}\n`);
  }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
