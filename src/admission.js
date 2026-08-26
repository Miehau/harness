const terminalStatuses = new Set(["completed", "failed", "needs_attention", "cancelled", "interrupted"]);

export function ticketReady(ticket) {
  if (ticket?.state?.type !== "unstarted") return false;
  return !/(backlog|triage|icebox|draft|blocked)/i.test(ticket.state?.name || "");
}

export function occupiedTicketIds(state) {
  return new Set(Object.values(state?.ticketRuns || {})
    .filter((run) => !terminalStatuses.has(run.status))
    .map((run) => run.id));
}

export function admissionCandidates(tickets, state, capacity) {
  const occupied = occupiedTicketIds(state);
  const available = Math.max(0, capacity - occupied.size);
  return tickets
    .filter((ticket) => ticketReady(ticket) && !state?.ticketRuns?.[ticket.id])
    .map((ticket, index) => ({ ticket, index }))
    .sort((left, right) => {
      const a = Number(left.ticket.priority) > 0 ? Number(left.ticket.priority) : Number.POSITIVE_INFINITY;
      const b = Number(right.ticket.priority) > 0 ? Number(right.ticket.priority) : Number.POSITIVE_INFINITY;
      return a - b || left.index - right.index;
    })
    .slice(0, available)
    .map(({ ticket }) => ticket);
}
