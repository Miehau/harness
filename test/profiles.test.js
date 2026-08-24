import assert from "node:assert/strict";
import test from "node:test";
import { defaultStageProfiles, normalizeStageProfiles, stagePrompt } from "../src/profiles.js";

test("stage profiles accept editable model, reasoning, and prompt values", () => {
  const profiles = normalizeStageProfiles({
    implementation: { model: "gpt-5.6-luna", thinking: "low", prompt: "Keep it tiny." }
  });
  assert.equal(profiles.implementation.model, "gpt-5.6-luna");
  assert.equal(profiles.implementation.thinking, "low");
  assert.match(stagePrompt(profiles.implementation, "Locked contract."), /Locked contract[\s\S]*Keep it tiny/);
  assert.equal(profiles.architecture.model, defaultStageProfiles().architecture.model);
  assert.match(profiles.architecture.prompt, /ubiquitous language[\s\S]*downstream ticket/);
});

test("stage profiles reject invalid reasoning levels", () => {
  assert.throws(() => normalizeStageProfiles({ implementation: { model: "gpt-5.6-terra", thinking: "maximum" } }), /invalid reasoning/);
});
