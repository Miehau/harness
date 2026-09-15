import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supervisor from '../runner/supervisor-extension.js';

test('supervisor watches exact decisions, persists acknowledgements and separates advice from answers', async t => {
  const handlers = {}, commands = {}, messages = [], entries = [], calls = []; let tool;
  const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, value) => { commands[name] = value; }, registerTool: value => { tool = value; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }), sendMessage: message => messages.push(message) };
  const task = { events: [{ id: 'event', kind: 'decision', decisionId: 'decision', artifact: 'question.md', at: '2000-01-01' }], decisions: [{ id: 'decision', artifact: 'question.md' }] };
  supervisor(pi, { root: await memoryRoot(t), request: async body => { calls.push(body); return body.action === 'inspect' ? task : body.action === 'read' ? { content: 'Which colour?' } : {}; } });
  const ctx = { sessionManager: { getEntries: () => entries }, ui: { setStatus() {}, notify() {}, confirm: async () => true } };
  try {
    await handlers.session_start({}, ctx);
    await commands['runner-watch'].handler('task', ctx);
    assert.equal(messages.length, 1); assert.equal(messages[0].details.ids[0], 'event');
    await handlers.agent_end({ messages: [messages[0]] });
    handlers.session_shutdown(); await handlers.session_start({}, ctx);
    await commands['runner-watch'].handler('task', ctx); assert.equal(messages.length, 1);
    await tool.execute('advice', { action: 'feedback', taskId: 'task', text: 'Consider blue' });
    assert.equal(calls.at(-1).action, 'feedback');
    await tool.execute('routine-answer', { action: 'answer', taskId: 'task', decisionId: 'decision', text: 'Blue, per the agreed requirements' });
    assert.equal(calls.at(-1).action, 'supervisor-answer');
    assert.deepEqual(calls.at(-1).input, { decisionId: 'decision', text: 'Blue, per the agreed requirements' });
    await assert.rejects(tool.execute('bad', { action: 'delete', taskId: 'task' }), /Unsupported/);
    await assert.rejects(commands['runner-answer'].handler('task stale yes', ctx), /pending decision/);
    await commands['runner-answer'].handler('task decision Blue please', ctx);
    assert.equal(calls.at(-1).action, 'answer'); assert.equal(calls.at(-1).input.decisionId, 'decision');
    ctx.ui.confirm = async () => false;
    const count = calls.filter(c => c.action === 'answer').length;
    await commands['runner-answer'].handler('task decision No', ctx);
    assert.equal(calls.filter(c => c.action === 'answer').length, count);
  } finally { handlers.session_shutdown(); }
});

test('supervisor MCP is opt-in, pinned, and preserves Pi model/session arguments', async t => {
  const { supervisorArgs, main } = await import('../runner/cli.js');
  const plain = supervisorArgs(['--model', 'example', '--continue']);
  assert(!plain.some(arg => arg.startsWith('npm:')));
  const enabled = supervisorArgs(['--mcp', '--mcp-config', '/tmp/tickets.json', '--provider', 'example']);
  assert.equal(enabled.filter(arg => arg === 'npm:pi-mcp-adapter@2.33.0').length, 1);
  assert(!enabled.includes('--mcp'));
  assert(enabled.includes('/tmp/tickets.json')); assert(enabled.includes('--provider'));
  assert(supervisorArgs(['--mcp-config', '/tmp/tickets.json']).includes('npm:pi-mcp-adapter@2.33.0'));
  assert.throws(() => supervisorArgs(['--mcp-config']), /Missing/);
  assert.match(await main(['supervisor', '--help']), /managed workers use runner tools only/);
});

test('supervisor exposes video metadata as text rather than an image block', async t => {
  let tool;
  const pi = { on() {}, registerCommand() {}, registerTool(value) { tool = value; } };
  supervisor(pi, { root: await memoryRoot(t), request: async () => ({ mimeType: 'video/webm', artifact: 'runtime/clip.webm', localPath: '/tmp/clip.webm', size: 42 }) });
  const result = await tool.execute('video', { action: 'read', taskId: 'task', path: 'runtime/clip.webm' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).localPath, '/tmp/clip.webm');
});

test('human dialogs fail closed on cancellation, stale identity, headless mode and abort', async t => {
  let tool; const mutations = [];
  const pi = { on() {}, registerCommand() {}, registerTool: value => { tool = value; }, appendEntry() {} };
  const task = { status: 'completed', repo: '/repo', verification: { passed: true, commit: 'current', artifact: 'proof.md' }, decisions: [] };
  supervisor(pi, { root: await memoryRoot(t), request: async body => { if (body.action === 'inspect') return task; mutations.push(body); return {}; } });
  const ctx = { hasUI: true, ui: { input: async () => undefined, confirm: async () => false } };
  const accept = { action: 'accept', taskId: 'task', commit: 'current' };
  assert((await tool.execute('cancel-accept', accept, undefined, undefined, ctx)).details.cancelled);
  assert((await tool.execute('cancel-question', { action: 'ask_user', text: 'Requirements?' }, undefined, undefined, ctx)).details.cancelled);
  await assert.rejects(tool.execute('no-ui', accept), /interactive/);
  await assert.rejects(tool.execute('stale', { ...accept, commit: 'old' }, undefined, undefined, ctx), /current verified/);
  await assert.rejects(tool.execute('wrong', { action: 'ask_user', taskId: 'task', decisionId: 'old' }, undefined, undefined, ctx), /active coordinator/);
  ctx.ui.confirm = async () => true;
  await assert.rejects(tool.execute('aborted', accept, AbortSignal.abort(), undefined, ctx), /aborted/);
  assert.deepEqual(mutations, []);
  ctx.ui.input = async () => 'Support dark mode';
  const result = await tool.execute('requirements', { action: 'ask_user', text: 'Requirements?' }, undefined, undefined, ctx);
  assert.equal(JSON.parse(result.content[0].text).answer, 'Support dark mode');
  assert.deepEqual(mutations, []);
});

