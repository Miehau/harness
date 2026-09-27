import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../codex/agent-plan/', import.meta.url));
const lifecycle = ['start', 'onboard', 'status', 'recover', 'accept'];
const discussion = ['how', 'why', 'arena', 'architect', 'blast-radius', 'open-pr'];

test('native lifecycle is discoverable beside intact discussion entrypoints', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-plan');
  assert.equal(resolve(root, manifest.skills), resolve(root, 'skills'));
  assert(!manifest.mcpServers && !manifest.apps, 'native instructions require no daemon connector');
  for (const name of [...lifecycle, ...discussion]) {
    const text = await readFile(resolve(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert(text.startsWith('---\n'));
    assert.match(text, new RegExp(`\\nname: ${name}\\n`));
    assert.match(text, /\ndescription: .+/);
    const binding = lifecycle.includes(name) ? '../../native.md' : 'references/execution.md';
    assert(text.includes(`](${binding})`), `${name}: wrong execution binding`);
  }
});

test('native lifecycle references resolve inside the independently installed package', async () => {
  for (const name of ['native.md', ...lifecycle.map(name => `skills/${name}/SKILL.md`)]) {
    const path = resolve(root, name);
    const text = await readFile(path, 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const target = resolve(dirname(path), link.split('#')[0]);
      assert(!relative(root, target).startsWith('..'), `${name}: escaping package`);
      assert((await stat(target)).isFile(), `${name}: missing ${link}`);
    }
  }
});
