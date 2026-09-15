import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../runner/runtime.js';
import { serve } from '../runner/server.js';
import { git, id, atomic } from '../runner/io.js';

class FakeHerdr {
  constructor() { this.agents = new Map(); this.starts = []; }
  async create(task, agent) { return { pane: agent.id, tab: agent.id, workspace: task.workspace ?? 'test-workspace' }; }
  async start(agent) { this.agents.set(agent.id, 'idle'); this.starts.push(agent.id); }
  async status(agent) { return this.agents.get(agent.id) ?? 'missing'; }
  async stop(agent) { this.agents.delete(agent.id); }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(join(repo, '.runner'), { recursive: true });
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'Runner Test');
  await writeFile(join(repo, 'value.txt'), 'base\n');
  await writeFile(join(repo, '.runner', 'project.json'), JSON.stringify({ commands: { test: [process.execPath, '-e', "if(!require('fs').readFileSync('value.txt','utf8').trim())process.exit(1)"] }, verify: ['test'], maxWorkers: 2 }));
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Fixture');
  const transport = new FakeHerdr(); const data = join(root, 'data'); const runtime = new Runtime(data, { transport }); await runtime.init(); runtime.url = 'http://127.0.0.1:1';
  const call = (identity, action, taskId, input = {}, requestId = id()) => runtime.execute(identity, { action, taskId, input, requestId });
  const task = await call('owner', 'submit', null, { repo, text: 'Implement an improvement', requestId: id() });
  await call('owner', 'start', task.id);
  const main = runtime.task(task.id).agents[0]; const who = a => ({ taskId: task.id, agentId: a.id });
  await call(who(main), 'write', task.id, { area: 'artifacts', path: 'fixture-clarification.md', content: 'Fixture scope clarified' });
  await call(who(main), 'clarify', task.id, { artifact: 'fixture-clarification.md' });
  const artifact = async (name, content = name, actor = who(main)) => { if (actor !== 'owner' && actor.agentId !== main.id) name = `workers/${actor.agentId}/${name}`; await call(actor, 'write', task.id, { area: 'artifacts', path: name, content }); return name; };
  return { root, repo, data, runtime, transport, call, task, main, who, artifact };
}

test('fresh runner: worker question, restart, answer, report, integrate and verify', async t => {
  const f = await fixture(t); const { runtime, call, task, main, who, artifact, transport } = f;
  await artifact('assignment.md', 'Change value.txt to improved');
  const spawnId = id();
  const spawned = await call(who(main), 'spawn', task.id, { assignment: 'assignment.md', mode: 'write' }, spawnId);
  assert.deepEqual(await call(who(main), 'spawn', task.id, { assignment: 'assignment.md', mode: 'write' }, spawnId), spawned);
  assert.equal(transport.starts.length, 2);
  const worker = runtime.task(task.id).agents.find(a => a.id === spawned.workerId);
  assert.notEqual(worker.cwd, f.repo); assert.notEqual(worker.cwd, main.cwd);
  await artifact('question.md', 'Which wording?', who(worker));
  const question = await call(who(worker), 'ask', task.id, { artifact: `workers/${worker.id}/question.md` });
  await assert.rejects(call(who(worker), 'write', task.id, { area: 'repo', path: 'value.txt', content: 'premature' }), /Waiting/);
  assert(runtime.poll(who(main)).messages.some(m => m.decisionId === question.decisionId));
  const restarted = new Runtime(f.data, { transport }); await restarted.init();
  assert.equal(restarted.task(task.id).decisions[0].id, question.decisionId);
  assert.equal(restarted.task(task.id).agents.find(a => a.id === worker.id).status, 'waiting');
  await artifact('answer.md', 'Use improved');
  await call(who(main), 'answer', task.id, { decisionId: question.decisionId, artifact: 'answer.md' });
  assert(runtime.poll(who(worker)).messages.some(m => m.kind === 'answer'));
  await call(who(worker), 'write', task.id, { area: 'repo', path: 'value.txt', content: 'improved\n' });
  await artifact('handoff.md', 'Updated value; verify after integration.', who(worker));
  await call(who(worker), 'report', task.id, { status: 'completed', artifact: `workers/${worker.id}/handoff.md` });
  await assert.rejects(call(who(worker), 'write', task.id, { area: 'repo', path: 'value.txt', content: 'late' }), /Inactive/);
  await artifact('result.md', 'Completed candidate');
  await assert.rejects(call(who(main), 'report', task.id, { status: 'completed', artifact: 'result.md' }), /integrated/);
  await call(who(main), 'integrate', task.id, { workerId: worker.id });
  await assert.rejects(call(who(main), 'report', task.id, { status: 'completed', artifact: 'result.md' }), /verification/);
  const proof = await call(who(main), 'verify', task.id); assert.equal(proof.passed, true);
  await call(who(main), 'report', task.id, { status: 'completed', artifact: 'result.md' });
  assert.equal(runtime.task(task.id).status, 'completed');
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(main.cwd, 'value.txt'), 'utf8'), 'improved\n');
});

test('ownership, shared contracts, path boundaries and exact user decisions', async t => {
  const { runtime, call, task, main, who, artifact, root } = await fixture(t);
  await artifact('assignment.md');
  const first = await call(who(main), 'spawn', task.id, { assignment: 'assignment.md', mode: 'write' });
  await assert.rejects(call(who(main), 'spawn', task.id, { assignment: 'assignment.md', mode: 'write' }), /contract/);
  const worker = runtime.task(task.id).agents.find(a => a.id === first.workerId);
  await assert.rejects(call(who(worker), 'spawn', task.id, { assignment: 'assignment.md', mode: 'explore' }), /Orchestrator/);
  await assert.rejects(call(who(main), 'write', task.id, { area: 'repo', path: 'value.txt', content: 'no' }), /cannot write/);
  await assert.rejects(call(who(worker), 'write', task.id, { area: 'repo', path: '../escape', content: 'no' }), /inside/);
  await symlink(root, join(worker.cwd, 'escape'));
  await assert.rejects(call(who(worker), 'write', task.id, { area: 'repo', path: 'escape/secret', content: 'no' }), /Symlink/);
  await artifact('user-question.md');
  const q = await call(who(main), 'ask', task.id, { artifact: 'user-question.md' });
  await artifact('answer.md', 'Yes', 'owner');
  await assert.rejects(call(who(worker), 'answer', task.id, { decisionId: q.decisionId, artifact: 'answer.md' }), /Orchestrator/);
  await call('owner', 'answer', task.id, { decisionId: q.decisionId, artifact: 'answer.md' });
  await artifact('different.md');
  await assert.rejects(call('owner', 'answer', task.id, { decisionId: q.decisionId, artifact: 'different.md' }), /differently/);
});

test('Herdr idle/done never completes a task, missing agents require explicit resume', async t => {
  const { runtime, transport, call, task, main } = await fixture(t);
  transport.agents.set(main.id, 'done'); await runtime.reconcile();
  assert.equal(runtime.task(task.id).status, 'running');
  transport.agents.delete(main.id); await runtime.reconcile();
  assert.equal(runtime.task(task.id).agents[0].status, 'failed');
  await call('owner', 'resume', task.id, { agentId: main.id });
  assert.equal(runtime.task(task.id).agents[0].session, main.session);
  assert.equal(transport.starts.length, 2);
});

