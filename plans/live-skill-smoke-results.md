# Live skill smoke results — 27 September 2026

These tests used OMP 18.3.2 and configured Codex/Grok logins against disposable local repositories. Claude was not tested. One sample per model/skill is useful smoke evidence, not a benchmark or a guarantee for larger repositories.

## How and why: accurate answers, binding qualification

| Model | How | Why | Observed quality |
| --- | ---: | ---: | --- |
| Grok 4.7 | 63s | 177s | Accurate, detailed; rationale kept separate from inference |
| Codex Terra 5.6 | 64s | 67s | Accurate, detailed; also ran the fixture checks |
| Codex Luna 6 | 34s | 48s | Accurate and concise; minor citation/confidence-label imprecision |
| Codex Sol 6 | — | 48s synthesis | Combined all six answers and preserved uncertainty |

The fixture tests concurrent same-key requests, strict expiry at 30,000 ms, failed-load retry, per-instance state and successful-load timestamps. Git history explains rate-limit protection and retry behavior but deliberately does not explain the TTL. All six answers preserved that unknown and rejected the supplied unsupported “all for performance” assumption. All fixtures stayed clean.

The actual skill and reference templates were read. However, five runs tried a parent-relative `skill://.../../../runner.md` binding link, which OMP normalized incorrectly; the binding read failed. Terra why did not try the binding. Thus answer quality and direct activation passed, but full execution-binding compliance is not established. This is a package usability defect requiring filesystem/absolute binding resolution or a resource reachable within the skill URI. No canonical skills were changed during these tests.

These six cases use the simple/direct leaf path, without agent dispatch or external connectors. Sol's synthesis is a separate model session launched by the harness. Initial harness mistakes (package selection and unclosed stdin) were corrected and excluded from model results.

See [detailed explanation results](skill-smoke/results.md), [Sol synthesis](skill-smoke/sol-synthesis.answer.md), and the per-model answers/tool traces in that directory.

## Architecture: real mixed-model dispatch, incomplete within budget

The real runner used Sol as coordinator, Luna for how/why grounding, and three independent proposal contexts on Grok, Terra and Sol. All candidates received the same brief, rubric and committed base in separate worktrees. The task was preparation only: design durable local queue delivery, preserve or explicitly migrate the synchronous API, and do not promise exactly-once external effects.

Verified observations:

- Luna returned grounded code/history analysis with correct failure-loss behavior and unknown-ID rationale.
- Terra and Sol completed proposals on their first attempts.
- Grok's first attempt failed with OMP's repeated-thinking-loop detection. Sol automatically dispatched a replacement Grok worker with the same assignment; it eventually completed.
- All three completed proposals used separate worktrees at the same base and the same assignment. No writing worker ran, and all worktrees stayed clean.
- A separate Grok cross-judge launched only after the three proposals finished.
- The overall 20-minute limit expired during judging. The test cancelled the task and retained its artifacts. The judge did not finish; the coordinator did not return final synthesis or the expected owner design question. Therefore the **full architect/arena workflow did not pass this bounded test**.

See [structural results and model/agent evidence](architecture-smoke/result.json). Proposal files are retained under `architecture-smoke/artifacts/workers/`; failure evidence is retained too. This result is a timing/reliability limitation, not evidence that the runner falsely approved a design or modified the repository.

## Two independent proposals → separate Sol synthesis

A separate diagnostic passed Terra and Sol's completed original proposals, the common rubric, and grounding to a fresh Sol session. It completed in **44 seconds**, compared all five criteria and kept its recommendation distinct from an owner decision. This demonstrates the requested two-proposal synthesis capability; it is not a substitute pass for the three-candidate architect/arena workflow.

The synthesis found a genuine contradiction in Terra's design: ready order is ascending job ID, but redrive claims to move the same ID to the tail without an additional ordering mechanism. It also identified queue identity/idempotency and producer-acknowledgement concerns. Stronger synthesis was useful, but not infallible: it overstated Terra's crash-before-callback dead-letter risk. Terra only moves a job to dead letters after callback rejection; crashes consume attempt budget but alone do not trigger that transition. Keep this correction alongside the model's original answer.

