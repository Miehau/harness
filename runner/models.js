import { assert, string } from './io.js';

export function modelMenu(config) {
  const coordinator = { ...(config.model ? { model: config.model } : {}), ...(config.provider ? { provider: config.provider } : {}) };
  const planning = { model: config.planningModel ?? config.model, provider: config.planningProvider ?? config.provider };
  const menu = {
    discovery: { model: config.discoveryModel, provider: config.discoveryProvider, purpose: 'Cheap, bounded code and documentation discovery' },
    planning: { ...planning, purpose: 'Architecture, tradeoffs and implementation planning' },
    implementation: { ...coordinator, purpose: 'Routine implementation; inherits coordinator when unspecified' },
    review: { purpose: 'Independent candidate review; prefer the opposite OpenAI/Claude family from implementation' },
    complex: { ...coordinator, purpose: 'Difficult debugging or broad changes; inherits coordinator when unspecified' },
    ...config.workerModels,
  };
  for (const [name, choice] of Object.entries(menu)) {
    assert(/^[a-z][a-z0-9_-]*$/.test(name) && choice && typeof choice === 'object', 'Invalid worker model choice');
    for (const key of ['model', 'provider', 'purpose']) if (choice[key] !== undefined) string(choice[key], `workerModels.${name}.${key}`, 500);
  }
  return { coordinator, choices: menu, instruction: 'Select modelChoice when spawning. Missing model/provider inherit the task selection. Explicit overrides require modelReason. Availability is checked before launch; a rejected choice is not a reason to guess another model ID.' };
}

export function chooseModel(task, input, stage) {
  const choice = input.modelChoice ?? (stage === 'review' ? 'review' : stage === 'discovery' ? 'discovery' : ['architecture', 'planning'].includes(stage) ? 'planning' : 'implementation');
  const menu = task.modelMenu ?? modelMenu(task.config);
  assert(Object.hasOwn(menu.choices, choice), `Unknown model choice: ${choice}`);
  const selected = menu.choices[choice];
  const selection = { model: selected.model ?? task.config.model, provider: selected.provider ?? task.config.provider };
  if (input.model !== undefined || input.provider !== undefined) string(input.modelReason, 'modelReason for override', 1000);
  for (const key of ['model', 'provider']) if (input[key] !== undefined) selection[key] = string(input[key], key, 200);
  return { choice, selection, reason: input.modelReason ?? selected.purpose ?? choice };
}

const family = selection => /claude|anthropic/i.test(`${selection.provider} ${selection.model}`) ? 'anthropic' : /openai|gpt-|^o[134]/i.test(`${selection.provider} ${selection.model}`) ? 'openai' : 'other';
export async function reviewModel(task, input, transport, commit) {
  const writers = task.agents.filter(a => a.mode === 'write' && a.integrated).map(a => a.modelSelection ?? {});
  const used = m => writers.some(w => w.model === m.model && w.provider === m.provider);
  const writer = task.agents.findLast(a => a.mode === 'write' && a.integrated)?.modelSelection ?? task.config;
  const failed = task.agents.filter(a => a.stage === 'review' && a.base === commit && a.status === 'failed');
  const unavailable = selection => failed.some(a => a.modelSelection?.model === selection.model && a.modelSelection?.provider === selection.provider);
  let configuredError;
  const configured = input.model || input.provider || task.config.workerModels?.review?.model;
  if (configured && !failed.length) {
    const selected = chooseModel(task, input, 'review');
    if (transport.resolveModel) {
      try { selected.selection = await transport.resolveModel(selected.selection); return selected; }
      catch (error) { configuredError = error.message; }
    } else return selected;
  }
  let available, availabilityError;
  try { available = transport.availableModels ? await transport.availableModels() : []; }
  catch (error) { available = []; availabilityError = error.message; }
  const opposite = family(writer) === 'openai' ? 'anthropic' : 'openai';
  const candidates = available.filter(selection => !unavailable(selection));
  // Prefer configured menu choices within the opposite family, then Pi's available models.
  const preferred = ['review', 'planning', 'complex'].map(name => task.modelMenu.choices[name]).filter(Boolean).filter(c => c.model).map(c => candidates.find(m => m.model === c.model && (!c.provider || m.provider === c.provider))).filter(Boolean);
  const selection = [...preferred, ...candidates].find(m => family(m) === opposite && !used(m))
    ?? candidates.find(m => !used(m))
    ?? candidates.find(m => family(m) === opposite)
    ?? candidates[0] ?? { model: writer.model, provider: writer.provider };
  assert(!unavailable(selection), 'Review models failed; resolve provider/budget errors before continuing');
  const reason = family(selection) === opposite ? 'Review uses the opposite model family from the latest integrated writer' : `Review fallback: opposite family unavailable${availabilityError ? ': ' + availabilityError : ''}`;
  return { choice: 'review', selection, reason: reason + (configuredError ? `; configured reviewer unavailable: ${configuredError}` : '') + (failed.length ? `; failed review attempts: ${failed.map(a => a.id).join(', ')}` : '') };
}
