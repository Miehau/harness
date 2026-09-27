# Project configuration examples

Copy a selected `project.json` to your repository's `.agent-plan/project.json` and
adjust its checks and hosting to your project. Existing `.runner/project.json`
remains a fallback when the canonical file is absent.

`home-omp` runs the automatic OMP/Herdr workflow. Select a Codex or Grok model
through OMP's available model menu, then save its actual model/provider identifiers
in an agent choice or `.agent-plan/local.json`; its runtime remains `omp`.
No example guesses a model ID. Credentials belong in the runtime's credential
store, never in either configuration file.

`work-claude` represents a native Claude workflow with GitLab hosting.
The hosting fields represent project intent;
the native binding does not provide the runner's automatic hosted delivery.

To record a desired secondary Codex reviewer, an owner can override the role:

```json
{ "agents": { "review": { "runtime": "codex" } } }
```

This mixed-runtime choice is representable but execution validation rejects it:
automatic mixed-runtime delegation is not implemented. Coordinate that review
manually outside automatic execution until an adapter exists.

Private `.agent-plan/local.json` overrides only execution and model/agent settings.
Ignore that file in Git. It cannot change hosting, commands, or verification.
Native Grok and Cursor choices can be recorded, but remain planned and unverified
and cannot execute automatically.
