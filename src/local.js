import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { dependencySteps, flattenSteps, normalizePlan } from "./plan.js";

const runtimeFields = ["prompt", "agentId", "harness", "skills", "contextPolicy", "expectedArtifacts", "status", "attempts", "artifacts"];

function authoredNodes(raw) {
  return (raw.nodes || []).flatMap((node) => node?.type === "group" || Array.isArray(node?.children) ? [node, ...(node.children || [])] : [node]);
}

function validateAuthoredPlan(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error("plan.json needs at least one ticket");
  const nodes = authoredNodes(raw);
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== "object") throw new Error("Every plan node must be an object");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.id || "")) throw new Error(`Plan node IDs must be stable kebab-case: ${node.id || "missing ID"}`);
    if (ids.has(node.id)) throw new Error(`Duplicate plan node ID: ${node.id}`);
    ids.add(node.id);
    if (node.type !== "group") {
      const field = runtimeFields.find((name) => Object.hasOwn(node, name));
      if (field) throw new Error(`Local tickets must not encode runtime field “${field}”`);
      if (!String(node.title || "").trim()) throw new Error(`Ticket ${node.id} needs a title`);
      if (!Array.isArray(node.acceptanceCriteria) || !node.acceptanceCriteria.length) throw new Error(`Ticket ${node.id} needs acceptance criteria`);
    }
  }
  for (const node of nodes.filter((item) => item.type !== "group")) {
    for (const dependency of node.dependsOn || []) {
      if (!ids.has(dependency)) throw new Error(`Ticket ${node.id} has unknown dependency: ${dependency}`);
      if (dependency === node.id) throw new Error(`Ticket ${node.id} cannot depend on itself`);
    }
  }
}

function validateAcyclic(plan) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (step) => {
    if (visiting.has(step.id)) throw new Error(`Plan dependency cycle includes ${step.id}`);
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const dependency of dependencySteps(plan, step)) visit(dependency);
    visiting.delete(step.id);
    visited.add(step.id);
  };
  for (const step of flattenSteps(plan)) visit(step);
}

export async function loadLocalFixture(workspaceCwd, input = "fixtures/zero-state-task-board") {
  const workspace = resolve(workspaceCwd);
  const directory = resolve(workspace, String(input || ""));
  const withinWorkspace = relative(workspace, directory);
  if (isAbsolute(withinWorkspace) || withinWorkspace === ".." || withinWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Local fixture must be inside the open repository");
  }
  if (!(await stat(directory)).isDirectory()) throw new Error("Local fixture must be a directory");
  const [feature, planSource] = await Promise.all([
    readFile(resolve(directory, "feature.md"), "utf8"),
    readFile(resolve(directory, "plan.json"), "utf8")
  ]);
  if (!feature.trim()) throw new Error("feature.md must not be empty");
  let raw;
  try { raw = JSON.parse(planSource); }
  catch (error) { throw new Error(`Invalid plan.json: ${error.message}`); }
  validateAuthoredPlan(raw);
  const plan = normalizePlan(raw);
  validateAcyclic(plan);
  for (const step of flattenSteps(plan)) {
    step.prompt = "";
    step.contextPolicy = "seeded";
    step.harness = "pi";
    step.skills = [];
    step.expectedArtifacts = [`${step.id}.md`];
  }
  return { directory, feature, plan, planSource };
}
