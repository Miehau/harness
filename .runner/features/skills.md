# Selected skills

The Pi supervisor automatically loads the six pstack-derived skills in
`codex/agent-plan/skills` via the native `--skill` argument. Their package includes
portable reference playbooks, MIT attribution and runner tool/role bindings.
Architecture produces at least three independent proposals at one committed base;
the supervisor and owner agree the design before background implementation.
The runtime snapshots the whole package under task artifacts `pstack/` and passes
`pstack/runner.md` to coordinator and worker assignments. Managed agents load only
relevant pages with artifact reads; discovery of native skills stays disabled there.

Owner configuration selects repository SKILL.md paths in `.runner/project.json`.
`runner/skills.js` validates regular committed files and reads the task base tree.
`runner/runtime.js` publishes immutable snapshots and a source-path manifest for
both coordinator and worker assignments. `runner/pi-extension.js` explains loading
through scoped runner tools. Supporting files remain in each worktree; executable
skills require owner-configured commands. Global native discovery stays disabled.

Evidence: the selected-skills case in `test/runner.test.js` verifies committed
content despite local edits, both assignment paths, and invalid selections.
`test/portable-skills.test.js` uses Pi's actual skill loader and checks local package
links and attribution. The three-proposal runtime test exercises isolated read-only
workers, bundled prompt access, human decision routing and implementation handoff.
