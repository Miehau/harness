# Agent Plan UI reference

This is a source-linked inventory of the existing application, not a new visual specification. Read this overview, then inspect only the sources relevant to the change. Observed at base revision `1002e33`; verify changed selectors and components before relying on them.

## Authoritative sources

- [Styles and tokens](../public/styles.css): start at the later `:root` token block (`--canvas`, `--surface`, `--stroke`, `--text`, `--accent`) and inspect the final matching selector/media-query overrides.
- [Dashboard rendering and actions](../public/app.js): ticket queue, stage workspace, inspector, dialogs and action handlers.
- [UI state projection](../public/ui-model.js): labels, actionable states and derived UI behavior.
- [HTML shell and dialogs](../public/index.html): document structure, native controls and dialog markup.
- [Supported UI journeys](features/ui-journeys.md), [scenario definitions](ui-scenarios.json), and [UI CLI](ui.mjs): interaction and proof entry points.
- [Dashboard tests](../test/dashboard.test.js) and [UI model tests](../test/ui-model.test.js): representative behavior checks.

## Observed conventions

- Dark workspace with raised panels, subtle borders and violet accent tokens (`--accent`, `--accent-strong`). Reuse tokens rather than copying legacy literal colors.
- System/sans typography for content and controls; compact monospace labels for identifiers and operational metadata. Uppercase eyebrow labels are presentation styles, not stable text assertions.
- Ticket queue and stage-first work surface, with inspector detail and disclosures. The workflow map is persistent navigation; detailed output belongs behind relevant inspection controls.
- Reuse `.button`, `.icon-button`, `.file-button`, `.mini-button` and their existing primary/success/danger/disabled states. Reuse native inputs and dialogs with the existing focus styling and dismissal handlers.
- Existing state displays distinguish running, waiting, failure and completed outcomes. Use the UI model to determine labels/actions rather than deriving new status interpretations in a component.
- Keep action labels short and concrete. Put operational diagnostics and long output in the inspector/disclosures; do not repeat them in every card or primary action area.
- Check keyboard access, focus, accessible names, disabled states and existing dialog behavior in the actual changed flow. Existing markup is a starting point, not proof of accessibility compliance.

## Known inconsistencies

The stylesheet has several generations of overrides, literal colors and responsive rules. The first selector definition may not describe the rendered result. Inspect the cascade and representative screen before changing a pattern. This reference does not authorize a stylesheet rewrite, token migration or new component framework.

## Maintenance decisions

For UI changes, record a brief plan: reused pattern/source, information hierarchy, necessary states, interaction/accessibility, proof journeys and justified deviations. Update this reference only when conventions or their authoritative locations intentionally change. Keep detailed examples in their source files. Backend-only changes do not require rediscovering the UI.
