import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVerificationContractStep, formatCommitMessage, formatTicketHorizon, MAX_VERIFICATION_ACTIONS, PiHarness, projectCommandTool, scopedWorkerTools, stepContext, transientRepositoryCheckFailure } from "../src/pi-harness.js";
import { normalizePlan } from "../src/plan.js";
import { defaultStageProfiles } from "../src/profiles.js";

test("commit messages always explain why and name the requirement", () => {
  assert.equal(formatCommitMessage({ subject: "feat: add task board", why: "Users need a visible queue.", requirement: "REQ-board — tasks are displayed" }, {}), "feat: add task board\n\nWhy: Users need a visible queue.\nRequirement: REQ-board — tasks are displayed");
});

test("ticket horizon excludes the current ticket and puts same-team work first", () => {
  const horizon = formatTicketHorizon(
    { id: "current", team: { id: "team-a" } },
    [
      { id: "other", identifier: "B-1", title: "Other team", team: { id: "team-b" } },
      { id: "current", identifier: "A-1", title: "Current", team: { id: "team-a" } },
      { id: "next", identifier: "A-2", title: "Shared foundation", description: "Reuse the task model", team: { id: "team-a" }, state: { name: "Backlog" } }
    ]
  );
  assert.doesNotMatch(horizon, /Current/);
  assert.ok(horizon.indexOf("A-2") < horizon.indexOf("B-1"));
  assert.match(horizon, /A-2 \[Backlog\] Shared foundation — Reuse the task model/);
});

test("requirements clarification reuses the private session for follow-up questions", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let opened;
  let prompt;
  harness.planningSession = async (...args) => {
    opened = args;
    return { sessionFile: "/tmp/requirements.jsonl" };
  };
  harness.visibleSupervisorPrompt = async (_session, value) => {
    prompt = value;
    return JSON.stringify({ artifact: "# Revised requirements", questions: ["Should archived tasks remain searchable?"] });
  };

  const result = await harness.refineRequirements({
    cwd: "/repo", ticket: { id: "ticket-1" }, runId: "run-1",
    sessionFile: "/tmp/requirements.jsonl", answers: "Yes, keep them searchable."
  });

  assert.equal(opened[1], "/tmp/requirements.jsonl");
  assert.equal(opened[3].repositoryAccess, false);
  assert.match(prompt, /Yes, keep them searchable\./);
  assert.doesNotMatch(prompt, /attachments/);
  assert.deepEqual(result.questions, ["Should archived tasks remain searchable?"]);
});

test("requirements clarification reserves questions for unresolved product outcomes", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let prompt;
  harness.planningSession = async () => ({ sessionFile: "/tmp/requirements.jsonl" });
  harness.visibleSupervisorPrompt = async (_session, value) => {
    prompt = value;
    return JSON.stringify({ artifact: "# Requirements", questions: [] });
  };

  await harness.clarifyRequirements({
    cwd: "/repo", runId: "run-1", productContext: "No extra context.",
    ticket: { id: "ticket-1", identifier: "T-1", title: "Add verification", description: "Reuse existing checks." }
  });

  assert.match(prompt, /Questions are a last resort/);
  assert.match(prompt, /conservative minimal interpretation/);
  assert.match(prompt, /Never ask the user to choose implementation mechanics/);
  assert.match(prompt, /fail-fast versus aggregate execution/);
});

test("planning exposes exact skills and rejects unavailable names", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  const session = {
    sessionFile: "/tmp/planning.jsonl",
    resourceLoader: { getSkills: () => ({ skills: [{ name: "frontend", description: "UI work" }] }) }
  };
  let prompt;
  harness.planningSession = async () => session;
  harness.visibleSupervisorPrompt = async (_session, value) => {
    prompt = value;
    return JSON.stringify({ title: "Plan", nodes: [{ title: "Build", skills: ["invented"] }] });
  };

  await assert.rejects(harness.generatePlan({ cwd: "/repo", sessionFile: null }), /unavailable skills: invented/);
  assert.match(prompt, /# Available skills\n- frontend/);
  assert.match(prompt, /Default to serial vertical slices/);
  assert.match(prompt, /"designArtifact"/);
  assert.doesNotMatch(prompt, /establish one shared contract first/);
});

