import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizePlan, flattenSteps, planReviewViolations } from "../src/plan.js";
import { designSystemPath, designSystemExists, ensureDesignSystemStep, uiDesignViolations } from "../src/design-system.js";

const ui = { id: "ui", title: "Search UI", permission: "write", writeScope: "public", expectedFiles: ["public/app.js"], estimatedChangedLines: 80, requiresVisualEvidence: true };

test("missing UI reference becomes a scoped prerequisite without changing backend-only plans", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "design-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = normalizePlan({ nodes: [{ id: "api", title: "API" }] });
  assert.equal(await designSystemExists("/does-not-exist", backend), true);
  assert.equal(ensureDesignSystemStep(backend, false), backend);
  const plan = normalizePlan({ nodes: [ui] });
  assert.equal(await designSystemExists(root, plan), false);
  const prepared = ensureDesignSystemStep(plan, false);
  const prerequisite = prepared.nodes[0];
  assert.equal(prerequisite.writeScope, designSystemPath);
  assert.deepEqual(prepared.nodes[1].dependsOn, [prerequisite.id]);
  assert.ok(prepared.nodes[1].references.includes(designSystemPath));
  assert.match(prerequisite.prompt, /observed facts separate from proposed changes/);
  assert.match(prerequisite.prompt, /another design-system document exists/);
  assert.deepEqual(planReviewViolations(prepared), []);
  assert.equal(ensureDesignSystemStep(prepared, false).nodes.length, 2, "normalization is idempotent");
  await mkdir(join(root, ".agent-plan"));
  await writeFile(join(root, designSystemPath), "# Existing system\nSee public/styles.css and public/components.\n");
  assert.equal(await designSystemExists(root, plan), true);
  assert.equal(ensureDesignSystemStep(plan, true).nodes.length, 1);
});

test("UI decisions survive plan normalization and validation asks for missing decisions", () => {
  assert.equal(uiDesignViolations(normalizePlan({ nodes: [ui] })).length, 6);
  const uiPlan = { reuse: "Existing search input", hierarchy: "Results first; one search control", states: "Empty, loading, failed, results", interaction: "Keyboard search and retry", proof: "Submit search and inspect results", deviations: "none" };
  const plan = normalizePlan({ nodes: [{ ...ui, uiPlan }] });
  assert.deepEqual(plan.nodes[0].uiPlan, uiPlan);
  assert.deepEqual(uiDesignViolations(plan), []);
  const grouped = normalizePlan({ nodes: [{ id: "group", type: "group", children: [{ ...ui, uiPlan }] }] });
  const prepared = ensureDesignSystemStep(grouped, false);
  assert.ok(flattenSteps(prepared).find((step) => step.id === "ui").dependsOn.includes(prepared.nodes[0].id));
});

test("frontend plans preserve impact exemptions and stable per-criterion journey contracts", async () => {
  const { prepareUiPlan, uiContractViolations, uiPlanSummary } = await import("../src/design-system.js");
  const { initializeProofMap } = await import("../src/proof-map.js");
  const { captureProofCriteria } = await import("../src/preview-orchestration.js");
  const input = { uiImpact: { level: "minor", reason: "Change button colour using an existing token" }, nodes: [{ ...ui,
    acceptanceCriteria: ["Button uses the approved colour", "Settings persist after restart"],
    criterionBindings: [{ index: 0, id: "ac-colour", evidence: "screenshot", journeyId: "button-colour" }, { index: 1, id: "ac-persistence", evidence: "check" }]
  }] };
  const plan = normalizePlan(input);
  assert.deepEqual(uiContractViolations(plan), []);
  assert.equal(prepareUiPlan(plan).uiImpact.level, "minor");
  assert.equal(prepareUiPlan(normalizePlan({ nodes: [ui] })).uiImpact.level, "material");
  assert.equal(prepareUiPlan(plan, { level: "material", reason: "New panel" }).uiImpact.level, "material");
  assert.match(uiPlanSummary(plan), /minor.*\nChange button colour/);
  const criteria = initializeProofMap(plan).criteria;
  assert.equal(criteria[1].requiresVisualEvidence, false);
  assert.deepEqual(captureProofCriteria(criteria).map((criterion) => criterion.journeyId), ["button-colour"]);
  assert.deepEqual(captureProofCriteria([criteria[1]]), []);
  input.nodes[0].acceptanceCriteria[0] = "Reworded colour requirement";
  assert.equal(initializeProofMap(normalizePlan(input)).criteria[0].id, "ac-colour");
  assert.throws(() => normalizePlan({ ...input, uiImpact: { level: "minor" } }), /reason/);
  assert.throws(() => normalizePlan({ nodes: [{ ...input.nodes[0], criterionBindings: [{ index: 8, id: "bad", evidence: "check" }] }] }), /indices/);
  assert.ok(uiContractViolations(normalizePlan({ ...input, uiImpact: { level: "none", reason: "Incorrectly exempted" } })).length);
});
