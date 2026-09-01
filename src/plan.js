import { randomUUID } from "node:crypto";

const stepStatuses = new Set(["draft", "ready", "running", "review_ready", "fixing", "needs_attention", "needs_input", "awaiting_approval", "accepted", "failed", "interrupted", "cancelled"]);
export const defaultReviewBudget = Object.freeze({ maxFiles: 8, maxChangedLines: 400 });

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeReviewBudget(raw = {}) {
  return {
    maxFiles: positiveInteger(raw?.maxFiles, defaultReviewBudget.maxFiles),
    maxChangedLines: positiveInteger(raw?.maxChangedLines, defaultReviewBudget.maxChangedLines),
    justification: String(raw?.justification || "").trim()
  };
}

function excludedFromReviewBudget(path) {
  return /(^|\/)(?:dist|build|coverage|vendor|generated)(?:\/|$)/i.test(path)
    || /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(path);
}

function idFrom(value, used) {
  const base = String(value || "step")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `step-${randomUUID().slice(0, 8)}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function strings(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split("\n").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeStep(raw, used, defaultHarness) {
  if (!raw || typeof raw !== "object") throw new Error("Each step must be an object");
  const title = String(raw.title || raw.name || "Untitled step").trim();
  const id = idFrom(raw.id || title, used);
  return {
    id,
    type: "step",
    title,
    role: ["architecture", "implementation"].includes(raw.role) ? raw.role : "implementation",
    description: String(raw.description || "").trim(),
    prompt: String(raw.prompt || "").trim(),
    contextPolicy: ["fresh", "seeded", "fork"].includes(raw.contextPolicy) ? raw.contextPolicy : "seeded",
    harness: String(raw.harness || defaultHarness || "pi"),
    agentId: String(raw.agentId || `worker:${id}`),
    permission: ["none", "read", "write"].includes(raw.permission) ? raw.permission : "read",
    writeScope: String(raw.writeScope || "").trim(),
    expectedFiles: strings(raw.expectedFiles),
    estimatedChangedLines: Math.max(0, Number(raw.estimatedChangedLines) || 0),
    reviewBudget: normalizeReviewBudget(raw.reviewBudget),
    skills: strings(raw.skills),
    references: strings(raw.references),
    requirementIds: strings(raw.requirementIds),
    capabilityIds: strings(raw.capabilityIds),
    deltaIds: strings(raw.deltaIds),
    productContext: String(raw.productContext || "").trim(),
    expectedArtifacts: strings(raw.expectedArtifacts),
    acceptanceCriteria: strings(raw.acceptanceCriteria),
    requiresVisualEvidence: raw.requiresVisualEvidence === true,
    dependsOn: strings(raw.dependsOn),
    required: raw.required !== false,
    status: stepStatuses.has(raw.status) ? raw.status : "ready",
    attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    diff: raw.diff || null,
    vcsChange: raw.vcsChange || null,
    sessionFile: raw.sessionFile || null,
    supervisorReview: raw.supervisorReview || null,
    lastError: raw.lastError || null
  };
}

export function planReviewViolations(plan) {
  return flattenSteps(plan).flatMap((step) => {
    if (step.permission !== "write") return [];
    const budget = normalizeReviewBudget(step.reviewBudget);
    const exception = budget.justification;
    const violations = [];
    const verificationBootstrap = step.expectedFiles.some((path) => [".agent-plan/project.json", ".agent-plan/verify.mjs"].includes(path));
    const scope = step.writeScope.split(",").map((path) => path.trim().replace(/^\.\//, "").replace(/\/\*\*?$/, "")).filter(Boolean);
    if (!step.expectedFiles.length) violations.push(`${step.title}: expectedFiles must name the predicted review surface`);
    if (!step.estimatedChangedLines) violations.push(`${step.title}: estimatedChangedLines must be a positive review estimate`);
    if (verificationBootstrap && scope.some((path) => path !== ".agent-plan")) violations.push(`${step.title}: verification bootstrap write scope must contain only .agent-plan; put other changes in a separate ticket-specific step`);
    if (/^(?:\*|\*\*)$/.test(step.writeScope) && !exception) violations.push(`${step.title}: broad write scope requires a review-budget justification`);
    if (budget.maxFiles > defaultReviewBudget.maxFiles && !exception) violations.push(`${step.title}: maxFiles above ${defaultReviewBudget.maxFiles} requires justification`);
    if (budget.maxChangedLines > defaultReviewBudget.maxChangedLines && !exception) violations.push(`${step.title}: maxChangedLines above ${defaultReviewBudget.maxChangedLines} requires justification`);
    if (step.expectedFiles.length > budget.maxFiles && !exception) violations.push(`${step.title}: ${step.expectedFiles.length} expected files exceed the ${budget.maxFiles}-file review budget`);
    if (step.estimatedChangedLines > budget.maxChangedLines && !exception) violations.push(`${step.title}: ${step.estimatedChangedLines} estimated changed lines exceed the ${budget.maxChangedLines}-line review budget`);
    return violations;
  });
}

export function diffReviewBudget(step, diff) {
  const budget = normalizeReviewBudget(step?.reviewBudget);
  const fileStats = (diff?.fileStats || (diff?.files || []).map((path) => ({ path, additions: 0, deletions: 0 })))
    .filter((file) => !excludedFromReviewBudget(file.path));
  const files = fileStats.length;
  const changedLines = fileStats.reduce((total, file) => total + Number(file.additions || 0) + Number(file.deletions || 0), 0);
  const reasons = [
    files > budget.maxFiles ? `${files} reviewable files exceed the ${budget.maxFiles}-file budget` : null,
    changedLines > budget.maxChangedLines ? `${changedLines} changed lines exceed the ${budget.maxChangedLines}-line budget` : null
  ].filter(Boolean);
  return {
    ...budget,
    files,
    changedLines,
    excludedFiles: Math.max(0, (diff?.files?.length || 0) - files),
    reasons,
    exceeded: reasons.length > 0 && !budget.justification
  };
}

export function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Plan must be an object");
  const used = new Set();
  const harness = String(raw.harness || "pi");
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node) => {
    if (node?.type === "group" || Array.isArray(node?.children)) {
      const title = String(node.title || node.name || "Untitled group").trim();
      const id = idFrom(node.id || title, used);
      const children = (node.children || []).map((child) => {
        if (child?.type === "group" || Array.isArray(child?.children)) throw new Error("MVP supports one nesting level only");
        return normalizeStep(child, used, harness);
      });
      if (!children.length) throw new Error(`Group “${title}” needs at least one child step`);
      return { id, type: "group", title, description: String(node.description || "").trim(), required: node.required !== false, children };
    }
    return normalizeStep(node, used, harness);
  });
  if (!nodes.length) throw new Error("Plan needs at least one step");

  const known = new Set(flattenSteps({ nodes }).map((step) => step.id));
  for (const node of nodes) if (node.type === "group") known.add(node.id);
  for (const step of flattenSteps({ nodes })) {
    step.dependsOn = step.dependsOn.filter((id) => id !== step.id && known.has(id));
  }

  return {
    id: String(raw.id || `plan-${randomUUID().slice(0, 8)}`),
    title: String(raw.title || "Untitled plan").trim(),
    summary: String(raw.summary || "").trim(),
    harness,
    createdAt: raw.createdAt || new Date().toISOString(),
    nodes
  };
}

function rawNodes(raw) {
  return (Array.isArray(raw?.nodes) ? raw.nodes : []).flatMap((node) =>
    node?.type === "group" || Array.isArray(node?.children) ? [node, ...(node.children || [])] : [node]
  );
}

export function normalizeEditedPlan(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Plan must be an object");
  const ids = rawNodes(raw).map((node) => String(node?.id || "").trim()).filter(Boolean);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Plan contains duplicate id “${duplicate}”`);

  const known = new Set(ids);
  for (const node of rawNodes(raw)) {
    if (node?.type === "group" || Array.isArray(node?.children)) continue;
    const id = String(node?.id || "").trim();
    for (const dependency of strings(node?.dependsOn)) {
      if (dependency === id) throw new Error(`Step “${id}” cannot depend on itself`);
      if (!known.has(dependency)) throw new Error(`Step “${id || node?.title || "untitled"}” has unknown dependency “${dependency}”`);
    }
  }

  const plan = normalizePlan(raw);
  const groups = new Map(plan.nodes.filter((node) => node.type === "group").map((group) => [group.id, group.children.map((step) => step.id)]));
  const edges = new Map(flattenSteps(plan).map((step) => [step.id, step.dependsOn.flatMap((id) => groups.get(id) || [id])]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Plan dependency cycle includes “${id}”`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return plan;
}

export function flattenSteps(plan) {
  return (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
}

export function findNode(plan, id) {
  for (const node of plan?.nodes || []) {
    if (node.id === id) return node;
    if (node.type === "group") {
      const child = node.children.find((item) => item.id === id);
      if (child) return child;
    }
  }
  return null;
}

export function parentGroup(plan, stepId) {
  return (plan?.nodes || []).find((node) => node.type === "group" && node.children.some((child) => child.id === stepId)) || null;
}

export function groupStatus(group) {
  const required = group.children.filter((step) => step.required);
  if (required.every((step) => step.status === "accepted")) return "accepted";
  if (required.some((step) => ["failed", "needs_attention", "interrupted", "cancelled"].includes(step.status))) return "needs_attention";
  if (required.some((step) => step.status === "running")) return "running";
  if (required.some((step) => step.status === "completed")) return "review";
  return "blocked";
}

export function dependencySteps(plan, step) {
  const result = [];
  for (const id of step.dependsOn || []) {
    const node = findNode(plan, id);
    if (!node) continue;
    if (node.type === "group") result.push(...node.children.filter((child) => child.required));
    else result.push(node);
  }
  return result;
}

export function blockingReasons(plan, step) {
  return dependencySteps(plan, step)
    .filter((dependency) => dependency.status !== "accepted")
    .map((dependency) => `${dependency.title} is ${dependency.status}`);
}

export function dependencyArtifacts(plan, step) {
  return dependencySteps(plan, step).flatMap((dependency) =>
    (dependency.artifacts || []).map((artifact) => ({ ...artifact, sourceStepId: dependency.id, sourceStepTitle: dependency.title }))
  );
}

export function planProgress(plan) {
  const steps = flattenSteps(plan);
  const accepted = steps.filter((step) => step.status === "accepted").length;
  return { accepted, total: steps.length, percent: steps.length ? Math.round((accepted / steps.length) * 100) : 0 };
}
