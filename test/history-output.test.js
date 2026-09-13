import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store.js";

test("completed output is retained outside hot state, reloadable, and not archived repeatedly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "history-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "state-v3.json");
  const store = new JsonStore(file, root);
  await store.init();
  const output = "historical check output\n".repeat(10000);
  await store.update((draft) => {
    draft.ticketRuns.done = { ticket: { id: "done", identifier: "DONE" }, runId: "run", status: "completed", finalChecks: { status: "passed", output } };
    draft.ticketRuns.active = { ticket: { id: "active" }, runId: "active-run", status: "running", finalChecks: { output } };
  });
  const done = store.read((state) => state.ticketRuns.done);
  assert.ok(done.finalChecks.output.length < 4000);
  assert.equal(done.finalChecks.status, "passed");
  const artifact = done.artifacts.find((item) => item.kind === "historical-output");
  const entries = JSON.parse(await readFile(artifact.path, "utf8"));
  assert.deepEqual(entries, [{ pointer: ["finalChecks", "output"], content: output }]);
  assert.equal(store.read((state) => state.ticketRuns.active.finalChecks.output), output);
  await store.update((draft) => { draft.notice = "another update"; });
  assert.equal(store.read((state) => state.ticketRuns.done.artifacts.length), 1);
  const reloaded = await new JsonStore(file, root).init();
  assert.equal(reloaded.ticketRuns.done.artifacts[0].path, artifact.path);
  assert.ok(store.metrics.bytes > 0);
  assert.ok(store.metrics.serializeMs >= 0);
});
