# Selected skills

Owner configuration selects repository SKILL.md paths in `.runner/project.json`.
`runner/skills.js` validates regular committed files and reads the task base tree.
`runner/runtime.js` publishes immutable snapshots and a source-path manifest for
both coordinator and worker assignments. `runner/pi-extension.js` explains loading
through scoped runner tools. Supporting files remain in each worktree; executable
skills require owner-configured commands. Global native discovery stays disabled.

Evidence: the selected-skills case in `test/runner.test.js` verifies committed
content despite local edits, both assignment paths, and invalid selections.
