import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCommitMessage, PiHarness, stepContext } from "../src/pi-harness.js";
import { normalizePlan } from "../src/plan.js";

test("commit messages always explain why and name the requirement", () => {
  assert.equal(formatCommitMessage({ subject: "feat: add task board", why: "Users need a visible queue.", requirement: "REQ-board — tasks are displayed" }, {}), "feat: add task board\n\nWhy: Users need a visible queue.\nRequirement: REQ-board — tasks are displayed");
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
});

test("synthetic review steps can omit optional planning arrays", () => {
  const step = { id: "review-fix", title: "Fix review findings", role: "implementation", harness: "pi", contextPolicy: "seeded", permission: "write" };
  assert.match(stepContext({ plan: { title: "Review", nodes: [step] }, step, artifacts: [] }), /Skills requested: none/);
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
