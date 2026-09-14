import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
export const exec = promisify(execFile);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function assert(ok, message) { if (!ok) throw new Error(message); }
export function string(value, label, max = 10000) { assert(typeof value === 'string' && value.trim() && value.length <= max, `${label} must contain 1–${max} characters`); return value; }
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${id()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export async function git(cwd, ...args) { return (await exec('git', args, { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
export function inside(root, path) { const rel = relative(root, path); return !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel); }
export async function safePath(root, input, writing = false) {
  string(input, 'path', 4096);
  const path = resolve(root, input);
  assert(inside(root, path) && path !== root, 'Path must be inside its allowed root');
  assert(!relative(root, path).split('/').some(p => ['.git', '.pi'].includes(p)), 'Git and Pi internal files are protected');
  // Reject symlinks, including dangling links, before following any parent.
  let cursor = path;
  while (cursor !== root) {
    try { assert(!(await lstat(cursor)).isSymbolicLink(), 'Symlinks are not accessible'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    cursor = dirname(cursor);
  }
  const canonical = await realpath(root);
  assert(canonical === root, 'Root must be canonical');
  if (!writing) assert(inside(root, await realpath(path)), 'Path escaped its root');
  return path;
}
