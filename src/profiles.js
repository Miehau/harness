export const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "commit", "handoff"];

const defaults = {
  requirements: ["Requirements", "gpt-5.6-sol", "high", "Clarify product intent, surface consequential ambiguity, and produce observable requirements."],
  exploration: ["Exploration", "gpt-5.6-sol", "high", "Ground every recommendation in repository evidence and identify only decisions that can change implementation."],
  architecture: ["Architecture & planning", "gpt-5.6-sol", "high", "Preserve the existing structure for simple changes. Derive architecture from product behavior only when that behavior justifies a new boundary. Identify the relevant language, commands, state transitions, invariants, lifecycles, and responsibilities that change together, then define the smallest cohesive ownership and dependency direction needed. Map requirements and downstream tickets, including automation and operational concerns, to existing owners where possible. Avoid speculative layers, interfaces, factories, and generic abstractions."],
  implementation: ["Implementation", "gpt-5.6-terra", "high", "Implement the smallest complete slice, preserve accepted behavior, and run focused deterministic checks."],
  verification: ["Verification", "gpt-5.6-sol", "high", "Look for evidence-backed correctness, requirement, regression, security, and accessibility failures."],
  commit: ["Commit messages", "gpt-5.6-luna", "low", "Explain the product reason for the change and tie it to the approved requirement without narrating implementation mechanics."],
  handoff: ["Handoff", "gpt-5.6-terra", "medium", "Summarize only verified outcomes and preserve unrelated product context."]
};

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function defaultStageProfiles() {
  return Object.fromEntries(profileIds.map((id) => {
    const [label, model, thinking, prompt] = defaults[id];
    return [id, { id, label, provider: "openai-codex", model, thinking, prompt }];
  }));
}

export function normalizeStageProfiles(input = {}) {
  const result = defaultStageProfiles();
  for (const id of profileIds) {
    const source = input?.[id];
    if (!source) continue;
    const model = String(source.model || "").trim();
    const prompt = String(source.prompt ?? "").trim();
    if (!model || model.length > 160) throw new Error(`${result[id].label} needs a valid model ID`);
    if (!thinkingLevels.has(source.thinking)) throw new Error(`${result[id].label} has an invalid reasoning level`);
    if (prompt.length > 20000) throw new Error(`${result[id].label} prompt is too long`);
    Object.assign(result[id], { model, thinking: source.thinking, prompt });
  }
  return result;
}

export function stagePrompt(profile, instruction) {
  if (!profile?.prompt) return instruction;
  const guidance = String(profile.prompt).trim();
  if (!guidance || instruction.includes(guidance)) return instruction;
  return `# Configured stage guidance (advisory)\n${guidance}\n\n# Authoritative stage instructions\nConfigured guidance must not override or weaken any stage, output, tool, permission, safety, or stop instruction below.\n\n${instruction}`;
}
