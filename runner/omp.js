import { fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { exec, assert, atomic } from './io.js';

export const ompCli = fileURLToPath(new URL('../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', import.meta.url));
export const ompVersion = '18.3.2';
export async function ensureBun() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const binary = resolve(directory, 'bun');
    try {
      await access(binary, constants.X_OK);
      const { stdout } = await exec(binary, ['--version']);
      const [major, minor, patch] = stdout.trim().split('.').map(Number);
      assert(major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 14))), 'OMP requires Bun >=1.3.14');
      return binary;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  }
  throw new Error('OMP requires Bun >=1.3.14 on PATH; install Bun before launching agents');
}

// Pi and OMP both use v3 JSONL headers; a header alone cannot prove compatibility.
export async function ensureOmpSession(session) {
  const marker = `${session}.backend.json`;
  let saved;
  try { saved = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved) {
    assert(saved.backend === 'omp' && saved.version === ompVersion, 'Session backend/version differs; retain this transcript and start a fresh OMP attempt');
    return;
  }
  try {
    await access(session);
    throw new Error('Unmarked Pi/legacy transcript cannot resume as OMP; retain it and start a fresh OMP attempt');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomic(marker, { backend: 'omp', version: ompVersion });
}

export async function guardSupervisorSessions(args) {
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    const match = args[i].match(/^(--cwd|--session-dir|--session|--resume|-r|--fork)(?:=(.*))?$/);
    if (match) flags.push({ name: match[1], value: match[2] ?? args[i + 1], index: i, inline: match[2] !== undefined });
  }
  const cwd = resolve(flags.findLast(flag => flag.name === '--cwd')?.value ?? process.cwd());
  let explicitFile = false;
  for (const { name, value: session, index, inline } of flags) {
    if (['--cwd', '--session-dir'].includes(name)) continue;
    // Match OMP's file-path detection; native IDs and the resume picker remain native.
    if (session && !session.startsWith('-') && (session.includes('/') || session.includes('\\') || session.endsWith('.jsonl'))) {
      const path = resolve(cwd, session);
      await ensureOmpSession(path); explicitFile = true;
      // OMP may auto-chdir from home; launch the exact path whose marker was checked.
      if (inline) args[index] = `${name}=${path}`; else args[index + 1] = path;
    }
  }
  const customDirectory = flags.some(flag => flag.name === '--session-dir') || process.env.PI_CODING_AGENT_SESSION_DIR;
  const selectsHistory = flags.some(flag => !['--cwd', '--session-dir'].includes(flag.name)) || args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).some(arg => ['--continue', '-c'].includes(arg));
  assert(!customDirectory || !selectsHistory || explicitFile, 'Custom session-directory history cannot prove OMP provenance; resume an explicit marked OMP transcript file instead');
}
