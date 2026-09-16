import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const root = fileURLToPath(new URL('../claude/', import.meta.url));
const run = promisify(execFile);
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    assert(!entry.isSymbolicLink(), 'Plugin must not depend on files outside its package');
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}
const read = path => readFile(join(root, path), 'utf8');

test('native Claude package has no executable runtime, MCP config or escaping resource references', async () => {
  const manifest = JSON.parse(await read('.claude-plugin/plugin.json'));
  const marketplace = JSON.parse(await read('.claude-plugin/marketplace.json'));
  assert.equal(manifest.name, 'agent-plan');
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(resolve(root, marketplace.plugins[0].source), resolve(root));
  const paths = await files(root);
  for (const path of paths) {
    assert(/\.(md|json)$/.test(path), `Unexpected executable/dependency: ${path}`);
    assert.notEqual(relative(root, path), '.mcp.json');
    const content = await readFile(path, 'utf8');
    if (path.endsWith('.json')) { JSON.parse(content); continue; }
    // Bundled Markdown links must survive copying just claude/ to another location.
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(target)) continue;
      const destination = resolve(dirname(path), target.split('#')[0]);
      assert(destination.startsWith(resolve(root) + sep), `Escaping link: ${target}`);
      await readFile(destination);
    }
  }
  assert.equal(paths.filter(path => path.endsWith('SKILL.md')).length, 8);
});

test('native agent definitions restrict research/review and isolate writers without permission bypass', async () => {
  for (const name of ['researcher', 'reviewer', 'implementer']) {
    const text = await read(`agents/${name}.md`);
    const frontmatter = text.split('---')[1];
    assert.match(frontmatter, new RegExp(`^name: ${name}$`, 'm'));
    const tools = frontmatter.match(/^tools: (.+)$/m)[1].split(', ');
    assert.deepEqual(tools, name === 'implementer'
      ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] : ['Read', 'Glob', 'Grep']);
    assert.match(frontmatter, /^model: inherit$/m);
    assert.doesNotMatch(frontmatter, /permissionMode|mcpServers|hooks|background/);
    if (name === 'implementer') assert.match(frontmatter, /^isolation: worktree$/m);
  }
  const coordinator = (await read('agents/coordinator.md')).split('---')[1];
  assert.match(coordinator, /^tools: Read, Glob, Grep, Edit, Write, Bash, Agent, SendMessage, TaskStop$/m);
  assert.match(coordinator, /^isolation: worktree$/m);
  assert.match(coordinator, /^model: inherit$/m);
  assert.doesNotMatch(coordinator, /permissionMode|mcpServers/);
  for (const entry of await readdir(join(root, 'skills'))) {
    const content = await read(`skills/${entry}/SKILL.md`);
    assert.match(content, /\.\.\/\.\.\/workflows\//);
    if (entry !== 'status') assert.match(content.split('---')[1], /^disable-model-invocation: true$/m);
  }
});

test('native startup hook needs no helper program and stop prompt includes bounded completion checks', async t => {
  const hooks = JSON.parse(await read('hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop']);
  const startup = hooks.SessionStart[0].hooks[0];
  assert.equal(startup.type, 'command');
  assert.match(startup.command, /^printf '%s\\n' "[^"`\n]*"$/);
  assert.doesNotMatch(startup.command.replace('${CLAUDE_PLUGIN_ROOT}', ''), /\$/);
  const cwd = await mkdtemp(join(tmpdir(), 'native-claude-hook-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { stdout, stderr } = await run('/bin/sh', ['-c', startup.command], {
    cwd, env: { PATH: '/nonexistent', CLAUDE_PLUGIN_ROOT: '/plugin path/with spaces' }
  });
  assert.equal(stderr, '');
  assert.match(stdout, /\/plugin path\/with spaces\/workflows\/supervisor.md/);
  assert.deepEqual(await readdir(cwd), []);
  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, 'prompt');
  assert.match(stop.prompt, /\$ARGUMENTS/);
  assert.match(stop.prompt, /stop_hook_active/);
  assert.match(stop.prompt, /Agent Plan candidate:/);
  assert.match(stop.prompt, /not proof/);
});

test('ticket dispatch preserves supervisor to coordinator to worker hierarchy and nesting prerequisite', async () => {
  const start = await read('skills/start/SKILL.md');
  assert.match(start, /supervisor workflow/);
  assert.match(start, /Spawn one `agent-plan:coordinator`/);
  assert.match(start, /Do not dispatch researcher, implementer or reviewer/);
  const supervisor = await read('workflows/supervisor.md');
  assert.match(supervisor, /subagent_type: "agent-plan:coordinator"/);
  assert.match(supervisor, /2\.1\.219/);
  assert.match(supervisor, /CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1/);
  assert.match(supervisor, /supervisor\.md/);
  const task = await read('workflows/task.md');
  assert.match(task, /inside the ticket's `agent-plan:coordinator`/);
  assert.match(task, /coordinator, make these Agent calls/);
  const coordinator = await read('agents/coordinator.md');
  assert.match(coordinator, /status needs-input/);
  assert.match(coordinator, /settle all known children/);
});
