import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';

export default function runner(pi) {
  const url = process.env.RUNNER_URL;
  const token = process.env.RUNNER_TOKEN;
  const replyToken = process.env.RUNNER_REPLY_TOKEN;
  if (!url || !token) throw new Error('Runner extension requires RUNNER_URL and RUNNER_TOKEN');
  let timer, polling = false, context, stopped = false, shownDecision;
  const queued = new Set();
  async function request(path, body) {
    const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 650000 : 5000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Runner HTTP ${response.status}`);
    return result;
  }
  const call = (action, input, requestId) => request('/action', { action, input, requestId });
  async function poll() {
    if (polling || stopped || !context) return;
    polling = true;
    try {
      const state = await request('/poll');
      if (['completed', 'failed', 'cancelled'].includes(state.status) || ['completed', 'failed', 'cancelled'].includes(state.taskStatus)) {
        stopped = true; clearInterval(timer); context.shutdown(); return;
      }
      // Questions keep the agent quiet until answered. Contract updates remain queued.
      if (state.status === 'waiting') {
        if (!context.isIdle()) await context.abort();
        if (state.decision && shownDecision !== state.decision.id) {
          const question = await call('read', { area: 'artifacts', path: state.decision.artifact }, randomUUID());
          context.ui?.notify(`${question.content}\n\nType your answer here to resume.`, 'info');
          shownDecision = state.decision.id;
        }
        return;
      }
      const messages = state.messages.filter(m => !queued.has(m.id));
      if (messages.length) {
        for (const message of messages) queued.add(message.id);
        pi.sendMessage({ customType: 'runner-inbox', content: JSON.stringify(messages), display: true, details: { messageIds: messages.map(m => m.id) } }, { triggerTurn: true, deliverAs: 'followUp' });
      }
    } catch (error) { context.ui?.setStatus('runner', `Runner disconnected: ${error.message}`); }
    finally { polling = false; }
  }
  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    pi.setActiveTools(['runner_read', 'runner_write', 'runner_action']);
    timer = setInterval(poll, 2000); timer.unref?.();
    // Initialization must finish before the first model turn is injected.
    setTimeout(poll, 100).unref?.();
  });
  pi.on('session_shutdown', () => { stopped = true; clearInterval(timer); });
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'interactive' || event.text.startsWith('/')) return { action: 'continue' };
    try {
      const state = await request('/poll');
      if (state.status !== 'waiting' || !state.decision) return { action: 'continue' };
      if (event.images?.length) { ctx.ui.notify('Please answer this decision with text; image answers are not supported yet.', 'warning'); return { action: 'handled' }; }
      if (shownDecision !== state.decision.id) { await poll(); ctx.ui.notify('Read the current question above, then enter your answer again.', 'info'); return { action: 'handled' }; }
      if (!replyToken) throw new Error('This older session needs the agent-plan answer command');
      const response = await fetch(`${url}/terminal-answer`, { method: 'POST', headers: { authorization: `Bearer ${replyToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: state.decision.id, text: event.text }), signal: AbortSignal.timeout(10000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      await poll(); return { action: 'handled' };
    } catch (error) { ctx.ui.notify(`Answer was not confirmed: ${error.message}`, 'error'); return { action: 'handled' }; }
  });
  pi.on('before_agent_start', (event, ctx) => ({ systemPrompt: `${event.systemPrompt}\nYou are a managed runner agent. Your current model is ${ctx?.model?.provider ?? 'unknown'}/${ctx?.model?.id ?? 'unknown'}. Read the model-menu artifact if supplied; select worker modelChoice from it instead of guessing IDs or pricing. Inbox messages contain file references relative to the task artifacts directory. Read the referenced workflow, assignment and discovery manifest (when present) using runner_read before acting. If the assignment supplies a skills manifest, read it and its selected skill artifacts with runner_read before acting. Skill source paths identify the original repository directory for relative supporting files. Use runner tools in place of native read/write/bash; scripts require owner-configured named commands. Skills do not expand permissions. Discovery paths refer to repository files; read only the relevant documents. Inspect your agent record for artifactDir; write your artifacts only inside that directory. Use only runner tools. Full outputs belong in artifact files. After ask or report, stop your turn. End the turn when awaiting workers; durable inbox messages will wake you. Never substitute terminal readiness for task completion.` }));
  pi.on('tool_call', event => {
    if (!['runner_read', 'runner_write', 'runner_action'].includes(event.toolName)) return { block: true, reason: 'Managed agents use runner tools only' };
  });
  pi.on('user_bash', () => ({ result: { output: 'Use a configured runner command.', exitCode: 1, cancelled: false, truncated: false } }));
  pi.on('agent_end', async event => {
    const failed = event.messages?.some(m => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason));
    if (failed) {
      try {
        const state = await request('/poll');
        if (state.status !== 'waiting' && ['starting', 'running'].includes(state.status)) {
          const artifact = `${state.artifactDir ? state.artifactDir + '/' : ''}failure-${randomUUID()}.json`;
          const errors = event.messages.filter(m => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason)).map(m => ({ reason: m.stopReason, error: m.errorMessage ?? 'Agent turn aborted' }));
          await call('write', { area: 'artifacts', path: artifact, content: JSON.stringify(errors) }, randomUUID());
          await call('fault', { artifact }, randomUUID());
        }
      } catch { /* Keep messages queued: a disconnected runtime must not cause a model retry loop. */ }
      return;
    }
    // Acknowledge only messages actually present in this turn's session history.
    const ids = event.messages?.filter(m => m.customType === 'runner-inbox').flatMap(m => m.details?.messageIds ?? []) ?? [];
    if (ids.length) try { await call('ack', { ids }, randomUUID()); } catch { queued.clear(); }
  });
  const area = Type.Union([Type.Literal('repo'), Type.Literal('artifacts')]);
  const definition = (name, description, parameters, action) => pi.registerTool({
    name, label: name, description, parameters,
    async execute(toolCallId, input) {
      const result = await call(action ?? input.action, action ? input : input.input ?? {}, toolCallId);
      return { content: result.mimeType === 'image/png' ? [{ type: 'image', data: result.base64, mimeType: result.mimeType }] : [{ type: 'text', text: JSON.stringify(result) }], details: result.mimeType ? { mimeType: result.mimeType } : result, ...(!action && ['ask', 'report'].includes(input.action) ? { terminate: true } : {}) };
    }
  });
  definition('runner_read', 'Read a file or list a directory. Artifact references are relative to the task artifacts root. Large files support offset/limit.', Type.Object({ area, path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), 'read');
  definition('runner_write', 'Write your own repository file or create an immutable artifact. Use unique artifact paths; published artifacts cannot be overwritten.', Type.Object({ area, path: Type.String(), content: Type.String() }), 'write');
  definition('runner_action', 'Execute a workflow action. Read the workflow file for action inputs. ask/report finish your turn. inspect returns current assignments and artifact references.', Type.Object({
    action: Type.Union(['inspect', 'spawn', 'contract', 'ask', 'answer', 'integrate', 'verify', 'report', 'command', 'remove', 'pause', 'checkpoint', 'revise', 'publish', 'peers', 'coordinate', 'clarify', 'surface'].map(v => Type.Literal(v))), input: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  }));
}
