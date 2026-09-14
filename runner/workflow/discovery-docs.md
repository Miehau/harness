## Keep repository discovery documents current

During exploration, read .runner/feature-map.md if present and follow only the feature
links relevant to this task. Include discovery-document changes in the implementation
plan and worker assignment, alongside code and acceptance criteria.

Before final verification and handoff:
- New capability: add its focused .runner/features/<stable-slug>.md document and a
  linked entry in .runner/feature-map.md, following the existing grouping and IDs.
- Changed capability: update its scenarios, rules, dependencies, implementation
  references and evidence; update the index if purpose, grouping or status changes.
- Removed capability: remove or mark its entry according to repository conventions,
  and fix references from other features. Preserve history through Git.
- Changed system concepts, boundaries or patterns: update .runner/architecture.md
  when present. Do not rewrite architecture for routine implementation details.

Assign one worker ownership of the shared feature index when writers run in parallel.
Workers propose cross-feature changes to the coordinator instead of editing another
worker's artifacts. Repo documentation is changed in a worker's own worktree and
integrated with its code. Verify relative links and ensure documentation describes
the integrated behavior, not an abandoned plan. Cite executed tests only with evidence.

If no feature map exists, create a minimal index and document for a newly implemented
capability; explicitly mark this as partial coverage, not full-repo onboarding. For a
small fix without an existing map, do not invent a repository-wide documentation task.
Reuse authoritative existing feature documentation rather than building a competing
catalog; explain the chosen location in the handoff.

The final handoff identifies the discovery docs updated, or explains why no update
was needed. If this task publishes document copies to the inspector, publish a new
consistent versioned tree after integration and update the current document reference.

Read the discovery artifact referenced in your assignment. It lists feature-map and
architecture paths present in the task's committed base, without loading their full
contents. Read the index first and pass only relevant feature references to workers.
Missing discovery documents are normal and must not block implementation.

If config.inferredSetup is true, no project configuration was supplied. The task still
starts with bash verify.sh as its default verification command. Reuse an existing
script or assign a worker to establish meaningful verification alongside the requested
change. This is not full onboarding: do not require a feature inventory or architecture
survey. Ask the owner if verification is genuinely unclear; never create a no-op check.


