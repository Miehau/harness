import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, effectiveTrackerCredentials, publicTrackerSettings } from "../src/credentials.js";

test("stores tracker secrets locally with owner-only permissions and never exposes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-credentials-"));
  const file = join(root, "credentials.json");
  try {
    const store = new CredentialStore(file);
    const saved = await store.save({
      linearApiKey: "linear-secret", jiraBaseUrl: "https://example.atlassian.net", jiraEmail: "dev@example.com",
      jiraApiToken: "jira-secret", jiraProjectKey: "APP"
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(effectiveTrackerCredentials(saved, {}).linear.apiKey, "linear-secret");
    assert.deepEqual(publicTrackerSettings(saved, {}).linear, { configured: true, stored: true });
    assert.doesNotMatch(JSON.stringify(publicTrackerSettings(saved, {})), /linear-secret|jira-secret/);
    assert.equal((await store.save({ clearLinear: true, clearJira: true })).linear, undefined);
  } finally { await rm(root, { recursive: true }); }
});

test("stored credentials override environment values", () => {
  assert.equal(effectiveTrackerCredentials({ linear: { apiKey: "stored" } }, { LINEAR_API_KEY: "environment" }).linear.apiKey, "stored");
});
