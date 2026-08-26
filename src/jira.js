function adfText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfText).filter(Boolean).join("\n");
  const own = value.type === "text" ? value.text || "" : "";
  return [own, adfText(value.content)].filter(Boolean).join(value.type === "paragraph" ? "\n" : "");
}

function statusType(status) {
  const category = status?.statusCategory?.key;
  if (category === "done") return "completed";
  if (category === "indeterminate") return "started";
  return "unstarted";
}

function linkedIssue(link) {
  const inward = String(link.type?.inward || "").toLowerCase();
  const outward = String(link.type?.outward || "").toLowerCase();
  if (link.inwardIssue && /(blocked by|depends on)/.test(inward)) return link.inwardIssue;
  if (link.outwardIssue && /(blocked by|depends on)/.test(outward)) return link.outwardIssue;
  return null;
}

function unresolvedBlockers(issue) {
  return (issue.fields?.issuelinks || [])
    .map(linkedIssue)
    .filter((blocker) => blocker && blocker.fields?.status?.statusCategory?.key !== "done");
}

function jiraError(payload, status) {
  const details = [
    ...(payload?.errorMessages || []),
    ...Object.values(payload?.errors || {})
  ].filter(Boolean);
  return details.join("; ") || `Jira returned ${status}`;
}

function adfDocument(body) {
  return {
    type: "doc",
    version: 1,
    content: String(body).split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph.trim() || " " }]
    }))
  };
}

export class JiraClient {
  constructor({
    baseUrl = process.env.JIRA_BASE_URL,
    email = process.env.JIRA_EMAIL,
    apiToken = process.env.JIRA_API_TOKEN,
    projectKey = process.env.JIRA_PROJECT_KEY,
    fetchImpl = fetch
  } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.email = email;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    this.fetch = fetchImpl;
  }

  get provider() { return "jira"; }
  get configured() { return Boolean(this.baseUrl && this.email && this.apiToken && this.projectKey); }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      }
    });
    const payload = response.text
      ? await response.text().then((text) => text ? JSON.parse(text) : null)
      : await response.json();
    if (!response.ok) throw new Error(jiraError(payload, response.status));
    return payload;
  }

  async tickets() {
    if (!this.configured) return { configured: false, viewer: null, tickets: [] };
    if (!/^[a-z][a-z0-9_]*$/i.test(this.projectKey)) throw new Error("JIRA_PROJECT_KEY must contain only letters, numbers, and underscores");
    const [viewer, result] = await Promise.all([
      this.request("/rest/api/3/myself"),
      this.request("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: `project = "${this.projectKey}" AND statusCategory != Done ORDER BY priority ASC, updated DESC`,
          maxResults: 100,
          fields: ["summary", "description", "priority", "status", "assignee", "labels", "project", "issuelinks", "updated"]
        })
      })
    ]);
    return {
      configured: true,
      viewer: { id: viewer.accountId, name: viewer.displayName },
      tickets: (result.issues || [])
        .filter((issue) => unresolvedBlockers(issue).length === 0)
        .map((issue) => ({
          id: `jira:${issue.id}`,
          nativeId: issue.id,
          provider: "jira",
          identifier: issue.key,
          title: issue.fields?.summary || issue.key,
          description: adfText(issue.fields?.description).trim(),
          priority: Number(issue.fields?.priority?.id) || null,
          priorityName: issue.fields?.priority?.name || null,
          url: `${this.baseUrl}/browse/${issue.key}`,
          updatedAt: issue.fields?.updated,
          state: {
            id: issue.fields?.status?.id,
            name: issue.fields?.status?.name || "Unknown",
            type: statusType(issue.fields?.status),
            color: "#6554c0"
          },
          team: {
            id: issue.fields?.project?.id,
            key: issue.fields?.project?.key,
            name: issue.fields?.project?.name || "Jira"
          },
          assignee: issue.fields?.assignee ? {
            id: issue.fields.assignee.accountId,
            name: issue.fields.assignee.displayName,
            email: issue.fields.assignee.emailAddress
          } : null,
          labels: (issue.fields?.labels || []).map((name) => ({ id: name, name }))
        }))
    };
  }

  async comment(ticket, body) {
    const result = await this.request(`/rest/api/3/issue/${encodeURIComponent(ticket.identifier)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adfDocument(body) })
    });
    return { id: result.id, body: adfText(result.body), createdAt: result.created };
  }

  async comments(ticket) {
    const result = await this.request(`/rest/api/3/issue/${encodeURIComponent(ticket.identifier)}/comment?maxResults=100&orderBy=created`);
    return (result.comments || []).map((comment) => ({ id: comment.id, body: adfText(comment.body), createdAt: comment.created }));
  }

  async transition(ticket, target) {
    const result = await this.request(`/rest/api/3/issue/${encodeURIComponent(ticket.identifier)}/transitions`);
    const category = target === "done" ? "done" : target === "in_progress" ? "indeterminate" : "new";
    const transition = (result.transitions || []).find((candidate) => candidate.to?.statusCategory?.key === category);
    if (!transition) throw new Error(`Jira workflow has no ${target} transition`);
    await this.request(`/rest/api/3/issue/${encodeURIComponent(ticket.identifier)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } })
    });
    return transition.to;
  }
}

export const jiraDescriptionText = adfText;
export const jiraUnresolvedBlockers = unresolvedBlockers;
