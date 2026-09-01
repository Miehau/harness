# Hardening evidence

Real Chromium captures of the dashboard after the in-scope fixes. Regenerate with `node scripts/capture-evidence.mjs`.

| File | Fix | What it shows |
|---|---|---|
| `01-named-status-plan-approval.png` | Named run vocabulary | `awaiting_approval` still paints the plan gate (Run manually / Auto) |
| `01-named-status-needs-attention.png` | Named run vocabulary | `needs_attention` pill and stalled correction banner |
| `02-http-extract-dashboard.png` | HTTP extract (`src/http.js`) | Static UI + `/api/state` still load after the handler move |
| `04-e2e-recovery-interrupted.png` | Daemon e2e / recovery | In-flight `running` recovered as `interrupted` with Resume run |
| `05-codex-rename-profiles.png` | Drop leftover Codex labels | Stage profiles footer is `Provider: pi-test`, not `openai-codex` |

Jujutsu sibling isolation and the remaining pipeline extract from `createDaemon` were left for later (see [hardening-plan.md](../hardening-plan.md)).