test('HTTP owner and worker scopes survive server restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-http-')); const data = join(root, 'http'); const transport = new FakeHerdr();
  let server = await serve(data, { transport });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const url = server.runtime.url; const token = server.descriptor.token;
  assert.equal((await fetch(url + '/tasks')).status, 401);
  assert.equal((await fetch(url + '/tasks', { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(url + '/tasks', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  await assert.rejects(serve(data, { transport }), /already owns/);
  await server.close(); server = await serve(data, { transport });
  assert.equal(server.runtime.url, url); assert.equal(server.descriptor.token, token);
  const dashboard = await fetch(url + '/?task=example');
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Evidence reader/);
});

test('submission is idempotent and workflow snapshot survives repo edits', async t => {
  const { runtime, call, repo, task } = await fixture(t);
  const requestId = id(); const input = { repo, text: 'A queued task', requestId };
  const submitted = await call('owner', 'submit', null, input);
  assert.equal((await call('owner', 'submit', null, input)).id, submitted.id);
  await assert.rejects(call('owner', 'submit', null, { ...input, text: 'Different' }), /different/);
  assert.equal((await call('owner', 'start', submitted.id)).status, 'running');
  await writeFile(join(repo, '.runner', 'workflow.md'), 'changed');
  const snapshot = await readFile(join(runtime.dir(task), 'artifacts', 'workflow.md'), 'utf8');
  assert.match(snapshot, /Main agent workflow/);
  const listing = await call('owner', 'read', task.id, { area: 'artifacts', path: '.' });
  assert.ok(listing.directories.includes('workflow'));
  assert.ok(!listing.directories.includes('workflow.md'));
  for (const [, path] of snapshot.matchAll(/\]\((workflow\/[^)]+)\)/g)) {
    assert.ok((await readFile(join(runtime.dir(task), 'artifacts', path), 'utf8')).length > 0);
  }
  const custom = await call('owner', 'submit', null, { repo, text: 'Custom workflow', requestId: id() });
  assert.equal(await readFile(join(runtime.dir(custom), 'artifacts', 'workflow.md'), 'utf8'), 'changed');
});

test('parallel writing workers share a contract and integrate independently', async t => {
  const { runtime, call, task, main, who, artifact } = await fixture(t);
  await artifact('contract.md', 'API: GET /message returns {text:string}; FE owns ui.txt, BE owns api.txt');
  await call(who(main), 'contract', task.id, { artifact: 'contract.md' });
  await artifact('fe.md'); await artifact('be.md');
  const workers = [];
  for (const assignment of ['fe.md', 'be.md']) {
    const spawn = await call(who(main), 'spawn', task.id, { assignment, mode: 'write', contract: 'contract.md' });
    workers.push(runtime.task(task.id).agents.find(a => a.id === spawn.workerId));
  }
  await assert.rejects(call(who(main), 'spawn', task.id, { assignment: 'fe.md', mode: 'explore' }), /capacity/);
  await artifact('revised.md');
  await assert.rejects(call(who(main), 'contract', task.id, { artifact: 'revised.md' }), /Pause/);
  for (const [i, worker] of workers.entries()) {
    await call(who(worker), 'write', task.id, { area: 'repo', path: i ? 'api.txt' : 'ui.txt', content: 'contract implementation' });
    await artifact(`handoff-${i}.md`, 'Implemented', who(worker));
    await call(who(worker), 'report', task.id, { status: 'completed', artifact: `workers/${worker.id}/handoff-${i}.md` });
  }
  for (const worker of workers) await call(who(main), 'integrate', task.id, { workerId: worker.id });
  assert.equal((await call(who(main), 'verify', task.id)).passed, true);
  assert.equal(await readFile(join(main.cwd, 'ui.txt'), 'utf8'), 'contract implementation');
  assert.equal(await readFile(join(main.cwd, 'api.txt'), 'utf8'), 'contract implementation');
});

test('shared contract revision pauses and resumes exact workers', async t => {
  const { runtime, call, task, main, who, artifact } = await fixture(t);
  await artifact('assignment.md'); await artifact('contract.md');
  await call(who(main), 'contract', task.id, { artifact: 'contract.md' });
  const spawned = await call(who(main), 'spawn', task.id, { assignment: 'assignment.md', mode: 'write', contract: 'contract.md' });
  const worker = runtime.task(task.id).agents.find(a => a.id === spawned.workerId);
  await artifact('pause.md', 'Shared response field changes');
  const q = await call(who(main), 'pause', task.id, { workerId: worker.id, artifact: 'pause.md' });
  await artifact('contract-v2.md'); await call(who(main), 'contract', task.id, { artifact: 'contract-v2.md' });
  await call(who(main), 'answer', task.id, { decisionId: q.decisionId, artifact: 'contract-v2.md' });
  assert.equal(runtime.task(task.id).agents.find(a => a.id === worker.id).contract, 'contract-v2.md');
  assert(runtime.poll(who(worker)).messages.some(m => m.kind === 'contract' && m.artifact === 'contract-v2.md'));
});

test('pending request receipts never repeat an uncertain spawn after restart', async t => {
  const { runtime, task, main, who, data, transport } = await fixture(t);
  const current = runtime.task(task.id); const requestId = id();
  const { createHash } = await import('node:crypto'); const body = { assignment: 'unknown.md', mode: 'write' };
  const fingerprint = createHash('sha256').update(JSON.stringify({ action: 'spawn', body })).digest('hex');
  current.receipts[`${main.id}:${requestId}`] = { fingerprint, action: 'spawn', status: 'pending' }; await runtime.save(current);
  const restarted = new Runtime(data, { transport }); await restarted.init();
  await assert.rejects(restarted.execute(who(main), { action: 'spawn', input: body, requestId }), /uncertain/);
  assert.equal(transport.starts.length, 1);
});

test('verification failure and changed integration invalidate completion', async t => {
  const { runtime, call, task, main, who, artifact } = await fixture(t);
  await artifact('result.md');
  const current = runtime.task(task.id); current.config.commands.test = [process.execPath, '-e', 'console.log("failure evidence");process.exit(1)']; await runtime.save(current);
  const proof = await call(who(main), 'verify', task.id); assert.equal(proof.passed, false);
  await assert.rejects(call(who(main), 'report', task.id, { status: 'completed', artifact: 'result.md' }), /verification/);
  const evidence = JSON.parse(await readFile(join(runtime.dir(task), 'artifacts', proof.artifact), 'utf8'));
  const check = JSON.parse(await readFile(join(runtime.dir(task), 'artifacts', evidence.checks[0].artifact), 'utf8'));
  assert.match(await readFile(join(runtime.dir(task), 'artifacts', check.output), 'utf8'), /failure evidence/);
});

test('worker time budget applies even with a healthy heartbeat', async t => {
  const { runtime, task, main } = await fixture(t);
  const current = runtime.task(task.id); current.agents[0].startedAt = new Date(0).toISOString(); await runtime.save(current);
  runtime.heartbeats.set(main.id, Date.now()); await runtime.reconcile();
  assert.equal(runtime.task(task.id).agents[0].status, 'failed');
  assert.match(runtime.task(task.id).agents[0].error, /budget/);
});

test('webhook uncertainty is recorded without automatic duplicate delivery', async t => {
  const { notify } = await import('../runner/notifications.js');
  const { runtime, task } = await fixture(t);
  await atomic(join(runtime.root, 'supervisor.json'), { webhook: { url: 'https://receiver.example.invalid/events' } });
  const current = runtime.task(task.id); runtime.event(current, 'decision', { decisionId: id(), artifact: 'question.md' }); await runtime.save(current);
  let calls = 0;
  const transport = async () => { calls++; throw new Error('network uncertain'); };
  await notify(runtime, transport); await notify(runtime, transport);
  assert.equal(calls, 1);
  const receipts = JSON.parse(await readFile(join(runtime.root, 'notifications.json'), 'utf8'));
  assert.equal(Object.values(receipts)[0].status, 'unknown');
});

test('one runtime operates independently in two repositories', async t => {
  const a = await fixture(t); const b = await fixture(t);
  const task = await a.call('owner', 'submit', null, { repo: b.repo, text: 'Another repo', requestId: id() });
  await a.call('owner', 'start', task.id);
  assert.equal(a.runtime.task(task.id).status, 'running');
  assert.equal(a.runtime.task(a.task.id).status, 'running');
  assert.equal(a.runtime.task(task.id).repo, await realpath(b.repo));
});

