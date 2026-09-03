# Final review fixes — round 7

- Repository checks now use the controlled spawn runner, settle at command exit or timeout rather than pipe closure, and request their shared containment on timeout or abort.
- Managed project commands no longer signal a `ChildProcess` PID directly; timeout and abort cleanup is delegated to the supplied execution containment coordinator.
- Follow-up containment snapshots are deduplicated by immutable process identity before scheduling another cleanup cycle.

Regression coverage adds pipe-holding repository-check and project-command fixtures plus a descendant present in both follow-up snapshots.

Focused checks were not run in this worker: the only declared project command is the canonical `verify` command, which the step instructions reserve for the framework. Attempts to use the required helper command names `nav`, `test-map`, and `seed-list` were rejected because they are not declared in `.agent-plan/project.json` (`Unknown project command “<name>”; add it to .agent-plan/project.json`).
