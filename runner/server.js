import { createServer } from 'node:http';
import { readFile, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataRoot } from './connection.js';
import { notify } from './notifications.js';
import { Runtime } from './runtime.js';
import { atomic, json, id, assert } from './io.js';

export async function serve(root, options = {}) {
  const runtime = new Runtime(root, options); await runtime.init(); root = runtime.root;
  const lockPath = join(root, 'daemon.lock');
  // A stale lock is removed only when its recorded process is certainly gone.
  try {
    const owner = await json(lockPath);
    assert(Number.isInteger(owner.pid) && owner.pid > 0, 'Invalid daemon lock; inspect it before removing');
    let alive = true; try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    assert(!alive, 'A runner daemon already owns this data directory'); await unlink(lockPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  let descriptor;
  try {
    try { descriptor = await json(join(root, 'connection.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; descriptor = { token: id() + id(), port: 0 }; }
    assert(typeof descriptor.token === 'string' && descriptor.token.length >= 64 && Number.isInteger(descriptor.port) && descriptor.port >= 0 && descriptor.port <= 65535, 'Invalid connection descriptor');
  } catch (e) { await unlink(lockPath); throw e; }
  const server = createServer(async (req, res) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const identity = typeof token === 'string' && token.length >= 64 ? (token === descriptor.token ? 'owner' : runtime.authenticate(token)) : null;
      const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && new URL(req.url, runtime.url).pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", 'cache-control': 'no-store' });
        res.end(await readFile(fileURLToPath(new URL('./dashboard.html', import.meta.url)))); return;
      }
      if (req.method === 'POST' && req.url === '/terminal-answer') {
        assert(!req.headers.origin || req.headers.origin === runtime.url, 'Unexpected origin');
        assert(typeof token === 'string' && token.length >= 64, 'Invalid terminal reply credential');
        let body = ''; for await (const chunk of req) { body += chunk; assert(Buffer.byteLength(body) <= 110000, 'Answer too large'); }
        send(await runtime.terminalAnswer(token, JSON.parse(body))); return;
      }
      if (!identity) { send({ error: 'Unauthorized' }, 401); return; }
      if (req.headers.origin && req.headers.origin !== runtime.url) { send({ error: 'Unexpected origin' }, 403); return; }
      if (req.method === 'GET' && req.url === '/health') { assert(identity === 'owner', 'Owner access required'); send({ service: 'agent-plan-runner' }); return; }
      if (req.method === 'GET' && req.url === '/tasks') { assert(identity === 'owner', 'Owner access required'); send([...runtime.tasks.values()].map(t => runtime.view(t))); return; }
      if (req.method === 'GET' && req.url === '/poll') { assert(identity !== 'owner', 'Agent access required'); send(runtime.poll(identity)); return; }
      assert(req.method === 'POST' && req.url === '/action', 'Unknown route');
      let body = ''; for await (const chunk of req) { body += chunk; assert(Buffer.byteLength(body) <= 1100000, 'Request too large'); }
      send(await runtime.execute(identity, JSON.parse(body)));
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  try { await new Promise((accept, reject) => { server.once('error', reject); server.listen(options.port ?? descriptor.port, '127.0.0.1', accept); }); }
  catch (e) { await unlink(lockPath); throw e; }
  descriptor.port = server.address().port;
  runtime.url = `http://127.0.0.1:${descriptor.port}`;
  try { await atomic(join(root, 'connection.json'), descriptor); } catch (e) { await new Promise(resolve => server.close(resolve)); await unlink(lockPath); throw e; }
  let notifying = false, notificationWork = Promise.resolve();
  const notifications = setInterval(() => { if (notifying) return; notifying = true; notificationWork = notify(runtime).catch(e => process.stderr.write(`Supervisor: ${e.message}\n`)).finally(() => { notifying = false; }); }, 5000); notifications.unref();
  let checking = false, reconciliationWork = Promise.resolve();
  const timer = setInterval(() => { if (checking) return; checking = true; reconciliationWork = runtime.reconcile().catch(e => process.stderr.write(`Reconciliation: ${e.message}\n`)).finally(() => { checking = false; }); }, 10000); timer.unref();
  return { runtime, descriptor, async close() { clearInterval(timer); clearInterval(notifications); await new Promise(resolve => server.close(resolve)); await Promise.all([runtime.tail, notificationWork, reconciliationWork]); await unlink(lockPath); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] ?? dataRoot());
  const app = await serve(root); process.stdout.write(JSON.stringify({ url: app.runtime.url, root }) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
