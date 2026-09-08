import { access } from "node:fs/promises";
import { join } from "node:path";
import { flattenSteps, normalizePlan } from "./plan.js";

export const designSystemPath = ".agent-plan/design-system.md";
export const uiPlanningInstruction = `For rendered UI work, start at ${designSystemPath}. Read its overview, then only relevant source references. If missing, inspect the existing application and establish this reference before UI implementation. Reference authoritative design documentation instead of copying it. Record components, tokens, typography, layout, interaction/accessibility states, writing conventions and representative screens. Distinguish observed conventions from approved decisions; record conflicts without silently redesigning them. Keep the overview concise and details in linked sources. Update affected references when a convention intentionally changes. Backend-only work does not require design-system discovery.`;

export async function designSystemExists(cwd, plan) {
  if (!flattenSteps(plan).some((step) => step.requiresVisualEvidence || step.requiresVideoEvidence)) return true;
  try { await access(join(cwd, designSystemPath)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function uiDesignViolations(plan) {
  return flattenSteps(plan).filter((step) => step.permission === "write" && step.requiresVisualEvidence).flatMap((step) => {
    const ui = step.uiPlan;
    return ["reuse", "hierarchy", "states", "interaction", "proof", "deviations"].filter((key) => !ui?.[key]?.trim())
      .map((key) => `${step.title}: uiPlan.${key} must briefly describe the UI decision (use "none" for no deviations)`);
  });
}

export function ensureDesignSystemStep(plan, exists) {
  const uiSteps = flattenSteps(plan).filter((step) => step.requiresVisualEvidence || step.requiresVideoEvidence);
  if (!uiSteps.length) return plan;
  const copy = structuredClone(plan);
  for (const step of flattenSteps(copy).filter((step) => step.requiresVisualEvidence || step.requiresVideoEvidence)) {
    step.references = [...new Set([...(step.references || []), designSystemPath])];
  }
  if (exists) return copy;
  const existing = flattenSteps(copy).find((step) => step.permission === "write" && step.role === "architecture" && step.expectedFiles?.includes(designSystemPath) && !step.dependsOn?.length);
  let id = existing?.id || "identify-design-system";
  const steps = flattenSteps(copy);
  if (!existing) {
    for (let n = 2; steps.some((step) => step.id === id); n++) id = `identify-design-system-${n}`;
    copy.nodes.unshift({
      id, title: "Identify existing UI conventions", role: "architecture", permission: "write",
      writeScope: designSystemPath, expectedFiles: [designSystemPath], estimatedChangedLines: 80,
      description: "Establish a concise, source-linked reference to the existing design system before changing UI.",
      prompt: `${uiPlanningInstruction} Create ${designSystemPath} from inspected source evidence, not an invented template. If another design-system document exists, make this a short entry point linking to it. Include source paths and representative examples; keep observed facts separate from proposed changes. Do not edit product code or redesign inconsistencies.`,
      acceptanceCriteria: ["The reference identifies authoritative sources and existing UI patterns, with observed conventions separated from decisions and inconsistencies", "The overview supports progressive lookup and does not duplicate existing design-system documentation"],
      expectedArtifacts: [designSystemPath], dependsOn: [], required: true
    });
  }
  // Place the reference before all work, preventing cycles when an existing
  // implementation group or serial step precedes the first UI slice.
  for (const step of steps) if (step.id !== id) step.dependsOn = [...new Set([id, ...(step.dependsOn || [])])];
  return normalizePlan(copy);
}
