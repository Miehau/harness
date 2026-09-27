import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checked-in resources make each native package independently distributable.
const check = process.argv.includes('--check');
const root = fileURLToPath(new URL('../', import.meta.url));
const discussion = ['how', 'why', 'arena', 'architect', 'blast-radius', 'open-pr'];
let stale = false;
async function files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Package resource must not be a symlink: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}
async function copy(destination, content) {
  if (!check) { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content); return; }
  let packaged;
  try { packaged = await readFile(destination, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (packaged !== content) { console.error(`Stale package resource: ${destination}`); stale = true; }
}
for (const target of ['claude/shared', 'codex/agent-plan/shared']) {
  for (const name of ['contract.md', 'task-record.md', 'policy.json']) {
    await copy(join(root, target, name), await readFile(join(root, 'workflow', name), 'utf8'));
  }
}
for (const name of discussion) {
  const source = join(root, 'codex/agent-plan/skills', name);
  const destination = join(root, 'claude/skills', name);
  const expected = new Set();
  // OMP skill:// reads are rooted at the skill directory, so upward binding
  // links cannot be resolved there. Keep one source and package a local copy.
  await copy(join(source, 'references/execution.md'),
    (await readFile(join(root, 'codex/agent-plan/runner.md'), 'utf8'))
      .replaceAll('(native.md)', '(../../../native.md)'));
  for (const path of await files(source)) {
    const local = relative(source, path);
    if (local === 'references/execution.md') continue;
    expected.add(local);
    let content = await readFile(path, 'utf8');
    if (local === 'SKILL.md') content = content.replaceAll('(references/execution.md)', '(../../workflows/supervisor.md)')
      .replace('---\n\n', '---\n\nRead [the common workflow contract](../../shared/contract.md) and\n[the common task record](../../shared/task-record.md). Follow the native Claude\nsupervisor binding; discussion skills do not expand tool permissions.\n\n');
    if (local === 'SKILL.md' && ['architect', 'arena'].includes(name)) {
      content = content.replace('# ' + (name === 'architect' ? 'Architect' : 'Arena'),
        'For native Claude, follow [mixed-model architecture](../../workflows/second-model.md):\n' +
        '2–3 Claude proposals plus one Codex proposal in separate worktrees, then a fresh\n' +
        'Codex judge recommending one approach to the user. This binding overrides the\n' +
        'generic roster and judge fallback below. Each report includes work done, learnings,\n' +
        'pros and cons. Candidate review pairs Claude with background Codex.\n\n# ' +
        (name === 'architect' ? 'Architect' : 'Arena'));
    }
    await copy(join(destination, local), content);
  }
  for (const path of await files(destination)) if (!expected.has(relative(destination, path))) {
    if (check) { console.error(`Obsolete generated skill resource: ${path}`); stale = true; }
    else await rm(path);
  }
}
await copy(join(root, 'claude/THIRD_PARTY_NOTICES.md'), await readFile(join(root, 'codex/agent-plan/THIRD_PARTY_NOTICES.md'), 'utf8'));
if (stale) { console.error('Run npm run package:workflows and commit the generated resources.'); process.exitCode = 1; }
