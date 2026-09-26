import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBun, ensureOmpSession, guardSupervisorSessions, ompVersion } from '../runner/omp.js';
import { exec } from '../runner/io.js';
import runner from '../runner/pi-extension.js';

test('OMP rejects legacy transcripts and records its backend before a fresh launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-omp-session-'));
  try {
    const session = join(root, 'session.jsonl');
    await writeFile(session, '{"type":"session","version":3}\n');
    await assert.rejects(ensureOmpSession(session), /legacy transcript/);
    await rm(session);
    await ensureOmpSession(session);
    assert.deepEqual(JSON.parse(await readFile(`${session}.backend.json`, 'utf8')), { backend: 'omp', version: ompVersion });
    await ensureOmpSession(session);
    await writeFile(`${session}.backend.json`, JSON.stringify({ backend: 'pi', version: ompVersion }));
    await assert.rejects(ensureOmpSession(session), /backend\/version differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OMP awaited tool-result hook stops successful ask/report, not failed actions', () => {
  const previous = { url: process.env.RUNNER_URL, token: process.env.RUNNER_TOKEN };
  process.env.RUNNER_URL = 'http://127.0.0.1:1'; process.env.RUNNER_TOKEN = 'test';
  try {
    const handlers = new Map(), tools = [];
    runner({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.push(tool) });
    let aborts = 0;
    for (const action of ['ask', 'report']) handlers.get('tool_result')({ toolName: 'runner_action', input: { action }, isError: false }, { abort: () => aborts++ });
    handlers.get('tool_result')({ toolName: 'runner_action', input: { action: 'ask' }, isError: true }, { abort: () => aborts++ });
    assert.equal(aborts, 2);
    assert.ok(tools.every(tool => tool.loadMode === 'essential'));
  } finally {
    for (const [name, value] of [['RUNNER_URL', previous.url], ['RUNNER_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('supervisor rejects unmarked explicit transcripts while preserving native IDs and continue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-omp-supervisor-'));
  try {
    const session = join(root, 'legacy.jsonl');
    await writeFile(session, '{"type":"session","version":3}\n');
    for (const args of [['--session', session], ['--resume', session], [`--session=${session}`], [`--resume=${session}`], ['-r', session], ['--fork', session], [`--fork=${session}`], ['--cwd', root, '--resume', 'legacy.jsonl'], [`--cwd=${root}`, '--session=legacy.jsonl']]) await assert.rejects(guardSupervisorSessions(args), /legacy transcript/);
    await guardSupervisorSessions(['--continue', '--resume', 'native-session-id']);
    await guardSupervisorSessions(['--resume']);
    for (const args of [['--session-dir', root, '--continue'], [`--session-dir=${root}`, '--resume=native-id'], ['--session-dir', root, '--fork=native-id']]) await assert.rejects(guardSupervisorSessions(args), /cannot prove OMP provenance/);
    await writeFile(`${session}.backend.json`, JSON.stringify({ backend: 'omp', version: ompVersion }));
    await guardSupervisorSessions([`--resume=${session}`]);
    const relative = ['--cwd', root, '--resume', 'legacy.jsonl'];
    await guardSupervisorSessions(relative); assert.equal(relative[3], session);
    const inline = [`--cwd=${root}`, '--fork=legacy.jsonl'];
    await guardSupervisorSessions(inline); assert.equal(inline[1], `--fork=${session}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned OMP loads runner and supervisor extensions without model calls', async t => {
  let bun;
  try { bun = await ensureBun(); } catch (error) { t.skip(error.message); return; }
  const root = await mkdtemp(join(tmpdir(), 'runner-omp-load-'));
  try {
    const script = `const {loadExtensions}=await import('@oh-my-pi/pi-coding-agent/extensibility/extensions/loader'); const result=await loadExtensions([process.cwd()+'/runner/pi-extension.js',process.cwd()+'/runner/supervisor-extension.js'],process.cwd()); console.log(JSON.stringify({errors:result.errors,tools:result.extensions.map(e=>[...e.tools.keys()])}));`;
    const { stdout } = await exec(bun, ['--eval', script], { env: { ...process.env, PI_CODING_AGENT_DIR: root, RUNNER_URL: 'http://127.0.0.1:1', RUNNER_TOKEN: 'test' }, timeout: 30000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, [['runner_read', 'runner_write', 'runner_action'], ['runner_supervisor']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
