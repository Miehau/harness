export class TrackerHub {
  constructor(clients = []) {
    this.clients = clients;
  }

  get configured() { return this.clients.some((client) => client.configured); }

  async tickets() {
    const results = await Promise.allSettled(this.clients.map((client) => client.tickets()));
    const sources = results.map((result, index) => {
      const client = this.clients[index];
      if (result.status === "rejected") return { provider: client.provider, configured: client.configured, viewer: null, error: result.reason?.message || String(result.reason) };
      return { provider: client.provider, configured: result.value.configured, viewer: result.value.viewer, error: null };
    });
    const tickets = results.flatMap((result) => result.status === "fulfilled" ? result.value.tickets : []);
    const connected = sources.filter((source) => source.configured && !source.error);
    return {
      configured: this.configured,
      viewer: connected.length ? { name: connected.map((source) => `${source.provider}: ${source.viewer?.name || "connected"}`).join(" · ") } : null,
      sources,
      tickets
    };
  }
}
