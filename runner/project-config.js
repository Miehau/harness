import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, json, string } from './io.js';

export const runtimeCapabilities = Object.freeze({
  omp: Object.freeze({ runner: 'supported', native: 'unsupported' }),
  claude: Object.freeze({ runner: 'unsupported', native: 'packaged' }),
  codex: Object.freeze({ runner: 'unsupported', native: 'packaged' }),
  grok: Object.freeze({ runner: 'unsupported', native: 'planned-unverified' }),
  cursor: Object.freeze({ runner: 'unsupported', native: 'planned-unverified' }),
});
const roles = ['supervisor', 'coordinator', 'implementation', 'review', 'discovery', 'planning', 'requirements', 'correctness', 'security', 'database', 'recovery', 'ui', 'performance'];
const modelKeys = ['model', 'provider', 'discoveryModel', 'discoveryProvider', 'planningModel', 'planningProvider', 'workerModels'];
const object = (value, label) => assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${label} key: ${key}`);
}
function credentials(value, label = 'config') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|authorization|private[-_]?key)$/i.test(key), `Credentials are not allowed in ${label}.${key}; use the runtime's credential store`);
    credentials(child, `${label}.${key}`);
  }
}
function shape(config) {
  object(config, 'config'); credentials(config);
  if (config.execution !== undefined) {
    keys(config.execution, ['mode', 'runtime'], 'execution');
    if (config.execution.mode !== undefined) assert(['runner', 'native'].includes(config.execution.mode), 'execution.mode must be runner or native');
    if (config.execution.runtime !== undefined) assert(Object.hasOwn(runtimeCapabilities, config.execution.runtime), 'Unknown execution.runtime');
  }
  if (config.agents !== undefined) {
    keys(config.agents, roles, 'agents');
    for (const [role, choice] of Object.entries(config.agents)) {
      keys(choice, ['runtime', 'model', 'provider'], `agents.${role}`);
      if (choice.runtime !== undefined) assert(Object.hasOwn(runtimeCapabilities, choice.runtime), `agents.${role}.runtime must name a known runtime`);
      for (const key of ['model', 'provider']) if (choice[key] !== undefined) string(choice[key], `agents.${role}.${key}`, 200);
    }
  }
  for (const key of modelKeys.filter(key => key !== 'workerModels')) if (config[key] !== undefined) string(config[key], key, 200);
  if (config.workerModels !== undefined) {
    object(config.workerModels, 'workerModels');
    for (const [role, choice] of Object.entries(config.workerModels)) {
      keys(choice, ['model', 'provider', 'purpose'], `workerModels.${role}`);
      for (const key of Object.keys(choice)) string(choice[key], `workerModels.${role}.${key}`, 500);
    }
  }
  return config;
}
async function optional(file) {
  try { return await json(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Choose the existing owner file; new projects use the canonical directory.
export async function projectConfigPath(repo) {
  for (const directory of ['.agent-plan', '.runner']) {
    const file = join(repo, directory, 'project.json');
    try { await access(file); return file; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return join(repo, '.agent-plan', 'project.json');
}

export async function loadProjectConfig(repo) {
  const file = await projectConfigPath(repo);
  const loaded = await optional(file);
  const config = shape(loaded === undefined ? { commands: { test: ['bash', 'verify.sh'] }, verify: ['test'], inferredSetup: true } : loaded);
  const local = await optional(join(repo, '.agent-plan', 'local.json'));
  if (local === undefined) return config;
  keys(local, ['execution', 'agents', ...modelKeys], 'local');
  // Validate merged choices: local role settings can override just the model.
  credentials(local, 'local');
  const merged = { ...config, ...local };
  for (const key of ['execution', 'agents', 'workerModels']) if (local[key] !== undefined) {
    object(local[key], `local.${key}`);
    merged[key] = { ...config[key], ...local[key] };
    if (key !== 'execution') for (const [role, choice] of Object.entries(local[key])) {
      object(choice, `local.${key}.${role}`);
      merged[key][role] = { ...config[key]?.[role], ...choice };
    }
  }
  return shape(merged);
}

export function validateExecution(config, requested = {}) {
  shape(config); keys(requested, ['mode', 'runtime'], 'execution request');
  const execution = { mode: 'runner', runtime: 'omp', ...config.execution };
  for (const key of ['mode', 'runtime']) if (requested[key] !== undefined) {
    assert(!config.execution?.[key] || config.execution[key] === requested[key], `Configured execution.${key} is ${config.execution?.[key]}; cannot execute as ${requested[key]}`);
    execution[key] = requested[key];
  }
  assert(['runner', 'native'].includes(execution.mode) && Object.hasOwn(runtimeCapabilities, execution.runtime), 'Unknown execution mode/runtime');
  const capability = runtimeCapabilities[execution.runtime][execution.mode];
  assert(['supported', 'packaged'].includes(capability), `${execution.mode} execution with ${execution.runtime} is ${capability}; no automatic runtime adapter is available`);
  for (const [role, choice] of Object.entries(config.agents ?? {})) {
    assert(choice.runtime === undefined || choice.runtime === execution.runtime, `agents.${role} selects ${choice.runtime}, but execution uses ${execution.runtime}; mixed-runtime delegation is not implemented`);
  }
  return execution;
}
