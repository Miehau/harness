import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../runner/io.js';
import { publishCandidate, hostedStatus, mergeHosted } from '../runner/hosted-delivery.js';
import { publishEvidence } from '../runner/hosted-evidence.js';
import { notificationPayload } from '../runner/notifications.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-hosted-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote'), data = join(root, 'data');
  await Promise.all([mkdir(repo), mkdir(remote), mkdir(join(data, 'artifacts'), { recursive: true })]);
  await git(remote, 'init', '--bare', '-q'); await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@localhost'); await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'file'), 'candidate'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'Candidate');
  await git(repo, 'remote', 'add', 'origin', remote); const commit = await git(repo, 'rev-parse', 'HEAD');
  for (const path of ['brief.md', 'proof.json', 'result.md']) await writeFile(join(data, 'artifacts', path), path === 'brief.md' ? 'Implement the agreed requirement' : 'evidence');
  await writeFile(join(data, 'artifacts', 'proof.json'), JSON.stringify({ commit, passed: true, checks: [{ passed: true, artifact: 'command.json' }] }));
  await writeFile(join(data, 'artifacts', 'command.json'), JSON.stringify({ passed: true, output: 'command.log' }));
  await writeFile(join(data, 'artifacts', 'command.log'), 'Tests passed');
  const task = { id: 'task', title: 'Test task', status: 'completed', repo, createdAt: '2026-09-26T00:00:00Z', config: { hosting: { provider: 'github', host: 'github.com', project: 'owner/repo', target: 'main', remote: 'origin' } }, integration: { cwd: repo, branch: 'runner/task' }, verification: { passed: true, commit, artifact: 'proof.json' }, reviews: [], decisions: [], agents: [], events: [], result: 'result.md' };
  let request = null, creates = 0, merges = 0;
  const adapter = {
    find: async () => request,
    create: async ({ body }) => { creates++; request = { body, number: 1, url: 'https://github.com/owner/repo/pull/1', state: 'open', head: commit, branch: 'runner/task', target: 'main', ci: { state: 'passed' }, mergeable: true }; return request; },
    read: async () => structuredClone(request),
    update: async ({ body }) => { request.body = body; return structuredClone(request); },
    merge: async ({ head }) => { merges++; assert.equal(head, request.head); request.state = 'merged'; },
    uploadEvidence: async path => ({ url: `https://github.com/owner/repo/evidence/${path.split('/').at(-1)}` })
  };
  const runtime = { hostingFactory: () => adapter, dir: () => data, save: async () => {}, event: (task, kind, details) => task.events.push({ kind, ...details }), assertCandidateReviews: (_task, sha) => assert.equal(sha, commit) };
  return { runtime, task, adapter, commit, get creates() { return creates; }, get merges() { return merges; }, get request() { return request; } };
}

test('publication uploads evidence, pushes exact candidate and reconciles duplicate requests', async t => {
  const f = await fixture(t); const result = await publishCandidate(f.runtime, f.task);
  assert.equal(result.head, f.commit); assert.equal(result.evidence.length, 5); assert.equal(f.task.operation, null);
  assert.match(await git(f.task.repo, 'ls-remote', 'origin', 'refs/heads/runner/task'), new RegExp(f.commit));
  await publishCandidate(f.runtime, f.task); assert.equal(f.creates, 1);
  await mergeHosted(f.runtime, f.task, { commit: f.commit }); await mergeHosted(f.runtime, f.task, { commit: f.commit });
  assert.equal(f.merges, 1);
});

test('a timed-out create is recovered by reading existing request, without another create', async t => {
  const f = await fixture(t); const create = f.adapter.create;
  f.adapter.create = async input => { await create(input); throw Error('timeout'); };
  await assert.rejects(publishCandidate(f.runtime, f.task), /timeout/);
  assert.equal(f.task.operation.step, 'request');
  await hostedStatus(f.runtime, f.task); assert.equal(f.task.operation, null);
  assert.equal(f.task.events.filter(event => event.kind === 'published').length, 1);
  const recovered = f.task.events.find(event => event.kind === 'published');
  assert.equal(recovered.recovered, true); assert.equal(recovered.artifact, 'result.md'); assert.equal(recovered.commit, f.commit);
  const notification = await notificationPayload({ ...f.runtime, files: async () => ({ content: 'Recovered candidate handoff' }) }, f.task, recovered, 'grokbot');
  assert.equal(notification.action, 'approval');
  assert.equal(notification.reply.command, `agent-plan accept ${f.task.id} ${f.commit}`);
  await hostedStatus(f.runtime, f.task);
  await publishCandidate(f.runtime, f.task); assert.equal(f.creates, 1);
  assert.equal(f.task.events.filter(event => event.kind === 'published').length, 1);
});

