# Agent Plan

A shared workflow for turning an agreed task into a verified, independently reviewed
candidate and, when configured, a GitHub pull request or GitLab merge request. Choose
the platform binding for each repository; home and work projects keep independent
configuration, credentials, hosting and private task records.

The maintained [workflow contract](workflow/contract.md), [task record](workflow/task-record.md)
and [review policy](workflow/policy.json) define the common rules. Native packages
include copies of these resources so they can be distributed independently.

## Choose a binding

| Binding | What is available | Verification boundary |
| --- | --- | --- |
| OMP/Herdr runner | Automatic worktree orchestration, durable decisions, verification, parallel reviews and hosted delivery | 145 regression tests passed; live configured Grok canary passed |
| Native Codex | Packaged lifecycle skills and existing discussion skills; uses exposed native tools | Package/reference tests; disposable live execution is pending |
| Native Claude Code | Self-contained plugin with supervisor/coordinator/workers and native tool restrictions | Package checks; full hierarchy smoke test remains pending on a compatible CLI |
| Grok models through OMP | Supported model/provider routing within the OMP runtime | Live grok-4.7 / xai-oauth implementation and both independent reviews passed |
| Native Grok or Cursor | Future binding choices, no execution adapter | Planned and unverified |
| Automatic mixed native runtimes | Configurable intent, rejected during execution validation | No adapter implemented |

“Packaged” means instructions are present, not that an end-to-end live workflow has
passed. Native delegation must be exposed and authorized in the active environment.
Unsupported runtime/model/provider choices fail explicitly; they never silently fall
back to another runtime. Self-review cannot replace required independent reviews.

Use [native Codex instructions](codex/agent-plan/native.md) with its `onboard`, `start`,
`status`, `recover` and `accept` skills. The [native Claude guide](claude/README.md)
covers installation, its supported CLI baseline and nested delegation requirements.
These packages do not require Node, Bun, OMP, Herdr or the runner daemon. They use the
platform's normal authentication, Git and the project's own check tools.
Both native packages include `how`, `why`, `arena`, `architect`, `blast-radius` and
`open-pr`. Their binding selects the native tools or OMP runner for the chosen execution.

## Configure each repository

Onboarding reads `.agent-plan/project.json`. Only when it is absent does it use
legacy `.runner/project.json`; the two project files are never merged. Optional
ignored `.agent-plan/local.json` overrides execution and role/model preferences,
not hosting, commands or verification. Tasks snapshot their effective configuration.
Credentials stay in each official runtime or hosting tool's credential store;
configuration contains no secrets or extracted subscription tokens.

```json
{
  "execution": { "mode": "native", "runtime": "codex" },
  "agents": {
    "implementation": { "runtime": "codex" },
    "requirements": { "runtime": "codex" },
    "correctness": { "runtime": "codex" }
  },
  "commands": { "test": ["npm", "test"] },
  "verify": ["test"],
  "hosting": {
    "provider": "github",
    "host": "github.com",
    "project": "owner/project",
    "target": "main"
  }
}
```

A role can additionally select `model` and `provider` supported by its runtime;
omitted model choices inherit. All automatic roles currently use the execution
runtime. Selecting a Grok model in OMP still means `runtime: "omp"`, not `"grok"`.
Use actual identifiers exposed by that runtime, rather than guessed model names.

See [configuration examples](examples/README.md): [home OMP](examples/home-omp/project.json)
and [work Claude](examples/work-claude/project.json). For home GitHub delivery add
that repository's GitHub project; work GitLab settings belong only in the work
repository, including its own host, project and target. Use normal `gh` or `glab`
authentication for the intended account. A native binding records this intent but
does not acquire the runner's automatic hosted-delivery implementation.
Keep private local overrides and task notes out of Git; each native binding documents
its private storage location and recovery procedure.

## Daily workflow

1. Discuss and save the brief, observable acceptance criteria, decisions, risk roles
   and verification commands. Existing implementation authorization carries forward.
2. Use isolated implementation worktrees and serial integration. A small understood
   task takes one worker; discovery, architecture and planning are optional.
3. Verify a frozen candidate, then run independent requirements/AC and correctness
   reviews in parallel, plus relevant security, data-safety, recovery, UI or performance
   specialists. Medium/major findings block delivery. No generic final reviewer is required.
4. Publish when authorized, with evidence for that exact candidate. Merge requires
   owner approval of the exact revision and target plus passing current provider gates.

A changed candidate requires fresh verification, every required review and new
approval. Dirty worktrees and uncertain side effects are retained for recovery.
Native worktrees isolate changes, not OS access; permissions and tool restrictions
come from the actual platform. Native workflow records are instructions and files,
not runner-style process locks or durable receipts.

## Optional OMP/Herdr runner

Requires Node 22.19+, Bun 1.3.14+, Git, running Herdr and configured OMP credentials.
The installer uses the locked OMP version rather than a global installation.

```sh
./install.sh
agent-plan onboard /path/to/repo
agent-plan supervisor
agent-plan start /path/to/repo "Fix the empty-state message"
agent-plan inspect TASK
agent-plan hosted-status TASK
agent-plan accept TASK EXACT_PUBLISHED_COMMIT
```

Use `/skill:how`, `/skill:why`, `/skill:arena`, `/skill:architect`,
`/skill:blast-radius` and `/skill:open-pr` in the supervisor. GrokBot uses the
[existing webhook integration](runner/docs/webhooks.md), not a native Grok adapter.
For local-only delivery configure it explicitly; the runner retains its verified
local acceptance flow. Publication never authorizes merge.

- [Runner guide](runner/README.md): commands and operational boundaries.
- [Hosted delivery](runner/docs/hosted-delivery.md): provider gates, evidence and previews.
- [Supervisor](runner/docs/supervisor.md): discussion and durable handoff.
- [Unified workflow plan](plans/unified-workflow.md): acceptance criteria and current validation.
- [Existing OMP evidence](plans/omp-acceptance.md) and [skill attribution](codex/agent-plan/THIRD_PARTY_NOTICES.md).

The retired visual pipeline remains only in Git history. `runner/` remains the active
runtime application; native packages are independent bindings, not its dependencies.

## Develop and verify

```sh
npm ci
npm test
npm run check
npm run probe   # opt-in Herdr/OMP connection check; no model calls
npm run canary  # opt-in disposable model task; incurs model usage
```

Local tests use disposable repositories and mocked agents. Model, provider and
notification smoke tests are separate evidence; none implies the others passed.
