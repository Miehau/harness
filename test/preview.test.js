import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from '../runner/preview.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check) {
  for (let n = 0; n < 100; n++) { const result = await check(); if (result) return result; await delay(20); }
  assert.fail('Preview process did not reach expected state within 2 seconds');
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'runner-preview-'));
  const runtime = { dir: () => cwd, saved: [], save: async task => runtime.saved.push(structuredClone(task)) };
  const childScript = "console.log('child=' + process.pid); setInterval(() => {}, 1000)";
  const script = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio:'inherit'}); console.log('parent=' + process.pid); setInterval(() => {}, 1000)`;
  const task = { id: 'preview-test', integration: { cwd }, config: { commands: { preview: [process.execPath, '-e', script] }, preview: { command: 'preview', url: 'http://localhost:3000' } } };
  t.after(async () => {
    if (task.preview?.pid) { try { process.kill(-task.preview.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(cwd, { recursive: true, force: true });
  });
  return { runtime, task };
}

test('preview starts a real disposable process, captures output, reuses identity and stops its process group', async t => {
  const { runtime, task } = await fixture(t);
  const started = await preview(runtime, task);
  assert(started.pid > 0); assert(alive(started.pid));
  assert.equal(started.worktree, task.integration.cwd);
  assert.equal(started.url, 'http://localhost:3000');
  assert.match(started.readiness, /unverified/);
  const output = await until(async () => { const log = await readFile(started.log, 'utf8'); return /child=\d+/.test(log) && /parent=\d+/.test(log) && log; });
  const childPid = Number(output.match(/child=(\d+)/)[1]);
  assert(alive(childPid));
  assert.equal(runtime.saved[0].preview.pid, started.pid);
  const repeated = await preview(runtime, task);
  assert.equal(repeated.pid, started.pid); assert.equal(runtime.saved.length, 1);
  const stopped = await preview(runtime, task, { stop: true });
  assert(stopped.stoppedAt);
  await until(() => !alive(started.pid) && !alive(childPid));
  assert.equal(runtime.saved.at(-1).preview.stoppedAt, stopped.stoppedAt);
});

test('preview rejects missing/remote configuration and unavailable worktrees without launching', async t => {
  const { runtime, task } = await fixture(t);
  delete task.config.preview;
  await assert.rejects(preview(runtime, task), /Configure preview/);
  assert.equal(runtime.previews.size, 0);
  task.config.preview = { command: 'preview', url: 'https://example.com' };
  await assert.rejects(preview(runtime, task), /local HTTP/);
  task.cleanedAt = new Date().toISOString();
  await assert.rejects(preview(runtime, task), /unavailable/);
});

test('restarted runtime refuses to reuse or kill a live preview whose identity it cannot verify', async t => {
  const { runtime, task } = await fixture(t);
  const started = await preview(runtime, task);
  const restarted = { dir: runtime.dir, save: runtime.save };
  await assert.rejects(preview(restarted, structuredClone(task)), /identity is unverified after restart/);
  await assert.rejects(preview(restarted, structuredClone(task), { stop: true }), /identity is unverified after restart/);
  assert(alive(started.pid));
  await preview(runtime, task, { stop: true });
  await until(() => !alive(started.pid));
});

test('preview refuses to mark a SIGTERM-ignoring group stopped or permit checkout cleanup', async t => {
  const { runtime, task } = await fixture(t);
  task.config.commands.preview = [process.execPath, '-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"];
  const started = await preview(runtime, task);
  await until(async () => (await readFile(started.log, 'utf8')).includes('ready'));
  await assert.rejects(preview(runtime, task, { stop: true }), /did not stop within 2 seconds/);
  assert(alive(started.pid));
  assert.equal(task.preview.stoppedAt, undefined);
  assert.equal(runtime.saved.length, 1);
});

test('preview retains ownership when its launcher exits leaving server descendants', async t => {
  const { runtime, task } = await fixture(t);
  const server = "console.log('server=' + process.pid); setInterval(() => {}, 1000)";
  task.config.commands.preview = [process.execPath, '-e', `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{stdio:'inherit'}); child.unref();`];
  const started = await preview(runtime, task);
  const output = await until(async () => { const log = await readFile(started.log, 'utf8'); return /server=\d+/.test(log) && !alive(started.pid) && log; });
  const serverPid = Number(output.match(/server=(\d+)/)[1]);
  assert(alive(serverPid)); assert.equal(runtime.previews.get(task.id).pid, started.pid);
  assert.equal((await preview(runtime, task)).pid, started.pid);
  await preview(runtime, task, { stop: true });
  assert(!alive(serverPid)); assert(!runtime.previews.has(task.id));
});
