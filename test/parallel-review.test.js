import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, assertCandidateReviews } from '../runner/runtime.js';
import { git, id } from '../runner/io.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'parallel-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.runner'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Review Test');
  await writeFile(join(repo, 'value.txt'), 'base\n');
  await writeFile(join(repo, '.runner/project.json'), JSON.stringify({ commands: { test: [process.execPath, '-e', 'process.exit(0)'], setup: [process.execPath, '-e', 'process.exit(0)'] }, setup: 'setup', verify: ['test'], maxWorkers: 2, maxAttempts: 20 }));
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Fixture');
  const transport = { create: async (_task, agent) => ({ pane: agent.id, workspace: 'test' }), start: async () => {}, stop: async () => {} };
  const runtime = new Runtime(join(root, 'data'), { transport }); await runtime.init();
  const created = await runtime.create({ repo, text: 'Change value', requestId: id() });
  const task = runtime.task(created.id); await runtime.start(task);
  const assignment = await runtime.artifact(task, 'Inspect acceptance criteria, changed flow and recorded verification');
  await runtime.execute({ taskId: task.id, agentId: task.agents[0].id }, { action: 'clarify', requestId: id(), input: { artifact: assignment } });
  Object.assign(task, runtime.task(task.id));
  const spawn = async reviewRole => {
    const result = await runtime.spawn(task, { assignment, mode: 'explore', stage: 'review', reviewRole });
    return task.agents.find(a => a.id === result.workerId);
  };
  const report = async (agent, findings = [], extra = {}) => {
    const artifact = await runtime.artifact(task, JSON.stringify({ commit: agent.base, reviewRole: agent.reviewRole, scope: 'Full assigned scope', coverage: ['AC1 / value.txt / recorded verification'], findings, ...extra }), 'json', agent.artifactDir);
    return runtime.report(task, agent, { status: 'completed', artifact });
  };
  return { runtime, task, spawn, report, assignment, transport };
}

const finding = { severity: 'medium', file: 'value.txt', line: 1, description: 'Required value missing', evidence: 'AC1 requires improved', fix: 'Change value' };

test('role reviewers inspect a verified frozen candidate in parallel; blockers and missing coverage stop completion', async t => {
  const { runtime, task, spawn, report, assignment } = await fixture(t);
  await assert.rejects(spawn('requirements'), /Verify the exact candidate/);
  await runtime.verify(task);
  await assert.rejects(spawn('general'), /required reviewRole/);
  const requirements = await spawn('requirements');
  await assert.rejects(runtime.spawn(task, { assignment, mode: 'write' }), /frozen candidate/);
  const correctness = await spawn('correctness');
  assert.equal(requirements.base, correctness.base);
  assert.equal(correctness.inbox[0].review.previous.length, 0);
  await assert.rejects(spawn('requirements'), /capacity/);
  await assert.rejects(runtime.command(task, task.integration, 'test'), /frozen candidate/);
  await assert.rejects(runtime.verify(task), /Wait for workers/);
  await assert.rejects(report(requirements, [], { coverage: [] }), /explicit coverage/);
  await assert.rejects(report(requirements, [], { reviewRole: 'correctness' }), /assigned role/);
  await report(requirements);
  await report(correctness, [finding]);
  assert.throws(() => assertCandidateReviews(task, correctness.base), /correctness/);
  await assert.rejects(runtime.report(task, task.agents[0], { status: 'completed', artifact: assignment }), /correctness/);
  const adjudicator = await spawn('correctness'); await report(adjudicator);
  assertCandidateReviews(task, correctness.base);
  await runtime.report(task, task.agents[0], { status: 'completed', artifact: assignment });
  assert.equal(task.status, 'completed');
});

