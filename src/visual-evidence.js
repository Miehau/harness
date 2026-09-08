import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { flattenSteps } from "./plan.js";

export const visualEvidenceManifestName = "final-proof-manifest.json";

export function planRequiresVisualEvidence(plan) {
  return flattenSteps(plan || { nodes: [] }).some((step) => step.requiresVisualEvidence || step.requiresVideoEvidence);
}

export function planRequiresVideoEvidence(plan) {
  return flattenSteps(plan || { nodes: [] }).some((step) => step.requiresVideoEvidence);
}

export function ticketProofManifest({ ticketId, runId, ticketIdentifier = null, ticketTitle = null, captures = [], capturedAt = new Date().toISOString() } = {}) {
  return {
    version: 1,
    source: "live-ticket-run",
    capturedAt,
    identity: { ticketId, runId, ticketIdentifier, ticketTitle },
    captures
  };
}

function evidenceDirectory(evidence = [], evidenceDir = null) {
  if (evidenceDir) return evidenceDir;
  const file = (evidence || []).find((item) => item.path)?.path;
  return file ? dirname(file) : null;
}

export function visualEvidenceManifest(evidence = [], evidenceDir = null) {
  const directory = evidenceDirectory(evidence, evidenceDir);
  if (!directory) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, visualEvidenceManifestName), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Decode recordings and expose a bounded set of frames to image-capable reviewers. */
export async function prepareVisualEvidence(evidence, { evidenceDir, run }) {
  const manifest = visualEvidenceManifest(evidence, evidenceDir);
  const captures = Array.isArray(manifest?.captures) ? manifest.captures : [];
  const result = [];
  for (const item of evidence) {
    const capture = captures.find((capture) => capture.path === item.name || capture.path === item.path);
    const journey = capture && Array.isArray(capture.commands) && capture.commands.length && Array.isArray(capture.assertions) && capture.assertions.length
      ? { criterionIds: Array.isArray(capture.criterionIds) ? capture.criterionIds.filter((id) => typeof id === "string") : [], commands: capture.commands, assertions: capture.assertions }
      : { criterionIds: [], commands: [], assertions: [] };
    result.push({ ...item, ...journey });
    if (item.mediaKind !== "video") continue;
    const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", item.path]);
    const metadata = JSON.parse(probe.stdout);
    const duration = Number(metadata.format?.duration);
    if (!metadata.streams?.[0]?.codec_name || !Number.isFinite(duration) || duration <= 0) throw new Error(`Recording is not a playable video: ${item.name}`);
    const prefix = `${basename(item.path)}.frame-`;
    // Decode the entire recording; fps bounds model attachments to roughly six frames.
    await run("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-y", "-i", item.path, "-an", "-vf", `fps=${6 / duration},scale=1280:-2`, join(evidenceDir, `${prefix}%02d.png`)]);
    const frames = (await readdir(evidenceDir)).filter((name) => name.startsWith(prefix) && name.endsWith(".png")).sort();
    if (!frames.length || frames.length > 8) throw new Error(`Recording did not produce a bounded frame sample: ${item.name}`);
    for (const name of frames) result.push({ name, path: join(evidenceDir, name), mediaKind: "image", mediaType: "image/png", videoPath: item.path, ...journey });
  }
  return result;
}

export function ticketBoundVisualEvidence(evidence = [], { ticketId, runId, evidenceDir = null } = {}) {
  if (!ticketId || !runId) return { bound: false, reason: "missing_identity" };
  const items = Array.isArray(evidence) ? evidence : [];
  if (items.some((item) => item.boundTicketId === ticketId && item.boundRunId === runId && item.mediaKind === "image")) {
    return { bound: true, evidence: items.filter((item) => item.boundTicketId === ticketId && item.boundRunId === runId) };
  }
  const manifest = visualEvidenceManifest(items, evidenceDir);
  if (manifest?.source !== "live-ticket-run") return { bound: false, reason: "unbound_evidence", manifest };
  if (manifest.identity?.ticketId !== ticketId || manifest.identity?.runId !== runId) {
    return { bound: false, reason: "identity_mismatch", manifest };
  }
  if (!items.some((item) => item.mediaKind === "image")) return { bound: false, reason: "unbound_evidence", manifest };
  return { bound: true, manifest, evidence: items };
}

export function applyVerifyEvidenceGate(checks, { required = false, requiredVideo = false, ticketId = null, runId = null, criteria = [] } = {}) {
  if (!required) return checks;
  // Preserve the causal command failure; absence of media is a consequence.
  if (checks.status === "failed") return checks;
  const evidence = checks.evidence || [];
  const hasImage = evidence.some((item) => item.mediaKind === "image");
  const hasVideo = evidence.some((item) => item.mediaKind === "video");
  if (!hasImage) {
    return Object.assign(checks, {
      status: "failed",
      failureKind: "visual-evidence",
      summary: "Visual verification produced no screenshot evidence for the required outcomes."
    });
  }
  if (requiredVideo && !hasVideo) {
    return Object.assign(checks, {
      status: "failed",
      failureKind: "visual-evidence",
      summary: "Visual verification produced no video evidence."
    });
  }
  if (ticketId && runId && !ticketBoundVisualEvidence(evidence, { ticketId, runId, evidenceDir: checks.evidenceDir }).bound) {
    return Object.assign(checks, {
      status: "failed",
      failureKind: "visual-evidence",
      summary: "Visual verification produced no ticket-bound evidence."
    });
  }
  const requiredCriteria = criteria.filter((criterion) => criterion.stepRequired !== false && (criterion.requiresVisualEvidence || criterion.requiresVideoEvidence));
  const missing = requiredCriteria.filter((criterion) => {
    const linked = evidence.filter((item) => item.criterionIds?.includes(criterion.id) && item.commands?.length && item.assertions?.length);
    return !linked.some((item) => item.mediaKind === "image") || (criterion.requiresVideoEvidence && !linked.some((item) => item.mediaKind === "video"));
  });
  if (missing.length) Object.assign(checks, {
    status: "failed", failureKind: "visual-evidence", missingCriterionIds: missing.map((criterion) => criterion.id),
    summary: `Visual proof does not cover required criteria: ${missing.map((criterion) => criterion.id).join(", ")}.`,
    failureHighlights: "Capture each missing outcome with criterion links, executed journey commands and assertions; provide recordings for criteria requiring video."
  });
  return checks;
}

export function verifyStageEvidenceError(run, { media = null } = {}) {
  if (!planRequiresVisualEvidence(run?.plan)) return null;
  const evidence = media || [
    ...(run.checkpoint?.media || []),
    ...(run.artifacts || []).filter((artifact) => artifact.kind === "visual-evidence")
  ];
  const checks = applyVerifyEvidenceGate({ status: "passed", evidence }, {
    required: true,
    requiredVideo: planRequiresVideoEvidence(run.plan),
    ticketId: run.ticket?.id,
    runId: run.runId
  });
  return checks.status === "failed" ? checks.summary : null;
}
