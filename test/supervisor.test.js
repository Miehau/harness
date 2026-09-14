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
    await assert.rejects(tool.execute('bad', { action: 'answer', taskId: 'task' }), /Unsupported/);
    await assert.rejects(commands['runner-answer'].handler('task stale yes', ctx), /pending decision/);
    await commands['runner-answer'].handler('task decision Blue please', ctx);
    assert.equal(calls.at(-1).action, 'answer'); assert.equal(calls.at(-1).input.decisionId, 'decision');
    ctx.ui.confirm = async () => false;
    const count = calls.filter(c => c.action === 'answer').length;
    await commands['runner-answer'].handler('task decision No', ctx);
    assert.equal(calls.filter(c => c.action === 'answer').length, count);
  } finally { handlers.session_shutdown(); }
});
