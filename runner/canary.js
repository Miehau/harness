// Opt-in live canary: exercises the full OMP/Herdr/model workflow and incurs model calls.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from './server.js';
import { assert, git, id } from './io.js';

const timeoutMs = Number(process.env.RUNNER_CANARY_TIMEOUT_MS ?? 10 * 60 * 1000);
assert(Number.isFinite(timeoutMs) && timeoutMs >= 60_000, 'RUNNER_CANARY_TIMEOUT_MS must be at least 60000');

const root = await mkdtemp(join(tmpdir(), 'agent-plan-canary-'));
const repo = join(root, 'repo');
const data = join(root, 'data');
let app, taskId, retained = true;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Canary interrupted by ${signal}`)));

try {
  process.stdout.write(`Live canary: model calls enabled; timeout ${timeoutMs}ms\n`);
  await mkdir(join(repo, '.runner'), { recursive: true });
  await writeFile(join(repo, 'value.txt'), 'before\n');
  await writeFile(join(repo, 'AGENTS.md'), 'Change only value.txt. Use the configured test command.\n');
  await writeFile(join(repo, '.runner', 'project.json'), JSON.stringify({
    commands: { test: [process.execPath, '-e', "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='ready\\n')process.exit(1)"] },
    verify: ['test'], maxWorkers: 2, maxAttempts: 5, timeoutMinutes: Math.ceil(timeoutMs / 60_000), commandTimeoutMs: 30_000,
  }, null, 2) + '\n');
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Agent Plan Canary');
  await git(repo, 'config', 'user.email', 'canary@example.invalid');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'Create canary fixture');

  app = await serve(data);
  const submitted = await app.runtime.execute('owner', {
    action: 'submit', input: {
      repo,
      text: 'Live canary: change only value.txt so it contains exactly "ready" followed by a newline. This is a tiny known fix: skip discovery, architecture, and planning; do not ask the owner. Delegate implementation to one writing worker, integrate it, run verification, run independent requirements/AC and correctness/code-quality reviewers in parallel against the verified candidate, and complete with evidence.',
      requestId: id(),
    },
  });
  taskId = submitted.id;
  await app.runtime.execute('owner', { action: 'start', taskId, requestId: id() });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const task = app.runtime.task(taskId);
    if (task.status === 'completed') break;
    if (['failed', 'cancelled'].includes(task.status)) throw new Error(`Task ended ${task.status}`);
    const decision = task.decisions.find(item => !item.answer && item.audience === 'owner');
    if (decision) throw new Error(`Task requested owner input (${decision.id}); inspect ${decision.artifact}`);
    const orchestrator = task.agents.findLast(agent => agent.role === 'orchestrator');
    if (orchestrator?.status === 'failed') throw new Error(orchestrator.error ?? 'Orchestrator failed');
    if (Date.now() >= deadline) throw new Error(`Canary timed out after ${timeoutMs}ms`);
    await sleep(Math.min(2000, deadline - Date.now()), undefined, { signal: abort.signal });
  }

  const proof = await app.runtime.execute('owner', { action: 'verify', taskId, requestId: id() });
  const task = app.runtime.task(taskId);
  const head = await git(task.integration.cwd, 'rev-parse', 'HEAD');
  assert(proof.passed && proof.commit === head, 'Fresh verification did not prove the final candidate');
  assert(await readFile(join(task.integration.cwd, 'value.txt'), 'utf8') === 'ready\n', 'Final candidate has the wrong value');
  assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Final candidate is dirty');
  await app.runtime.execute('owner', { action: 'cleanup', taskId, requestId: id() });
  await app.close(); app = null;
  await rm(root, { recursive: true });
  retained = false;
  process.stdout.write(JSON.stringify({ passed: true, taskId, commit: head }) + '\n');
} catch (error) {
  if (app && taskId) {
    const task = app.runtime.task(taskId);
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) await app.runtime.execute('owner', { action: 'cancel', taskId, requestId: id() }).catch(() => {});
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (retained) {
    const task = app && taskId ? app.runtime.task(taskId) : null;
    process.stderr.write(JSON.stringify({ retained: {
      root, repo, data,
      taskState: taskId ? join(data, 'tasks', taskId, 'state.json') : null,
      integration: task?.integration?.cwd ?? null,
    } }) + '\n');
  }
}
