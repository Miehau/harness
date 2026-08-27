import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVerificationContractStep, formatCommitMessage, formatTicketHorizon, PiHarness, scopedWorkerTools, stepContext } from "../src/pi-harness.js";
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
  assert.deepEqual(result.questions, ["Should archived tasks remain searchable?"]);
});

test("architecture workers see completed and future plan outcomes", () => {
  const plan = normalizePlan({ title: "Board", nodes: [
    { id: "skeleton", title: "Create skeleton", description: "Launch the empty app.", status: "accepted" },
    { id: "architecture", role: "architecture", title: "Design the domain", description: "Define boundaries for the full board." },
    { id: "persistence", title: "Persist tasks", description: "Survive browser reloads." }
  ] });
  const prompt = stepContext({ plan, step: plan.nodes[1], artifacts: [] });

  assert.match(prompt, /Already completed[\s\S]*Create skeleton: Launch the empty app\./);
  assert.match(prompt, /Current architecture outcome[\s\S]*Design the domain: Define boundaries for the full board\./);
  assert.match(prompt, /Planned after this ticket[\s\S]*Persist tasks: Survive browser reloads\./);
  assert.match(prompt, /node \.agent-plan\/verify\.mjs/);
});

test("existing projects get one architecture-owned operating contract before feature work", () => {
  const plan = ensureVerificationContractStep(normalizePlan({ nodes: [
    { id: "feature", title: "Build feature", permission: "write", writeScope: "src,test", requiresVisualEvidence: true }
  ] }), false);
  assert.equal(plan.nodes[0].role, "architecture");
  assert.equal(plan.nodes[0].writeScope, ".agent-plan,AGENTS.md,docs");
  assert.deepEqual(plan.nodes[1].dependsOn, [plan.nodes[0].id]);
  assert.match(plan.nodes[0].prompt, /AGENT_PLAN_EVIDENCE_DIR/);
  assert.match(plan.nodes[0].prompt, /project\.json/);
  assert.deepEqual(plan.nodes[0].expectedArtifacts, ["docs/architecture.md", "AGENTS.md", ".agent-plan/project.json", ".agent-plan/verify.mjs"]);
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

test("prefers the repository verification contract and requires visual evidence when declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-contract-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-contract-state-"));
  try {
    await mkdir(join(root, ".agent-plan"));
    await writeFile(join(root, ".agent-plan", "verify.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(process.env.AGENT_PLAN_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENT_PLAN_EVIDENCE_DIR, "page.png"), Buffer.from("png"));
    `);
    const harness = new PiHarness({ dataDir });
    const result = await harness.runRepositoryChecks({ cwd: root, requireVisualEvidence: true });
    assert.equal(result.status, "passed");
    assert.equal(result.command, "node .agent-plan/verify.mjs");
    assert.equal(result.evidence.length, 1);
    assert.equal((await harness.evidenceImages(result.evidence))[0].source.mediaType, "image/png");

    await writeFile(join(root, ".agent-plan", "verify.mjs"), "// no screenshot\n");
    assert.equal((await harness.runRepositoryChecks({ cwd: root, requireVisualEvidence: true })).status, "failed");
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
    await assert.rejects(write.execute("blocked", { path: "blocked.txt", content: "nope" }), /Write blocked outside scope/);
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
    assert.deepEqual(trace.events.map((event) => event.type), ["reasoning_summary", "reasoning_summary", "tool_start", "tool_start", "tool_end", "tool_end"]);
    assert.match(trace.events[2].args, /npm test/);
    assert.match(trace.events[3].args, /Derived the architecture/);
    assert.equal(trace.events[4].result, "32 tests pass");
    assert.equal(trace.events[5].result, "Reported completed");
  } finally {
    await rm(root, { recursive: true });
  }
});
