import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, now } from './io.js';

// One preview per task; its process group is retained until an explicit stop.
export async function preview(runtime, task, { stop = false } = {}) {
  assert(task.integration && !task.cleanedAt, 'Task worktree is unavailable');
  runtime.previews ??= new Map();
  if (task.preview?.pid) {
    const groupAlive = () => { try { process.kill(-task.preview.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const alive = groupAlive();
    if (alive) assert(runtime.previews.get(task.id)?.pid === task.preview.pid, 'Preview process identity is unverified after restart; inspect and stop it manually');
    if (stop) {
      if (alive) {
        try { process.kill(-task.preview.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        const deadline = Date.now() + 2000;
        while (groupAlive()) {
          assert(Date.now() < deadline, 'Preview process group did not stop within 2 seconds; retain its worktree and inspect it before cleanup');
          await delay(20);
        }
      }
      runtime.previews.delete(task.id);
      task.preview.stoppedAt = now(); await runtime.save(task); return task.preview;
    }
    if (alive && !task.preview.stoppedAt) return task.preview;
    assert(!alive, 'Previous preview is still stopping');
  }
  if (stop) return { stopped: true };
  const config = task.config.preview;
  assert(config && task.config.commands[config.command], 'Configure preview.command and preview.url during onboarding');
  const url = new URL(config.url);
  assert(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Preview URL must be local HTTP(S)');
  const [command, ...args] = task.config.commands[config.command];
  const logPath = join(runtime.dir(task), 'preview.log');
  const log = await open(logPath, 'a', 0o600);
  try {
    const child = spawn(command, args, { cwd: task.integration.cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    runtime.previews.set(task.id, child);
    child.once('exit', () => {
      // A launcher may exit while its server descendants keep the same group alive.
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code === 'ESRCH' && runtime.previews.get(task.id) === child) runtime.previews.delete(task.id); }
    });
    task.preview = { pid: child.pid, url: config.url, worktree: task.integration.cwd, log: logPath, startedAt: now(), stop: `agent-plan preview ${task.id} --stop` };
    await runtime.save(task); return { ...task.preview, readiness: 'unverified; inspect the URL and log' };
  } finally { await log.close(); }
}
