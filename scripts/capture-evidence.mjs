#!/usr/bin/env node
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/server.js";
import { mockHarness } from "./harness.js";
import { writeSeed } from "./seed-state.js";
import { repoRoot } from "./inspect.js";
import { capturePage } from "./screenshot.mjs";

const outDir = join(repoRoot, "docs/evidence");

async function withServer(seed, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-plan-shot-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "agent-plan-shot-cwd-"));
  await writeSeed({ dataDir, cwd, scenario: seed });
  const daemon = await createDaemon({
    cwd, dataDir, listen: true, lock: false, host: "127.0.0.1", port: 0, harness: mockHarness()
  });
  if (!daemon.server.listening) await new Promise((resolve) => daemon.server.once("listening", resolve));
  const url = `http://${daemon.host}:${daemon.server.address().port}/`;
  try { return await fn(url, daemon); }
  finally { await daemon.close({ exit: false }); }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await withServer("plan-approval", async (url) => {
    await capturePage({ url, out: join(outDir, "01-named-status-plan-approval.png"), waitMs: 1200 });
    await capturePage({ url, out: join(outDir, "02-http-extract-dashboard.png"), waitMs: 1200 });
    await capturePage({
      url,
      click: "#profile-settings",
      eval: "document.querySelector('.profiles-provider')?.scrollIntoView({block:'end'})",
      out: join(outDir, "05-codex-rename-profiles.png"),
      waitMs: 1200
    });
  });
  await withServer("needs-attention", async (url) => {
    await capturePage({ url, out: join(outDir, "01-named-status-needs-attention.png"), waitMs: 1200 });
  });
  await withServer("interrupted", async (url) => {
    await capturePage({ url, out: join(outDir, "04-e2e-recovery-interrupted.png"), waitMs: 1200 });
  });
  process.stdout.write(`Wrote screenshots to ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