test('cancellation interrupts named commands instead of waiting for their timeout', async t => {
  const f = await fixture(t); const task = f.runtime.task(f.task.id);
  task.config.commands.long = [process.execPath, '-e', 'setInterval(()=>{},1000)']; await f.runtime.save(task);
  const command = f.call(f.who(f.main), 'command', task.id, { name: 'long' });
  const { setTimeout: sleep } = await import('node:timers/promises');
  for (let i = 0; !f.runtime.processes.size && i < 100; i++) await sleep(10);
  assert.equal(f.runtime.processes.size, 1);
  const cancelled = f.call('owner', 'cancel', task.id);
  assert.equal((await command).passed, false);
  assert.equal((await cancelled).status, 'cancelled');
});

test('Pi extension delivers references, acknowledges turns, and surfaces model failure', async t => {
  let cleanup;
  const f = await fixture({ after(fn) { cleanup = fn; } });
  const server = await serve(f.data, { transport: f.transport });
  const prior = { url: process.env.RUNNER_URL, token: process.env.RUNNER_TOKEN, reply: process.env.RUNNER_REPLY_TOKEN };
  process.env.RUNNER_URL = server.runtime.url; process.env.RUNNER_TOKEN = f.main.token; process.env.RUNNER_REPLY_TOKEN = f.main.replyToken;
  const handlers = new Map(), tools = new Map(), messages = [];
  const pi = { on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), setActiveTools() {}, sendMessage: message => messages.push(message) };
  const { default: extension } = await import('../runner/pi-extension.js'); extension(pi);
  t.after(async () => {
    handlers.get('session_shutdown')(); await server.close(); await cleanup();
    if (prior.url === undefined) delete process.env.RUNNER_URL; else process.env.RUNNER_URL = prior.url;
    if (prior.token === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = prior.token;
    if (prior.reply === undefined) delete process.env.RUNNER_REPLY_TOKEN; else process.env.RUNNER_REPLY_TOKEN = prior.reply;
  });
  const notices = []; const ctx = { isIdle: () => true, shutdown() {}, ui: { setStatus() {}, notify(text) { notices.push(text); } } };
  await handlers.get('session_start')({}, ctx);
  const { setTimeout: sleep } = await import('node:timers/promises');
  for (let i = 0; !messages.length && i < 100; i++) await sleep(10);
  assert.equal(messages.length, 1); assert.match(messages[0].content, /brief.md/);
  await handlers.get('agent_end')({ messages: [messages[0], { role: 'assistant', stopReason: 'stop' }] });
  assert(server.runtime.task(f.task.id).agents[0].inbox.every(m => m.acknowledgedAt));
  const report = tools.get('runner_action');
  await tools.get('runner_write').execute(id(), { area: 'artifacts', path: 'ask.md', content: 'Need user decision' });
  const q = await report.execute(id(), { action: 'ask', input: { artifact: 'ask.md' } }); assert.equal(q.terminate, true);
  const denied = await fetch(server.runtime.url + '/terminal-answer', { method: 'POST', headers: { authorization: `Bearer ${f.main.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: q.details.decisionId, text: 'Forged answer' }) });
  assert.equal(denied.status, 400);
  assert.deepEqual(await handlers.get('input')({ source: 'extension', text: 'Do not approve this' }, ctx), { action: 'continue' });
  for (let i = 0; !notices.length && i < 250; i++) await sleep(10);
  assert.match(notices[0], /Need user decision/);
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Proceed' }, ctx), { action: 'handled' });
  for (let i = 0; messages.length < 2 && i < 250; i++) await sleep(10);
  assert.equal(messages.length, 2); assert.match(messages[1].content, /answer/);
  const decision = server.runtime.task(f.task.id).decisions.find(d => d.id === q.details.decisionId);
  assert.equal(await readFile(join(server.runtime.dir(f.task), 'artifacts', decision.answer), 'utf8'), 'Proceed');
  await handlers.get('agent_end')({ messages: [messages[1], { role: 'assistant', stopReason: 'error', errorMessage: 'Provider unavailable' }] });
  assert.equal(server.runtime.task(f.task.id).agents[0].status, 'failed');
  assert.equal(server.runtime.task(f.task.id).status, 'running');
});

test('resume wakes acknowledged sessions and preserves unanswered user decisions', async t => {
  const f = await fixture(t);
  const inbox = f.runtime.poll(f.who(f.main)).messages;
  await f.call(f.who(f.main), 'ack', f.task.id, { ids: inbox.map(m => m.id) });
  f.transport.agents.delete(f.main.id); await f.runtime.reconcile();
  await f.call('owner', 'resume', f.task.id, { agentId: f.main.id });
  assert(f.runtime.poll(f.who(f.main)).messages.some(m => m.kind === 'resume'));
  await f.artifact('question.md'); const q = await f.call(f.who(f.main), 'ask', f.task.id, { artifact: 'question.md' });
  f.transport.agents.delete(f.main.id); f.runtime.heartbeats.clear(); await f.runtime.reconcile();
  await f.call('owner', 'resume', f.task.id, { agentId: f.main.id });
  assert.equal(f.runtime.poll(f.who(f.main)).status, 'waiting');
  assert.equal(f.runtime.task(f.task.id).decisions.find(d => d.id === q.decisionId).answer, undefined);
});

test('interrupted integration can recover without replaying an applied commit', async t => {
  const f = await fixture(t); await f.artifact('assignment.md');
  const spawned = await f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write' });
  const worker = f.runtime.task(f.task.id).agents.find(a => a.id === spawned.workerId);
  await f.call(f.who(worker), 'write', f.task.id, { area: 'repo', path: 'extra.txt', content: 'change' });
  await f.artifact('handoff.md', 'Done', f.who(worker));
  await f.call(f.who(worker), 'report', f.task.id, { status: 'completed', artifact: `workers/${worker.id}/handoff.md` });
  const current = f.runtime.task(f.task.id); const saved = current.agents.find(a => a.id === worker.id);
  current.operation = { kind: 'integrate', workerId: worker.id, before: await git(f.main.cwd, 'rev-parse', 'HEAD'), commit: saved.commit };
  await f.runtime.save(current); await git(f.main.cwd, 'cherry-pick', saved.commit);
  await assert.rejects(f.call('owner', 'recover', f.task.id, { outcome: 'aborted' }), /differs/);
  await f.call('owner', 'recover', f.task.id, { outcome: 'applied' });
  const head = await git(f.main.cwd, 'rev-parse', 'HEAD');
  assert.equal((await f.call(f.who(f.main), 'integrate', f.task.id, { workerId: worker.id })).commit, head);
  assert.equal(await git(f.main.cwd, 'rev-parse', 'HEAD'), head);
});

test('malformed connection credentials fail closed and release the startup lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  await atomic(join(root, 'connection.json'), {});
  await assert.rejects(serve(root, { transport: new FakeHerdr() }), /Invalid connection/);
  await assert.rejects(readFile(join(root, 'daemon.lock')), /ENOENT/);
});


test('Herdr transport errors never expose launch credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-herdr-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'herdr');
  await writeFile(binary, `#!${process.execPath}\nprocess.stderr.write('transport unavailable');process.exit(1);\n`); await chmod(binary, 0o700);
  const previous = process.env.PATH; process.env.PATH = root;
  try {
    const { Herdr } = await import('../runner/herdr.js');
    await assert.rejects(new Herdr().call('tab', 'create', '--env', 'RUNNER_TOKEN=private-secret'), error => !error.message.includes('private-secret') && error.message.includes('Herdr'));
  } finally { process.env.PATH = previous; }
});

test('CLI starts a task directly, focuses its workspace, opens by prefix and stops', async t => {
  let cleanup; const f = await fixture({ after(fn) { cleanup = fn; } });
  await f.call('owner', 'cancel', f.task.id);
  const focused = []; f.transport.open = async agent => { focused.push(agent.id); return agent.place; };
  const app = await serve(f.data, { transport: f.transport });
  const previous = process.env.RUNNER_DATA; process.env.RUNNER_DATA = f.data;
  t.after(async () => { await app.close(); await cleanup(); if (previous === undefined) delete process.env.RUNNER_DATA; else process.env.RUNNER_DATA = previous; });
  const { main } = await import('../runner/cli.js');
  const started = await main(['start', f.repo, 'Improve the message']);
  assert.equal(started.status, 'running'); assert.equal(focused.length, 1);
  assert.equal((await main(['open', started.id.slice(0, 8)])).taskId, started.id); assert.equal(focused.length, 2);
  assert((await main(['list'])).some(row => row.id === started.id));
  assert.equal((await main(['stop', started.id.slice(0, 8)])).status, 'cancelled');
  f.transport.ready = async () => { throw new Error('Start Herdr first'); };
  await assert.rejects(main(['start', f.repo, 'Another change']), /Start Herdr first/);
  const draft = [...app.runtime.tasks.values()].findLast(task => task.status === 'queued');
  assert(draft); assert.equal(draft.integration, undefined);
});

test('terminal replies require a separate credential and exact decision', async t => {
  const f = await fixture(t); await f.artifact('question.md', 'Proceed?');
  const q = await f.call(f.who(f.main), 'ask', f.task.id, { artifact: 'question.md' });
  const reply = { decisionId: q.decisionId, text: 'Proceed' };
  await assert.rejects(f.runtime.terminalAnswer(f.main.token, reply), /credential/);
  await assert.rejects(f.runtime.terminalAnswer(f.main.replyToken, { ...reply, decisionId: id() }), /matching/);
  assert.equal(f.runtime.view(f.runtime.task(f.task.id)).agents[0].replyToken, undefined);
  await f.runtime.terminalAnswer(f.main.replyToken, reply);
  assert.equal(f.runtime.task(f.task.id).decisions[0].answeredBy, 'owner');
  assert.equal(f.runtime.poll(f.who(f.main)).status, 'running');
  await f.runtime.terminalAnswer(f.main.replyToken, reply);
  await assert.rejects(f.runtime.terminalAnswer(f.main.replyToken, { ...reply, text: 'Different' }), /differently/);
});

test('background runtime starts once for concurrent clients and recovers a stale connection', async t => {
  const { connect } = await import('../runner/connection.js');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const root = await mkdtemp(join(tmpdir(), 'runner-auto-'));
  const stop = async () => {
    let pid; try { pid = JSON.parse(await readFile(join(root, 'daemon.lock'), 'utf8')).pid; } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100; i++) { try { await readFile(join(root, 'daemon.lock')); } catch (e) { if (e.code === 'ENOENT') return; throw e; } await sleep(20); }
    throw new Error('Background runtime failed to shut down');
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const [a, b] = await Promise.all([connect(root), connect(root)]);
  assert.deepEqual(a, b); assert.deepEqual(await connect(root), a);
  await stop(); assert.deepEqual(await connect(root), a);
});

test('installed CLI symlink runs help without starting a runtime', async t => {
  const { exec } = await import('../runner/io.js'); const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'runner-bin-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'agent-plan'); await symlink(fileURLToPath(new URL('../runner/cli.js', import.meta.url)), bin);
  assert.match((await exec(process.execPath, [bin, 'help'])).stdout, /start <repo>/);
});

test('incompatible runtime errors identify the connection without exposing credentials', async t => {
  const { createServer } = await import('node:http');
  const { connect } = await import('../runner/connection.js');
  const root = await mkdtemp(join(tmpdir(), 'runner-health-'));
  const server = createServer((req, res) => { res.writeHead(404); res.end('Not found'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const token = id() + id(); const port = server.address().port;
  await atomic(join(root, 'connection.json'), { token, port });
  await assert.rejects(connect(root), error => error.message.includes(root) && error.message.includes(String(port)) && error.message.includes('HTTP 404') && !error.message.includes(token));
  await assert.rejects(readFile(join(root, 'daemon.lock')), /ENOENT/);
});

test('worker artifacts are isolated, document revisions retain history, and checkpoints survive restart', async t => {
  const f = await fixture(t); await f.artifact('assignment.md');
  const spawned = await f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write', model: 'small-model', provider: 'test-provider', modelReason: 'Test explicit override' });
  const worker = f.runtime.task(f.task.id).agents.find(a => a.id === spawned.workerId);
  assert.deepEqual(worker.modelSelection, { model: 'small-model', provider: 'test-provider' });
  const checkpoint = await f.artifact('checkpoint.md', 'Implemented parsing; validation remains', f.who(worker));
  await f.call(f.who(worker), 'checkpoint', f.task.id, { artifact: checkpoint });
  for (const path of ['orchestrator/architecture.md', `workers/${f.main.id}/stolen.md`, 'unowned.md']) {
    await assert.rejects(f.call(f.who(worker), 'write', f.task.id, { area: 'artifacts', path, content: 'no' }), /own artifact directory/);
  }
  await f.artifact('orchestrator/architecture-v1.md', 'First');
  await f.call(f.who(f.main), 'revise', f.task.id, { name: 'architecture', artifact: 'orchestrator/architecture-v1.md' });
  await f.artifact('orchestrator/architecture-v2.md', 'Second');
  await assert.rejects(f.call(f.who(f.main), 'revise', f.task.id, { name: 'architecture', artifact: 'orchestrator/architecture-v2.md' }), /revision changed/);
  await f.call(f.who(f.main), 'revise', f.task.id, { name: 'architecture', artifact: 'orchestrator/architecture-v2.md', previous: 'orchestrator/architecture-v1.md' });
  assert.equal((await f.call('owner', 'read', f.task.id, { area: 'artifacts', path: 'orchestrator/architecture-v1.md' })).content, 'First');
  const restarted = new Runtime(f.data, { transport: f.transport }); await restarted.init();
  assert.equal(restarted.task(f.task.id).agents.find(a => a.id === worker.id).checkpoint, checkpoint);
  assert.equal(restarted.task(f.task.id).documents.architecture, 'orchestrator/architecture-v2.md');
});

test('a busy task does not block another task in the same repository', async t => {
  const f = await fixture(t);
  const second = await f.call('owner', 'submit', null, { repo: f.repo, text: 'Independent task', model: 'coordinator-model', requestId: id() });
  await f.call('owner', 'start', second.id);
  assert.equal(f.runtime.task(second.id).config.model, 'coordinator-model');
  assert.notEqual(f.runtime.task(second.id).integration.cwd, f.main.cwd);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const busy = f.runtime.serial(() => gate, f.task.id);
  try {
    const result = await Promise.race([f.call('owner', 'inspect', second.id), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Unrelated task blocked')), 1000); timer.unref(); })]);
    assert.equal(result.id, second.id);
  } finally { release(); await busy; }
});

test('browser scenario records criterion screenshots and rejects unknown actions', async () => {
  const { scenario } = await import('../runner/browser.js'); const actions = [];
  const page = { goto: async url => actions.push(url), getByLabel: label => ({ fill: async value => actions.push([label, value]) }), getByRole: (role, options) => ({ click: async () => actions.push([role, options.name]) }), getByText: text => ({ waitFor: async () => actions.push(text) }) };
  const proof = await scenario(page, [{ action: 'goto', url: 'http://localhost:3000' }, { action: 'fill', label: 'Name', value: 'Michal' }, { action: 'click', name: 'Greet' }, { action: 'visible', text: 'Hello, Michal!' }, { action: 'screenshot', criterion: 'AC-1' }], async file => actions.push(file));
  assert.deepEqual(proof, [{ criterion: 'AC-1', file: '1.png' }]); assert.equal(actions.length, 5);
  await assert.rejects(scenario(page, [{ action: 'evaluate', code: 'anything' }], () => {}), /Unknown browser action/);
});

test('PNG evidence is copied into worker artifacts and reads as an image', async t => {
  const f = await fixture(t); await f.artifact('assignment.md');
  const spawned = await f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write' });
  const worker = f.runtime.task(f.task.id).agents.find(a => a.id === spawned.workerId);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(worker.cwd, 'proof.png'), png);
  const { artifact } = await f.call(f.who(worker), 'publish', f.task.id, { path: 'proof.png' });
  assert(artifact.startsWith(worker.artifactDir + '/'));
  const image = await f.call('owner', 'read', f.task.id, { area: 'artifacts', path: artifact });
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.base64, png.toString('base64'));
  await assert.rejects(f.call(f.who(worker), 'publish', f.task.id, { path: 'value.txt' }), /PNG/);
});

test('coordinators exchange durable file messages without duplicate delivery', async t => {
  const f = await fixture(t); const peer = await f.call('owner', 'submit', null, { repo: f.repo, text: 'Peer task', requestId: id() }); await f.call('owner', 'start', peer.id);
  await f.artifact('proposal.md', 'Use the same greeting interface');
  const sent = await f.call(f.who(f.main), 'coordinate', f.task.id, { taskId: peer.id, artifact: 'proposal.md' });
  await f.runtime.deliverCoordination(); await f.runtime.deliverCoordination();
  const messages = f.runtime.task(peer.id).agents[0].inbox.filter(m => m.deliveryId === sent.messageId); assert.equal(messages.length, 1);
  assert.equal((await f.call('owner', 'read', peer.id, { area: 'artifacts', path: messages[0].artifact })).content, 'Use the same greeting interface');
});

test('onboarding requires the generated verify script to pass', async t => {
  const f = await fixture(t);
  const task = await f.call('owner', 'submit', null, { repo: f.repo, text: 'Create verification setup', onboarding: true, requestId: id() });
  await f.call('owner', 'start', task.id);
  const main = f.runtime.task(task.id).agents[0]; const identity = { taskId: task.id, agentId: main.id };
  assert(task.config.verify.includes('onboard_verify'));
  assert.equal((await f.call(identity, 'verify', task.id)).passed, false);
  await writeFile(join(main.cwd, 'verify.sh'), 'exit 0\n');
  assert.equal((await f.call(identity, 'command', task.id, { name: 'onboard_verify' })).passed, true);
  await writeFile(join(main.cwd, 'verify.sh'), 'exit 1\n');
  assert.equal((await f.call(identity, 'command', task.id, { name: 'onboard_verify' })).passed, false);
});

test('repository aliases persist, resolve in CLI intake, and never overwrite another target', async t => {
  let cleanup; const f = await fixture({ after(fn) { cleanup = fn; } });
  const app = await serve(f.data, { transport: f.transport });
  const previous = process.env.RUNNER_DATA; process.env.RUNNER_DATA = f.data;
  t.after(async () => { await app.close(); await cleanup(); if (previous === undefined) delete process.env.RUNNER_DATA; else process.env.RUNNER_DATA = previous; });
  const { main } = await import('../runner/cli.js');
  const { resolveRepo } = await import('../runner/repos.js');
  assert.deepEqual(await main(['repo', 'list']), []);
  await main(['repo', 'add', 'demo', f.repo]);
  await main(['repo', 'add', 'demo', f.repo]);
  assert.equal(await resolveRepo('demo'), await realpath(f.repo));
  assert.equal(await resolveRepo('./demo'), join(process.cwd(), 'demo'));
  assert.deepEqual(await main(['repo', 'list']), [{ alias: 'demo', path: await realpath(f.repo) }]);
  const brief = join(f.root, 'brief.md'); await writeFile(brief, 'Alias task');
  const task = await main(['submit', 'demo', brief]); assert.equal(task.repo, await realpath(f.repo));
  await assert.rejects(main(['repo', 'add', '../escape', f.repo]), /Alias must/);
  await assert.rejects(main(['repo', 'add', 'demo', f.main.cwd]), /already exists/);
  await main(['repo', 'remove', 'demo']); assert.deepEqual(await main(['repo', 'list']), []);
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'base\n');
});

test('help topics and command help never connect to a runtime', async () => {
  const { main } = await import('../runner/cli.js');
  assert.match(await main(['help']), /Examples and details/);
  assert.match(await main(['help', 'start']), /committed HEAD/);
  assert.equal(await main(['repo', '--help']), await main(['help', 'repo']));
  assert.match(await main(['start', '--help']), /--model/);
  assert.match(await main(['help', 'answer']), /decision-id/);
  await assert.rejects(main(['help', 'unknown-command']), /Unknown help topic/);
});

test('installer runs from another directory and stops when dependency installation fails', async t => {
  const { exec } = await import('../runner/io.js'); const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'runner-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const npm = join(root, 'npm'); const log = join(root, 'calls');
  await writeFile(npm, '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$INSTALL_TEST_LOG"\nif [ "$1" = "ci" ] && [ "${INSTALL_TEST_FAIL:-}" = 1 ]; then exit 9; fi\nif [ "$1" = "prefix" ]; then echo /test/prefix; fi\n'); await chmod(npm, 0o700);
  const script = fileURLToPath(new URL('../install.sh', import.meta.url));
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, INSTALL_TEST_LOG: log };
  const result = await exec('sh', [script], { cwd: root, env });
  assert.match(result.stdout, /Installed from/);
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /ci --no-audit --no-fund/); assert.match(calls, /link --ignore-scripts/);
  assert(calls.split('\n').filter(Boolean).every(line => line.startsWith(fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '') + '|')));
  await writeFile(log, '');
  await assert.rejects(exec('sh', [script], { cwd: root, env: { ...env, INSTALL_TEST_FAIL: '1' } }));
  assert.doesNotMatch(await readFile(log, 'utf8'), /link/);
});

test('onboard by alias snapshots discovery instructions and retains verification gates', async t => {
  let cleanup; const f = await fixture({ after(fn) { cleanup = fn; } });
  f.transport.open = async agent => agent.place;
  const app = await serve(f.data, { transport: f.transport });
  const previous = process.env.RUNNER_DATA; process.env.RUNNER_DATA = f.data;
  t.after(async () => { await app.close(); await cleanup(); if (previous === undefined) delete process.env.RUNNER_DATA; else process.env.RUNNER_DATA = previous; });
  const { main } = await import('../runner/cli.js');
  await main(['repo', 'add', 'discovery', f.repo]);
  const configBefore = await readFile(join(f.repo, '.runner/project.json'), 'utf8');
  const result = await main(['onboard', 'discovery', '--model', 'test-model']);
  const task = app.runtime.task(result.id);
  assert.equal(task.config.model, 'test-model'); assert(task.config.verify.includes('onboard_verify'));
  const brief = await app.runtime.files(task, 'owner', 'read', { area: 'artifacts', path: 'brief.md' });
  assert.equal(brief.content, await readFile(new URL('../runner/onboarding.md', import.meta.url), 'utf8'));
  assert.match(brief.content, /feature-map\.md/); assert.match(brief.content, /brownfield only/);
  assert.equal(await readFile(join(f.repo, '.runner/project.json'), 'utf8'), configBefore);
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
});

test('unconfigured repositories start and pass lightweight discovery references to agents', async t => {
  const f = await fixture(t);
  await git(f.repo, 'rm', '.runner/project.json');
  await mkdir(join(f.repo, '.runner/features'), { recursive: true });
  await writeFile(join(f.repo, '.runner/feature-map.md'), '[Greeting](features/greeting.md)');
  await writeFile(join(f.repo, '.runner/features/greeting.md'), 'Greeting details');
  await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Discovery without onboarding config');
  const task = await f.call('owner', 'submit', null, { repo: f.repo, text: 'Improve greeting', requestId: id() });
  assert.equal(task.config.inferredSetup, true);
  await f.call('owner', 'start', task.id);
  const current = f.runtime.task(task.id); const main = current.agents[0]; const identity = { taskId: task.id, agentId: main.id };
  assert.equal(main.inbox[0].discovery, 'discovery.json');
  const discovery = JSON.parse((await f.call('owner', 'read', task.id, { area: 'artifacts', path: 'discovery.json' })).content);
  assert.equal(discovery.featureMap, '.runner/feature-map.md'); assert.equal(discovery.architecture, null);
  assert.equal(discovery.featuresDirectory, '.runner/features'); assert.equal(discovery.verificationSetupNeeded, true);
  assert.equal((await f.call(identity, 'verify', task.id)).passed, false);
  await f.call(identity, 'write', task.id, { area: 'artifacts', path: 'assignment.md', content: 'Improve greeting' });
  await f.call(identity, 'clarify', task.id, { artifact: 'assignment.md' });
  const worker = await f.call(identity, 'spawn', task.id, { assignment: 'assignment.md', mode: 'write' });
  assert.equal(f.runtime.task(task.id).agents.find(a => a.id === worker.workerId).inbox[0].discovery, 'discovery.json');
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
});

async function candidate(t) {
  const f = await fixture(t); await f.artifact('assignment.md');
  const result = await f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write' });
  const worker = f.runtime.task(f.task.id).agents.find(a => a.id === result.workerId);
  await f.call(f.who(worker), 'write', f.task.id, { area: 'repo', path: 'value.txt', content: 'improved\n' });
  const report = await f.artifact('handoff.md', 'Implemented', f.who(worker));
  await f.call(f.who(worker), 'report', f.task.id, { status: 'completed', artifact: report });
  await f.call(f.who(f.main), 'integrate', f.task.id, { workerId: worker.id });
  const proof = await f.call(f.who(f.main), 'verify', f.task.id);
  await f.artifact('complete.md', 'Verified candidate');
  await f.call(f.who(f.main), 'report', f.task.id, { status: 'completed', artifact: 'complete.md' });
  return { ...f, commit: proof.commit, worker };
}

test('accept rebases a verified candidate onto advanced main and merges once', async t => {
  const f = await candidate(t);
  await writeFile(join(f.repo, 'other.txt'), 'Concurrent main work'); await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Advance main');
  const requestId = id(); const input = { commit: f.commit };
  const result = await f.call('owner', 'accept', f.task.id, input, requestId);
  assert.equal(result.phase, 'merged'); assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'improved\n');
  assert.equal(await readFile(join(f.repo, 'other.txt'), 'utf8'), 'Concurrent main work');
  assert.deepEqual(await f.call('owner', 'accept', f.task.id, input, requestId), result);
  assert.equal(f.runtime.task(f.task.id).verification.commit, result.commit);
});

test('accept rejects stale approval and dirty source without changing main', async t => {
  const f = await candidate(t); const before = await git(f.repo, 'rev-parse', 'HEAD');
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: before }), /Candidate changed/);
  await writeFile(join(f.repo, 'local.txt'), 'Keep this');
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: f.commit }), /Source repository must be clean/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before); assert.equal(await readFile(join(f.repo, 'local.txt'), 'utf8'), 'Keep this');
});

