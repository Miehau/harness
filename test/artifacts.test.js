import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistArtifact, persistProductContext, readProductContext, safeName } from "../src/artifacts.js";

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

test("keeps one living product context per source workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-context-"));
  const missing = await readProductContext(root, "/projects/meal-minder");
  assert.match(missing.content, /No established PRD/);
  const saved = await persistProductContext(root, "/projects/meal-minder", "# Product\n\nCAP-1 shipped");
  assert.equal((await readProductContext(root, "/projects/meal-minder")).content, "# Product\n\nCAP-1 shipped");
  assert.equal(saved.path, missing.path);
});
