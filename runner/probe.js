// Opt-in live transport probe: launches Pi with an empty inbox; makes no model call.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from './server.js';
import { id, now } from './io.js';
const root = await mkdtemp(join(tmpdir(), 'runner-herdr-probe-'));
const app = await serve(root);
const task = { version: 1, id: id(), status: 'running', createdAt: now(), config: { maxAttempts: 2, timeoutMinutes: 2 }, agents: [], events: [], decisions: [], receipts: {} };
await mkdir(app.runtime.dir(task), { recursive: true });
const agent = app.runtime.agent(task, 'orchestrator', root);
let good = false;
try {
  await app.runtime.launch(task, agent);
  if (agent.status !== 'running') throw new Error(agent.error);
  for (let i = 0; i < 30; i++) { if (app.runtime.heartbeats.has(agent.id)) { good = true; break; } await sleep(1000); }
  if (!good) throw new Error(`Pi extension did not connect. Inspect Herdr tab ${agent.place?.tab}; probe data ${root}`);
  process.stdout.write(JSON.stringify({ connected: true, modelCalls: 0, pane: agent.place.pane }) + '\n');
} finally {
  if (agent.place) await app.runtime.transport.stop(agent).catch(() => {});
  await app.close();
  if (good) await rm(root, { recursive: true, force: true });
}
