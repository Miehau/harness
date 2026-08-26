const endpoint = "https://api.linear.app/graphql";

const query = `query AgentPlanTickets {
  viewer { id name }
  issues(
    first: 100
    orderBy: updatedAt
    filter: { state: { type: { in: ["backlog", "unstarted", "started"] } } }
  ) {
    nodes {
      id identifier title description priority url updatedAt branchName
      state { id name type color }
      team { id key name }
      assignee { id name email }
      labels { nodes { id name color } }
      inverseRelations {
        nodes {
          type
          issue { id identifier title state { name type } }
        }
      }
    }
  }
}`;

export class LinearClient {
  constructor({ apiKey = process.env.LINEAR_API_KEY, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.apiKey); }

  async tickets() {
    if (!this.apiKey) return { configured: false, viewer: null, tickets: [] };
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query })
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
      throw new Error(payload.errors?.map((item) => item.message).join("; ") || `Linear returned ${response.status}`);
    }
    return {
      configured: true,
      viewer: payload.data.viewer,
      tickets: payload.data.issues.nodes
        .filter((ticket) => !(ticket.inverseRelations?.nodes || []).some((relation) =>
          relation.type === "blocks" && !["completed", "canceled"].includes(relation.issue?.state?.type)
        ))
        .map((ticket) => ({ ...ticket, labels: ticket.labels?.nodes || [] }))
    };
  }
}
