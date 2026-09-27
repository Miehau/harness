# Repository onboarding

Explore this repository's actual code, documentation, build/test instructions and CI.
Produce a reviewable onboarding candidate in the task's integration worktree. Do not
manually merge, push or deploy it; the runtime publishes verified, independently reviewed
candidates when hosting is configured. Preserve existing documentation and unrelated source code.
Select preparation stages according to workflow/stages.md; delegate substantial
repository exploration, but skip separate design/planning workers when unnecessary.
Record coordinator clarification before one implementation worker applies the files.

## Git hosting

Read the task's snapshotted hosting configuration. Configure `.agent-plan/project.json`
with the owner-selected provider, hostname, project path, Git remote and target branch:

```json
{
  "hosting": {
    "provider": "github",
    "host": "github.com",
    "project": "owner/repository",
    "remote": "origin",
    "target": "main"
  }
}
```

Use `gitlab` for GitLab.com or a self-managed instance; nested GitLab namespaces are
supported. A hostname has no URL scheme. Inspect the actual Git push URL and remote
HEAD; do not guess the provider of a self-hosted domain. Ask the owner when provider,
project or target is unclear. Keep credentials in the authenticated `gh` or `glab`
CLI, never in committed configuration. Check that the selected push remote resolves
to the same host and project, and document any required CLI prerequisites.

The owner can edit this file or use `agent-plan hosting REPO` with
`--hosting-provider`, `--hosting-host`, `--hosting-project`, `--hosting-remote` and
`--hosting-target`. Onboarding accepts these flags too. Changes apply to future
tasks; each running task keeps its configuration snapshot.

After final verification and a clean independent review of the exact candidate, the
runtime pushes the task branch and creates or updates its PR/MR. Publication is not
merge approval. The owner must explicitly approve the exact published head with
`agent-plan accept TASK COMMIT`; changed heads require fresh approval. Provider
merge requirements and required CI must pass. Pending or uncertain publication,
upload or merge outcomes require reconciliation before repeating side effects.

Screenshots and other candidate evidence belong in the PR/MR body with durable
links. Both providers use the runtime's dedicated evidence branch and commit-pinned
repository links. GitLab image uploads can be public by URL even in private projects,
so the runner does not use that upload API. Do not invent upload URLs, make a public gist, or claim an
unperformed browser check. Record authentication requirements and evidence gaps.

## Verification

Create a reliable verify.sh that runs meaningful existing tests and exits nonzero
when checks fail. Do not fake success, suppress failures, or install global tools.
Document prerequisites, commands and coverage gaps. If meaningful verification
cannot be established, ask the owner. Merge the verification command into the existing
.agent-plan/project.json; preserve curated commands, setup, verify, hosting, skills and
UI evidence settings. Use bash verify.sh when no adequate verification command exists.
Keep .omp/, .pi/, .runner/answers/, and .runner-ui-*/ in .gitignore so
agent-local files stay untracked. Run every configured verification command, including onboard_verify.

For an application with a local HTTP preview, save a named long-running command in
`commands` and `preview: {"command": "preview", "url": "http://127.0.0.1:PORT"}`
using its actual launch command and port. Preserve an existing working preview.
Run it in the candidate worktree, inspect readiness at the saved URL, and stop only
the process you started. Document prerequisites and port conflicts. For projects
without an HTTP preview, omit this setting and explain how to inspect the result.

### Project verification skill for interactive systems

When the repository has a user-driven runtime surface that `verify.sh` cannot exercise
meaningfully (web, desktop, mobile, CLI/TUI or a stateful service), create or improve
one committed `.agents/skills/verify-<app>/SKILL.md`. Do not generate one for a library
or batch project whose real public behavior is already covered by the configured
commands. Prefer the repository's existing harness; do not add a framework merely to
match this structure.

The skill is cold-start instructions for later workers and must contain exact,
repository-grounded sections:

- **Launch:** start an isolated instance and identify readiness and teardown.
- **Doctor:** a read-only health check proving the instance is safe to drive.
- **Drive:** stable user-facing commands, selectors or requests; avoid coordinates.
- **Evidence:** capture the action and observable result, including persisted effects.
- **Cleanup:** stop only what the run started while preserving proof artifacts.

Put feature-specific recipes beside the skill, indexed by stable feature IDs from
`.runner/feature-map.md`. Each recipe names how a user reaches the feature, how the
harness drives it and what observable state proves it works. Expose helper scripts as
named commands in `.agent-plan/project.json`, add the skill path to `skills`, and configure
`uiEvidence` when the project can provide its required integrated-candidate manifest.
Run launch, doctor, one representative drive, evidence capture and cleanup before
handing the generated skill over. A skill that has not executed successfully is a
draft and must not be selected in project configuration.

