# Task playbooks

Read only the playbook matching the task. These are evidence requirements, not extra
documents or mandatory worker stages. Put the selected playbook and any skipped step
with its reason in the clarification artifact. Map its final checks into the handoff.

## Bug fix

1. Reproduce the smallest observable failure before changing production code. Save the
   command, input or user flow and its result. If reproduction is impractical, record
   the concrete blocker and the closest executable check; do not guess at a cause.
2. Trace the failing path and its callers until one root cause explains the symptom.
   Prefer one fix at the shared cause over guards in each caller.
3. When a cheap local regression test exists, prove it fails for the intended reason
   before the fix. Do not manufacture a brittle mock-heavy test when the real command
   or flow is stronger evidence.
4. Apply the smallest root-cause fix. Replay the original reproduction, run the focused
   regression check and then the configured final verification.

## Feature

1. State the user-visible behavior, non-goals and checkable acceptance criteria.
2. Name the core data shape, ownership and existing pattern before assigning code. Use
   architecture only when a boundary or consequential design choice remains unsettled.
3. Resolve observable design forks with the prototype rule in stages.md. Do not ask the
   owner to predict behavior the runner can measure.
4. Implement in small units that each end in an executable check. Exercise the real
   user path or public API and map every changed criterion to final evidence.

## Refactor

1. Record the current behavior with the closest real command, test, fixture or output.
2. Trace affected callers, formats and external contracts before moving ownership.
3. Make the smallest structural change that reaches the target shape. Migrate callers
   and remove the obsolete internal API in the same wave instead of adding a permanent
   compatibility layer.
4. Re-run the baseline and configured verification. Any intended behavior change makes
   this a feature or bug fix and must be named as such.

## Performance

1. Freeze a repeatable workload and record a numeric baseline. A report that something
   feels slow is an intake symptom, not evidence for a fix.
2. Capture a profile, trace or equivalent measurement and derive the hypothesis from
   the measured bottleneck.
3. Make one targeted change, then compare before and after with the same workload and
   environment. Revert changes that do not improve the metric.
4. Run correctness verification as well as the performance measurement. Report the
   baseline, result, variance or limitations and retained evidence.
