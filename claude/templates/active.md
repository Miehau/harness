# Agent Plan active tickets

Owner supervisor session: <exact native session ID>
Revision: <monotonic revision>
Updated: <timestamp>

This is a discovery index, not a heartbeat, lock or approval. Only the owner
supervisor writes it. Read linked scope/state before acting; saved IDs can be stale.

| Ticket | Repository identity | Supervisor session | Coordinator ID | Phase | Features / files / interfaces | Scope artifact | Base / candidate | Agreements / dependencies | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Pending acceptance

Finished coordinators are archived. Keep unmerged candidates discoverable here;
contact the supervisor rather than the historical coordinator ID.

| Ticket / repository | Candidate commit | Features / scope | Archive entry | PR/MR / CI / evidence / status | Supervisor / next decision |
| --- | --- | --- | --- | --- | --- |

## Activity

Append dated events with ticket/coordinator IDs and artifact references: registered,
coordinator-started, scope-published, clash-found, proposal-sent, acknowledged,
scope-changed, paused, resumed, candidate, accepted, cancelled, unreachable, archived.
Preserve retired events in archive.md before removing them here. An observation is not permission to act.