See [two-proposal synthesis](architecture-smoke/two-proposal-synthesis.answer.md) and its metadata/tool evidence.

## Practical interpretation

Luna is a promising default for bounded how/why grounding; Terra is a useful proposal worker; Sol successfully dispatched independent workers and synthesized completed material. In this run Grok supplied good explanations and eventually a substantial proposal, but its architecture retry dominated the latency. Treat it as an optional alternative until retry/time budgets are better characterized. Do not infer a general quality ranking from one fixture.

Before declaring the complete skill workflow ready, fix the OMP execution-binding resource path and rerun a full architecture round through completed judging, synthesis and the owner-decision boundary. Neither native Codex/Claude lifecycle, external evidence search, implementation, hosted PR/MR delivery nor merge was exercised here.

## Timing and recovery correction after transcript inspection

The earlier statement that recovery behaved as expected was too generous. The initial
Grok candidate was marked failed at 23:47:05 UTC, but its OMP session continued model
and tool activity until 23:55:36. The replacement started at 23:47:18. Their executions
overlapped. The old session's runner writes/reports were rejected as `Inactive attempt`,
after which it used native file writes to save proposal artifacts. No product repo
changes were found, but a failed status did not mean execution had stopped. Replacement
must wait for confirmed termination, or allow the provider's own retry to finish while
retaining one authoritative attempt. Do not apply both independently.

| Stage | Measured time | Observation |
| --- | --- | --- |
| Luna grounding | 1m48s | Completed |
| Sol proposal | 2m56s | Completed |
| Terra proposal | 4m24s | Completed |
| Grok first attempt | 3m33s until marked failed | Continued another ~8m31s in the background |
| Grok replacement | 10m19s | Completed; ~617.5 of 618.9 seconds were recorded model-response duration |
| Grok judge | ~1m16s available before cancellation | Started late; did not independently exhaust a full judge budget |
| Separate Sol two-proposal synthesis | 44s | Completed |

Proposal workers overlapped, so these times must not be added. About four minutes
elapsed from task creation to proposal dispatch, including grounding. The coordinator
also ran `sleep 30` and `sleep 60` while waiting; these overlap discovery and are not
90 additional seconds on the critical path. It should rely on event-driven wakeups.
Recorded Grok replacement usage includes ~30k reasoning tokens; this supports substantial
model-side deliberation/generation, not an inference that filesystem work was slow.
It does not establish that a prose-length cap would solve the problem.

Upstream inspiration: [architect](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/SKILL.md)
asks for caller-first usage, types/signatures and rationale, and at least two structurally
distinct candidates; [arena](https://github.com/cursor/plugins/blob/main/pstack/skills/arena/SKILL.md)
permits recording a dropout and continuing with remaining candidates. Our mandatory
three-successful-proposal rule unnecessarily put the retry on the critical path.
Adopt purposeful artifacts and explicit dropout/stop semantics rather than truncation.
Retain this project's owner architecture checkpoint, despite upstream's opt-in checkpoint.

## Agreed correction and implementation

The final owner decision supersedes the dropout suggestion above: keep every requested
proposal accounted for and do not steer independent authors. Freeze a common brief,
grounding and rubric, then exchange full proposals, critique, synthesis and decisions
by file reference. There is no prose-length cap. A missing proposal remains an explicit
coverage gap; execution failure is not evidence that the architecture is impossible.
The owner decides how to proceed with an incomplete round and approves implementation.

OMP execution bindings are now packaged inside each skill's reference directory so
its `skill://` reader can load them. Provider continuations stay in the same attempt;
terminal failure and replacement require confirmed termination. Regression validation
is recorded in the unified-workflow tracker. These fixes do not retroactively turn
the timed-out live architecture run into a pass; a full live rerun remains outstanding.