If a verification skill already exists, maintain it instead of generating another.
Run one read-only source pass per mapped feature, reconcile concrete drift, then drive
every reachable feature live through one coordinated session. Edit only the skill,
its recipes and its owned harness. Report broken product behavior instead of changing
the verification docs to match it. End with one explicit outcome: `clean`, `changed`
with one proven candidate, or `blocked` with the missing prerequisite. Keep this audit
proportionate: a small non-interactive repository does not need a feature-driving layer.

## Experimental feature map

Create .runner/feature-map.md as a concise navigation aid for humans and later agents.
Mark it "Experimental — inferred from the inspected repository" and record the
inspected base commit and scope. Start with user-visible capabilities; for libraries
or infrastructure, use public APIs and operational capabilities. Do not merely list
folders or infer that a feature works because a filename exists.

Use this structure for progressive discovery:

.runner/
  feature-map.md
  features/
    <stable-feature-slug>.md
  architecture.md

feature-map.md is the entry point, not a combined feature specification. Organize
capabilities into a shallow tree. Each entry has a stable identifier, a one-sentence
purpose, discovery status and a relative link to its feature document. Keep detailed
behavior, code references and evidence in features/, not duplicated in the index.
Group by capability, not source folder; split only when a feature can be understood
or worked on independently. Cross-cutting concerns belong in architecture, with links
from affected features. Do not create empty documents to imply completed exploration:
mark uninspected entries explicitly and link only to files that actually exist.

Each explored feature document contains:
- Purpose, users/actors and key scenarios, including important failure behavior.
- Relevant domain terms, business rules and invariants supported by the code.
- Implementation entry points and a few useful file/symbol references.
- Dependencies on other features (linked), shared concepts and external systems.
- Existing tests, executed evidence, gaps and unresolved questions.

Keep each document focused enough to load independently. Use relative Markdown links
that resolve from the containing file. A future agent should read the index, then only
the feature documents relevant to its task, then follow code links as needed. Avoid
copying every feature document into coordinator or worker prompts.

Separate observed facts, inferences and unknowns. Distinguish tested behavior from
implemented-but-unverified or incomplete behavior. A test counts as executed only
when its result is saved as evidence. Record the inspected base commit and bound the
scope on large repos; explicitly list uninspected areas rather than claiming coverage.
Check that index links and cross-feature links resolve before handing off the map.

## Existing architecture (brownfield only)

Decide from code evidence whether the repo already has a substantive implementation.
For an existing application/library/service, create .runner/architecture.md as a
high-level explanation of how to reason about the system, not a directory inventory.
Cover the following where applicable, using the repo's own terminology:
- Core concepts, responsibilities, vocabulary and relationships.
- Major boundaries, dependency direction and ownership of data/business rules.
- Architectural patterns actually used and their consequences for making changes.
- Important runtime interactions, state transitions and consistency/transaction rules.
- Cross-cutting conventions such as error handling, authorization and integration.
- Constraints and documented tradeoffs; separate documented rationale from inference.

Use DDD concepts where the implementation or established project conventions support
them: bounded contexts, aggregates, invariants, domain services and domain events.
Do not force a DDD taxonomy onto every repository, equate folders with bounded contexts,
or rename generic database objects as aggregates without evidence. If the repo uses
layers, transaction scripts, a functional core, pipelines or mixed patterns, describe
that honestly. The owner's preference for DDD is not proof that existing code uses it.
Record relevant discrepancies between intended architecture and implementation.

Link representative code, existing ADRs and the feature index for deeper discovery.
Include a small concept/boundary diagram when it clarifies relationships. Keep detailed
feature behavior in features/. Do not propose a redesign or invent historical rationale.

For an empty repo or bare scaffold, skip architecture.md and explain why in the handoff.
Keep the feature map minimal: record what actually exists and what remains unknown.

## Existing docs, revisions and handoff

Read existing feature maps and architecture docs first. Reuse and link authoritative
docs; amend existing .runner documents carefully rather than replacing curated content.
If code and docs disagree, record the discrepancy instead of silently picking a story.
Discuss material uncertainty with the owner; cosmetic choices do not need approval.

The implementation worker writes the repo documents and saves copies in its own
artifactDir. The coordinator publishes those artifact references with revise using
names feature-map and repo-architecture, making them discoverable in the inspector.
Copy the feature index and features/ together, preserving their relative layout inside
the worker artifact directory. Publish the index reference rather than concatenating
all feature documents. When revising the map, save a complete versioned document tree
so retained index references continue to resolve to their original feature revisions.
Keep repo-architecture distinct from the architecture of an individual feature task.
After discussion, save a new revision, update the candidate repo document through a
worker, and republish its reference. Retain earlier artifacts and checkpoints.

The final handoff links verify.sh, configuration, feature map, architecture (or reason
for skipping it), evidence, uncovered areas and the candidate branch/commit. These
maps are experimental guides, not proof of correctness or complete system coverage.

Use the existing `.runner/project.json` owner file instead when canonical config is absent
and that legacy file already exists; never create a competing project file. Preserve
execution and agents choices. Never copy private local overrides into project configuration.