test("configured guidance is emitted once per stage in a session", () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  const session = {};
  const profile = { id: "requirements", prompt: "Ask only consequential questions." };

  assert.match(harness.configuredPrompt(session, profile, "Hard contract."), /Ask only consequential questions[\s\S]*Hard contract/);
  assert.equal(harness.configuredPrompt(session, profile, "Follow-up contract."), "Follow-up contract.");
  assert.match(harness.configuredPrompt(session, { ...profile, id: "exploration" }, "Explore."), /Ask only consequential questions[\s\S]*Explore/);
});

test("worker project commands defer canonical verification to the framework", async () => {
  const result = await projectCommandTool("/unused").execute("call-1", { name: "verify" });
  assert.equal(result.isError, false);
  assert.equal(result.details.status, "deferred");
  assert.match(result.content[0].text, /once after worker_report/);
});

test("architecture workers see completed and future plan outcomes without unrelated verification ownership", () => {
  const plan = normalizePlan({ title: "Board", nodes: [
    { id: "skeleton", title: "Create skeleton", description: "Launch the empty app.", status: "accepted" },
    { id: "architecture", role: "architecture", title: "Design the domain", description: "Define boundaries for the full board." },
    { id: "persistence", title: "Persist tasks", description: "Survive browser reloads." }
  ] });
  const prompt = stepContext({ plan, step: plan.nodes[1], artifacts: [] });

  assert.match(prompt, /Already completed[\s\S]*Create skeleton: Launch the empty app\./);
  assert.match(prompt, /Current architecture outcome[\s\S]*Design the domain: Define boundaries for the full board\./);
  assert.match(prompt, /Planned after this ticket[\s\S]*Persist tasks: Survive browser reloads\./);
  assert.doesNotMatch(prompt, /Own the repository verification contract/);
  assert.match(prompt, /Expected files:/);
  assert.match(prompt, /Review budget:/);
});

test("existing projects get one focused verification contract before feature work", () => {
  const plan = ensureVerificationContractStep(normalizePlan({ nodes: [
    { id: "feature", title: "Build feature", permission: "write", writeScope: "src,test", requiresVisualEvidence: true }
  ] }), false);
  assert.equal(plan.nodes[0].role, "architecture");
  assert.equal(plan.nodes[0].writeScope, ".agent-plan");
  assert.deepEqual(plan.nodes[1].dependsOn, [plan.nodes[0].id]);
  assert.match(plan.nodes[0].prompt, /AGENT_PLAN_EVIDENCE_DIR/);
  assert.match(plan.nodes[0].prompt, /project\.json/);
  assert.deepEqual(plan.nodes[0].expectedArtifacts, [".agent-plan/project.json", ".agent-plan/verify.mjs"]);
  assert.doesNotMatch(plan.nodes[0].prompt, /docs\/architecture\.md|AGENTS\.md/);
  assert.equal(ensureVerificationContractStep(plan, true), plan);
});

test("synthetic review steps can omit optional planning arrays", () => {
  const step = { id: "review-fix", title: "Fix review findings", role: "implementation", harness: "pi", contextPolicy: "seeded", permission: "write" };
  const prompt = stepContext({ plan: { title: "Review", nodes: [step] }, step, artifacts: [] });
  assert.match(prompt, /Skills requested: none/);
  assert.match(prompt, /use review_note for up to five non-obvious changed sections/);
  assert.match(prompt, /one to three informative, direct sentences/);
});