test('missing evidence and failed reviews prevent a publishable candidate', async t => {
  const f = await fixture(t); f.runtime.assertCandidateReviews = () => { throw Error('Missing requirements review'); };
  await assert.rejects(publishCandidate(f.runtime, f.task), /Missing requirements/); assert.equal(f.creates, 0);
  f.runtime.assertCandidateReviews = () => {};
  f.adapter.uploadEvidence = async () => ({ supported: false, reason: 'Upload unavailable' });
  await assert.rejects(publishCandidate(f.runtime, f.task), /Upload unavailable/); assert.equal(f.creates, 0); assert.equal(f.task.operation.step, 'evidence');
});

test('stale approval, failed CI, wrong target and pending mergeability never merge', async t => {
  const f = await fixture(t); await publishCandidate(f.runtime, f.task);
  await assert.rejects(mergeHosted(f.runtime, f.task, { commit: 'old' }), /Approval/);
  f.request.head = 'new'; await assert.rejects(mergeHosted(f.runtime, f.task, { commit: f.commit }), /stale/); f.request.head = f.commit;
  f.request.ci.state = 'failed'; await assert.rejects(mergeHosted(f.runtime, f.task, { commit: f.commit }), /CI/); f.request.ci.state = 'passed';
  f.request.mergeable = false; await assert.rejects(mergeHosted(f.runtime, f.task, { commit: f.commit }), /mergeability/); f.request.mergeable = true;
  await assert.rejects(mergeHosted(f.runtime, f.task, { commit: f.commit, target: 'other' }), /target/);
  assert.equal(f.merges, 0);
});

test('uncertain merge is reconciled, not repeated', async t => {
  const f = await fixture(t); await publishCandidate(f.runtime, f.task); const merge = f.adapter.merge;
  f.adapter.merge = async input => { await merge(input); throw Error('timeout'); };
  await assert.rejects(mergeHosted(f.runtime, f.task, { commit: f.commit }), /timeout/);
  assert.equal(f.task.operation.kind, 'hosted-merge');
  assert.equal((await hostedStatus(f.runtime, f.task)).state, 'merged');
  await mergeHosted(f.runtime, f.task, { commit: f.commit }); assert.equal(f.merges, 1);
});

