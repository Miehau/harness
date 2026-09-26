import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../runner/io.js';
import { serve } from '../runner/server.js';
import { main } from '../runner/cli.js';
import supervisor from '../runner/supervisor-extension.js';

test('onboarding retry forwards one request identity through supervisor and CLI to one task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-onboard-retry-'));
  const repo = join(root, 'repo'), data = join(root, 'state');
  const previous = process.env.RUNNER_DATA;
  let app, tool;
  try {
    await mkdir(join(repo, '.runner'), { recursive: true });
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'Runner Test');
    await writeFile(join(repo, 'verify.sh'), 'exit 0\n');
    await writeFile(join(repo, '.runner/project.json'), JSON.stringify({ commands: { test: ['bash', 'verify.sh'] }, verify: ['test'] }));
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Fixture');
    let launches = 0;
    const transport = { create: async () => ({ pane: 'test', tab: 'test', workspace: 'test' }), start: async () => { launches++; }, open: async agent => agent.place };
    app = await serve(data, { transport }); process.env.RUNNER_DATA = data;
    supervisor({ on() {}, registerCommand() {}, appendEntry() {}, registerTool(value) { tool = value; } }, { root: data, onboard: (path, requestId) => main(['onboard', path, '--request-id', requestId]) });
    const input = { action: 'onboard', repo, requestId: 'same-onboarding-request' };
    const first = await tool.execute('call-one', input), second = await tool.execute('call-two', input);
    assert.equal(JSON.parse(first.content[0].text).id, JSON.parse(second.content[0].text).id);
    assert.equal(app.runtime.tasks.size, 1); assert.equal(launches, 1);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_DATA; else process.env.RUNNER_DATA = previous;
    await app?.close(); await rm(root, { recursive: true, force: true });
  }
});
