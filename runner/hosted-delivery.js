import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, git, now, safePath } from './io.js';
import { createHosting, validateHosting } from './hosting.js';
import { assertHostingRemote, publishEvidence } from './hosted-evidence.js';

const bodyDigest = text => createHash('sha256').update(text ?? '').digest('hex');
const publicationAttachments = task => (task.hosted?.evidence ?? []).map(e => e.artifact).filter(path => /\.png$/i.test(path)).slice(0, 4);

function host(runtime, task) {
  const config = validateHosting(task.config.hosting);
  assert(config, 'Configure hosting during onboarding first');
  return (runtime.hostingFactory ?? createHosting)(config);
}

async function candidate(runtime, task, commit) {
  assert(task.integration && !task.cleanedAt, 'Candidate worktree is unavailable');
  assert(commit === await git(task.integration.cwd, 'rev-parse', 'HEAD'), 'Candidate changed; inspect its current commit');
  assert(task.verification?.passed && task.verification.commit === commit, 'Fresh passing verification is required');
  runtime.assertCandidateReviews(task, commit);
  assert(!task.agents.some(a => a.role === 'worker' && ['starting', 'running', 'waiting'].includes(a.status)), 'Wait for workers before delivery');
  assert(!task.decisions.some(d => !d.answer), 'Unanswered decisions remain');
  assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Candidate worktree is dirty');
}

async function publicationPaths(runtime, task, artifact, commit) {
  const read = async path => JSON.parse(await readFile(await safePath(join(runtime.dir(task), 'artifacts'), path), 'utf8'));
  const proof = await read(task.verification.artifact);
  assert(proof.commit === commit && proof.passed === true && Array.isArray(proof.checks), 'Verification evidence must match the passing candidate');
  const paths = ['brief.md', task.verification.artifact, artifact, ...(task.reviews ?? []).filter(r => r.commit === commit).map(r => r.artifact), ...Object.values(task.documents ?? {}), task.clarification?.artifact];
  const commands = [...proof.checks];
  if (proof.uiEvidence) {
    const ui = await read(proof.uiEvidence.artifact);
    assert(ui.commit === commit && ui.passed === true, 'UI evidence must match the passing candidate');
    paths.push(proof.uiEvidence.artifact, ...(ui.criteria ?? []).flatMap(criterion => criterion.files.map(file => file.artifact)));
    commands.push(ui.command);
  }
  for (const command of commands) {
    assert(command?.passed === true && command.artifact, 'Verification command evidence is missing');
    const result = await read(command.artifact);
    assert(result.passed === true && typeof result.output === 'string', 'Verification command output is missing');
    paths.push(command.artifact, result.output);
  }
  paths.push(...(task.events ?? []).filter(event => event.kind === 'evidence-published' && event.commit === commit).map(event => event.artifact), ...(task.hostedEvidence ?? []).filter(evidence => evidence.commit === commit).map(evidence => evidence.artifact));
  return [...new Set(paths.filter(Boolean))];
}

// The intent is persisted before every remote mutation. An uncertain result is
// reconciled by hostedStatus; never repeat a create or merge merely on timeout.
export async function publishCandidate(runtime, task, { artifact = task.result, descriptionArtifact } = {}) {
  const adapter = host(runtime, task);
  const commit = task.verification?.commit;
  await candidate(runtime, task, commit);
  assert(!task.operation, 'Reconcile the interrupted operation before publishing');
  assert(task.hosted?.state !== 'merged', 'This task was already merged');
  const paths = await publicationPaths(runtime, task, artifact, commit);
  descriptionArtifact ??= task.hosted?.commit === commit ? task.hosted.descriptionArtifact : undefined;
  const description = descriptionArtifact
    ? await readFile(await safePath(join(runtime.dir(task), 'artifacts'), descriptionArtifact), 'utf8')
    : `${task.title}\n\nSee the linked handoff for changes, acceptance evidence and limitations.`;
  assert(description.trim(), 'PR/MR description must not be empty');
  if (descriptionArtifact && !paths.includes(descriptionArtifact)) paths.push(descriptionArtifact);
  const publicationFingerprint = bodyDigest(JSON.stringify({ format: 2, descriptionArtifact, description: bodyDigest(description), paths, artifact, documents: task.documents ?? {}, clarification: task.clarification?.artifact ?? null }));
  if (task.hosted?.phase === 'published' && task.hosted.commit === commit && task.hosted.number && task.hosted.publicationFingerprint === publicationFingerprint) {
    const current = await hostedStatus(runtime, task);
    assert(current.head === commit && current.target === task.config.hosting.target, 'Remote request changed; inspect before publishing');
    if (bodyDigest(current.body) === task.hosted.bodyDigest) return current;
  }
  const previous = task.hosted;
  task.hosted = { ...previous, phase: 'publishing', commit, publicationFingerprint, publicationArtifact: artifact, descriptionArtifact, branch: task.integration.branch, target: task.config.hosting.target, evidence: [], publishedAt: now() };
  task.operation = { kind: 'hosted-publish', commit, step: 'push', at: now() }; await runtime.save(task);
  try {
    if (!runtime.hostingFactory) await assertHostingRemote(task);
    // Ordinary push intentionally rejects rewritten remote history.
    await git(task.integration.cwd, 'push', task.config.hosting.remote, `${commit}:refs/heads/${task.integration.branch}`);
    task.operation.step = 'evidence'; await runtime.save(task);
    if (!runtime.hostingFactory) task.hosted.evidence = await publishEvidence(runtime, task, paths);
    else for (const path of paths) {
      task.operation.artifact = path; await runtime.save(task);
      const file = await safePath(join(runtime.dir(task), 'artifacts'), path);
      const uploaded = await adapter.uploadEvidence(file, { taskId: task.id, commit });
      assert(uploaded.url, uploaded.reason ?? 'Evidence upload returned no URL');
      task.hosted.evidence.push({ artifact: path, ...uploaded }); await runtime.save(task);
    }
    const labels = new Map([['brief.md', 'Original brief'], [artifact, 'Full handoff'],
      [task.verification.artifact, 'Verification results'], [task.clarification?.artifact, 'Agreed scope']]);
    const body = `${description}\n\n## Verified candidate\n\nCommit: ${commit}\n\n## Evidence\n\n${task.hosted.evidence.map(e => `- [${labels.get(e.artifact) ?? e.artifact}](${e.url})`).join('\n')}\n\nMerge requires explicit approval of this exact revision and passing required CI.\n\n<!-- agent-plan:${task.id} -->`;
    task.hosted.bodyDigest = bodyDigest(body);
    task.operation.step = 'request'; delete task.operation.artifact; await runtime.save(task);
    let request = await adapter.find(task.integration.branch);
    if (!request) request = await adapter.create({ branch: task.integration.branch, title: task.title, body });
    else if (adapter.update) request = await adapter.update({ number: request.number, title: task.title, body });
    const current = await adapter.read(request.number);
    assert(current.head === commit && current.target === task.config.hosting.target, 'Remote request does not match the reviewed candidate');
    assert(bodyDigest(current.body) === task.hosted.bodyDigest, 'Remote request body does not match the candidate evidence handoff');
    task.hosted = { ...task.hosted, ...current, commit, phase: 'published' };
    task.operation = null;
    runtime.event(task, 'published', { artifact, pr: current.number, url: current.url, commit, evidence: task.verification.artifact, attachments: publicationAttachments(task) });
    await runtime.save(task); return task.hosted;
  } catch (error) {
    task.hosted.phase = 'needs-attention';
    runtime.event(task, 'attention', { error: 'Hosted publication needs inspection; use hosted-status before retrying', artifact, commit });
    await runtime.save(task); throw error;
  }
}

