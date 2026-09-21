# Risk assurance

Both workflows classify each task as routine or declare concrete `security`,
`data-safety`, `recovery` or `operator` risks. Routine work retains the existing final
general review without extra agents.

For declared risks, a fresh read-only planning specialist challenges the exact plan
and contract before writers start. Its report records invariants, abuse/failure cases,
rollback or recovery, required checks and actionable findings. Changed reviewed
documents invalidate affected plan assurance.

After integration and verification, fresh review specialists trace those invariants
through the exact candidate. Any commit change invalidates every candidate-assurance
pass. A fresh general review still runs last and covers the whole change; specialist
agreement never replaces evidence or the general gate.

Pi expresses this policy in `runner/workflow/stages.md` and `review.md` using existing
planning and review worker stages. Native Claude uses its existing researcher and
reviewer agents in `claude/workflows/task.md`; its Stop hook checks that a candidate
report includes the declared assurance evidence. No new runtime state or skill is
introduced.
