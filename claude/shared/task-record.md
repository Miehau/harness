# Portable task record

Each binding keeps task state locally on the user's machine. No cross-machine sync or
shared credential store is required. Native bindings may use versioned Markdown; the
runner uses its existing JSON state and immutable artifacts. Do not invent a second
state database. Preserve these meanings, even when field names and storage differ:

| Record | Required information |
| --- | --- |
| Identity | Task ID, repository identity, original checkout, exact base and target, binding/runtime and config snapshot |
| Brief | Agreed scope, AC, decisions with rationale and human sources, selected/skipped stages, risk roles, implementation authorization |
| Architecture round | Requested seats, frozen brief/grounding/rubric references and base, per-seat proposal or evidence-backed failure, stopped-attempt observation, comparison gaps and owner decision |
| Agents | Role/runtime/model when known, exact session or agent ID, assignment, owned paths/worktree, state and report references |
| Questions | Exact task and decision ID, context/options/recommendation, audience, answer source and affected work |
| Candidate | Full commit, clean/dirty observation, integrated worker commits |
| Verification | Command argv, outcome, log references, candidate and applicable UI proof |
| Reviews | Required roles, independent reviewer IDs, candidate, coverage, findings and evidence references |
| Delivery | Provider/project/request URL and head, evidence links, CI observation, exact human-approved commit and target |
| Recovery | Pending side-effect identity, before-state, observed outcome, retained work, next safe action |

Use phases preparing, implementing, verifying, reviewing, awaiting-approval, blocked,
paused, cancelled and complete; a binding may retain compatible legacy names. One
coordinator writes shared task state. Keep earlier brief/report versions. Save absolute
artifact pointers when workers cannot resolve the same relative path. Native bindings
record where the private task directory lives; it must be excluded from Git publication.

On resume, load the existing record and verify repository, agent/session and worktree
identities against actual state. Missing or ambiguous identity requires inspection.
Do not choose the newest session merely because it is recent. Preserve permissions and
do not infer approval from messages, HTTP receipts, agent exit or terminal status.