export async function hostedStatus(runtime, task) {
  const adapter = host(runtime, task);
  let current = task.hosted?.number ? await adapter.read(task.hosted.number) : await adapter.find(task.integration.branch);
  if (current?.number) current = await adapter.read(current.number);
  if (!current) return { found: false, operation: task.operation, instruction: 'No PR/MR found. Inspect remote branch and retained publication intent before recovery.' };
  const operation = task.operation;
  const previousCI = task.hosted?.ci?.state;
  task.hosted = { ...task.hosted, ...current, checkedAt: now() };
  if (current.state === 'merged') {
    task.hosted.phase = 'merged';
    if (operation?.kind === 'hosted-merge') {
      assert(current.head === operation.commit, 'Merged request differs from approved revision; inspect remote history');
      task.operation = null;
    }
  } else if (operation?.kind === 'hosted-publish' && operation.step === 'request' && current.head === operation.commit && current.target === task.config.hosting.target && bodyDigest(current.body) === task.hosted.bodyDigest) {
    task.hosted.phase = 'published'; task.operation = null;
    runtime.event(task, 'published', { artifact: task.hosted.publicationArtifact ?? task.result, pr: current.number, url: current.url, commit: operation.commit, evidence: task.verification?.artifact, attachments: publicationAttachments(task), recovered: true });
  }
  if (previousCI !== current.ci?.state) runtime.event(task, 'ci-status', { commit: current.head, ci: current.ci, url: current.url });
  await runtime.save(task); return task.hosted;
}

export async function mergeHosted(runtime, task, input) {
  assert(task.status === 'completed', 'Only completed candidates can be merged');
  assert(task.hosted?.number, 'Publish the candidate before approval');
  assert(input.commit === task.hosted.commit, 'Approval must name the published candidate commit');
  const current = await hostedStatus(runtime, task);
  assert(current.head === input.commit, 'Remote head changed; approval is stale');
  if (current.state === 'merged') return current;
  assert(!task.operation, 'Reconcile the interrupted operation before merging');
  await candidate(runtime, task, input.commit);
  assert(current.state === 'open' && current.target === task.config.hosting.target, 'Remote request is closed or targets another branch');
  assert(['passed', 'none'].includes(current.ci?.state), 'Required remote CI has not passed');
  assert(current.mergeable === true, 'Provider has not confirmed mergeability');
  assert(!input.target || input.target === current.target, 'Approval target differs from published target');
  task.operation = { kind: 'hosted-merge', commit: input.commit, number: current.number, at: now() };
  task.hosted.approvedCommit = input.commit; task.hosted.approvedAt = now(); await runtime.save(task);
  try {
    await host(runtime, task).merge({ number: current.number, head: input.commit });
    const result = await hostedStatus(runtime, task);
    assert(result.state === 'merged', 'Merge outcome is uncertain; inspect hosted-status');
    runtime.event(task, 'merged', { commit: input.commit, url: result.url, target: result.target }); await runtime.save(task);
    return result;
  } catch (error) {
    runtime.event(task, 'attention', { error: 'Hosted merge outcome needs inspection; do not repeat without reconciling', commit: input.commit });
    await runtime.save(task); throw error;
  }
}
