import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { json, assert } from './io.js';

export const dataRoot = () => resolve(process.env.RUNNER_DATA ?? join(homedir(), '.local', 'state', 'agent-plan'));
export async function connect(root = dataRoot()) {
  root = resolve(root);
  async function live() {
    let connection;
    try { connection = await json(join(root, 'connection.json')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    assert(typeof connection.token === 'string' && connection.token.length >= 64 && Number.isInteger(connection.port) && connection.port > 0 && connection.port <= 65535, 'Invalid runner connection descriptor');
    let response;
    try { response = await fetch(`http://127.0.0.1:${connection.port}/health`, { headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1500) }); }
    catch { return null; }
    let health;
    try { health = await response.json(); } catch { /* Non-JSON services are incompatible too. */ }
    assert(response.ok && health?.service === 'agent-plan-runner', `Runner health check failed for ${root} at 127.0.0.1:${connection.port} (HTTP ${response.status}). Check RUNNER_DATA and the process on that port before restarting.`);
    return connection;
  }
  const existing = await live(); if (existing) return existing;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const logPath = join(root, 'daemon.log'); const log = await open(logPath, 'a', 0o600);
  let failure;
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url)), root], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.once('error', error => { failure = error.message; }); child.unref();
  } finally { await log.close(); }
  // The server's exclusive lock elects one owner if two CLIs start together.
  for (let i = 0; i < 100; i++) {
    const ready = await live(); if (ready) return ready;
    if (failure) break;
    await sleep(100);
  }
  throw new Error(`Runner did not become ready${failure ? `: ${failure}` : ''}. See ${logPath}`);
}