test('accept retains a rebase conflict until explicit recovery', async t => {
  const f = await candidate(t);
  await writeFile(join(f.repo, 'value.txt'), 'conflicting main change\n'); await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Conflict');
  const before = await git(f.repo, 'rev-parse', 'HEAD');
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: f.commit }));
  assert.equal(f.runtime.task(f.task.id).operation.kind, 'accept-rebase'); assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
  await assert.rejects(f.call('owner', 'recover', f.task.id, { outcome: 'applied' }), /rebase/);
  await git(f.main.cwd, 'rebase', '--abort');
  await f.call('owner', 'recover', f.task.id, { outcome: 'aborted' });
  assert.equal(await git(f.main.cwd, 'rev-parse', 'HEAD'), f.commit); assert.equal(f.runtime.task(f.task.id).operation, null);
});

test('failed rebased verification never merges into main', async t => {
  const f = await candidate(t); const current = f.runtime.task(f.task.id);
  current.config.commands.test = [process.execPath, '-e', "if(require('fs').existsSync('break-check'))process.exit(1)"];
  await f.runtime.save(current);
  await writeFile(join(f.repo, 'break-check'), 'new main condition'); await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Introduce failing condition');
  const before = await git(f.repo, 'rev-parse', 'HEAD');
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: f.commit }), /verification failed/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before); assert.equal(f.runtime.task(f.task.id).verification.passed, false);
});

