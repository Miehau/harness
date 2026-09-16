# Independent candidate review

New tasks set reviewRequired. Review is a read-only worker stage on the integrated
candidate; its inbox includes the base/current commits, diff artifact, rubric, earlier
reviews and verification. JSON findings are validated and recorded against the worker's
base commit. Completion requires fresh verification and a clean review of that exact
commit; major/medium findings require repair and re-review. Legacy tasks are unchanged.

Model selection prefers the opposite OpenAI/Claude family from the latest integrated
writer and avoids all writer models where possible. Explicit reviewer configuration is
supported. Recorded failed reviewers are excluded for the same commit; unavailable
models/provider errors permit fallback, never skipping review. Standard attempt budgets
bound the loop. Workers register their actual Pi model so inherited defaults are known.

Implementation: runner/models.js, runner/runtime.js, runner/herdr.js,
runner/pi-extension.js and runner/workflow/review.md. Tests exercise blocking findings,
read-only enforcement, stale commits, repeated repairs, minor-only completion and model
fallback/exhaustion. Model judgment remains fallible; the gate enforces reported results.