test('risk roles and review coverage persist; every changed candidate requires every role again', async t => {
  const { runtime, task, spawn, report, assignment, transport } = await fixture(t);
  const main = task.agents[0];
  const identity = { taskId: task.id, agentId: main.id };
  await runtime.execute(identity, { action: 'clarify', requestId: id(), input: { artifact: assignment, risks: ['security', 'database', 'data-safety', 'ui', 'performance', 'recovery', 'operator'] } });
  Object.assign(task, runtime.task(task.id));
  assert.deepEqual(task.reviewPolicy.requiredRoles, ['requirements', 'correctness', 'security', 'database', 'ui', 'performance', 'recovery']);
  await runtime.verify(task);
  for (const role of task.reviewPolicy.requiredRoles) await report(await spawn(role));
  const commit = task.verification.commit;
  assertCandidateReviews(task, commit);
  const restarted = new Runtime(runtime.root, { transport }); await restarted.init();
  assert.deepEqual(restarted.task(task.id).reviewPolicy, task.reviewPolicy);
  assert.equal(restarted.task(task.id).reviews[0].coverage.length, 1);
  await writeFile(join(task.integration.cwd, 'value.txt'), 'changed\n');
  await git(task.integration.cwd, 'add', '.'); await git(task.integration.cwd, 'commit', '-m', 'Changed candidate');
  await runtime.verify(task);
  assert.throws(() => assertCandidateReviews(task, task.verification.commit), /requirements/);
  await report(await spawn('requirements'));
  assert.throws(() => assertCandidateReviews(task, task.verification.commit), /correctness/);
});

test('new role reports reject a changed candidate; legacy tasks retain their original review contract', async t => {
  const { runtime, task, spawn, report } = await fixture(t);
  await runtime.verify(task);
  const reviewer = await spawn('requirements');
  await writeFile(join(task.integration.cwd, 'value.txt'), 'unreviewed\n');
  await assert.rejects(report(reviewer), /changed or verification is stale/);
  const commit = reviewer.base;
  const legacy = { reviewRequired: true, reviews: [{ commit, passed: true }] };
  assertCandidateReviews(legacy, commit);
  assert.throws(() => assertCandidateReviews(legacy, 'other'), /Fresh review/);
  assertCandidateReviews({ reviews: [] }, commit);
});

test('coordinator cannot clarify away a specialist blocker; repaired candidates rerun every declared role', async t => {
  const { runtime, task, spawn, report, assignment } = await fixture(t);
  const identity = { taskId: task.id, agentId: task.agents[0].id };
  const clarify = async risks => {
    await runtime.execute(identity, { action: 'clarify', requestId: id(), input: { artifact: assignment, risks } });
    Object.assign(task, runtime.task(task.id));
  };
  await clarify(['security']);
  await runtime.verify(task);
  await report(await spawn('requirements'));
  await report(await spawn('correctness'));
  await report(await spawn('security'), [finding]);
  await clarify([]);
  assert.deepEqual(task.reviewPolicy.risks, ['security']);
  assert.deepEqual(task.reviewPolicy.requiredRoles, ['requirements', 'correctness', 'security']);
  assert.throws(() => assertCandidateReviews(task, task.verification.commit), /security/);
  await assert.rejects(runtime.report(task, task.agents[0], { status: 'completed', artifact: assignment }), /security/);
  // Also reject older persisted policies that omitted an already-reviewed role.
  assert.throws(() => assertCandidateReviews({ ...task, reviewPolicy: { requiredRoles: ['requirements', 'correctness'] } }, task.verification.commit), /security/);
  await writeFile(join(task.integration.cwd, 'value.txt'), 'fixed\n');
  await git(task.integration.cwd, 'add', '.'); await git(task.integration.cwd, 'commit', '-m', 'Repair specialist finding');
  await runtime.verify(task);
  for (const role of task.reviewPolicy.requiredRoles) {
    assert.throws(() => assertCandidateReviews(task, task.verification.commit), new RegExp(role));
    await report(await spawn(role));
  }
  assertCandidateReviews(task, task.verification.commit);
});