test('merge receipt failure is recoverable without repeating Git merge', async t => {
  const f = await candidate(t); const save = f.runtime.save.bind(f.runtime); let injected = false;
  f.runtime.save = async task => { if (task.delivery?.phase === 'merged' && !injected) { injected = true; throw Error('Receipt unavailable'); } return save(task); };
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: f.commit }), /Receipt unavailable/);
  assert.equal(f.runtime.task(f.task.id).operation.kind, 'accept-merge');
  const head = await git(f.repo, 'rev-parse', 'HEAD');
  await f.call('owner', 'recover', f.task.id, { outcome: 'applied' });
  assert.equal(f.runtime.task(f.task.id).delivery.phase, 'merged'); assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
});

test('implementation requires current clarification and model choices resolve before worktree creation', async t => {
  const f = await fixture(t); await f.artifact('assignment.md');
  await f.artifact('plan-v1.md', 'Plan');
  await f.call(f.who(f.main), 'revise', f.task.id, { name: 'plan', artifact: 'plan-v1.md' });
  await assert.rejects(f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write' }), /clarification/);
  await f.call(f.who(f.main), 'clarify', f.task.id, { artifact: 'plan-v1.md' });
  const count = f.runtime.task(f.task.id).agents.length;
  await assert.rejects(f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write', modelChoice: 'invented' }), /Unknown model choice/);
  f.transport.resolveModel = async () => { throw Error('Unavailable model'); };
  await assert.rejects(f.call(f.who(f.main), 'spawn', f.task.id, { assignment: 'assignment.md', mode: 'write', modelChoice: 'complex' }), /Unavailable model/);
  assert.equal(f.runtime.task(f.task.id).agents.length, count); assert.equal(f.runtime.task(f.task.id).operation, null);
});

test('Grok-style notifications carry question text, explicit images and safe reply references', async t => {
  const f = await fixture(t); const { notify } = await import('../runner/notifications.js');
  await f.artifact('question.md', 'Which layout should we use?');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const picture = await f.runtime.artifact(f.runtime.task(f.task.id), png, 'png');
  const question = await f.call(f.who(f.main), 'ask', f.task.id, { artifact: 'question.md', attachments: [picture], hook: { action: 'harness-opinion' } });
  await atomic(join(f.data, 'supervisor.json'), { webhook: { url: 'https://receiver.example.invalid/events', format: 'grokbot', authorization: 'Bearer test-token' } });
  const sent = []; const transport = async (url, options) => { sent.push(JSON.parse(options.body)); assert.equal(options.redirect, 'error'); return { ok: true, status: 202 }; };
  await notify(f.runtime, transport); await notify(f.runtime, transport);
  assert.equal(sent[0].action, 'opinion'); assert.equal(sent[0].message, 'Which layout should we use?');
  assert.equal(sent.length, 1); assert.equal(sent[0].job, f.task.id); assert.equal(sent[0].text, 'Which layout should we use?');
  assert.equal(sent[0].attachments[0].base64, png.toString('base64')); assert.equal(sent[0].reply.decisionId, question.decisionId);
  assert(!JSON.stringify(sent).includes(f.main.token));
  const receipts = JSON.parse(await readFile(join(f.data, 'notifications.json'), 'utf8')); assert.equal(Object.values(receipts)[0].wake, 'unobserved');
});

test('accept stops if main advances during verification', async t => {
  const f = await candidate(t); const verify = f.runtime.verify.bind(f.runtime); let mainHead;
  f.runtime.verify = async task => {
    const result = await verify(task);
    await writeFile(join(f.repo, 'new-main.txt'), 'Concurrent change'); await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Advance during verification');
    mainHead = await git(f.repo, 'rev-parse', 'HEAD'); return result;
  };
  await assert.rejects(f.call('owner', 'accept', f.task.id, { commit: f.commit }), /Target branch advanced/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'base\n');
});


test('fresh heartbeat during Herdr lookup prevents a stale missing verdict', async t => {
  const { runtime, transport, task, main, who } = await fixture(t);
  transport.status = async () => { runtime.poll(who(main)); return 'missing'; };
  await runtime.reconcile();
  assert.equal(runtime.task(task.id).agents[0].status, 'running');
  runtime.heartbeats.clear();
  transport.status = async () => 'missing';
  await runtime.reconcile();
  assert.equal(runtime.task(task.id).agents[0].status, 'failed');
});


test('launch completion invalidates a missing lookup captured before registration', async t => {
  const { runtime, transport, task, main } = await fixture(t);
  transport.status = async () => {
    // launch() mutates the stored object before saving; preserve the pre-lookup identity.
    runtime.tasks.get(task.id).agents[0].startedAt = '2099-01-01T00:00:00Z';
    return 'missing';
  };
  await runtime.reconcile();
  assert.equal(runtime.task(task.id).agents[0].status, 'running');
});

test('Grok hook actions normalize aliases and keep probes silent', async t => {
  const f = await fixture(t);
  const { notificationPayload, hookFields, notify } = await import('../runner/notifications.js');
  for (const [action, aliases] of Object.entries({ approval: ['approval','pr-approval','impl-approval'], opinion: ['opinion','harness-opinion'], problem: ['problem','impl-problem','blocker'] })) {
    for (const alias of aliases) {
      const event = { id: id(), kind: 'decision', at: new Date().toISOString(), error: 'Example', ...hookFields({ action: alias, pr: 42, evidence: 'tests + screenshots', problems: ['e2e timeout'] }) };
      const payload = await notificationPayload(f.runtime, f.task, event, 'grokbot');
      assert.equal(payload.action, action); assert.equal(payload.from, 'harness'); assert.equal(payload.task, f.task.id); assert.equal(payload.message, 'Example'); assert.equal(payload.pr, 42);
      if (action === 'approval') assert.equal(payload.evidence, 'tests + screenshots');
      if (action === 'problem') assert.deepEqual(payload.problems, ['e2e timeout']);
    }
  }
  assert.throws(() => hookFields({ action: 'invented' }), /Unknown/);
  const candidate = { ...f.task, verification: { commit: 'abc', artifact: 'checks.json' } };
  const complete = await notificationPayload(f.runtime, candidate, { id: id(), kind: 'completed' }, 'grokbot');
  assert.equal(complete.action, 'approval'); assert.equal(complete.reply.command, `agent-plan accept ${f.task.id} abc`); assert.equal(complete.pr, undefined);
  const task = f.runtime.task(f.task.id);
  for (const kind of ['probe','health','noop']) {
    const event = { id: id(), kind, hook: { action: 'approval' } };
    assert.equal(await notificationPayload(f.runtime, task, event, 'grokbot'), null); task.events.push(event);
  }
  await f.runtime.save(task);
  await atomic(join(f.data, 'supervisor.json'), { webhook: { url: 'https://receiver.example.invalid/events', format: 'grokbot' } });
  await notify(f.runtime, async () => { assert.fail('Silent events must not send'); });
});

test('webhook config migrates legacy settings and prefers the private canonical file', async t => {
  const { data } = await fixture(t);
  const { loadWebhookConfig, validateWebhook } = await import('../runner/notifications.js');
  assert.equal(await loadWebhookConfig(data), null);
  const legacy = { webhook: { url: 'https://receiver.example.invalid/hooks', authorization: 'Bearer test-token', format: 'grokbot' }, since: '2026-01-01T00:00:00Z' };
  await atomic(join(data, 'supervisor.json'), legacy);
  assert.deepEqual(await loadWebhookConfig(data), legacy);
  await assert.rejects(readFile(join(data, 'supervisor.json')), { code: 'ENOENT' });
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(join(data, 'webhook.json'))).mode & 0o777, 0o600);
  await atomic(join(data, 'supervisor.json'), { obsolete: true });
  assert.deepEqual(await loadWebhookConfig(data), legacy);
  await writeFile(join(data, 'webhook.json'), 'invalid json');
  await assert.rejects(loadWebhookConfig(data), SyntaxError);
  validateWebhook(JSON.parse(await readFile(new URL('../webhook.example.json', import.meta.url), 'utf8')));
});

