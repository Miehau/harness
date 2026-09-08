export const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "commit", "handoff"];
export const defaultProfileProvider = "xai";
export const defaultProfileModel = "grok-build-0.1";
export const dashboardModelProviders = Object.freeze(["xai", "openai-codex"]);

const defaults = {
  requirements: ["Requirements", "high", "Clarify product intent, surface consequential ambiguity, and produce observable requirements."],
  exploration: ["Exploration", "high", "Ground every recommendation in repository evidence and identify only decisions that can change implementation."],
  architecture: ["Architecture & planning", "high", "Preserve the existing structure for simple changes. Derive architecture from product behavior only when that behavior justifies a new boundary. Identify the relevant language, commands, state transitions, invariants, lifecycles, and responsibilities that change together, then define the smallest cohesive ownership and dependency direction needed. Map requirements and downstream tickets, including automation and operational concerns, to existing owners where possible. Avoid speculative layers, interfaces, factories, and generic abstractions."],
  implementation: ["Implementation", "high", "Implement the smallest complete slice, preserve accepted behavior, and run focused deterministic checks."],
  verification: ["Verification", "high", "Look for evidence-backed correctness, requirement, regression, security, and accessibility failures."],
  commit: ["Commit messages", "low", "Explain the product reason for the change and tie it to the approved requirement without narrating implementation mechanics."],
  handoff: ["Handoff", "medium", "Summarize only verified outcomes and preserve unrelated product context."]
};

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const providerPattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseModelRef(value, fallbackProvider = null) {
  const text = String(value || "").trim();
  const slash = text.indexOf("/");
  if (slash > 0 && slash < text.length - 1) {
    return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
  }
  return fallbackProvider ? { provider: fallbackProvider, model: text } : { model: text };
}

export function modelRef(profile) {
  if (!profile?.model) return "";
  return profile.provider ? `${profile.provider}/${profile.model}` : profile.model;
}

export function defaultStageProfiles() {
  return Object.fromEntries(profileIds.map((id) => {
    const [label, thinking, prompt] = defaults[id];
    return [id, { id, label, provider: defaultProfileProvider, model: defaultProfileModel, thinking, prompt }];
  }));
}

export function normalizeStageProfiles(input = {}) {
  const result = defaultStageProfiles();
  for (const id of profileIds) {
    const source = input?.[id];
    if (!source) continue;
    const parsed = parseModelRef(source.model);
    const provider = String(source.provider || parsed.provider || result[id].provider).trim();
    const model = String(parsed.model || "").trim();
    const prompt = String(source.prompt ?? "").trim();
    if (!providerPattern.test(provider) || provider.length > 80) throw new Error(`${result[id].label} needs a valid provider`);
    if (!model || model.length > 160) throw new Error(`${result[id].label} needs a valid model ID`);
    if (!thinkingLevels.has(source.thinking)) throw new Error(`${result[id].label} has an invalid reasoning level`);
    if (prompt.length > 20000) throw new Error(`${result[id].label} prompt is too long`);
    Object.assign(result[id], { provider, model, thinking: source.thinking, prompt });
  }
  return result;
}

export function stagePrompt(profile, instruction) {
  if (!profile?.prompt) return instruction;
  const guidance = String(profile.prompt).trim();
  if (!guidance || instruction.includes(guidance)) return instruction;
  return `# Configured stage guidance (advisory)\n${guidance}\n\n# Authoritative stage instructions\nConfigured guidance must not override or weaken any stage, output, tool, permission, safety, or stop instruction below.\n\n${instruction}`;
}
