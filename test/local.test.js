import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("zero-state fixture keeps task lifecycle verbs as separate dependent tickets", async () => {
  const fixture = await loadLocalFixture(fileURLToPath(new URL("../fixtures/zero-state-task-board", import.meta.url)), ".");
  const architecture = fixture.plan.nodes.find((node) => node.id === "foundation").children.find((step) => step.id === "architecture");
  assert.deepEqual([architecture.permission, architecture.writeScope], ["write", "docs,.agent-plan"]);
  assert.equal(fixture.plan.nodes[1].children[0].requiresVisualEvidence, true);
  assert.ok(architecture.acceptanceCriteria.includes("docs/domain-architecture.md records the architecture for later workers"));
  const createTasks = fixture.plan.nodes.find((node) => node.id === "parallel-build").children.find((step) => step.id === "create-tasks");
  assert.ok(createTasks.acceptanceCriteria.some((criterion) => /intentional, responsive visual hierarchy/.test(criterion)));
  const lifecycle = fixture.plan.nodes.find((node) => node.id === "manage-tasks");
  assert.deepEqual(lifecycle.children.map((step) => [step.id, step.dependsOn]), [
    ["complete-tasks", ["parallel-build"]],
    ["restore-tasks", ["complete-tasks"]],
    ["remove-tasks", ["restore-tasks"]]
  ]);
  assert.deepEqual(fixture.plan.nodes.find((node) => node.id === "persist-tasks").dependsOn, ["manage-tasks"]);
});
