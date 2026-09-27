import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../runner/runtime.js';
import { git, id } from '../runner/io.js';

class FakeHerdr {
  agents = new Map();
  async create(task, agent) { return { pane: agent.id, tab: agent.id, workspace: task.workspace ?? 'fake' }; }
  async start(agent) { this.agents.set(agent.id, 'idle'); }
  async status(agent) { return this.agents.get(agent.id) ?? 'missing'; }
  async stop(agent) { this.agents.delete(agent.id); }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote'), data = join(root, 'data');
  await mkdir(join(repo, '.runner'), { recursive: true }); await mkdir(remote);
  await git(remote, 'init', '--bare', '-q'); await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@localhost'); await git(repo, 'config', 'user.name', 'Test');
  const hosting = { provider: 'github', host: 'github.com', project: 'owner/repo', remote: 'origin', target: 'main' };
  await writeFile(join(repo, 'value.txt'), 'base\n');
  await writeFile(join(repo, '.runner', 'project.json'), JSON.stringify({ hosting, commands: { test: [process.execPath, '-e', "if(!require('fs').readFileSync('value.txt','utf8').trim())process.exit(1)"] }, verify: ['test'], maxWorkers: 2 }));
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'Fixture'); await git(repo, 'remote', 'add', 'origin', remote);
  let request, creates = 0, merges = 0;
  const transport = new FakeHerdr();
  const adapter = {
    async find() { return request ? structuredClone(request) : null; },
    async read() { return structuredClone(request); },
    async create({ branch, body }) {
      creates++; const head = (await git(remote, 'rev-parse', `refs/heads/${branch}`));
      request = { number: 1, url: 'https://github.com/owner/repo/pull/1', state: 'open', head, branch, body, target: 'main', mergeable: true, ci: { state: 'passed', checks: [] } }; return structuredClone(request);
    },
    async update({ body }) { request.body = body; return structuredClone(request); },
    async merge({ head }) { assert.equal(head, request.head); merges++; request.state = 'merged'; },
    async uploadEvidence(path) { return { supported: true, url: `https://github.com/owner/repo/blob/evidence/${path.split('/').at(-1)}` }; }
  };
  const runtime = new Runtime(data, { transport, hostingFactory: () => adapter }); await runtime.init(); runtime.url = 'http://127.0.0.1:1';
  const call = (identity, action, taskId, input = {}, requestId = id()) => runtime.execute(identity, { action, taskId, input, requestId });
  const submitted = await call('owner', 'submit', null, { repo, text: 'Improve value', requestId: id() });
  const taskId = submitted.id;
  await call('owner', 'start', taskId);
  const current = () => runtime.task(taskId);
  const main = current().agents[0], who = agent => ({ taskId, agentId: agent.id });
  const artifact = async (actor, name, content) => {
    const path = actor === 'owner' || actor.id === main.id ? name : `${actor.artifactDir}/${name}`;
    await call(actor === 'owner' ? actor : who(actor), 'write', taskId, { area: 'artifacts', path, content }); return path;
  };
  await artifact(main, 'clarification.md', 'Change value using existing flow');
  await call(who(main), 'clarify', taskId, { artifact: 'clarification.md' });
  const prepare = async () => {
    await artifact(main, 'assignment.md', 'Update value.txt');
    const spawned = await call(who(main), 'spawn', taskId, { assignment: 'assignment.md', mode: 'write' });
    const worker = current().agents.find(agent => agent.id === spawned.workerId);
    await assert.rejects(call(who(worker), 'accept', taskId, { commit: worker.base }), /Owner/);
    await call(who(worker), 'write', taskId, { area: 'repo', path: 'value.txt', content: 'improved\n' });
    const handoff = await artifact(worker, 'handoff.md', 'Value improved');
    await call(who(worker), 'report', taskId, { status: 'completed', artifact: handoff });
    await call(who(main), 'integrate', taskId, { workerId: worker.id });
    const proof = await call(who(main), 'verify', taskId);
    await artifact(main, 'result.md', 'Improved value with verification and independent reviews');
    await assert.rejects(call(who(main), 'report', taskId, { status: 'completed', artifact: 'result.md' }), /Fresh clean requirements/);
    assert.equal(creates, 0);
    for (const role of ['requirements', 'correctness']) {
      const review = await call(who(main), 'spawn', taskId, { assignment: 'assignment.md', mode: 'explore', stage: 'review', reviewRole: role });
      const reviewer = current().agents.find(agent => agent.id === review.workerId);
      const report = await artifact(reviewer, 'review.json', JSON.stringify({ commit: proof.commit, scope: 'value change', reviewRole: role, coverage: ['value improvement and verification'], findings: [] }));
      await call(who(reviewer), 'report', taskId, { status: 'completed', artifact: report });
    }
    return { worker, commit: proof.commit };
  };
  const complete = () => call(who(main), 'report', taskId, { status: 'completed', artifact: 'result.md' });
  return { repo, data, hosting, runtime, adapter, taskId, current, main, who, call, artifact, prepare, complete, get request() { return request; }, get creates() { return creates; }, get merges() { return merges; } };
}

