import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig, projectConfigPath, validateExecution, runtimeCapabilities } from '../runner/project-config.js';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'project-config-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  return { repo, async save(file, value) {
    await mkdir(join(repo, file.split('/')[0]), { recursive: true });
    await writeFile(join(repo, file), JSON.stringify(value));
  } };
}

test('legacy config is preserved; canonical config takes precedence and malformed canonical fails', async t => {
  const f = await fixture(t);
  assert.equal((await loadProjectConfig(f.repo)).inferredSetup, true);
  assert.equal(await projectConfigPath(f.repo), join(f.repo, '.agent-plan/project.json'));
  const legacy = { commands: { test: ['npm', 'test'] }, verify: ['test'], maxWorkers: 3 };
  await f.save('.runner/project.json', legacy);
  assert.deepEqual(await loadProjectConfig(f.repo), legacy);
  assert.equal(await projectConfigPath(f.repo), join(f.repo, '.runner/project.json'));
  await f.save('.agent-plan/project.json', { ...legacy, maxWorkers: 2 });
  assert.equal((await loadProjectConfig(f.repo)).maxWorkers, 2);
  await writeFile(join(f.repo, '.agent-plan/project.json'), '{');
  await assert.rejects(loadProjectConfig(f.repo), SyntaxError);
  await f.save('.agent-plan/project.json', null);
  await assert.rejects(loadProjectConfig(f.repo), /config must be an object/);
});

test('local choices merge per role and cannot override checks, hosting, or credentials', async t => {
  const f = await fixture(t);
  const config = { commands: { test: ['npm', 'test'] }, verify: ['test'], execution: { mode: 'native', runtime: 'claude' }, agents: { implementation: { runtime: 'claude', model: 'owner-selected', provider: 'anthropic' }, review: { runtime: 'claude' } } };
  await f.save('.agent-plan/project.json', config);
  await f.save('.agent-plan/local.json', { agents: { implementation: { model: 'local-selected' } } });
  const merged = await loadProjectConfig(f.repo);
  assert.deepEqual(merged.agents.implementation, { runtime: 'claude', model: 'local-selected', provider: 'anthropic' });
  assert.deepEqual(merged.agents.review, config.agents.review);
  assert.deepEqual(merged.commands, config.commands);
  for (const invalid of [{ hosting: {} }, { verify: [] }, { token: 'secret' }, { agents: { review: { password: 'secret' } } }, { workerModels: { review: { apiKey: 'secret' } } }]) {
    await f.save('.agent-plan/local.json', invalid);
    await assert.rejects(loadProjectConfig(f.repo), /Unknown|Credentials/);
  }
});

test('configuration rejects unknown choices and credential fields', async t => {
  const f = await fixture(t);
  for (const config of [{ execution: { mode: 'other' } }, { execution: { runtime: 'other' } }, { execution: { executable: 'command' } }, { agents: { typo: { runtime: 'omp' } } }, { agents: { review: { runtime: 'omp', command: 'command' } } }, { hosting: { access_token: 'secret' } }]) {
    await f.save('.agent-plan/project.json', config);
    await assert.rejects(loadProjectConfig(f.repo), /Unknown|must|Credentials/);
  }
});

test('execution accepts OMP runner and packaged native bindings, rejects unavailable or mixed runtimes', async t => {
  assert.deepEqual(validateExecution({}), { mode: 'runner', runtime: 'omp' });
  assert.deepEqual(validateExecution({}, { mode: 'runner', runtime: 'omp' }), { mode: 'runner', runtime: 'omp' });
  for (const runtime of ['claude', 'codex']) assert.deepEqual(validateExecution({ execution: { mode: 'native', runtime }, agents: { review: { runtime } } }), { mode: 'native', runtime });
  assert.deepEqual(validateExecution({ execution: { mode: 'native', runtime: 'codex' }, agents: { review: { model: 'selected' } } }), { mode: 'native', runtime: 'codex' });
  for (const runtime of ['grok', 'cursor']) {
    const f = await fixture(t);
    const config = { execution: { mode: 'native', runtime } };
    await f.save('.agent-plan/project.json', config);
    assert.deepEqual(await loadProjectConfig(f.repo), config);
    assert.throws(() => validateExecution(config), /planned-unverified/);
  }
  assert.throws(() => validateExecution({ execution: { mode: 'runner', runtime: 'codex' } }), /no automatic runtime adapter/);
  assert.throws(() => validateExecution({ execution: { mode: 'native', runtime: 'omp' } }), /unsupported/);
  assert.throws(() => validateExecution({ execution: { mode: 'native', runtime: 'claude' }, agents: { review: { runtime: 'codex' } } }), /mixed-runtime delegation is not implemented/);
  assert.throws(() => validateExecution({ execution: { mode: 'native', runtime: 'claude' } }, { mode: 'runner', runtime: 'omp' }), /cannot execute as/);
  assert.equal(runtimeCapabilities.omp.runner, 'supported');
});
