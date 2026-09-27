# Live how/why smoke results

Six direct leaf runs used OMP 18.3.2 and the actual `codex/agent-plan` package via `--plugin-dir` and `/skill:how` or `/skill:why`. At most two simultaneous calls. Disposable two-commit cache fixture and runnable check; all six exited 0 with a clean Git status. No agent dispatch or external connectors were enabled. One sample per combination is a smoke check, not comparative quality or latency benchmarking.

| Model/provider | How seconds | Why seconds | Result |
|---|---:|---:|---|
| grok-4.7 / xai-oauth | 63.252 | 176.538 | Accurate requested mechanics; detailed confidence/source coverage |
| gpt-5.6-terra / openai-codex | 63.929 | 66.792 | Accurate mechanics and confidence/source coverage; ran fixture check |
| gpt-6-luna / openai-codex | 33.602 | 48.093 | Accurate compact mechanics and calibrated rationale; minor citation/tier issues |

All how outputs traced strict expiry (`age < 30000`; equality expires), successful completion timestamps, same-key coalescing, pending cleanup on success/failure, retry after rejection, and separate per-factory closure maps. All why outputs cited the rate-limit/coalescing and retry rationale, kept the exact TTL rationale unknown, challenged the embedded performance assumption, and listed all six missing external evidence categories. No model edited fixture files.

Grok gave most detail and explicit warnings about unbounded cache growth, backward clocks and same-reference object keys. Terra was similarly accurate, and ran `node cache.test.mjs` successfully. Luna was concise; its how citation spans `cache.test.mjs:1–12`, although the file has 11 lines. Luna why labels already documented retry intent as Inferred and mechanism/test statements as Inferred, a conservative but imprecise use of the epistemic tiers. No output invents a TTL motive.

The how descriptions sometimes say callers return “the same promise”. Shared underlying work/results is correct, but the outer async `lookup` adopts the pending promise: callers need not receive identical Promise objects. The fixture checks invocation count and results, not promise identity. This is a minor explanation precision issue, not a failed coalescing trace.

Actual skill and reference activation is visible in each `.tools.json`. All six read `skill://how` or `skill://why`; all how runs read the explainer template, and all why runs read epistemics plus synthesizer templates. Binding resolution is a real usability gap: every how run and Grok/Luna why tried `skill://NAME/../../runner.md`; OMP normalized this to `skills/NAME/runner.md` and returned File not found. Terra why did not attempt the binding. Filesystem-relative package links are valid, but parent traversal in `skill://` is not. Supply an absolute package-root binding path or instruct filesystem resolution for parent links; don't append `..` to a skill URI. No canonical skill files were modified.

Initial wrong-package and stdin-open startup attempts are excluded (see setup-correction.md). The harness now sends stdin EOF, uses fresh temp fixtures, checks fixture-test status, preserves configured approvals, bounds runtime, and stores raw events privately in `/private/tmp` rather than repository artifacts.

A separate gpt-6-sol/openai-codex session synthesized the six clean answers plus tool-call evidence in 47.517 seconds, exit 0, fixture clean. Its final is `sol-synthesis.answer.md`. It independently retained TTL uncertainty, distinguished path-read failure from failed skill activation, noted async promise-identity nuance, and cautioned that absence of PR markers does not prove no PR exists. This is external orchestration of independent leaf sessions with stronger synthesis, not model-controlled agent dispatch.

Raw JSON events and stderr for this execution are retained privately at `/private/tmp/agent-plan-skill-smoke-events-7718ppfl`; repository evidence contains assistant final text, tool name/arguments, prompts, timing/model metadata and no private reasoning blocks or opaque reasoning signatures. Fixture path/history are recorded in ground-truth.md. Harness syntax check and fixture assertions passed.
