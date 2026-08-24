import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalFixture } from "../src/local.js";

test("loads prompt-free local tickets and preserves their dependency graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-local-"));
  const fixture = join(root, "fixture");
  try {
    await mkdir(fixture);
    await writeFile(join(fixture, "feature.md"), "# Build it\n");
    await writeFile(join(fixture, "plan.json"), JSON.stringify({
      title: "Fixture",
      nodes: [
        { id: "foundation", type: "ticket", title: "Foundation", description: "Start", permission: "write", acceptanceCriteria: ["Runs"] },
        { id: "feature", type: "ticket", title: "Feature", description: "Build", permission: "write", acceptanceCriteria: ["Works"], dependsOn: ["foundation"] }
      ]
    }));
    const loaded = await loadLocalFixture(root, "fixture");
    assert.equal(loaded.feature, "# Build it\n");
    assert.equal(loaded.plan.nodes[0].prompt, "");
    assert.equal(loaded.plan.nodes[1].agentId, "worker:feature");
    assert.deepEqual(loaded.plan.nodes[1].dependsOn, ["foundation"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("rejects runtime prompts in local plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-local-invalid-"));
  try {
    await writeFile(join(root, "feature.md"), "# Build it\n");
    await writeFile(join(root, "plan.json"), JSON.stringify({ nodes: [{
      id: "feature", type: "ticket", title: "Feature", prompt: "Do it my way", acceptanceCriteria: ["Works"]
    }] }));
    await assert.rejects(loadLocalFixture(root, "."), /must not encode runtime field/);
  } finally {
    await rm(root, { recursive: true });
  }
});
