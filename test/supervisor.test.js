import test from 'node:test';
import assert from 'node:assert/strict';
import supervisor from '../runner/supervisor-extension.js';

test('supervisor watches exact decisions, persists acknowledgements and separates advice from answers', async () => {
  const handlers = {}, commands = {}, messages = [], entries = [], calls = []; let tool;
  const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, value) => { commands[name] = value; }, registerTool: value => { tool = value; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }), sendMessage: message => messages.push(message) };
  const task = { events: [{ id: 'event', kind: 'decision', decisionId: 'decision', artifact: 'question.md', at: '2000-01-01' }], decisions: [{ id: 'decision', artifact: 'question.md' }] };
  supervisor(pi, { request: async body => { calls.push(body); return body.action === 'inspect' ? task : body.action === 'read' ? { content: 'Which colour?' } : {}; } });
  const ctx = { sessionManager: { getEntries: () => entries }, ui: { setStatus() {}, notify() {}, confirm: async () => true } };
  try {
    handlers.session_start({}, ctx);
    await commands['runner-watch'].handler('task', ctx);
    assert.equal(messages.length, 1); assert.equal(messages[0].details.ids[0], 'event');
    handlers.agent_end({ messages: [messages[0]] });
    handlers.session_shutdown(); handlers.session_start({}, ctx);
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

test('supervisor MCP is opt-in, pinned, and preserves Pi model/session arguments', async () => {
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

test('supervisor exposes video metadata as text rather than an image block', async () => {
  let tool;
  const pi = { on() {}, registerCommand() {}, registerTool(value) { tool = value; } };
  supervisor(pi, { request: async () => ({ mimeType: 'video/webm', artifact: 'runtime/clip.webm', localPath: '/tmp/clip.webm', size: 42 }) });
  const result = await tool.execute('video', { action: 'read', taskId: 'task', path: 'runtime/clip.webm' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).localPath, '/tmp/clip.webm');
});

test('human dialogs fail closed on cancellation, stale identity, headless mode and abort', async () => {
  let tool; const mutations = [];
  const pi = { on() {}, registerCommand() {}, registerTool: value => { tool = value; }, appendEntry() {} };
  const task = { status: 'completed', repo: '/repo', verification: { passed: true, commit: 'current', artifact: 'proof.md' }, decisions: [] };
  supervisor(pi, { request: async body => { if (body.action === 'inspect') return task; mutations.push(body); return {}; } });
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
