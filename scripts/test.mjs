#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = split < 0 ? args : args.slice(0, split);
const extra = split < 0 ? [] : args.slice(split + 1);
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
});
if (options.includes('--help') || options.includes('-h')) {
  console.log('node scripts/test.mjs [filename-filter] [--list] [--watch] [--check] [-- node-test-options]');
} else if (options.includes('--check')) {
  for (const dir of ['runner', 'scripts', 'test']) {
    for (const name of await readdir(new URL(`../${dir}/`, import.meta.url))) {
      if (/\.(js|mjs)$/.test(name)) { const code = await run(['--check', `${dir}/${name}`]); if (code) process.exitCode = code; }
    }
  }
} else {
  const filters = options.filter(a => !a.startsWith('--'));
  const files = (await readdir(new URL('../test/', import.meta.url))).filter(name => name.endsWith('.test.js') && (!filters.length || filters.some(f => name.includes(f)))).sort().map(name => `test/${name}`);
  if (options.includes('--list')) console.log(files.join('\n'));
  else if (!files.length) { console.error('No matching tests'); process.exitCode = 1; }
  else process.exitCode = await run(['--test', ...(options.includes('--watch') ? ['--watch'] : []), ...extra, ...files]);
}
