import assert from "node:assert/strict";
import test from "node:test";
import { defaultStageProfiles, normalizeStageProfiles, stagePrompt } from "../src/profiles.js";

test("stage profiles accept editable model, reasoning, and prompt values", () => {
  const profiles = normalizeStageProfiles({
    implementation: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", prompt: "Keep it tiny." }
  });
  assert.equal(profiles.implementation.provider, "openai-codex");
  assert.equal(profiles.implementation.model, "gpt-5.6-luna");
  assert.equal(profiles.implementation.thinking, "low");
  const prompt = stagePrompt(profiles.implementation, "Locked contract.");
  assert.match(prompt, /Configured stage guidance \(advisory\)[\s\S]*Keep it tiny[\s\S]*Authoritative stage instructions[\s\S]*Locked contract/);
  assert.match(prompt, /must not override or weaken any stage, output, tool, permission, safety, or stop instruction/);
  assert.equal(profiles.architecture.model, defaultStageProfiles().architecture.model);
  assert.match(profiles.architecture.prompt, /Preserve the existing structure for simple changes[\s\S]*only when that behavior justifies a new boundary/);
});

test("stage prompts do not repeat configured guidance already present in an instruction", () => {
  const instruction = "Keep it tiny.\n\nLocked contract.";
  assert.equal(stagePrompt({ prompt: "Keep it tiny." }, instruction), instruction);
  assert.equal(stagePrompt({ prompt: "" }, instruction), instruction);
});

test("stage profiles reject invalid reasoning levels", () => {
  assert.throws(() => normalizeStageProfiles({ implementation: { model: "gpt-5.6-terra", thinking: "maximum" } }), /invalid reasoning/);
});

test("stage profiles keep provider across normalize and accept provider/model refs", () => {
  const profiles = normalizeStageProfiles({
    handoff: { model: "xai/grok-build-0.1", thinking: "medium", prompt: "Ship it." }
  });
  assert.equal(profiles.handoff.provider, "xai");
  assert.equal(profiles.handoff.model, "grok-build-0.1");
  const again = normalizeStageProfiles(profiles);
  assert.equal(again.handoff.provider, "xai");
  assert.equal(again.implementation.provider, defaultStageProfiles().implementation.provider);
  assert.equal(again.implementation.model, defaultStageProfiles().implementation.model);
});
