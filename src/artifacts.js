import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { boundedText, redactText } from "./redaction.js";

const evidenceMediaTypes = new Map([
  [".png", { mediaType: "image/png", mediaKind: "image" }],
  [".jpg", { mediaType: "image/jpeg", mediaKind: "image" }],
  [".jpeg", { mediaType: "image/jpeg", mediaKind: "image" }],
  [".webp", { mediaType: "image/webp", mediaKind: "image" }],
  [".webm", { mediaType: "video/webm", mediaKind: "video" }],
  [".mp4", { mediaType: "video/mp4", mediaKind: "video" }]
]);

export function visualEvidenceMedia(path) {
  const extension = String(path || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return extension ? evidenceMediaTypes.get(extension) || null : null;
}

export function safeName(value) {
  return String(value || "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "artifact";
}

export async function cleanupLegacyReviewArtifacts(cwd) {
  const removed = [];
  for (const entry of await readdir(cwd, { withFileTypes: true })) {
    if (!entry.isFile() || !/^review-fixes-round-\d+\.md$/.test(entry.name)) continue;
    await unlink(join(cwd, entry.name));
    removed.push(entry.name);
  }
  return removed.sort();
}

export function artifactPathForOpen(artifacts, id, dataDir) {
  return artifactPathInDataDir(artifacts?.find((artifact) => artifact?.id === id), dataDir);
}

export function artifactPathInDataDir(artifact, dataDir) {
  const path = artifact?.path;
  const root = `${resolve(dataDir)}${sep}`;
  return path && resolve(path).startsWith(root) ? resolve(path) : null;
}

export async function hydrateArtifact(artifact, dataDir) {
  if (!artifact || typeof artifact !== "object" || typeof artifact.content === "string" || !artifact.bodyStored) return artifact;
  const path = artifactPathInDataDir(artifact, dataDir);
  if (!path) throw new Error(`Artifact body is outside the data directory: ${artifact.name || artifact.id || "unknown"}`);
  return { ...artifact, content: await readFile(path, "utf8") };
}

export async function hydrateArtifacts(artifacts = [], dataDir) {
  return Promise.all((artifacts || []).map((artifact) => hydrateArtifact(artifact, dataDir)));
}

// Read-only API and worker context reads use this bounded reader. The legacy
// hydrateArtifacts above deliberately remains available for existing callers.
export function createArtifactReader({ dataDir }) {
  async function artifactContent(artifact, limit = 20000) {
    if (!artifact) return null;
    // Media stays behind the media endpoint; textual views read only a bounded prefix.
    if (artifact.kind === "visual-evidence" || artifact.mediaType || visualEvidenceMedia(artifact.name)) return null;
    if (typeof artifact.content === "string") {
      const source = String(artifact.content);
      return { content: redactText(source.slice(0, limit + 4096)), truncated: source.length > limit + 4096 };
    }
    const path = artifactPathForOpen([artifact], artifact.id, dataDir);
    if (!path) return null;
    try {
      const handle = await open(path, "r");
      try {
        const size = (await handle.stat()).size;
        const length = Math.min(size, limit + 4096);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        return { content: redactText(buffer.toString("utf8")), truncated: size > length };
      } finally { await handle.close(); }
    } catch { return null; }
  }

  async function artifactText(artifact, limit = 100000) {
    return (await artifactContent(artifact, limit))?.content || "";
  }

  async function hydrateBoundedArtifacts(artifacts, limit = 60000) {
    const boundedLimit = Number.isFinite(limit) ? limit : 60000;
    return Promise.all((artifacts || []).map(async (artifact) => {
      const content = boundedText(await artifactText(artifact, boundedLimit), boundedLimit);
      return { ...artifact, content: content.value, ...(content.truncated ? { truncated: true } : {}) };
    }));
  }

  return { artifactContent, artifactText, hydrateArtifacts: hydrateBoundedArtifacts };
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

function artifactStorageKey(kind, storageKey) {
  const identity = `${String(kind || "agent-output")}\0${storageKey == null ? "" : String(storageKey)}`;
  return `${safeName(kind)}-${createHash("sha256").update(identity).digest("hex").slice(0, 10)}`;
}

export async function persistArtifact(dataDir, ticket, { name, content, runId = "legacy", stageId = "run", kind = "agent-output", stepId = null, attemptId = null, storageKey = null }) {
  const root = join(dataDir, "ticket-runs", safeName(ticket.identifier || ticket.id), "runs", safeName(runId), "artifacts");
  const directory = join(root, safeName(stageId), ...(stepId ? [safeName(stepId)] : []), ...(attemptId ? [safeName(attemptId)] : []));
  await mkdir(directory, { recursive: true });
  const base = safeName(name || `${stageId}.md`);
  const filename = base.includes(".") ? base : `${base}.md`;
  const storageIdentity = artifactStorageKey(kind, storageKey);
  const path = join(directory, `${storageIdentity}-${filename}`);
  const retainedContent = redactText(content);
  await writeFile(path, retainedContent, "utf8");
  // Bodies live only in the artifact file; JsonStore retains the bounded metadata needed to locate them.
  // The stable kind/storage identity keeps same-named internal and worker artifacts independently addressable.
  return { id: [stageId, stepId, attemptId, storageIdentity, filename].filter(Boolean).join(":"), name: filename, kind, stageId, stepId, attemptId, path, bodyStored: true, createdAt: new Date().toISOString() };
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
  const retainedContent = redactText(content);
  await writeFile(path, retainedContent, "utf8");
  return { path, content: retainedContent };
}
