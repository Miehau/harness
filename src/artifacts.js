import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export function safeName(value) {
  return String(value || "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "artifact";
}

export function artifactPathForOpen(artifacts, id, dataDir) {
  const path = artifacts?.find((artifact) => artifact.id === id)?.path;
  const root = `${resolve(dataDir)}${sep}`;
  return path && resolve(path).startsWith(root) ? resolve(path) : null;
}

export function visualEvidenceArtifacts(artifacts = []) {
  return (artifacts || []).filter((artifact) => artifact.kind === "visual-evidence");
}

export function visualEvidenceHandoffSection(artifacts = []) {
  const shots = visualEvidenceArtifacts(artifacts);
  if (!shots.length) return "";
  return `\n\n## Evidence\n\n${shots.map((shot) => `- \`${shot.name}\`${shot.path ? ` — \`${shot.path}\`` : ""}`).join("\n")}`;
}

export function visualEvidenceComment(artifacts = []) {
  const shots = visualEvidenceArtifacts(artifacts);
  if (!shots.length) return "";
  return `\n\nVisual evidence attached as proof (${shots.length}):\n${shots.map((shot) => `- ${shot.name}`).join("\n")}`;
}

export async function persistArtifact(dataDir, ticket, { name, content, runId = "legacy", stageId = "run", kind = "agent-output", stepId = null, attemptId = null }) {
  const root = join(dataDir, "ticket-runs", safeName(ticket.identifier || ticket.id), "runs", safeName(runId), "artifacts");
  const directory = join(root, safeName(stageId), ...(stepId ? [safeName(stepId)] : []), ...(attemptId ? [safeName(attemptId)] : []));
  await mkdir(directory, { recursive: true });
  const base = safeName(name || `${stageId}.md`);
  const filename = base.includes(".") ? base : `${base}.md`;
  const path = join(directory, filename);
  await writeFile(path, String(content || ""), "utf8");
  return { id: [stageId, stepId, attemptId, filename].filter(Boolean).join(":"), name: filename, kind, stageId, stepId, attemptId, path, content, createdAt: new Date().toISOString() };
}

function productContextPath(dataDir, sourceCwd) {
  const key = `${safeName(basename(sourceCwd))}-${createHash("sha256").update(sourceCwd).digest("hex").slice(0, 10)}`;
  return join(dataDir, "projects", key, "product-context.md");
}

export async function readProductContext(dataDir, sourceCwd) {
  const path = productContextPath(dataDir, sourceCwd);
  try { return { path, content: await readFile(path, "utf8") }; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path, content: "# Product context\n\nNo established PRD or capability ledger yet." };
  }
}

export async function persistProductContext(dataDir, sourceCwd, content) {
  const path = productContextPath(dataDir, sourceCwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(content || ""), "utf8");
  return { path, content: String(content || "") };
}
