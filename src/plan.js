import { randomUUID } from "node:crypto";

const stepStatuses = new Set(["draft", "ready", "running", "review_ready", "fixing", "needs_attention", "needs_input", "awaiting_approval", "accepted", "failed", "interrupted", "cancelled"]);

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
    sessionFile: raw.sessionFile || null,
    supervisorReview: raw.supervisorReview || null,
    lastError: raw.lastError || null
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
