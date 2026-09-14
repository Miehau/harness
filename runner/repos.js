import { mkdir, readdir, readFile, writeFile, unlink, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assert, git } from './io.js';
import { dataRoot } from './connection.js';
const valid = name => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
const directory = () => join(dataRoot(), 'repos');

export async function resolveRepo(value) {
  if (!valid(value)) return resolve(value);
  let path;
  try { path = (await readFile(join(directory(), value + '.path'), 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return resolve(value); throw error; }
  try { return await realpath(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; throw Error(`Repository alias ${value} points to a missing directory; remove and register it again.`); }
}

export async function repos([command = 'list', name, path, ...extra]) {
  assert(['add', 'list', 'remove'].includes(command), 'Usage: agent-plan repo add NAME PATH | list | remove NAME');
  const dir = directory();
  if (command === 'list') {
    assert(!name, 'Usage: agent-plan repo list');
    let files; try { files = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(files.filter(f => f.endsWith('.path')).sort().map(async file => ({ alias: file.slice(0, -5), path: (await readFile(join(dir, file), 'utf8')).trim() })));
  }
  assert(typeof name === 'string' && valid(name), 'Alias must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit');
  assert(!extra.length && (command === 'add' ? path : !path), 'Usage: agent-plan repo add NAME PATH | remove NAME');
  const file = join(dir, name + '.path');
  if (command === 'remove') { await unlink(file); return { removed: name }; }
  const root = await realpath(resolve(path));
  assert(await git(root, 'rev-parse', '--show-toplevel') === root, 'Alias must point to a Git repository root');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writeFile(file, root + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; assert((await readFile(file, 'utf8')).trim() === root, `Alias ${name} already exists; remove it before changing its target`); }
  return { alias: name, path: root };
}
