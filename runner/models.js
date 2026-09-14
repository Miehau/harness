import { assert, string } from './io.js';

export function modelMenu(config) {
  const coordinator = { ...(config.model ? { model: config.model } : {}), ...(config.provider ? { provider: config.provider } : {}) };
  const planning = { model: config.planningModel ?? config.model, provider: config.planningProvider ?? config.provider };
  const menu = {
    discovery: { model: config.discoveryModel, provider: config.discoveryProvider, purpose: 'Cheap, bounded code and documentation discovery' },
    planning: { ...planning, purpose: 'Architecture, tradeoffs and implementation planning' },
    implementation: { ...coordinator, purpose: 'Routine implementation; inherits coordinator when unspecified' },
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
  const choice = input.modelChoice ?? (stage === 'discovery' ? 'discovery' : ['architecture', 'planning'].includes(stage) ? 'planning' : 'implementation');
  const menu = task.modelMenu ?? modelMenu(task.config);
  assert(Object.hasOwn(menu.choices, choice), `Unknown model choice: ${choice}`);
  const selected = menu.choices[choice];
  const selection = { model: selected.model ?? task.config.model, provider: selected.provider ?? task.config.provider };
  if (input.model !== undefined || input.provider !== undefined) string(input.modelReason, 'modelReason for override', 1000);
  for (const key of ['model', 'provider']) if (input[key] !== undefined) selection[key] = string(input[key], key, 200);
  return { choice, selection, reason: input.modelReason ?? selected.purpose ?? choice };
}
