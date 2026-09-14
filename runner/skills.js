import { posix } from 'node:path';
import { assert, git } from './io.js';

// Selected instructions come from the same committed tree as the task's code.
export async function selectedSkills(repo, base, paths = []) {
  assert(Array.isArray(paths) && paths.length <= 20, 'skills must be an array of at most 20 repository SKILL.md paths');
  assert(new Set(paths).size === paths.length, 'Duplicate skill path');
  const skills = [];
  for (const source of paths) {
    assert(typeof source === 'string' && !source.includes('\\') && !source.includes('\0') && !posix.isAbsolute(source) && source.split('/').every(p => p && !['.', '..', '.git', '.pi'].includes(p)) && posix.basename(source) === 'SKILL.md', 'Use a repository-relative SKILL.md path outside Git/Pi internals');
    const entry = await git(repo, 'ls-tree', base, '--', source);
    assert(/^100(?:644|755) blob /.test(entry), `Selected skill must be a committed regular file: ${source}`);
    const content = await git(repo, 'show', `${base}:${source}`);
    assert(content.length > 0 && content.length <= 100000, 'Selected skill must contain 1–100000 characters');
    skills.push({ source, path: `skills/${skills.length}.md`, content });
  }
  return skills;
}
