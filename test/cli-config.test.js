import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { relative } from 'node:path';
import { tmpdir } from 'node:os';
import { main, supervisorProjectArgs, supervisorArgs, agentIgnore } from '../runner/cli.js';
import { git } from '../runner/io.js';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'cli-config-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init');
  return { repo, async save(file, config) {
    await mkdir(join(repo, file.split('/')[0]), { recursive: true });
    await writeFile(join(repo, file), JSON.stringify(config));
  } };
}

test('init creates canonical config and preserves existing legacy owner settings without local overrides', async t => {
  const f = await fixture(t);
  await main(['init', f.repo, '["npm","test"]']);
  assert.deepEqual(JSON.parse(await readFile(join(f.repo, '.agent-plan/project.json'), 'utf8')).commands.test, ['npm', 'test']);
  await main(['init', f.repo, '["other"]']);
  assert.deepEqual(JSON.parse(await readFile(join(f.repo, '.agent-plan/project.json'), 'utf8')).commands.test, ['npm', 'test']);
  const legacy = await fixture(t);
  const owner = { commands: { test: ['owner-check'] }, verify: ['test'], model: 'owner-model' };
  await legacy.save('.runner/project.json', owner);
  await legacy.save('.agent-plan/local.json', { model: 'private-model' });
  await main(['init', legacy.repo, '["ignored-check"]']);
  assert.deepEqual(JSON.parse(await readFile(join(legacy.repo, '.runner/project.json'), 'utf8')), owner);
  await assert.rejects(readFile(join(legacy.repo, '.agent-plan/project.json')), { code: 'ENOENT' });
});

test('offline config reports capabilities and unsupported execution without dumping commands', async t => {
  const f = await fixture(t);
  await f.save('.agent-plan/project.json', { commands: { test: ['private-value'] }, execution: { mode: 'native', runtime: 'cursor' } });
  const report = await main(['config', f.repo]);
  assert.equal(report.execution.supported, false);
  assert.match(report.execution.error, /planned-unverified/);
  assert.equal(report.capabilities.omp.runner, 'supported');
  assert.equal(report.file, join(f.repo, '.agent-plan/project.json'));
  assert.doesNotMatch(JSON.stringify(report), /private-value/);
  assert.match(await main(['help', 'config']), /without connecting/);
});

test('supervisor honors cwd and effective role settings; explicit model flags win', async t => {
  const f = await fixture(t);
  await f.save('.agent-plan/project.json', { agents: { supervisor: { runtime: 'omp', model: 'owner-model', provider: 'owner-provider' } } });
  await f.save('.agent-plan/local.json', { agents: { supervisor: { model: 'local-model' } } });
  const nested = join(f.repo, 'nested'); await mkdir(nested);
  const launch = await supervisorProjectArgs(['--cwd', nested]);
  assert.equal(launch.cwd, await realpath(nested));
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'local-model');
  assert.equal(launch.args[launch.args.indexOf('--provider') + 1], 'owner-provider');
  const explicit = await supervisorProjectArgs([`--cwd=${f.repo}`, '--model=explicit', '--provider', 'explicit-provider']);
  assert(explicit.args.includes('--model=explicit'));
  assert(!explicit.args.includes('local-model'));
  assert.equal(explicit.args[explicit.args.indexOf('--provider') + 1], 'explicit-provider');
  const relativeLaunch = await supervisorProjectArgs(['--cwd', relative(process.cwd(), f.repo)]);
  assert.equal(relativeLaunch.args[relativeLaunch.args.indexOf('--cwd') + 1], await realpath(f.repo));
  await f.save('.agent-plan/local.json', { execution: { mode: 'native', runtime: 'codex' } });
  await assert.rejects(main(['supervisor', '--cwd', f.repo]), /cannot execute as runner/);
});

test('runner commands reject native execution before connection or onboarding changes', async t => {
  const f = await fixture(t);
  await f.save('.agent-plan/local.json', { execution: { mode: 'native', runtime: 'claude' } });
  for (const args of [['onboard', f.repo], ['submit', f.repo, '/missing-brief'], ['start', f.repo, 'task']]) {
    await assert.rejects(main(args), /cannot execute as runner/);
  }
  await assert.rejects(readFile(join(f.repo, '.agent-plan/project.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.repo, '.gitignore')), { code: 'ENOENT' });
});

test('hosting updates canonical or legacy owner config without persisting local choices', async t => {
  for (const directory of ['.agent-plan', '.runner']) {
    const f = await fixture(t);
    const file = `${directory}/project.json`;
    await f.save(file, { execution: { mode: 'native', runtime: 'claude' }, model: 'owner-model' });
    await f.save('.agent-plan/local.json', { model: 'local-model' });
    await git(f.repo, 'remote', 'add', 'origin', 'https://gitlab.com/team/project.git');
    const result = await main(['hosting', f.repo, '--hosting-target', 'main']);
    assert.equal(result.configured, join(f.repo, file));
    const saved = JSON.parse(await readFile(join(f.repo, file), 'utf8'));
    assert.equal(saved.model, 'owner-model');
    assert.equal(saved.hosting.provider, 'gitlab');
    assert.equal(saved.hosting.project, 'team/project');
  }
});

test('OMP supervisor loads only original discussion skills and ignores private state', () => {
  const args = supervisorArgs([]);
  const names = args[args.indexOf('--skills') + 1].split(',');
  assert.deepEqual(names, ['how', 'why', 'arena', 'architect', 'blast-radius', 'open-pr']);
  assert(agentIgnore.includes('.agent-plan/local.json'));
  assert(agentIgnore.includes('.agent-plan/tasks/'));
});