test('selected skills snapshot committed instructions and reach coordinators and workers', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.agents', 'skills', 'example'), { recursive: true });
  const source = '.agents/skills/example/SKILL.md';
  await writeFile(join(f.repo, source), 'Use the existing verifier.\n');
  const configPath = join(f.repo, '.runner', 'project.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.skills = [source];
  await writeFile(configPath, JSON.stringify(config));
  await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Select a skill');
  await writeFile(join(f.repo, source), 'Uncommitted replacement');
  const task = await f.call('owner', 'submit', null, { repo: f.repo, text: 'Use selected skills', requestId: id() });
  await f.call('owner', 'start', task.id);
  const main = f.runtime.task(task.id).agents[0];
  assert.equal(main.inbox[0].skills, 'skills.json');
  const manifest = await f.call('owner', 'read', task.id, { area: 'artifacts', path: 'skills.json' });
  assert.deepEqual(JSON.parse(manifest.content), [{ source, path: 'skills/0.md' }]);
  const skill = await f.call('owner', 'read', task.id, { area: 'artifacts', path: 'skills/0.md' });
  assert.equal(skill.content, 'Use the existing verifier.');
  await f.call('owner', 'write', task.id, { area: 'artifacts', path: 'assignment.md', content: 'Explore' });
  await f.call({ taskId: task.id, agentId: main.id }, 'spawn', task.id, { assignment: 'assignment.md', mode: 'explore' });
  assert.equal(f.runtime.task(task.id).agents[1].inbox[0].skills, 'skills.json');
  const { selectedSkills } = await import('../runner/skills.js');
  for (const path of ['../SKILL.md', '/tmp/SKILL.md', '.git/SKILL.md', 'missing/SKILL.md']) {
    await assert.rejects(selectedSkills(f.repo, task.base, [path]));
  }
  await assert.rejects(selectedSkills(f.repo, task.base, [source, source]), /Duplicate/);
});

