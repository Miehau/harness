import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHarness } from "../src/pi-harness.js";

test("recovers a chronological, detailed trace from a persisted Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-trace-"));
  const directory = join(root, "pi-sessions");
  const file = join(directory, "run.jsonl");
  try {
    await mkdir(directory);
    await writeFile(file, [
      { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "Rendered prompt" }] } },
      { type: "message", message: { role: "assistant", timestamp: 2, content: [
        { type: "thinking", thinkingSignature: JSON.stringify({ summary: [{ text: "Inspecting files" }] }) },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }
      ] } },
      { type: "message", message: { role: "toolResult", timestamp: 3, toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "32 tests pass" }], isError: false } }
    ].map(JSON.stringify).join("\n"));
    const trace = await new PiHarness({ dataDir: root }).sessionTrace(file);
    assert.equal(trace.prompt, "Rendered prompt");
    assert.deepEqual(trace.events.map((event) => event.type), ["reasoning_summary", "tool_start", "tool_end"]);
    assert.match(trace.events[1].args, /npm test/);
    assert.equal(trace.events[2].result, "32 tests pass");
  } finally {
    await rm(root, { recursive: true });
  }
});