async function memoryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('memory survives fresh sessions, restores watches, rejects stale writes and precedes compaction', async t => {
  const root = await memoryRoot(t);
  function session() {
    const handlers = {}, messages = []; let tool;
    const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand() {}, registerTool: value => { tool = value; }, appendEntry() {}, sendMessage: message => messages.push(message) };
    supervisor(pi, { root, request: async () => ({ events: [{ id: 'pending', kind: 'decision', decisionId: 'd', at: '2000' }], decisions: [{ id: 'd' }] }) });
    const ctx = { sessionManager: { getEntries: () => [] }, ui: { setStatus() {} } };
    t.after(() => handlers.session_shutdown());
    return { handlers, messages, ctx, run: input => tool.execute('memory-test', input) };
  }
  const first = session(); await first.handlers.session_start({}, first.ctx);
  await first.run({ action: 'memory_write', path: 'memory.md', previous: '', text: '# Priorities\nSee tasks/checkout.md' });
  await first.run({ action: 'memory_write', path: 'tasks/checkout.md', previous: '', text: 'Guest checkout; saved cards deferred. Source: user discussion.' });
  await assert.rejects(first.run({ action: 'memory_write', path: 'memory.md', previous: '', text: 'Stale overwrite' }), /changed/);
  await assert.rejects(first.run({ action: 'memory_write', path: '../escape.md', previous: '', text: 'Escape' }), /Use memory.md/);
  await assert.rejects(first.run({ action: 'memory_write', path: 'memory.md', previous: '', text: 'x'.repeat(12001) }), /12000/);
  await first.run({ action: 'watch', taskId: 'task' });
  await first.handlers.agent_end({ messages: first.messages });
  first.handlers.session_shutdown();
  const second = session(); await second.handlers.session_start({}, second.ctx);
  const prompt = await second.handlers.before_agent_start({ systemPrompt: 'Base' });
  assert.match(prompt.systemPrompt, /saved notes/); assert.match(prompt.systemPrompt, /tasks\/checkout.md/);
  assert.match(JSON.parse((await second.run({ action: 'memory_read', path: 'tasks/checkout.md' })).content[0].text).text, /saved cards deferred/);
  await second.run({ action: 'watch', taskId: 'task' });
  assert.equal(second.messages.length, 0); // Fresh session retains acknowledged event IDs.
  const state = JSON.parse(await readFile(join(root, 'supervisor/state.json'), 'utf8'));
  assert(state.watched.task); assert.deepEqual(state.seen, ['pending']);
});

test('contextual human questions preserve the exact original and save receipts across fresh sessions', async t => {
  const root = await memoryRoot(t); let dialogs = 0;
  function session() {
    const handlers = {}; let tool;
    supervisor({ on: (name, fn) => { handlers[name] = fn; }, registerCommand() {}, registerTool: value => { tool = value; }, appendEntry() {} }, { root, request: async body => body.action === 'inspect' ? { status: 'running', decisions: [{ id: 'decision', audience: 'owner', artifact: 'q.md' }] } : body.action === 'read' ? { content: 'Email or lookup page?' } : {} });
    const ctx = { hasUI: true, sessionManager: { getEntries: () => [] }, ui: { setStatus() {}, input: async question => { dialogs++; assert.match(question, /Guest checkout was agreed/); assert.match(question, /Original coordinator question:\nEmail or lookup page/); return 'Email only'; } }, compact: () => { ctx.compacted = true; } };
    t.after(() => handlers.session_shutdown());
    return { handlers, ctx, run: input => tool.execute('question', input, undefined, undefined, ctx) };
  }
  const input = { action: 'ask_user', taskId: 'task', decisionId: 'decision', requestId: 'receipt', text: 'Guest checkout was agreed. Recommend email to keep scope small. Is that sufficient?' };
  const first = session(); await first.handlers.session_start({}, first.ctx);
  await assert.rejects(first.run({ action: 'compact_memory' }), /Save the supervisor index/);
  await first.run({ action: 'memory_write', path: 'memory.md', previous: '', text: 'Guest checkout is active.' });
  await first.run({ action: 'compact_memory' }); assert(!first.ctx.compacted);
  await first.handlers.agent_end({ messages: [] }); assert(first.ctx.compacted);
  await first.run(input); first.handlers.session_shutdown();
  const second = session(); await second.handlers.session_start({}, second.ctx);
  const reply = JSON.parse((await second.run(input)).content[0].text);
  assert.equal(reply.humanAnswer, 'Email only'); assert.equal(reply.answeredBy, 'owner');
  assert.equal(dialogs, 1);
  await assert.rejects(second.run({ ...input, text: 'Changed context' }), /different input/);
});
