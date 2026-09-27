import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMenu, chooseModel, reviewModel } from '../runner/models.js';

const task = config => ({ config, modelMenu: modelMenu(config), agents: [] });
const choice = (model, provider = 'configured') => ({ runtime: 'omp', model, provider });

test('canonical worker roles override legacy choices and preserve stage routing', () => {
  const config = { model: 'coordinator', provider: 'default', workerModels: { implementation: { model: 'legacy' } }, agents: {
    discovery: choice('discover'), planning: choice('plan'), implementation: choice('implement'),
    review: choice('review'), requirements: { runtime: 'omp', model: 'requirements' },
  } };
  const current = task(config);
  for (const [stage, expected] of Object.entries({ discovery: 'discover', architecture: 'plan', planning: 'plan', implementation: 'implement' })) {
    assert.deepEqual(chooseModel(current, {}, stage).selection, { model: expected, provider: 'configured' });
  }
  assert.deepEqual(chooseModel(current, { reviewRole: 'requirements' }, 'review').selection, { model: 'requirements', provider: 'configured' });
  assert.equal(chooseModel(current, { reviewRole: 'correctness' }, 'review').selection.model, 'review');
  assert.equal(chooseModel(current, { reviewRole: 'requirements', modelChoice: 'implementation' }, 'review').selection.model, 'implement');
  assert.equal(current.modelMenu.choices.requirements.runtime, undefined);
});

test('explicit review role models resolve as configured without fallback', async () => {
  for (const agents of [{ review: choice('review') }, { requirements: choice('requirements') }, { review: choice('review'), requirements: { runtime: 'omp', provider: 'role-provider' } }]) {
    const current = task({ model: 'default', provider: 'default', agents });
    const expected = chooseModel(current, { reviewRole: 'requirements' }, 'review');
    let observed;
    const result = await reviewModel(current, { reviewRole: 'requirements' }, {
      resolveModel: async selected => { observed = selected; return selected; },
      availableModels: async () => { throw Error('Explicit choices must not enumerate fallback models'); },
    }, 'commit');
    assert.deepEqual(observed, expected.selection);
    assert.deepEqual(result.selection, expected.selection);
    await assert.rejects(reviewModel(current, { reviewRole: 'requirements' }, {
      resolveModel: async () => { throw Error('Configured provider unavailable'); },
      availableModels: async () => [{ model: 'different', provider: 'other' }],
    }, 'commit'), /Configured provider unavailable/);
  }
});

test('a failed explicit review model requires resolution instead of another provider', async () => {
  const current = task({ agents: { correctness: choice('review') } });
  current.agents.push({ stage: 'review', base: 'commit', status: 'failed', modelSelection: { model: 'review', provider: 'configured' } });
  await assert.rejects(reviewModel(current, { reviewRole: 'correctness' }, {
    availableModels: async () => [{ model: 'other', provider: 'other' }],
  }, 'commit'), /Configured review model failed/);
});

test('legacy unspecified review can still prefer the opposite model family', async () => {
  const current = task({});
  current.agents.push({ mode: 'write', integrated: true, modelSelection: { model: 'gpt-test', provider: 'openai' } });
  const result = await reviewModel(current, {}, { availableModels: async () => [{ model: 'claude-test', provider: 'anthropic' }] }, 'commit');
  assert.equal(result.selection.provider, 'anthropic');
});
