export function ticketReady(ticket) {
  if (ticket?.state?.type !== "unstarted") return false;
  return !/(backlog|triage|icebox|draft|blocked)/i.test(ticket.state?.name || "");
}

export function admissionCandidates(tickets, state) {
  return tickets
    .filter((ticket) => ticketReady(ticket) && !state?.ticketRuns?.[ticket.id])
    .map((ticket, index) => ({ ticket, index }))
    .sort((left, right) => {
      const a = Number(left.ticket.priority) > 0 ? Number(left.ticket.priority) : Number.POSITIVE_INFINITY;
      const b = Number(right.ticket.priority) > 0 ? Number(right.ticket.priority) : Number.POSITIVE_INFINITY;
      return a - b || left.index - right.index;
    })
    .map(({ ticket }) => ticket);
}