test('UI gate imports fresh media, exposes supervisor/Grok references, and blocks missing or stale evidence', async t => {
  const f = await fixture(t); const task = f.runtime.task(f.task.id);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  task.config.uiEvidence = { command: 'ui' };
  task.config.commands.ui = [process.execPath, '-e', ''];
  let proof = await f.runtime.verify(task);
  assert.equal(proof.passed, false); assert.match(proof.uiEvidence.error, /ENOENT/);
  await f.artifact('ui-handoff.md');
  await assert.rejects(f.runtime.report(task, f.main, { status: 'completed', artifact: 'ui-handoff.md' }), /verification/);
  const script = `const fs=require('fs'),p=require('path'),e=process.env;fs.writeFileSync(p.join(e.RUNNER_UI_DIR,'screen.png'),Buffer.from('${png}','base64'));fs.writeFileSync(p.join(e.RUNNER_UI_DIR,'flow.webm'),Buffer.from([26,69,223,163,0]));fs.writeFileSync(p.join(e.RUNNER_UI_DIR,'manifest.json'),JSON.stringify({commit:e.RUNNER_UI_COMMIT,runId:e.RUNNER_UI_RUN_ID,passed:true,criteria:[{id:'AC-1',assertion:'Saved value is visible',passed:true,files:['screen.png','flow.webm']}]}));`;
  task.config.commands.ui = [process.execPath, '-e', script.replace('runId:e.RUNNER_UI_RUN_ID', "runId:'old-run'")];
  assert.equal((await f.runtime.verify(task)).passed, false);
  task.config.commands.ui = [process.execPath, '-e', script.replace('commit:e.RUNNER_UI_COMMIT', "commit:'old-commit'")];
  assert.equal((await f.runtime.verify(task)).passed, false);
  task.config.commands.ui = [process.execPath, '-e', script.replace("files:['screen.png','flow.webm']", 'files:[]')];
  assert.equal((await f.runtime.verify(task)).passed, false);
  task.config.commands.ui = [process.execPath, '-e', script];
  proof = await f.runtime.verify(task); assert.equal(proof.passed, true);
  const video = proof.uiEvidence.criteria[0].files[1].artifact;
  const metadata = await f.runtime.files(task, 'owner', 'read', { area: 'artifacts', path: video });
  assert.equal(metadata.mimeType, 'video/webm'); assert.equal(metadata.base64, undefined); assert(metadata.localPath);
  const bytes = await f.runtime.files(task, 'owner', 'read', { area: 'artifacts', path: video, includeMedia: true });
  assert.equal(Buffer.from(bytes.base64, 'base64').length, 5);
  await f.runtime.report(task, f.main, { status: 'completed', artifact: 'ui-handoff.md' });
  const event = task.events.findLast(e => e.kind === 'completed');
  assert.equal(event.evidence, proof.uiEvidence.artifact); assert.equal(event.attachments.length, 2);
  const { notificationPayload } = await import('../runner/notifications.js');
  const payload = await notificationPayload(f.runtime, task, event, 'grokbot');
  assert.equal(payload.attachments[0].mimeType, 'image/png');
  assert.equal(payload.attachments[1].retrieval.input.path, video); assert.equal(payload.attachments[1].base64, undefined);
  assert.match(payload.evidence, /json/);
  // Acceptance must rerun the configured gate, including after rebase.
  task.config.commands.ui = [process.execPath, '-e', 'process.exit(1)'];
  await assert.rejects(f.call('owner', 'accept', task.id, { commit: proof.commit }), /verification failed/);
  assert.equal(f.runtime.task(task.id).delivery.phase, 'needs-attention');
});

