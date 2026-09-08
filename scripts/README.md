# Helper scripts

Run these instead of guessing. They read the current source and daemon store.

```bash
node .agent-plan/verify.mjs         # repository tests, syntax, real browser CLI/recording test
node scripts/test.mjs              # repository test/ suite
node scripts/test.mjs plan server  # files whose names match
node scripts/test.mjs --list
node scripts/test.mjs --map        # src file → matching test
node scripts/test.mjs --check      # node --check on src, public, scripts
node scripts/test.mjs --watch
node scripts/test.mjs -- --test-name-pattern "health"

node scripts/nav.mjs               # API, UI, CLI, modules from source
node scripts/nav.mjs --json
node scripts/nav.mjs routes

node scripts/seed.mjs --list
node scripts/seed.mjs              # clarifying ticket in a temp data dir
node scripts/seed.mjs plan-approval --json
node scripts/seed.mjs review-ready --data-dir /tmp/ap-data --cwd /tmp/ap-cwd
# then: AGENT_PLAN_DATA_DIR=/tmp/ap-data npm start -- --cwd /tmp/ap-cwd

node .agent-plan/ui.mjs --help      # browser commands and criterion-specific journeys
node scripts/capture-evidence.mjs  # diagnostic Chromium screenshots into docs/evidence
```

Tests import `test/helpers.js` (`withDaemon`, `invoke`, `seedRun`, `runAgainstDaemon`). Seed writes `state-v3.json` through `JsonStore`, so restart/recovery behavior matches production.

Drive a running daemon with the same actions as the dashboard:

```bash
node src/cli.js new text "Add an empty-state heading"
node src/cli.js list backlog
node src/cli.js select <ticketId>
node src/cli.js approve          # run manually
node src/cli.js list timeline
node src/cli.js queue clear
```

The UI CLI/recording test uses an isolated mocked daemon, Chromium, ffmpeg and ffprobe. It does not call a live Pi model. Feature discovery starts at [.agent-plan/feature-map.md](../.agent-plan/feature-map.md).
