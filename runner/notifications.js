import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { atomic, json, now, assert, safePath } from './io.js';

const actions = { approval: 'approval', 'pr-approval': 'approval', 'impl-approval': 'approval', opinion: 'opinion', 'harness-opinion': 'opinion', problem: 'problem', 'impl-problem': 'problem', blocker: 'problem' };
export function hookAction(value) { return Object.hasOwn(actions, value) ? actions[value] : null; }
export function hookFields(hook) {
  if (hook === undefined) return {};
  assert(hook && hookAction(hook.action), 'Unknown Grok hook action');
  if (hook.pr !== undefined) assert(Number.isInteger(hook.pr) && hook.pr > 0, 'pr must be a positive number');
  if (hook.evidence !== undefined) assert(typeof hook.evidence === 'string' && hook.evidence.length <= 10000, 'Invalid hook evidence');
  if (hook.problems !== undefined) assert(Array.isArray(hook.problems) && hook.problems.length <= 20 && hook.problems.every(p => typeof p === 'string' && p.length <= 1000), 'Invalid hook problems');
  return { hook: { action: hookAction(hook.action), ...(hook.pr !== undefined ? { pr: hook.pr } : {}), ...(hook.evidence !== undefined ? { evidence: hook.evidence } : {}), ...(hook.problems !== undefined ? { problems: hook.problems } : {}) } };
}
function eventAction(event) {
  if (['probe', 'health', 'noop'].includes(event.kind)) return null;
  return hookAction(event.hook?.action ?? event.kind) ?? ({ completed: 'approval', decision: 'opinion', attention: 'problem', failed: 'problem' })[event.kind] ?? null;
}

export function validateWebhook(config) {
  const webhook = config.webhook;
  assert(webhook && typeof webhook.url === 'string', 'Configure webhook.url');
  const url = new URL(webhook.url);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'Webhook requires HTTPS without embedded credentials or fragment');
  assert(webhook.authorization === undefined || /^Bearer [A-Za-z0-9._~+\/-]+=*$/.test(webhook.authorization), 'Authorization must be a complete Bearer header');
  assert(webhook.format === undefined || ['grokbot', 'references'].includes(webhook.format), 'Use grokbot or references format');
  assert(config.since === undefined || Number.isFinite(Date.parse(config.since)), 'Invalid notification start time');
  return url;
}

export async function notificationPayload(runtime, task, event, format) {
  const base = { version: 1, eventId: event.id, taskId: task.id, kind: event.kind, decisionId: event.decisionId ?? null, artifact: event.artifact ?? null, occurredAt: event.at, evidence: event.evidence ?? null, attachments: event.attachments ?? [] };
  if (format !== 'grokbot') return base;
  const action = eventAction(event);
  if (!action) return null;
  let text = event.error ?? event.kind;
  if (event.artifact) {
    const file = await runtime.files(task, 'owner', 'read', { area: 'artifacts', path: event.artifact, limit: 10000 });
    text = file.content ?? `Image artifact: ${event.artifact}`;
    if (file.nextOffset != null) text += '\n[Text truncated; inspect the original artifact.]';
  }
  const attachments = [];
  for (const path of event.attachments ?? []) {
    const file = await safePath(join(runtime.dir(task), 'artifacts'), path);
    if (/\.(webm|mp4)$/i.test(path) || (await stat(file)).size > 1000000) { attachments.push({ artifact: path, ...( /\.(webm|mp4)$/i.test(path) ? { mimeType: path.endsWith('.mp4') ? 'video/mp4' : 'video/webm' } : {}), omitted: 'Media available through authenticated artifact read', retrieval: { action: 'read', taskId: task.id, input: { area: 'artifacts', path, includeMedia: true } } }); continue; }
    const content = await runtime.files(task, 'owner', 'read', { area: 'artifacts', path, limit: 10000 });
    attachments.push(content.mimeType ? { artifact: path, mimeType: content.mimeType, base64: content.base64 } : { artifact: path, mimeType: 'text/plain', text: content.content, truncated: content.nextOffset != null });
  }
  return { ...base, action, from: 'harness', task: task.id, message: text,
    ...(event.hook?.pr !== undefined ? { pr: event.hook.pr } : {}),
    ...(action === 'approval' ? { evidence: event.hook?.evidence ?? [task.verification?.artifact, event.evidence, task.documents?.evidence, event.artifact].filter(Boolean).join(', ') } : {}),
    ...(action === 'problem' ? { problems: event.hook?.problems ?? [event.error ?? text] } : {}),
    version: 2, job: task.id, status: event.kind, branch: task.integration?.branch ?? null, text, attachments,
    reply: event.decisionId ? { taskId: task.id, decisionId: event.decisionId, command: `agent-plan answer ${task.id} ${event.decisionId} /path/to/answer.md` } : { taskId: task.id, command: event.kind === 'completed' ? `agent-plan accept ${task.id} ${task.verification?.commit ?? ''}`.trim() : `agent-plan feedback ${task.id} /path/to/feedback.md` } };
}

export async function loadWebhookConfig(root) {
  try { return await json(join(root, 'webhook.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let config;
  try { config = await json(join(root, 'supervisor.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  validateWebhook(config);
  await atomic(join(root, 'webhook.json'), config);
  await unlink(join(root, 'supervisor.json'));
  return config;
}

// Explicit owner configuration only. HTTP acceptance is not a bot/human acknowledgement.
export async function notify(runtime, fetchImpl = fetch) {
  const config = await loadWebhookConfig(runtime.root);
  if (!config?.webhook?.url) return;
  const url = validateWebhook(config);
  const receiptPath = join(runtime.root, 'notifications.json');
  let receipts;
  try { receipts = await json(receiptPath); } catch (e) { if (e.code !== 'ENOENT') throw e; receipts = {}; }
  for (const task of runtime.tasks.values()) for (const event of task.events) {
    if (!(config.webhook.format === 'grokbot' ? eventAction(event) : ['decision', 'attention', 'completed', 'failed', 'merged'].includes(event.kind)) || receipts[event.id] || config.since && Date.parse(event.at) < Date.parse(config.since)) continue;
    receipts[event.id] = { eventId: event.id, taskId: task.id, status: 'preparing', attemptedAt: now(), wake: 'unobserved' };
    await atomic(receiptPath, receipts);
    let payload;
    try { payload = await notificationPayload(runtime, task, event, config.webhook.format); }
    catch { receipts[event.id].status = 'not-sent'; await atomic(receiptPath, receipts); continue; }
    receipts[event.id].status = 'unknown'; await atomic(receiptPath, receipts);
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'idempotency-key': event.id, ...(config.webhook.authorization ? { authorization: config.webhook.authorization } : {}) }, body: JSON.stringify(payload) });
      receipts[event.id] = { ...receipts[event.id], status: response.ok ? 'accepted' : 'failed', httpStatus: response.status };
      await response.body?.cancel();
    } catch { /* A timed-out request may have arrived. Never blindly resend it. */ }
    await atomic(receiptPath, receipts);
  }
}
