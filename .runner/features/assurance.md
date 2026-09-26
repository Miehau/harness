# Risk assurance

Both workflows classify each task as routine or declare concrete `security`,
`data-safety`, `recovery` or `operator` risks. Routine OMP work requires parallel
requirements/AC and correctness reviews; it skips extra plan-assurance specialists.

For declared risks, a fresh read-only planning specialist challenges the exact plan
and contract before writers start. Its report records invariants, abuse/failure cases,
rollback or recovery, required checks and actionable findings. Changed reviewed
documents invalidate affected plan assurance.

After integration and verification, fresh review specialists trace those invariants
through the exact candidate. Any commit change invalidates every candidate-assurance
pass. OMP requires requirements/AC and correctness reviewers plus risk-selected roles in
parallel; no generic reviewer runs last. Its runtime persists the required roles
and enforces passing coverage of the exact candidate.

OMP expresses preparation policy in `runner/workflow/stages.md` and `review.md` using
existing planning and review worker stages. Native Claude uses its existing researcher and
reviewer agents in `claude/workflows/task.md`; its Stop hook checks that a candidate
report includes the declared assurance evidence. The native Claude policy remains independent.
