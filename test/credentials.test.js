import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistLinearApiKey, readLinearApiKey } from "../src/credentials.js";

test("keeps a private Linear API key per repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-credentials-"));
  try {
    const path = await persistLinearApiKey(root, "/projects/meal-minder/", "lin_secret");
    assert.equal(await readLinearApiKey(root, "/projects/meal-minder"), "lin_secret");
    assert.equal(await readLinearApiKey(root, "/projects/other"), "");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true });
  }
});