test('retrying an aborted revision completes evidence and body instead of trusting the retained request number', async t => {
  const f = await fixture(t); await publishCandidate(f.runtime, f.task);
  const published = f.task.hosted;
  f.task.hosted = { ...published, phase: 'needs-attention', evidence: [] };
  f.task.operation = null; // Owner inspected the failed publication and confirmed it aborted.
  f.request.body = 'Old handoff without current evidence';
  let uploads = 0, updates = 0;
  const upload = f.adapter.uploadEvidence, update = f.adapter.update;
  f.adapter.uploadEvidence = async path => { uploads++; return upload(path); };
  f.adapter.update = async input => { updates++; return update(input); };
  await publishCandidate(f.runtime, f.task);
  assert.equal(uploads, 5); assert.equal(updates, 1); assert.equal(f.creates, 1);
  assert.equal(f.task.hosted.phase, 'published'); assert.match(f.request.body, /## Evidence/);
  await publishCandidate(f.runtime, f.task);
  assert.equal(uploads, 5); assert.equal(updates, 1);
});

test('a new handoff invalidates the publication shortcut even on the same candidate head', async t => {
  const f = await fixture(t); await publishCandidate(f.runtime, f.task);
  await writeFile(join(f.runtime.dir(f.task), 'artifacts', 'updated-result.md'), 'New acceptance evidence');
  await publishCandidate(f.runtime, f.task, { artifact: 'updated-result.md' });
  assert.doesNotMatch(f.request.body, /New acceptance evidence/);
  assert.match(f.request.body, /updated-result.md/);
  assert(f.task.hosted.evidence.some(evidence => evidence.artifact === 'updated-result.md'));
  assert.equal(f.creates, 1);
});

test('status cannot reconcile an interrupted update from head alone when the body is stale', async t => {
  const f = await fixture(t); await publishCandidate(f.runtime, f.task);
  f.request.body = 'Stale request body';
  f.task.hosted.phase = 'needs-attention';
  f.task.operation = { kind: 'hosted-publish', step: 'request', commit: f.commit };
  await hostedStatus(f.runtime, f.task);
  assert.equal(f.task.operation.step, 'request');
  assert.equal(f.task.hosted.phase, 'needs-attention');
});

test('publication expands final command proofs and UI media while excluding historical captures', async t => {
  const f = await fixture(t); const root = join(f.runtime.dir(f.task), 'artifacts');
  for (const path of ['current.png', 'old.png', 'unbound.png', 'ui-1.png', 'ui-2.png', 'ui-3.png', 'ui-4.png', 'ui-5.png', 'ui.log']) await writeFile(join(root, path), path);
  await writeFile(join(root, 'ui-command.json'), JSON.stringify({ passed: true, output: 'ui.log' }));
  const ui = { commit: f.commit, passed: true, command: { passed: true, artifact: 'ui-command.json' }, criteria: [{ id: 'flow', files: ['ui-1.png', 'ui-2.png', 'ui-3.png', 'ui-4.png', 'ui-5.png'].map(artifact => ({ artifact })) }] };
  await writeFile(join(root, 'ui.json'), JSON.stringify(ui));
  await writeFile(join(root, 'proof.json'), JSON.stringify({ commit: f.commit, passed: true, checks: [{ passed: true, artifact: 'command.json' }], uiEvidence: { artifact: 'ui.json' } }));
  f.task.events = [{ kind: 'evidence-published', commit: f.commit, artifact: 'current.png' }, { kind: 'evidence-published', commit: 'old', artifact: 'old.png' }, { kind: 'evidence-published', artifact: 'unbound.png' }];
  await publishCandidate(f.runtime, f.task);
  const paths = f.task.hosted.evidence.map(item => item.artifact);
  for (const path of ['brief.md', 'proof.json', 'command.json', 'command.log', 'ui.json', 'ui-command.json', 'ui.log', 'ui-5.png', 'current.png']) assert(paths.includes(path), path);
  assert(!paths.includes('old.png')); assert(!paths.includes('unbound.png'));
});

test('missing command output stops publication instead of linking incomplete proof', async t => {
  const f = await fixture(t);
  await rm(join(f.runtime.dir(f.task), 'artifacts', 'command.log'));
  await assert.rejects(publishCandidate(f.runtime, f.task), /ENOENT/);
  assert.equal(f.creates, 0);
});

test('revised evidence for one product SHA creates separate immutable branches without rewriting either', async t => {
  const f = await fixture(t); const remote = await git(f.task.repo, 'remote', 'get-url', 'origin');
  f.task.hosted = { commit: f.commit };
  const options = { checkRemote: async () => remote };
  const first = await publishEvidence(f.runtime, f.task, ['brief.md', 'result.md'], options);
  await writeFile(join(f.runtime.dir(f.task), 'artifacts', 'revision.md'), 'Revised handoff');
  const second = await publishEvidence(f.runtime, f.task, ['brief.md', 'revision.md'], options);
  const retry = await publishEvidence(f.runtime, f.task, ['brief.md', 'revision.md'], options);
  assert.notEqual(first[0].evidenceCommit, second[0].evidenceCommit);
  assert.equal(second[0].evidenceCommit, retry[0].evidenceCommit);
  const refs = await git(f.task.repo, 'ls-remote', 'origin', `refs/heads/runner-evidence/${f.task.id}/${f.commit}/*`);
  assert.equal(refs.split('\n').length, 2);
  for (const evidence of [first[0], second[0]]) assert(refs.includes(`${evidence.evidenceCommit}\trefs/heads/runner-evidence/${f.task.id}/${f.commit}/${evidence.evidenceCommit}`));
});

test('GitLab evidence links use repository commit access rather than public upload URLs', async t => {
  const f = await fixture(t); const remote = await git(f.task.repo, 'remote', 'get-url', 'origin');
  f.task.config.hosting = { ...f.task.config.hosting, provider: 'gitlab', host: 'git.example.test', project: 'group/repo' };
  f.task.hosted = { commit: f.commit };
  const evidence = await publishEvidence(f.runtime, f.task, ['brief.md'], { checkRemote: async () => remote });
  assert.equal(evidence[0].url, `https://git.example.test/group/repo/-/blob/${evidence[0].evidenceCommit}/brief.md`);
  assert(!evidence[0].url.includes('/uploads/'));
});

test('publication uses a separate complete description and links full working documents as evidence', async t => {
  const f = await fixture(t);
  const root = join(f.runtime.dir(f.task), 'artifacts');
  const description = 'Fix empty-state rendering.\n\n' + 'Detailed relevant explanation. '.repeat(900) + 'END OF DESCRIPTION';
  await writeFile(join(root, 'description.md'), description);
  await writeFile(join(root, 'result.md'), 'INTERNAL HANDOFF SHOULD NOT BE INLINED');
  await publishCandidate(f.runtime, f.task, { descriptionArtifact: 'description.md' });
  assert(f.request.body.startsWith(description));
  assert.doesNotMatch(f.request.body, /INTERNAL HANDOFF|Implement the agreed requirement/);
  assert.match(f.request.body, /Full handoff.*result.md/);
  await writeFile(join(root, 'description-v2.md'), 'Revised reviewer summary');
  await publishCandidate(f.runtime, f.task, { descriptionArtifact: 'description-v2.md' });
  assert(f.request.body.startsWith('Revised reviewer summary'));
  await publishCandidate(f.runtime, f.task);
  assert(f.request.body.startsWith('Revised reviewer summary'));
  assert.equal(f.creates, 1);
});
