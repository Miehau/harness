# Helper scripts

Run these instead of guessing. They read the current source and daemon store.

```bash
node scripts/test.mjs              # all tests
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

node scripts/capture-evidence.mjs  # Chromium screenshots into docs/evidence
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
