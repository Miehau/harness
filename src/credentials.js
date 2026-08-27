import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function clean(value) { return String(value || "").trim(); }

export class CredentialStore {
  constructor(file) { this.file = file; }

  async load() {
    try { return JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }

  async save(input = {}) {
    const credentials = await this.load();
    if (input.clearLinear) delete credentials.linear;
    else if (clean(input.linearApiKey)) credentials.linear = { apiKey: clean(input.linearApiKey) };

    if (input.clearJira) delete credentials.jira;
    else {
      const current = credentials.jira || {};
      const jira = {
        baseUrl: clean(input.jiraBaseUrl) || current.baseUrl,
        email: clean(input.jiraEmail) || current.email,
        apiToken: clean(input.jiraApiToken) || current.apiToken,
        projectKey: clean(input.jiraProjectKey) || current.projectKey
      };
      if (Object.values(jira).some(Boolean)) {
        if (!/^https?:\/\//i.test(jira.baseUrl || "")) throw new Error("Jira base URL must start with http:// or https://");
        if (!jira.email?.includes("@")) throw new Error("Jira email is required");
        if (!jira.apiToken) throw new Error("Jira API token is required");
        if (!/^[a-z][a-z0-9_]*$/i.test(jira.projectKey || "")) throw new Error("Jira project key must contain only letters, numbers, and underscores");
        credentials.jira = jira;
      }
    }

    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
    return credentials;
  }
}

export function effectiveTrackerCredentials(saved = {}, environment = process.env) {
  return {
    linear: { apiKey: saved.linear?.apiKey || environment.LINEAR_API_KEY || "" },
    jira: {
      baseUrl: saved.jira?.baseUrl || environment.JIRA_BASE_URL || "",
      email: saved.jira?.email || environment.JIRA_EMAIL || "",
      apiToken: saved.jira?.apiToken || environment.JIRA_API_TOKEN || "",
      projectKey: saved.jira?.projectKey || environment.JIRA_PROJECT_KEY || ""
    }
  };
}

export function publicTrackerSettings(saved = {}, environment = process.env) {
  const effective = effectiveTrackerCredentials(saved, environment);
  return {
    linear: { configured: Boolean(effective.linear.apiKey), stored: Boolean(saved.linear?.apiKey) },
    jira: {
      configured: Boolean(effective.jira.baseUrl && effective.jira.email && effective.jira.apiToken && effective.jira.projectKey),
      stored: Boolean(saved.jira?.apiToken),
      baseUrl: saved.jira?.baseUrl || environment.JIRA_BASE_URL || "",
      email: saved.jira?.email || environment.JIRA_EMAIL || "",
      projectKey: saved.jira?.projectKey || environment.JIRA_PROJECT_KEY || ""
    }
  };
}
