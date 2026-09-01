import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPathForOpen, persistArtifact, persistProductContext, readProductContext, safeName, visualEvidenceComment, visualEvidenceHandoffSection, visualEvidenceMedia } from "../src/artifacts.js";

test("persists ticket artifacts outside session storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ticket-artifact-"));
  const artifact = await persistArtifact(root, { identifier: "MM-42" }, { name: "Exploration", content: "# Map", runId: "run-7", stageId: "explore" });
  assert.equal(await readFile(artifact.path, "utf8"), "# Map");
  assert.match(artifact.path, /ticket-runs\/mm-42\/runs\/run-7\/artifacts\/explore\/exploration\.md$/);
  assert.doesNotMatch(artifact.path, /pi-sessions/);
});

test("isolates step attempts within one ticket run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ticket-attempt-"));
  const artifact = await persistArtifact(root, { identifier: "MM-42" }, {
    name: "result.md", content: "attempt two", runId: "run-7", stageId: "implement", stepId: "api-slice", attemptId: "attempt-2"
  });
  assert.match(artifact.path, /runs\/run-7\/artifacts\/implement\/api-slice\/attempt-2\/result\.md$/);
  assert.equal(await readFile(artifact.path, "utf8"), "attempt two");
});

test("safeName constrains directory components", () => {
  assert.equal(safeName("../MM 42"), "mm-42");
  assert.equal(safeName(".."), "artifact");
});

test("classifies supported visual evidence media without guessing unsupported files", () => {
  assert.deepEqual(visualEvidenceMedia("screen.PNG"), { mediaType: "image/png", mediaKind: "image" });
  assert.deepEqual(visualEvidenceMedia("interaction.webm"), { mediaType: "video/webm", mediaKind: "video" });
  assert.deepEqual(visualEvidenceMedia("interaction.mp4"), { mediaType: "video/mp4", mediaKind: "video" });
  assert.equal(visualEvidenceMedia("notes.txt"), null);
});

test("only resolves recorded artifacts inside app storage", () => {
  assert.equal(artifactPathForOpen([{ id: "safe", path: "/data/runs/result.md" }], "safe", "/data"), "/data/runs/result.md");
  assert.equal(artifactPathForOpen([{ id: "unsafe", path: "/tmp/secret" }], "unsafe", "/data"), null);
  assert.equal(artifactPathForOpen([], "missing", "/data"), null);
});

test("keeps one living product context per source workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-context-"));
  const missing = await readProductContext(root, "/projects/meal-minder");
  assert.match(missing.content, /No established PRD/);
  const saved = await persistProductContext(root, "/projects/meal-minder", "# Product\n\nCAP-1 shipped");
  assert.equal((await readProductContext(root, "/projects/meal-minder")).content, "# Product\n\nCAP-1 shipped");
  assert.equal(saved.path, missing.path);
});

test("handoff evidence section and tracker comment list screenshot names only when present", () => {
  const shots = [
    { kind: "visual-evidence", name: "desktop.png", path: "/data/visual-evidence/desktop.png" },
    { kind: "visual-evidence", name: "mobile.png", path: "/data/visual-evidence/mobile.png" }
  ];
  assert.equal(visualEvidenceHandoffSection([]), "");
  assert.equal(visualEvidenceHandoffSection([{ kind: "handoff", name: "handoff.md" }]), "");
  assert.equal(visualEvidenceComment([]), "");
  const section = visualEvidenceHandoffSection(shots);
  assert.match(section, /## Evidence/);
  assert.match(section, /desktop\.png/);
  assert.match(section, /mobile\.png/);
  assert.match(section, /\/data\/visual-evidence\/desktop\.png/);
  const comment = visualEvidenceComment(shots);
  assert.match(comment, /Visual evidence attached as proof \(2\)/);
  assert.match(comment, /- desktop\.png/);
  assert.match(comment, /- mobile\.png/);
  assert.equal(comment.includes("/data/visual-evidence"), false);
});
