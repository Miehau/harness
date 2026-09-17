import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { assert, git, now } from './io.js';

export function dirty(output) {
  return output.split('\n').some(line => {
    if (!line) return false;
    if (line.startsWith('??')) {
      const path = line.slice(3);
      if (path === '.runner/answers' || path.startsWith('.runner/answers/')) return false;
    }
    return true;
  });
}

export async function rebaseInProgress(cwd) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = await git(cwd, 'rev-parse', '--git-path', name);
    try { await stat(resolve(cwd, path)); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

export async function accept(runtime, task, input) {
  assert(task.status === 'completed', 'Only completed candidates can be accepted');
  if (task.delivery?.phase === 'merged') {
    assert(input.commit === task.delivery.approvedCommit || input.commit === task.delivery.commit, 'A different candidate was already merged');
    return task.delivery;
  }
  assert(!task.operation, 'Recover the interrupted operation before accepting');
  const cwd = task.integration.cwd;
  assert(!await rebaseInProgress(cwd), 'Resolve or abort the current rebase first');
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  assert(input.commit === commit, 'Candidate changed; inspect and accept its current commit');
  assert(task.verification?.passed && task.verification.commit === commit, 'Verify this candidate before accepting');
  assert(!await git(cwd, 'status', '--porcelain'), 'Candidate worktree is dirty');
  const target = input.target ?? 'main';
  await git(task.repo, 'check-ref-format', '--branch', target);
  assert(await git(task.repo, 'symbolic-ref', '--short', 'HEAD') === target, `Check out ${target} in the source repository before accepting`);
  assert(!dirty(await git(task.repo, 'status', '--porcelain')), 'Source repository must be clean before accepting');
  const before = await git(task.repo, 'rev-parse', `refs/heads/${target}`);
  const base = task.delivery?.rebasedOnto ?? task.base;
  await git(cwd, 'merge-base', '--is-ancestor', base, commit);
  task.delivery = { phase: 'rebasing', target, before, rebasedOnto: base, approvedCommit: commit, acceptedAt: now() };
  task.operation = { kind: 'accept-rebase', before: commit, targetBefore: before, at: now() }; await runtime.save(task);
  try {
    await git(cwd, 'rebase', '--onto', before, base);
    task.delivery.rebasedOnto = before;
    task.operation = null; task.verification = null; task.delivery.phase = 'verifying'; await runtime.save(task);
    const proof = await runtime.verify(task);
    assert(proof.passed, `Rebased verification failed; see ${proof.artifact}`);
    assert(await git(task.repo, 'symbolic-ref', '--short', 'HEAD') === target, 'Source checkout changed during verification');
    assert(await git(task.repo, 'rev-parse', 'HEAD') === before, 'Target branch advanced; inspect the candidate and accept again');
    assert(!dirty(await git(task.repo, 'status', '--porcelain')), 'Source repository changed during verification');
    const merged = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'merge-base', '--is-ancestor', before, merged);
    task.delivery.phase = 'merging'; task.delivery.commit = merged;
    task.operation = { kind: 'accept-merge', before, commit: merged, target, at: now() }; await runtime.save(task);
    await git(task.repo, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', merged);
    const finished = structuredClone(task); finished.operation = null; finished.delivery.phase = 'merged'; finished.delivery.mergedAt = now();
    runtime.event(finished, 'merged', { commit: merged, target, artifact: proof.artifact }); await runtime.save(finished);
    return finished.delivery;
  } catch (error) {
    task.delivery.phase = 'needs-attention';
    runtime.event(task, 'attention', { error: 'Acceptance stopped; inspect retained Git state and verification', artifact: task.verification?.artifact });
    await runtime.save(task); throw error;
  }
}

export async function recoverDelivery(runtime, task, input) {
  const operation = task.operation;
  assert(['applied', 'aborted'].includes(input.outcome), 'Specify recovery outcome applied or aborted');
  assert(!await rebaseInProgress(task.integration.cwd), 'Finish or abort the rebase before recovery');
  assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Candidate must be clean before recovery');
  if (operation.kind === 'accept-merge') {
    const targetHead = await git(task.repo, 'rev-parse', `refs/heads/${operation.target}`);
    if (input.outcome === 'applied') {
      await git(task.repo, 'merge-base', '--is-ancestor', operation.commit, targetHead);
      assert(task.verification?.passed && task.verification.commit === operation.commit, 'Missing verification for merged commit');
      task.delivery.phase = 'merged'; task.delivery.mergedAt = now();
      runtime.event(task, 'merged', { commit: operation.commit, target: operation.target, recovered: true });
    } else { assert(targetHead === operation.before, 'Target branch changed; cannot confirm aborted merge'); task.delivery.phase = 'review-required'; }
  } else {
    if (input.outcome === 'aborted') assert(await git(task.integration.cwd, 'rev-parse', 'HEAD') === operation.before, 'Candidate differs from pre-rebase commit');
    if (input.outcome === 'applied') { await git(task.integration.cwd, 'merge-base', '--is-ancestor', operation.targetBefore, await git(task.integration.cwd, 'rev-parse', 'HEAD')); task.delivery.rebasedOnto = operation.targetBefore; }
    task.delivery.phase = 'review-required'; task.verification = null;
  }
  runtime.event(task, 'recovered', { operation }); task.operation = null; await runtime.save(task); return runtime.view(task);
}
