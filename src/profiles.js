export const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "handoff"];

const defaults = {
  requirements: ["Requirements", "gpt-5.6-sol", "high", "Clarify product intent, surface consequential ambiguity, and produce observable requirements."],
  exploration: ["Exploration", "gpt-5.6-sol", "high", "Ground every recommendation in repository evidence and identify only decisions that can change implementation."],
  architecture: ["Architecture & planning", "gpt-5.6-sol", "high", "Choose the simplest architecture that satisfies the requirements and gives downstream tickets concrete boundaries."],
  implementation: ["Implementation", "gpt-5.6-terra", "high", "Implement the smallest complete slice, preserve accepted behavior, and run focused deterministic checks."],
  verification: ["Verification", "gpt-5.6-sol", "high", "Look for evidence-backed correctness, requirement, regression, security, and accessibility failures."],
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
  return profile?.prompt ? `${instruction}\n\n# Configured stage guidance\n${profile.prompt}` : instruction;
}