test('runtime snapshots hosting, publishes after clean role reviews, and requires owner exact-head acceptance', async t => {
  const f = await fixture(t); const { worker, commit } = await f.prepare();
  const projectFile = join(f.repo, '.runner', 'project.json');
  const changed = JSON.parse(await readFile(projectFile, 'utf8')); changed.hosting.target = 'different'; await writeFile(projectFile, JSON.stringify(changed));
  assert.deepEqual(f.current().config.hosting, f.hosting);
  await assert.rejects(f.call(f.who(f.main), 'accept', f.taskId, { commit }), /Owner/);
  await assert.rejects(f.call(f.who(worker), 'accept', f.taskId, { commit }), /Inactive|Owner/);
  await f.artifact(f.main, 'pr-description.md', 'Improve the value shown to users.');
  await f.call(f.who(f.main), 'report', f.taskId, { status: 'completed', artifact: 'result.md', descriptionArtifact: 'pr-description.md' });
  assert(f.request.body.startsWith('Improve the value shown to users.'));
  assert.equal(f.current().status, 'completed'); assert.equal(f.current().hosted.head, commit); assert.equal(f.creates, 1);
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'base\n');
  await assert.rejects(f.call('owner', 'accept', f.taskId, { commit: 'old' }), /Approval/);
  await f.call('owner', 'accept', f.taskId, { commit }); assert.equal(f.merges, 1);
  assert.equal(f.current().hosted.state, 'merged');
});

test('feedback resumes the same published task and invalidates candidate verification and approval', async t => {
  const f = await fixture(t); await f.prepare(); await f.complete();
  const before = f.current().agents.filter(agent => agent.role === 'orchestrator').length;
  f.current().hosted.approvedCommit = f.current().hosted.commit; await f.runtime.save(f.current());
  const feedback = await f.artifact('owner', 'feedback.md', 'Also improve the wording');
  await f.call('owner', 'feedback', f.taskId, { artifact: feedback });
  const task = f.current(); assert.equal(task.id, f.taskId); assert.equal(task.status, 'running'); assert.equal(task.verification, null);
  assert.equal(task.hosted.approvedCommit, undefined); assert.equal(task.hosted.number, 1);
  assert.equal(task.agents.filter(agent => agent.role === 'orchestrator').length, before);
  const coordinator = task.agents.find(agent => agent.id === f.main.id);
  assert.equal(coordinator.status, 'running');
  assert(coordinator.inbox.some(message => message.kind === 'owner-feedback' && message.artifact === feedback));
});

test('timed-out automatic publication retains intent and status reconciles before retry', async t => {
  const f = await fixture(t); await f.prepare();
  const create = f.adapter.create; f.adapter.create = async input => { await create(input); throw Error('provider timeout'); };
  await assert.rejects(f.complete(), /provider timeout/);
  assert.equal(f.current().operation.kind, 'hosted-publish'); assert.equal(f.current().operation.step, 'request');
  assert.notEqual(f.current().status, 'completed');
  await f.call('owner', 'hosted-status', f.taskId);
  assert.equal(f.current().operation, null);
  await f.complete(); assert.equal(f.current().status, 'completed'); assert.equal(f.creates, 1);
});

test('rejected hosted merge requires inspected evidence and unchanged authoritative request before explicit abort and fresh approval', async t => {
  const f = await fixture(t); const { commit } = await f.prepare(); await f.complete();
  const merge = f.adapter.merge;
  let attempts = 0;
  f.adapter.merge = async () => { attempts++; throw Error('Provider rejected protected branch merge'); };
  const acceptanceId = id();
  await assert.rejects(f.call('owner', 'accept', f.taskId, { commit }, acceptanceId), /protected branch/);
  const operation = f.current().operation;
  assert.equal(operation.kind, 'hosted-merge'); assert.equal(operation.commit, commit);
  assert.equal(f.current().hosted.approvedCommit, commit);
  await assert.rejects(f.call('owner', 'accept', f.taskId, { commit }, acceptanceId), /protected branch/);
  assert.equal(attempts, 1);
  const recover = input => f.call('owner', 'recover', f.taskId, { outcome: 'aborted', ...input });
  await assert.rejects(recover({ evidence: 'Inspected open request' }), /exact inspected/);
  await assert.rejects(recover({ expectedOperation: { ...operation, commit: 'changed' }, evidence: 'Inspected request' }), /operation changed/);
  await assert.rejects(recover({ expectedOperation: operation, evidence: '   ' }), /recovery evidence/);
  f.request.head = 'unapproved-head';
  await assert.rejects(recover({ expectedOperation: operation, evidence: 'Inspected request' }), /open and unchanged/);
  f.request.head = commit; f.request.target = 'different';
  await assert.rejects(recover({ expectedOperation: operation, evidence: 'Inspected request' }), /open and unchanged/);
  f.request.target = 'main'; f.request.state = 'closed';
  await assert.rejects(recover({ expectedOperation: operation, evidence: 'Inspected request' }), /open and unchanged/);
  assert.deepEqual(f.current().operation, operation);
  f.request.state = 'open';
  await recover({ expectedOperation: operation, evidence: 'Provider confirmed request is open at the approved head and target; protection rejection applied no merge.' });
  assert.equal(f.current().operation, null);
  assert.equal(f.current().hosted.approvedCommit, undefined);
  assert.equal(f.current().hosted.approvedAt, undefined);
  assert.match(f.current().events.findLast(event => event.kind === 'recovered').evidence, /protection rejection applied no merge/);
  f.adapter.merge = merge;
  await f.call('owner', 'accept', f.taskId, { commit });
  assert.equal(f.merges, 1); assert.equal(f.current().hosted.state, 'merged');
});
