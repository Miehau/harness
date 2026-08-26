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

  get provider() { return "linear"; }
  get configured() { return Boolean(this.apiKey); }

  async graphql(query, variables = {}) {
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
      throw new Error(payload.errors?.map((item) => item.message).join("; ") || `Linear returned ${response.status}`);
    }
    return payload.data;
  }

  async tickets() {
    if (!this.apiKey) return { configured: false, viewer: null, tickets: [] };
    const data = await this.graphql(query);
    return {
      configured: true,
      viewer: data.viewer,
      tickets: data.issues.nodes
        .filter((ticket) => !(ticket.inverseRelations?.nodes || []).some((relation) =>
          relation.type === "blocks" && !["completed", "canceled"].includes(relation.issue?.state?.type)
        ))
        .map((ticket) => ({ ...ticket, provider: "linear", labels: ticket.labels?.nodes || [] }))
    };
  }

  async comment(ticket, body) {
    const data = await this.graphql(
      `mutation AgentPlanComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body createdAt } } }`,
      { issueId: ticket.nativeId || ticket.id, body }
    );
    if (!data.commentCreate?.success) throw new Error("Linear did not create the comment");
    return data.commentCreate.comment;
  }

  async comments(ticket) {
    const data = await this.graphql(
      `query AgentPlanComments($issueId: String!) { issue(id: $issueId) { comments(first: 100) { nodes { id body createdAt } } } }`,
      { issueId: ticket.nativeId || ticket.id }
    );
    return data.issue?.comments?.nodes || [];
  }

  async transition(ticket, target) {
    const data = await this.graphql(
      `query AgentPlanStates($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }`,
      { teamId: ticket.team?.id }
    );
    const type = target === "done" ? "completed" : target === "in_progress" ? "started" : "unstarted";
    const state = data.workflowStates?.nodes?.find((candidate) => candidate.type === type);
    if (!state) throw new Error(`Linear workflow has no ${type} state`);
    const updated = await this.graphql(
      `mutation AgentPlanTransition($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }`,
      { issueId: ticket.nativeId || ticket.id, stateId: state.id }
    );
    if (!updated.issueUpdate?.success) throw new Error("Linear did not update the issue state");
    return state;
  }
}
