import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { supervisorArgs } from '../runner/cli.js';

const root = fileURLToPath(new URL('../codex/agent-plan/', import.meta.url));
const names = ['architect', 'arena', 'blast-radius', 'how', 'open-pr', 'why'];

test('supervisor loads all six packaged skills through Pi with no discovery warnings', async () => {
  const args = supervisorArgs(['--continue']);
  const path = args[args.indexOf('--skill') + 1];
  assert.equal(resolve(path), join(root, 'skills'));
  const { skills, diagnostics } = loadSkillsFromDir({ dir: path, source: 'local' });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skills.map(skill => skill.name).sort(), names);
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-plan');
  assert.equal(resolve(root, manifest.skills), resolve(path));
});

test('ported prompts retain attribution and all local links resolve within the package', async () => {
  const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.md'));
  assert(paths.some(path => path.includes('why/references/sources/code-archaeology.md')));
  assert(paths.some(path => path.includes('architect/references/runner-prompt.md')));
  for (const path of paths) {
    const content = await readFile(join(root, path), 'utf8');
    assert.doesNotMatch(content, /\.cursor|AskQuestion|\/loop|control-ui|control-cli/, path);
    for (const [, link] of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const target = resolve(dirname(join(root, path)), link.split('#')[0]);
      assert(!relative(root, target).startsWith('..'), `${path}: escaping reference ${link}`);
      assert((await stat(target)).isFile(), `${path}: missing reference ${link}`);
    }
  }
  const notice = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notice, /pstack 0\.15\.2 by Lauren Tan/);
  assert.match(notice, /MIT License/);
});
