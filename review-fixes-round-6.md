# Final review fixes — round 6

- Discovery-only uncertainty retains its PID, reason, and error without an empty `identity` object. Immutable identity metadata is persisted only after both parent PID and start time have been observed.
- The existing unreadable-`/proc` regression assertions now validate this durable record contract.

## Checks

Not run: the harness permits only the `verify` project command, and this task explicitly prohibits running the canonical verification command. The skill-prescribed helper commands are not declared in `.agent-plan/project.json`.
