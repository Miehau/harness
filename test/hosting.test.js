import test from 'node:test';
import assert from 'node:assert/strict';
import { createHosting, discoverHosting, validateHosting, validateRemote } from '../runner/hosting.js';

const sha = 'a'.repeat(40);
const github = { provider: 'github', project: 'owner/repo', target: 'main' };
const gitlab = { provider: 'gitlab', host: 'git.example.test:8443', project: 'group/subgroup/repo', target: 'main' };
function mock(responses) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    assert(responses.length, 'Unexpected external command');
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result) };
  };
  return { exec, calls };
}
function pr(extra = {}) {
  return { number: 3, url: 'https://github.com/owner/repo/pull/3', state: 'OPEN', headRefOid: sha, headRefName: 'runner/task', baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }], ...extra };
}
function mr(extra = {}) {
  return { iid: 4, web_url: 'https://git.example.test/group/subgroup/repo/-/merge_requests/4', state: 'opened', sha, source_branch: 'runner/task', target_branch: 'main', source_project_id: 7, target_project_id: 7, detailed_merge_status: 'mergeable', head_pipeline: { status: 'success', sha }, ...extra };
}

test('hosting validation and remote hints require an explicit self-hosted provider', async () => {
  assert.deepEqual(validateHosting(github), { ...github, remote: 'origin', host: 'github.com' });
  for (const value of [{ ...github, provider: 'other' }, { ...github, host: 'https://github.com' }, { ...github, project: '../repo' }, { ...github, target: '-main' }, { ...github, target: 'a..b' }, { ...github, target: 'a/.hidden' }]) assert.throws(() => validateHosting(value));
  const one = mock(['git@git.example.test:group/subgroup/repo.git', 'origin/trunk']);
  assert.deepEqual(await discoverHosting('/repo', { provider: 'gitlab' }, one), { provider: 'gitlab', host: 'git.example.test', project: 'group/subgroup/repo', remote: 'origin', target: 'trunk' });
  const two = mock(['ssh://git@git.example.test/group/repo.git']);
  await assert.rejects(discoverHosting('/repo', {}, two), /explicitly/);
  const three = mock(['https://github.com/owner/repo.git', new Error('no symbolic ref')]);
  assert.equal((await discoverHosting('/repo', {}, three)).target, 'main');
});

test('GitHub reconciles publication and merges with an atomic head constraint', async () => {
  const fake = mock([[[{ number: 3 }]], pr(), pr(), { merged: true }, pr({ state: 'MERGED' })]);
  const host = createHosting(github, fake);
  assert.equal((await host.find('runner/task')).number, 3);
  assert.equal((await host.merge({ number: 3, head: sha })).state, 'merged');
  assert(fake.calls[3].args.includes(`sha=${sha}`));
  assert(fake.calls[3].args.includes('merge_method=merge'));
  assert(fake.calls[3].args.includes('PUT'));
  assert(fake.calls[0].args.includes('--slurp'));
  assert(fake.calls.every(call => call.command === 'gh'));
});

test('changed heads, failed checks and pending branch requirements stop before merge', async () => {
  for (const [remote, message] of [[pr({ headRefOid: 'b'.repeat(40) }), /head changed/], [pr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }), /CI/], [pr({ mergeStateStatus: 'BLOCKED' }), /CI/], [pr({ isDraft: true }), /CI/]]) {
    const fake = mock([remote]);
    await assert.rejects(createHosting(github, fake).merge({ number: 3, head: sha }), message);
    assert.equal(fake.calls.length, 1);
  }
  const pending = mock([pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] })]);
  assert.equal((await createHosting(github, pending).read(3)).ci.state, 'pending');
});

test('GitLab self-hosted APIs preserve namespace, reject fork matches, and constrain merge SHA', async () => {
  const fake = mock([[mr(), mr({ source_project_id: 8 })], mr(), mr(), {}, mr({ state: 'merged' })]);
  const host = createHosting(gitlab, fake);
  assert.equal((await host.find('runner/task')).number, 4);
  assert.equal((await host.merge({ number: 4, head: sha })).state, 'merged');
  assert(fake.calls[0].args[1].startsWith('projects/group%2Fsubgroup%2Frepo/merge_requests?'));
  assert(fake.calls[3].args.includes(`sha=${sha}`));
  assert(fake.calls.every(call => call.args.includes('git.example.test:8443')));
});

test('create and update preserve literal body fields; evidence support is honest', async () => {
  const body = 'Commit evidence\n$(do not execute) `literal`';
  const fake = mock([{ number: 3 }, pr(), pr(), {}, pr()]);
  const host = createHosting(github, fake);
  await host.create({ branch: 'runner/task', title: 'Change', body });
  await host.update({ number: 3, title: 'Updated', body });
  assert(fake.calls[0].args.includes(`body=${body}`));
  assert(fake.calls[3].args.includes('PATCH'));
  assert.equal((await host.uploadEvidence('/evidence.png')).supported, false);
  const upload = mock([]);
  const result = await createHosting(gitlab, upload).uploadEvidence('/tmp/screenshot.png');
  assert.equal(result.supported, false);
  assert.match(result.reason, /repository.*access controls/);
  assert.equal(upload.calls.length, 0);
});

test('ambiguous remote publication is surfaced instead of creating another PR', async () => {
  const fake = mock([[[{ number: 3 }, { number: 4 }]]]);
  await assert.rejects(createHosting(github, fake).find('runner/task'), /Multiple/);
});

test('push URL binding rejects a different project or multiple destinations', async () => {
  assert.deepEqual(await validateRemote('/repo', github, mock(['git@github.com:owner/repo.git'])), validateHosting(github));
  await assert.rejects(validateRemote('/repo', github, mock(['https://github.com/other/repo.git'])), /does not match/);
  await assert.rejects(validateRemote('/repo', github, mock(['https://github.com/owner/repo.git\nhttps://github.com/other/repo.git'])), /exactly one/);
});

test('GitLab stale pipeline success cannot authorize the new head', async () => {
  const fake = mock([mr({ head_pipeline: { status: 'success', sha: 'b'.repeat(40) } })]);
  await assert.rejects(createHosting(gitlab, fake).merge({ number: 4, head: sha }), /CI/);
  assert.equal(fake.calls.length, 1);
});
