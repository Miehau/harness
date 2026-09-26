# OMP migration acceptance record

Local implementation and independent review checks passed. External acceptance is pending; no live
GitHub/GitLab publication or merge, GrokBot reply, or model-driven canary is claimed.

| Journey / criterion | Evidence | Result |
| --- | --- | --- |
| Pinned OMP runtime and real extension loading | OMP 18.3.2; `test/omp.test.js`, `test/portable-skills.test.js` | Local checks pass |
| Herdr creates an OMP session | No-model probe: connected=true, modelCalls=0 | Live transport pass |
| Skills, discussion, durable brief, explicit handoff | `test/supervisor.test.js`, existing runtime tests | Mocked checks pass |
| Saved GitHub/GitLab configuration and destination snapshots | `test/hosting.test.js`, `test/hosted-runtime.test.js` | Mocked/local Git checks pass |
| Parallel required and risk-selected reviewer roles | `test/parallel-review.test.js` | Mocked checks pass |
| Publication, revisions, evidence, uncertain outcomes | `test/hosted-delivery.test.js`, `test/hosted-runtime.test.js` | Local checks pass |
| Contextual webhook, evidence attachments and exact task replies | `test/hosted-notifications.test.js`, existing webhook tests | Mocked checks pass; live receiver pending |
| Retained worktree and preview lifecycle | `test/preview.test.js` | Local process checks pass |
| Exact-revision human approval, CI gates, merge recovery | Hosted delivery/runtime tests | Mocked checks pass; live provider merge pending |
| Full repository verification | `npm test`: 128/128; `npm run check` and `git diff --check` passed | Pass |
| Actual model-driven implementation | `npm run canary` (opt-in model calls) | Running with explicit owner approval |
| Live GitHub and GitLab upload/read-back/merge | Needs authorized disposable project per provider | Pending |
| Actual GrokBot screenshot rendering and reply | Needs authorized receiver | Pending |

## Setup and rollback

Run `./install.sh`, configure OMP credentials and start Herdr. Use `agent-plan onboard`
and review `.runner/project.json`, including hosting, checks and preview. The detailed
migration guide is `runner/docs/hosted-delivery.md`.

The approved execution model is trusted local. Git worktrees isolate changes, not
process access or credentials. Existing unmarked Pi transcripts are retained and
rejected; finish those tasks using the old checkout or start a new OMP task from an
explicit recovery brief. Preserve old checkout/dependency lockfile and runner data
before switching. Never run two daemons against the same data directory.

No remote migration branch has been pushed and no PR/MR has been created by these tests.