test("runs the repository's root npm test script as a deterministic gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-checks-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const harness = new PiHarness({ dataDir: root });
    assert.equal((await harness.runRepositoryChecks({ cwd: root })).status, "passed");

    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
    assert.equal((await harness.runRepositoryChecks({ cwd: root })).status, "failed");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("retries one transient filesystem cleanup race without spending a correction round", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-check-retry-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node verify.mjs" } }));
    await writeFile(join(root, "verify.mjs"), `
      import { readFileSync, writeFileSync } from "node:fs";
      const path = new URL("count", import.meta.url);
      let count = 0;
      try { count = Number(readFileSync(path, "utf8")); } catch {}
      writeFileSync(path, String(count + 1));
      if (!count) { console.error("ENOTEMPTY: directory not empty, rmdir '/tmp/agent-plan-daemon-test'"); process.exit(1); }
    `);
    const result = await new PiHarness({ dataDir: root }).runRepositoryChecks({ cwd: root });
    assert.equal(result.status, "passed");
    assert.match(result.summary, /after retrying/);
    assert.equal(await readFile(join(root, "count"), "utf8"), "2");
    assert.equal(transientRepositoryCheckFailure("ordinary assertion failure"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded repository failure output retains both context and the final failing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-check-output-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node verify.mjs" } }));
    await writeFile(join(root, "verify.mjs"), `
      console.log("BEGIN-CONTEXT:" + "a".repeat(6000));
      console.log("not ok 237 - preserves the proof record");
      console.log("  location: 'test/proof.test.js:42:1'");
      console.log("  error: 'Expected 200 but received 400'");
      console.log("b".repeat(12000));
      process.exit(1);
    `);
    const result = await new PiHarness({ dataDir: root }).runRepositoryChecks({ cwd: root });
    assert.equal(result.status, "failed");
    assert.match(result.output, /BEGIN-CONTEXT/);
    assert.match(result.output, /characters omitted/);
    assert.match(result.output, /Failure highlights/);
    assert.match(result.output, /not ok 237 - preserves the proof record/);
    assert.match(result.output, /test\/proof\.test\.js:42:1/);
    assert.match(result.failureHighlights, /not ok 237 - preserves the proof record/);
    assert.doesNotMatch(result.failureHighlights, /BEGIN-CONTEXT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers the repository verification contract and discovers image and video evidence when declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-contract-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-contract-state-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "verify.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(process.env.AGENT_PLAN_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "page.png"), Buffer.from("png"));
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "interaction.webm"), Buffer.from("webm"));
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "ignored.txt"), "not evidence");
    `);
    const harness = new PiHarness({ dataDir });
    const result = await harness.runRepositoryChecks({ cwd: root, requireVisualEvidence: true });
    assert.equal(result.status, "passed");
    assert.equal(result.command, "node .agent-plan/verify.mjs");
    assert.deepEqual(result.evidence.map(({ name, mediaType, mediaKind }) => ({ name, mediaType, mediaKind })), [
      { name: "interaction.webm", mediaType: "video/webm", mediaKind: "video" },
      { name: "page.png", mediaType: "image/png", mediaKind: "image" }
    ]);
    const images = await harness.evidenceImages(result.evidence);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/png");
    assert.equal(images[0].type, "image");
    assert.equal(typeof images[0].data, "string");
    assert.equal("source" in images[0], false);
    assert.equal((await harness.runRepositoryChecks({ cwd: root, requireVideoEvidence: true })).status, "passed");

    await writeFile(join(root, ".agent-plan", "verify.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(process.env.AGENT_PLAN_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "page.png"), Buffer.from("png"));
    `);
    assert.equal((await harness.runRepositoryChecks({ cwd: root, requireVideoEvidence: true })).status, "failed");

    await writeFile(join(root, ".agent-plan", "verify.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(process.env.AGENT_PLAN_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "interaction.webm"), Buffer.from("webm"));
    `);
    assert.equal((await harness.runRepositoryChecks({ cwd: root, requireVideoEvidence: true })).status, "failed");

    await writeFile(join(root, ".agent-plan", "verify.mjs"), "// no screenshot\n");
    const missingEvidence = await harness.runRepositoryChecks({ cwd: root, requireVisualEvidence: true });
    assert.equal(missingEvidence.status, "failed");
    assert.equal(missingEvidence.failureKind, "visual-evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("hard worker tools allow scoped writes and block sibling paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-"));
  try {
    await mkdir(join(root, "allowed"));
    const write = scopedWorkerTools(root, "allowed").find((tool) => tool.name === "write");
    await write.execute("allowed", { path: "allowed/result.txt", content: "ok" });
    assert.equal(await readFile(join(root, "allowed", "result.txt"), "utf8"), "ok");
    await assert.rejects(write.execute("replace", { path: "allowed/result.txt", content: "truncated" }), /exist/i);
    assert.equal(await readFile(join(root, "allowed", "result.txt"), "utf8"), "ok");
    await assert.rejects(write.execute("blocked", { path: "blocked.txt", content: "nope" }), /Write blocked outside scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact file scope can create its missing parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-exact-scope-"));
  try {
    const write = scopedWorkerTools(root, "docs/architecture.md").find((tool) => tool.name === "write");
    await write.execute("architecture", { path: "docs/architecture.md", content: "# Architecture\n" });
    assert.equal(await readFile(join(root, "docs", "architecture.md"), "utf8"), "# Architecture\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workers cannot complete without the terminating worker report", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-report-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    const session = {
      state: { messages: [] },
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt() {},
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const plan = normalizePlan({ title: "Read", nodes: [{ id: "inspect", title: "Inspect", permission: "read" }] });

    await assert.rejects(harness.runStep({
      cwd: root, plan, step: plan.nodes[0], artifacts: [], images: [], feedback: ""
    }), /required worker_report tool/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh verification receives the completed deterministic gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-prompt-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    let prompt;
    const session = {
      state: { messages: [] },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt(value) {
        prompt = value;
        this.state.messages.push({ role: "assistant", content: [{ type: "text", text: '{"summary":"Verified","findings":[]}' }] });
      },
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const plan = normalizePlan({ title: "Verify", nodes: [
      { id: "slice", title: "Slice", permission: "write", writeScope: "src" },
      { id: "later", title: "Recover queued work", permission: "write", writeScope: "src", dependsOn: ["slice"], acceptanceCriteria: ["Paused work drains after resume"] }
    ] });

    const input = {
      cwd: root, ticket: { id: "T-1", identifier: "T-1", title: "Ticket" }, plan, step: plan.nodes[0],
      design: "Design", diff: { files: ["src/a.js"], patch: "+change" }, output: "Done", checks: {
        status: "passed", command: "node .agent-plan/verify.mjs", summary: "Checks passed.", output: "10 tests passed"
      }, runId: "run", round: 1
    };
    const result = await harness.verifyStep(input);

    assert.equal(result.summary, "Verified");
    assert.match(prompt, /The deterministic gate has already run/);
    assert.match(prompt, /Checks passed\./);
    assert.doesNotMatch(prompt, /10 tests passed/);
    assert.match(prompt, /Report only critical, high, or medium findings/);
    assert.match(prompt, /Keep inspection inside the current working directory/);
    assert.match(prompt, /primary review packet/);
    assert.match(prompt, /concrete medium-or-higher risk/);
    assert.match(prompt, /Deferred plan slices \(not acceptance criteria for this review\)/);
    assert.match(prompt, /Recover queued work: Paused work drains after resume/);
    assert.match(prompt, /Do not report behavior assigned exclusively to a deferred plan slice/);
    assert.doesNotMatch(prompt, /run focused deterministic checks when useful/);

    await harness.verifyStep({ ...input, round: 2, focusFindings: [{ severity: "high", claim: "Write guard is bypassed" }] });
    assert.match(prompt, /This is a correction verification/);
    assert.match(prompt, /Write guard is bypassed/);
    assert.match(prompt, /Do not start a new broad audit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh verification retries one empty model response without repeating inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-retry-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    const prompts = [];
    const session = {
      state: { messages: [] },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt(value) {
        prompts.push(value);
        this.state.messages.push({ role: "assistant", content: [{ type: "text", text: prompts.length === 1 ? " " : '{"summary":"Verified after retry","findings":[]}' }] });
      },
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const plan = normalizePlan({ title: "Verify", nodes: [{ id: "slice", title: "Slice", permission: "write", writeScope: "src" }] });

    const result = await harness.verifyStep({
      cwd: root, ticket: { id: "T-1", identifier: "T-1", title: "Ticket" }, plan, step: plan.nodes[0],
      design: "Design", diff: { files: ["src/a.js"], patch: "+change" }, output: "Done",
      checks: { status: "passed", command: "verify", summary: "Passed", output: "10 tests passed" }, runId: "run", round: 1
    });

    assert.equal(result.summary, "Verified after retry");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /do not repeat repository inspection/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification surfaces the provider error after one retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-error-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    let prompts = 0;
    const session = {
      state: { messages: [] },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt() {
        prompts++;
        this.state.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider rejected the image payload" });
      },
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const plan = normalizePlan({ title: "Verify", nodes: [{ id: "slice", title: "Slice", permission: "write", writeScope: "src" }] });

    await assert.rejects(harness.verifyStep({
      cwd: root, ticket: { id: "T-1", identifier: "T-1", title: "Ticket" }, plan, step: plan.nodes[0],
      design: "Design", diff: { files: ["src/a.js"], patch: "+change" }, output: "Done",
      checks: { status: "passed", command: "verify", summary: "Passed" }, runId: "run", round: 1
    }), /Provider rejected the image payload/);
    assert.equal(prompts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("later final-review rounds explicitly recheck earlier findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-focus-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    let prompt = "";
    const session = {
      state: { messages: [] },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt(value) {
        prompt = value;
        this.state.messages.push({ role: "assistant", content: [{ type: "text", text: '{"summary":"Rechecked","findings":[]}' }] });
      },
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const finding = { severity: "high", claim: "A late child can escape cleanup", evidence: [{ file: "src/process.js", line: 42 }] };
    await harness.reviewTicket({
      cwd: root, ticket: { id: "T-1", identifier: "T-1", title: "Ticket" },
      plan: normalizePlan({ title: "Review", nodes: [{ id: "slice", title: "Slice", permission: "write", writeScope: "src" }] }),
      artifacts: [], diff: { files: ["src/process.js"], patch: "+change" }, checks: { status: "passed", summary: "Passed" },
      focusFindings: [finding], role: "integration", round: 2, runId: "run"
    });
    assert.match(prompt, /Findings from earlier review rounds/);
    assert.match(prompt, /A late child can escape cleanup/);
    assert.match(prompt, /Report it again when it remains unresolved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh verification stops after its repository inspection budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-budget-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    const subscribers = [];
    const session = {
      state: { messages: [] },
      setSessionName() {},
      subscribe(fn) { subscribers.push(fn); return () => {}; },
      async prompt() {
        for (let index = 0; index <= MAX_VERIFICATION_ACTIONS; index++) {
          for (const fn of subscribers) fn({ type: "tool_execution_start", toolName: "read", toolCallId: `read-${index}`, args: { path: "src/a.js" } });
        }
      },
      async abort() {},
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}) }
    });
    const plan = normalizePlan({ title: "Verify", nodes: [{ id: "slice", title: "Slice", permission: "write", writeScope: "src" }] });

    await assert.rejects(harness.verifyStep({
      cwd: root, ticket: { id: "T-1", identifier: "T-1", title: "Ticket" }, plan, step: plan.nodes[0],
      design: "Design", diff: { files: ["src/a.js"], patch: "+change" }, output: "Done", checks: {
        status: "passed", command: "node .agent-plan/verify.mjs", summary: "Checks passed.", output: "10 tests passed"
      }, runId: "run", round: 1
    }), new RegExp(`${MAX_VERIFICATION_ACTIONS}-action inspection budget`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists every configured Codex model used by stage profiles", async () => {
  const ids = new Set((await new PiHarness({ dataDir: tmpdir() }).models()).map((model) => model.id));
  for (const profile of Object.values(defaultStageProfiles())) assert.equal(ids.has(profile.model), true);
});

test("recovers a chronological, detailed trace from a persisted Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-trace-"));
  const directory = join(root, "pi-sessions");
  const file = join(directory, "run.jsonl");
  try {
    await mkdir(directory);
    await writeFile(file, [
      { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "Rendered prompt" }] } },
      { type: "message", message: { role: "assistant", timestamp: 2, content: [
        { type: "thinking", thinkingSignature: JSON.stringify({ summary: [{ text: "Inspecting files" }, { text: "Checking the task model" }] }) },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
        { type: "toolCall", id: "call-2", name: "worker_report", arguments: { status: "completed", summary: "Derived the architecture", artifact: "# Architecture" } }
      ] } },
      { type: "message", message: { role: "toolResult", timestamp: 3, toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "32 tests pass" }], isError: false } },
      { type: "message", message: { role: "toolResult", timestamp: 4, toolCallId: "call-2", toolName: "worker_report", content: [{ type: "text", text: "Reported completed" }], isError: false } }
    ].map(JSON.stringify).join("\n"));
    const trace = await new PiHarness({ dataDir: root }).sessionTrace(file);
    assert.equal(trace.prompt, "Rendered prompt");
    assert.deepEqual(trace.prompts, [{ prompt: "Rendered prompt", at: "1970-01-01T00:00:00.001Z" }]);
    assert.deepEqual(trace.events.map((event) => event.type), ["reasoning_summary", "reasoning_summary", "tool_start", "tool_start", "tool_end", "tool_end"]);
    assert.match(trace.events[2].args, /npm test/);
    assert.match(trace.events[3].args, /Derived the architecture/);
    assert.equal(trace.events[4].result, "32 tests pass");
    assert.equal(trace.events[5].result, "Reported completed");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("resumed worker sessions send a continuation prompt instead of the full step context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-resume-prompt-"));
  try {
    const harness = new PiHarness({ dataDir: root });
    let prompt;
    const session = {
      state: { messages: [] },
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      setSessionName() {},
      subscribe() { return () => {}; },
      async prompt(value) { prompt = value; },
      dispose() {}
    };
    harness.sdk = async () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => ({}), open: () => ({}), forkFrom: () => ({}) }
    });
    const plan = normalizePlan({ title: "Read", nodes: [
      { id: "inspect", title: "Inspect", permission: "write", writeScope: "src,test/e2e-proof.test.js", skills: [], acceptanceCriteria: ["The API stores queued work"] },
      { id: "deliver", title: "Deliver queued work", permission: "write", writeScope: "src", dependsOn: ["inspect"], acceptanceCriteria: ["Queued work drains after resume"] }
    ] });
    plan.nodes[0].scopeChanges = [{ paths: ["test/e2e-proof.test.js"], reason: "Canonical proof fixtures exercise this contract." }];
    await assert.rejects(harness.runStep({
      cwd: root, plan, step: plan.nodes[0], artifacts: [], images: [],
      feedback: "Use the existing queue model", resumeSessionFile: join(root, "worker.jsonl")
    }), /required worker_report tool/);
    assert.match(prompt, /The user responded to this worker session/);
    assert.match(prompt, /Use the existing queue model/);
    assert.match(prompt, /Effective write scope: src,test\/e2e-proof\.test\.js/);
    assert.match(prompt, /Audited scope additions: test\/e2e-proof\.test\.js \(Canonical proof fixtures exercise this contract\.\)/);
    assert.match(prompt, /Do not request access to a path already included/);
    assert.match(prompt, /Acceptance criteria: The API stores queued work/);
    assert.match(prompt, /Deferred slices: Deliver queued work \(Queued work drains after resume\)/);
    assert.match(prompt, /Do not implement behavior assigned exclusively to a deferred slice/);
    assert.doesNotMatch(prompt, /Skills requested/);

    await assert.rejects(harness.runStep({
      cwd: root, plan, step: plan.nodes[0], artifacts: [], images: [], feedback: "Fix the tests"
    }), /required worker_report tool/);
    assert.match(prompt, /# Review feedback/);
    assert.match(prompt, /Skills requested/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified worker report cannot introduce a second model gate", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  harness.planningSession = async () => assert.fail("verified reports must not launch another model review");
  const result = await harness.reviewWorkerReport({
    cwd: "/repo", sessionFile: "/tmp/supervisor.jsonl", sessionKey: "ticket-run",
    step: { id: "slice", title: "Slice", agentId: "worker:impl", acceptanceCriteria: ["Board renders"] },
    report: { status: "completed", summary: "Done" }, diff: { files: ["src/a.js"] }
  });
  assert.equal(result.sessionFile, "/tmp/supervisor.jsonl");
  assert.deepEqual(result.checkpoints, []);
  assert.match(result.reply, /Independent verification passed for Slice/);
  assert.match(result.reply, /Done \(1 changed file\)/);
});

test("binding a discovered skill loads it as the supervisor workflow", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let opened;
  let prompt;
  const session = {
    sessionFile: "/tmp/supervisor.jsonl",
    resourceLoader: { getSkills: () => ({ skills: [{ name: "shape-feature", description: "Shape the brief" }] }) }
  };
  harness.planningSession = async (...args) => {
    opened = args;
    return session;
  };
  harness.visibleSupervisorPrompt = async (_session, value) => {
    prompt = value;
    return "Workflow loaded";
  };
  const result = await harness.activateWorkflow({
    cwd: "/repo", sessionFile: null, sessionKey: "ticket-run", skillName: "shape-feature"
  });
  assert.equal(opened[2], "ticket-run");
  assert.match(prompt, /\/skill:shape-feature/);
  assert.match(prompt, /binding workflow/);
  assert.equal(result.reply, "Workflow loaded");
  await assert.rejects(harness.activateWorkflow({
    cwd: "/repo", sessionFile: null, skillName: "missing"
  }), /Pi skill not found: missing/);
});

test("continuing a supervisor checkpoint sends the user response", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let prompt;
  harness.planningSession = async () => ({ sessionFile: "/tmp/supervisor.jsonl" });
  harness.visibleSupervisorPrompt = async (_session, value) => {
    prompt = value;
    return "Continuing";
  };
  const result = await harness.continueWorkflow({
    cwd: "/repo", sessionFile: "/tmp/supervisor.jsonl", sessionKey: "ticket-run",
    checkpoint: { title: "Approve the brief" }, response: "Ship it"
  });
  assert.match(prompt, /Approve the brief/);
  assert.match(prompt, /Ship it/);
  assert.equal(result.reply, "Continuing");
});

test("reset disposes cached supervisor sessions and clears the queue", () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  let disposed = 0;
  harness.planning.set("ticket-run", { cwd: "/repo", session: { dispose() { disposed++; } } });
  harness.supervisorQueues.set("ticket-run", Promise.resolve());
  harness.reset();
  assert.equal(disposed, 1);
  assert.equal(harness.planning.size, 0);
  assert.equal(harness.supervisorQueues.size, 0);
});

test("explore, design, bind, continue, and review share one supervisor queue key per run", async () => {
  const harness = new PiHarness({ dataDir: tmpdir() });
  const keys = [];
  const original = harness.supervisorTurn.bind(harness);
  harness.supervisorTurn = (work, key) => {
    keys.push(key);
    return original(work, key);
  };
  const session = {
    sessionFile: "/tmp/plan.jsonl",
    resourceLoader: { getSkills: () => ({ skills: [{ name: "shape-feature", description: "Shape" }] }) }
  };
  harness.planningSession = async () => session;
  harness.visibleSupervisorPrompt = async () => JSON.stringify({
    artifact: "# ok", questions: [], title: "Plan", nodes: [{ title: "Build" }], designArtifact: "# design"
  });
  const ticket = { id: "ticket-1", identifier: "T-1", title: "Ticket", description: "" };
  const runId = "run-1";
  const expected = harness.supervisorRunKey(ticket.id, runId);
  await harness.exploreTicket({ cwd: "/repo", ticket, runId, productContext: "ctx", requirements: "req" });
  await harness.designTicket({ cwd: "/repo", ticket, runId, productContext: "ctx", requirements: "req", exploration: "delta", ticketLookAhead: "none" }).catch(() => {});
  await harness.activateWorkflow({ cwd: "/repo", sessionKey: expected, skillName: "shape-feature" });
  await harness.continueWorkflow({ cwd: "/repo", sessionKey: expected, checkpoint: { title: "Gate" }, response: "ok" });
  await harness.reviewWorkerReport({ cwd: "/repo", sessionKey: expected, step: { id: "build", title: "Build", agentId: "w", acceptanceCriteria: [] }, report: { status: "completed" }, diff: { files: [] } });
  assert.ok(keys.includes(expected));
  assert.equal(keys.filter((key) => key === expected).length >= 4, true);
});
