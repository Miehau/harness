import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPayload } from '../runner/notifications.js';

const commit = 'a'.repeat(40);
function fixture() {
  const task = {
    id: 'task-123', title: 'Improve the agreed feature', config: { hosting: { provider: 'gitlab' } },
    documents: { architecture: 'design.md', implementation: 'plan.md' }, clarification: { artifact: 'clarification.md' },
    reviewPolicy: { requiredRoles: ['requirements', 'correctness'] }, verification: { commit, artifact: 'verification.json' }, integration: { branch: 'runner/task-123' },
    hosted: { commit, head: commit, number: 17, url: 'https://git.example.test/group/repo/-/merge_requests/17', ci: { state: 'passed', checks: [{ name: 'test', state: 'success' }] }, evidence: [{ artifact: 'screenshot.png', url: 'https://git.example.test/uploads/hash/screenshot.png' }] }
  };
  const runtime = { files: async (_task, identity, action, input) => { assert.equal(identity, 'owner'); assert.equal(action, 'read'); return { content: `Requirement result from ${input.path}` }; } };
  return { task, runtime };
}

test('published approval includes full agreed journey, evidence links and exact-head owner command', async () => {
  const { task, runtime } = fixture();
  const result = await notificationPayload(runtime, task, { id: 'published-1', kind: 'published', artifact: 'result.md', at: '2026-09-26T10:00:00Z' }, 'grokbot');
  assert.equal(result.action, 'approval'); assert.equal(result.context.goal, task.title);
  assert.equal(result.context.brief, 'brief.md'); assert.deepEqual(result.context.agreedDocuments, task.documents);
  assert.equal(result.context.clarification, 'clarification.md'); assert.equal(result.context.candidate, commit);
  assert.deepEqual(result.context.reviewRoles, ['requirements', 'correctness']);
  assert.equal(result.context.request.provider, 'gitlab'); assert.equal(result.pr, 17); assert.equal(result.prUrl, task.hosted.url);
  assert.deepEqual(result.evidenceLinks, task.hosted.evidence);
  assert.match(result.evidence, /verification\.json/); assert.match(result.message, /Requirement result from result\.md/);
  assert.equal(result.reply.command, `agent-plan accept ${task.id} ${commit}`);
});

test('failed CI carries exact candidate context; pending and successful CI do not wake the bot', async () => {
  const { task, runtime } = fixture();
  for (const state of ['passed', 'pending']) assert.equal(await notificationPayload(runtime, task, { id: state, kind: 'ci-status', ci: { state } }, 'grokbot'), null);
  task.hosted.ci = { state: 'failed', checks: [{ name: 'test', state: 'failure', url: 'https://git.example.test/jobs/7' }] };
  const result = await notificationPayload(runtime, task, { id: 'failed-ci', kind: 'ci-status', ci: task.hosted.ci }, 'grokbot');
  assert.equal(result.action, 'problem'); assert.equal(result.context.candidate, commit); assert.deepEqual(result.context.request.ci, task.hosted.ci);
  assert.equal(result.context.request.url, task.hosted.url); assert.equal(result.reply.command, `agent-plan feedback ${task.id} /path/to/feedback.md`);
});
