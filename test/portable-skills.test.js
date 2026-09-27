import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBun } from '../runner/omp.js';
import { exec } from '../runner/io.js';
import { supervisorArgs } from '../runner/cli.js';

const root = fileURLToPath(new URL('../codex/agent-plan/', import.meta.url));
const names = ['architect', 'arena', 'blast-radius', 'how', 'open-pr', 'why'];

test('supervisor loads all six packaged skills through OMP with no discovery warnings', async t => {
  const args = supervisorArgs(['--continue']);
  const path = args[args.indexOf('--plugin-dir') + 1];
  const selected = args[args.indexOf('--skills') + 1].split(',');
  assert.equal(resolve(path), resolve(root));
  assert.deepEqual(selected.sort(), names);
  let bun;
  try { bun = await ensureBun(); } catch (error) { t.skip(error.message); return; }
  const state = await mkdtemp(join(tmpdir(), 'runner-omp-skills-'));
  let skills, warnings, bindings;
  try {
    const script = `
      const {injectPluginDirRoots}=await import('@oh-my-pi/pi-coding-agent/discovery/helpers');
      const {loadSkills}=await import('@oh-my-pi/pi-coding-agent/extensibility/skills');
      const {SkillProtocolHandler}=await import('@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol');
      const {parseInternalUrl}=await import('@oh-my-pi/pi-coding-agent/internal-urls/parse');
      await injectPluginDirRoots(process.argv[2],[process.argv[1]],process.argv[2]);
      const result=await loadSkills({cwd:process.argv[2],includeSkills:process.argv[3].split(',')});
      const handler=new SkillProtocolHandler();
      const bindings=await Promise.all(result.skills.map(async skill=>{
        const entry=await handler.resolve(parseInternalUrl('skill://'+skill.name),result);
        const link=entry.content.match(/\\]\\((references\\/execution.md)\\)/)?.[1];
        if(!link) throw Error('Missing local binding: '+skill.name);
        return (await handler.resolve(parseInternalUrl('skill://'+skill.name+'/'+link),result)).content;
      }));
      console.log(JSON.stringify({...result,bindings}));`;
    const { stdout } = await exec(bun, ['--eval', script, path, state, selected.join(',')], { env: { ...process.env, PI_CODING_AGENT_DIR: state }, timeout: 30000 });
    ({ skills, warnings, bindings } = JSON.parse(stdout));
  } finally { await rm(state, { recursive: true, force: true }); }
  assert.deepEqual(warnings, []);
  assert.deepEqual(skills.map(skill => skill.name).sort(), names);
  const binding = (await readFile(join(root, 'runner.md'), 'utf8')).replaceAll('(native.md)', '(../../../native.md)');
  assert.deepEqual(bindings, names.map(() => binding));
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-plan');
  assert.equal(resolve(root, manifest.skills), join(root, 'skills'));
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