test('supervisor start launches once, auto-watches across restart and recovers a lost response', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  const { default: supervisor } = await import('../runner/supervisor-extension.js');
  const handlers = {}, commands = {}, entries = [], messages = []; let tool, loseResponse = true;
  const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, value) => { commands[name] = value; }, registerTool: value => { tool = value; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }), sendMessage: message => messages.push(message) };
  supervisor(pi, { request: async body => {
    const result = await f.runtime.execute('owner', body);
    if (body.action === 'start' && loseResponse) { loseResponse = false; throw new Error('Connection lost'); }
    return result;
  } });
  const ctx = { sessionManager: { getEntries: () => entries }, ui: { setStatus() {} } };
  handlers.session_start({}, ctx); t.after(() => handlers.session_shutdown());
  const input = { action: 'start', repo: f.repo, text: 'Agreed ticket requirements and acceptance criteria', requestId: 'ticket-launch' };
  await assert.rejects(tool.execute('first-call', input), /Task .*Connection lost.*Reuse requestId ticket-launch/);
  const task = [...f.runtime.tasks.values()].find(task => task.requestId === input.requestId);
  assert(task); assert.equal(task.agents.length, 1);
  assert(entries.at(-1).data.watched[task.id]);
  handlers.session_shutdown(); handlers.session_start({}, ctx);
  const result = JSON.parse((await tool.execute('retry-call', input)).content[0].text);
  assert.deepEqual(result, { taskId: task.id, status: 'running', watching: true });
  assert.equal(f.transport.starts.length, 2); // fixture coordinator plus the new coordinator
  assert.equal(f.runtime.tasks.size, 2);
  const brief = await f.call('owner', 'read', task.id, { area: 'artifacts', path: 'brief.md' });
  assert.equal(brief.content, input.text);
  await f.call('owner', 'write', task.id, { area: 'artifacts', path: 'question.md', content: 'Clarify scope' });
  await f.call({ taskId: task.id, agentId: task.agents[0].id }, 'ask', task.id, { artifact: 'question.md' });
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert(JSON.parse(messages[0].content).some(message => message.taskId === task.id && message.kind === 'decision'));
  const attached = JSON.parse((await tool.execute('attach-existing', { action: 'watch', taskId: f.task.id })).content[0].text);
  assert.equal(attached.watching, true); assert(entries.at(-1).data.watched[f.task.id]);
  await assert.rejects(tool.execute('invalid', { action: 'start', repo: f.repo, text: 'Missing retry identity' }), /requestId/);
  await assert.rejects(tool.execute('changed', { ...input, text: 'Different ticket' }), /different input/);
});

test('supervisor answers resume exact coordinator decisions without granting human approval', async t => {
  const f = await fixture(t); const { call, task, main, who, artifact } = f;
  await assert.rejects(call(who(main), 'supervisor-answer', task.id, { decisionId: 'missing', text: 'No' }), /Owner connection/);
  await artifact('routine.md', 'Which verifier should we use?');
  const question = await call(who(main), 'ask', task.id, { artifact: 'routine.md' });
  const input = { decisionId: question.decisionId, text: 'Use npm test, as agreed in the requirements.' };
  const receipt = id();
  const result = await call('owner', 'supervisor-answer', task.id, input, receipt);
  let current = f.runtime.task(task.id);
  assert.equal(current.status, 'running'); assert.equal(current.agents[0].status, 'running');
  assert.equal(current.decisions[0].answeredBy, 'supervisor');
  assert.equal(current.agents[0].inbox.at(-1).decisionId, question.decisionId);
  assert.equal(current.agents[0].inbox.at(-1).answeredBy, 'supervisor');
  assert.equal((await call('owner', 'read', task.id, { area: 'artifacts', path: result.artifact })).content, input.text);
  const restarted = new Runtime(f.data, { transport: f.transport }); await restarted.init();
  assert.deepEqual(await restarted.execute('owner', { action: 'supervisor-answer', taskId: task.id, input, requestId: receipt }), result);
  assert.equal(restarted.task(task.id).agents[0].inbox.filter(m => m.decisionId === question.decisionId).length, 1);
  await assert.rejects(call('owner', 'supervisor-answer', task.id, input), /already answered/);
  await assert.rejects(call('owner', 'supervisor-answer', task.id, { ...input, decisionId: 'wrong-task-decision' }), /Unknown decision/);
  await artifact('human.md', 'Expand the agreed scope?');
  await artifact('human-answer.md', 'Yes', 'owner');
  for (const classification of [{ requiresOwner: true }, { requiresOwner: false, hook: { action: 'pr-approval' } }]) {
    const q = await call(who(main), 'ask', task.id, { artifact: 'human.md', ...classification });
    current = f.runtime.task(task.id);
    assert.equal(current.decisions.at(-1).requiresOwner, true);
    if (classification.hook) { // Legacy tasks stored approval only on the event.
      delete current.decisions.at(-1).requiresOwner; await f.runtime.save(current);
    }
    await assert.rejects(call('owner', 'supervisor-answer', task.id, { decisionId: q.decisionId, text: 'Approve' }), /human owner/);
    assert.equal(f.runtime.task(task.id).status, 'waiting');
    await call('owner', 'answer', task.id, { decisionId: q.decisionId, artifact: 'human-answer.md' });
    assert.equal(f.runtime.task(task.id).decisions.at(-1).answeredBy, 'owner');
  }
  const cancelled = await call(who(main), 'ask', task.id, { artifact: 'routine.md' });
  await call('owner', 'cancel', task.id);
  await assert.rejects(call('owner', 'supervisor-answer', task.id, { decisionId: cancelled.decisionId, text: 'Late reply' }), /active coordinator/);
});
