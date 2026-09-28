#!/usr/bin/env node
import { mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { json, assert, atomic, git } from './io.js';
import { connect, dataRoot } from './connection.js';
import { repos, resolveAlias, resolveRepo } from './repos.js';
import { validateWebhook } from './notifications.js';
import { discoverHosting } from './hosting.js';
import { ompCli, ensureBun, guardSupervisorSessions } from './omp.js';
import { loadProjectConfig, projectConfigPath, validateExecution, runtimeCapabilities } from './project-config.js';
const help = `agent-plan — launch OMP tasks in your running Herdr

agent-plan start <repo> "task description"       Create a workspace and open its orchestrator
agent-plan launch <alias> <brief> <request-id>    Idempotent unattended launch for GrokBot
agent-plan repo add <alias> <path>                Save a repository alias
agent-plan repo list                              List saved repositories
agent-plan repo remove <alias>                    Forget an alias
agent-plan skills [name]                         Read packaged skills from GrokBot or scripts
agent-plan onboard <repo>                        Explore the repo and create onboarding docs
agent-plan feedback <task> <file>                 Revise an open PR or send coordinator feedback
agent-plan list                                  Show tasks
agent-plan open <task>                            Focus the task's Herdr session
agent-plan accept <task> [commit] [--target main] Rebase, verify and merge an accepted result
agent-plan hosting <repo> [--hosting-provider github|gitlab] Save hosting configuration
agent-plan hosted-status <task>                   Refresh PR/MR and CI status
agent-plan publish-candidate <task>               Publish a verified reviewed candidate
agent-plan preview <task> [--stop]                 Start/stop the configured app preview
agent-plan verify <task>                          Verify a recovered candidate
agent-plan stop <task>                            Stop agents; preserve worktrees and artifacts
agent-plan init <repo> '<verification argv JSON>' Configure a repository once
agent-plan config <repo>                         Check configuration and runtime capabilities offline

The background runtime starts automatically. No daemon terminal or copied submission ID.
Repositories accept saved aliases or paths (use ./name to bypass an alias).
Tasks accept a full ID or a unique prefix. Answer pending questions in the OMP terminal.
State: ~/.local/state/agent-plan (override with RUNNER_DATA).

Advanced:
agent-plan submit <repo> <brief-file> [request-id] Save a draft without model work
agent-plan start <task>                           Start a saved draft and open its session
agent-plan inspect <task>
agent-plan answer <task> <decision-id> <answer-file>
agent-plan resume <task> <agent-id>
agent-plan recover <task> [applied|aborted] ["inspection evidence"]
agent-plan cleanup <task>
agent-plan artifact <task> <relative-path>
agent-plan dashboard
agent-plan notifications
agent-plan webhook <private-config-file>          Configure owner notifications
agent-plan supervisor [--model MODEL] [--provider PROVIDER] [--mcp] Open your supervisor OMP session

start/onboard accept --model MODEL and --provider PROVIDER.
Stage defaults: --discovery-model/--discovery-provider, --planning-model/--planning-provider.
Starting work uses your configured OMP model and the repo's committed HEAD.
`;
const topics = {
  supervisor: `agent-plan supervisor [--cwd REPO] [--model MODEL] [--provider PROVIDER] [--mcp] [--mcp-config FILE]

Open an ordinary OMP supervisor. /runner-watch TASK subscribes to coordinator events.
Repository configuration must select runner/omp. Supervisor role model settings
apply unless overridden by explicit model/provider flags.
Bundled skills: /skill:how, /skill:why, /skill:arena, /skill:architect,
/skill:blast-radius and /skill:open-pr. Architecture returns at least three proposals
for discussion before authorized background implementation.
OMP uses its native MCP configuration. --mcp is accepted for compatibility;
MCP files live at ~/.omp/agent/mcp.json or .omp/mcp.json.
The old --mcp-config flag reports migration instructions. Other OMP arguments, including --continue, pass
through. MCP stays in the supervisor; managed workers use native OMP and runner tools (trusted local execution).`,
  accept: `agent-plan accept TASK [COMMIT] [--target main]

Accept a completed candidate, rebase its task changes onto local main, rerun checks,
and fast-forward merge. The source repo must be clean with the target checked out.
Conflicts or failed checks stop for inspection. No remote fetch or push is performed.
For hosting-configured tasks, COMMIT is required: merge the published PR/MR only
when its exact head is approved and provider CI/merge requirements pass. Local-only
tasks retain local acceptance; without COMMIT they select the verified candidate.`,
  start: `agent-plan start REPO "Task description" [--model MODEL] [--provider PROVIDER]
agent-plan start TASK

REPO is a saved alias or path. TASK is a saved draft ID or unique prefix.
Start Herdr and configure OMP credentials first. The runtime starts automatically.
New tasks use committed HEAD and snapshot .agent-plan/project.json (legacy .runner fallback) plus the workflow.
Model/provider flags select the coordinator for a new task.

Example: agent-plan start demo "Add a dark mode toggle"`,
  launch: `agent-plan launch ALIAS BRIEF_FILE REQUEST_ID

Launch an unattended task for GrokBot or another local scheduler. ALIAS must be a
saved repository alias; paths are rejected. BRIEF_FILE contains the complete task.
REQUEST_ID must be stable across retries: identical retries return the same task,
while different input with the same ID is rejected. The command does not focus Herdr.

Example: agent-plan launch meal-minder /absolute/task.md grok-issue-123-20260921`,
  repo: `agent-plan repo add NAME PATH
agent-plan repo list
agent-plan repo remove NAME

Save a Git repository root once, then use NAME with start, submit, init or onboard.
Use ./NAME to bypass an alias. Removing an alias does not delete the repository.

Example: agent-plan repo add demo /path/to/demo`,
  onboard: `agent-plan onboard REPO [--model MODEL] [--provider PROVIDER]

Launch an agent task to produce verify.sh, a .runner/feature-map.md index with
.runner/features/ documents, and conceptual .runner/architecture.md for existing code.
Missing project configuration is scaffolded in .agent-plan; existing canonical or legacy configuration is preserved.
Missing agent-local gitignore entries, including .agent-plan/local.json and tasks/, are added and
committed so agent-local files do not dirty later worktrees.
The result stays in its integration worktree for review; it is not merged.`,
  init: `agent-plan init REPO 'VERIFY_ARGV_JSON'

Create .agent-plan/project.json without launching an agent. Existing canonical or legacy config is preserved.
Example: agent-plan init demo '["bun","test"]'`,
  config: `agent-plan config REPO

Read effective .agent-plan/project.json (or legacy .runner/project.json) with private
.agent-plan/local.json overrides and report runtime capabilities without connecting
to Herdr or launching a model. Unsupported execution is reported with its reason.`,
  feedback: `agent-plan feedback TASK FILE
agent-plan answer TASK DECISION_ID FILE

Feedback sends a saved text file to an unfinished task's coordinator, or reopens a
completed task whose hosted PR/MR is still open. Revisions reuse its branch, worktree
and PR/MR; no merge or checkout switch is needed. Use list to find the task by PR URL.
Use answer for an exact pending decision; feedback does not resume a waiting agent.`,
  dashboard: `agent-plan dashboard

Print the private authenticated inspector URL. Open it in your browser to view
assignments, reports, images, verification and worker handoffs.`,
  recovery: `agent-plan inspect TASK
agent-plan resume TASK AGENT_ID
agent-plan recover TASK [applied|aborted] ["inspection evidence"]
agent-plan stop TASK

Inspect retained work before recovering uncertain operations. Resume reconciles the
recorded agent session. Stop preserves worktrees and artifacts.`,
};
function showHelp(topic) {
  if (!topic) return help + '\nExamples and details: agent-plan help start | repo | onboard | init | feedback | dashboard | recovery\n';
  if (topics[topic]) return topics[topic] + '\n';
  const lines = help.split('\n').filter(line => line.startsWith(`agent-plan ${topic} `) || line === `agent-plan ${topic}`);
  assert(lines.length, `Unknown help topic: ${topic}. Run agent-plan help.`);
  return lines.join('\n') + '\n';
}
export function supervisorArgs(raw) {
  const args = ['-e', fileURLToPath(new URL('./supervisor-extension.js', import.meta.url)),
    '--plugin-dir', fileURLToPath(new URL('../codex/agent-plan/', import.meta.url)),
    '--skills', 'how,why,arena,architect,blast-radius,open-pr'];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--mcp') continue;
    if (raw[i] === '--mcp-config') {
      throw new Error('OMP discovers MCP in ~/.omp/agent/mcp.json or .omp/mcp.json; --mcp-config is not supported. Move the configuration there before launching.');
    } else args.push(raw[i]);
  }
  return args;
}
export async function supervisorProjectArgs(raw) {
  raw = [...raw];
  const flags = raw.slice(0, raw.indexOf('--') < 0 ? raw.length : raw.indexOf('--'));
  const selected = {}, cwdFlags = [];
  for (let i = 0; i < flags.length; i++) {
    const match = flags[i].match(/^--(cwd|model|provider)(?:=(.*))?$/);
    if (!match) continue;
    const index = i;
    const value = match[2] ?? flags[++i];
    assert(value && !value.startsWith('--'), `Missing --${match[1]} value`);
    selected[match[1]] = value;
    if (match[1] === 'cwd') cwdFlags.push({ index, inline: match[2] !== undefined });
  }
  const cwd = await realpath(resolve(selected.cwd ?? process.cwd()));
  for (const { index, inline } of cwdFlags) {
    if (inline) raw[index] = `--cwd=${cwd}`; else raw[index + 1] = cwd;
  }
  let repo = cwd;
  try { repo = await git(cwd, 'rev-parse', '--show-toplevel'); } catch (error) { if (error.code !== 128) throw error; }
  const config = await loadProjectConfig(repo);
  validateExecution(config, { mode: 'runner', runtime: 'omp' });
  const choice = config.agents?.supervisor ?? {};
  const defaults = [];
  for (const key of ['model', 'provider']) if (!selected[key] && (choice[key] ?? config[key])) defaults.push(`--${key}`, choice[key] ?? config[key]);
  return { cwd, args: supervisorArgs([...defaults, ...raw]) };
}
export const agentIgnore = ['.pi/', '.omp/', '.runner/answers/', '.runner-ui-*/', '.agent-plan/local.json', '.agent-plan/tasks/'];
export async function ensureAgentIgnore(repo) {
  const path = join(repo, '.gitignore');
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = agentIgnore.filter(entry => !present.has(entry));
  if (!missing.length) return { updated: false };
  await writeFile(path, (current && !current.endsWith('\n') ? current + '\n' : current) + missing.join('\n') + '\n');
  await git(repo, 'add', '--', '.gitignore');
  await git(repo, 'commit', '-m', 'Ignore agent-local directories', '--', '.gitignore');
  return { updated: true };
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...raw] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) return showHelp(raw[0]);
  if (raw.includes('--help') || raw.includes('-h')) return showHelp(command);
  if (command === 'skills') {
    const directory = fileURLToPath(new URL('../codex/agent-plan/skills/', import.meta.url));
    const names = (await readdir(directory, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    if (!raw[0]) return names;
    assert(names.includes(raw[0]), 'Unknown packaged skill'); return { name: raw[0], source: join(directory, raw[0], 'SKILL.md'), content: await readFile(join(directory, raw[0], 'SKILL.md'), 'utf8') };
  }
  if (command === 'supervisor') {
    const { args, cwd } = await supervisorProjectArgs(raw);
    await guardSupervisorSessions(args);
    await connect();
    const bun = await ensureBun();
    const code = await new Promise((resolve, reject) => {
      const child = spawn(bun, [ompCli, ...args], { stdio: 'inherit', cwd });
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
    assert(code === 0, `Supervisor exited with status ${code}`); return '';
  }
  const rest = [], selection = {};
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--onboarding') selection.onboarding = true;
    else if (['--model', '--provider', '--target', '--request-id', '--discovery-model', '--discovery-provider', '--planning-model', '--planning-provider', '--hosting-provider', '--hosting-host', '--hosting-project', '--hosting-remote', '--hosting-target'].includes(raw[i])) { const key = raw[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); assert(raw[i + 1] && !raw[i + 1].startsWith('--'), `Missing ${raw[i]} value`); selection[key] = raw[++i]; }
    else rest.push(raw[i]);
  }
  assert(['config', 'init', 'start', 'launch', 'list', 'open', 'stop', 'submit', 'inspect', 'answer', 'resume', 'recover', 'cleanup', 'artifact', 'dashboard', 'notifications', 'cancel', 'feedback', 'onboard', 'repo', 'accept', 'verify', 'webhook', 'hosting', 'hosted-status', 'publish-candidate', 'preview'].includes(command), `Unknown command: ${command}\n${help}`);
  if (command === 'webhook') { assert(rest.length === 1, 'Usage: agent-plan webhook PRIVATE_CONFIG_FILE'); const config = await json(resolve(rest[0])); validateWebhook(config); config.since ??= new Date().toISOString(); await atomic(join(dataRoot(), 'webhook.json'), config); return { configured: true, format: config.webhook.format ?? 'references', since: config.since }; }
  if (command === 'repo') return repos(rest);
  if (command === 'config') {
    assert(rest.length === 1, 'Usage: agent-plan config REPO');
    const repo = await resolveRepo(rest[0]); const config = await loadProjectConfig(repo);
    let execution;
    try { execution = { supported: true, ...validateExecution(config) }; }
    catch (error) { execution = { supported: false, error: error.message }; }
    return { file: await projectConfigPath(repo), execution, capabilities: runtimeCapabilities, agents: config.agents ?? {} };
  }
  if (command === 'init') {
    assert(rest.length === 2, "Usage: agent-plan init <repo> '<verification argv JSON>'");
    const root = await resolveRepo(rest[0]); const argv = JSON.parse(rest[1]);
    if (!Array.isArray(argv) || !argv.length || !argv.every(v => typeof v === 'string' && v.length)) throw new Error('Verification command must be an argv array');
    const file = await projectConfigPath(root);
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(file, JSON.stringify({ commands: { test: argv }, verify: ['test'], maxWorkers: 2 }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { configured: root };
  }
  if (!['list', 'dashboard', 'notifications'].includes(command)) assert(rest[0], `Missing arguments. Run agent-plan help.`);
  if (command === 'hosting') {
    const repo = await resolveRepo(rest[0]); const file = await projectConfigPath(repo); const config = await json(file);
    const overrides = Object.fromEntries(Object.entries(selection).filter(([k]) => k.startsWith('hosting')).map(([k,v]) => [k.slice(7,8).toLowerCase()+k.slice(8),v]));
    config.hosting = await discoverHosting(repo, overrides); await atomic(file, config); return { configured: file, hosting: config.hosting };
  }
  if (command === 'onboard') {
    const repo = await resolveRepo(rest[0]); const file = await projectConfigPath(repo);
    validateExecution(await loadProjectConfig(repo), { mode: 'runner', runtime: 'omp' });
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(file, JSON.stringify({ commands: { test: ['bash', 'verify.sh'] }, verify: ['test'], maxWorkers: 2 }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const config = await json(file);
    const overrides = Object.fromEntries(Object.entries(selection).filter(([k]) => k.startsWith('hosting')).map(([k,v]) => [k.slice(7,8).toLowerCase()+k.slice(8),v]));
    if (Object.keys(overrides).length || !config.hosting) {
      let discovered;
      try { discovered = await discoverHosting(repo, overrides); }
      catch (error) { if (Object.keys(overrides).length) throw error; process.stderr.write(`Hosting not configured: ${error.message}. Set it with agent-plan hosting REPO before hosted delivery.\n`); }
      if (discovered) { config.hosting = discovered; await atomic(file, config); }
    }
    await ensureAgentIgnore(repo);
    return main(['start', repo, await readFile(new URL('./onboarding.md', import.meta.url), 'utf8'), '--onboarding', ...Object.entries(selection).filter(([k]) => k !== 'onboarding' && !k.startsWith('hosting')).flatMap(([k,v]) => ['--' + k.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()),v])]);
  }
  const root = dataRoot();
  if (command === 'notifications') { try { return await json(join(root, 'notifications.json')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  if (command === 'submit' || command === 'launch' || command === 'start' && rest.length >= 2) {
    if (command === 'launch') assert(rest.length === 3, 'Usage: agent-plan launch ALIAS BRIEF_FILE REQUEST_ID');
    const repo = await (command === 'launch' ? resolveAlias(rest[0]) : resolveRepo(rest[0]));
    validateExecution(await loadProjectConfig(repo), { mode: 'runner', runtime: 'omp' });
  }
  const connection = await connect(root); const url = `http://127.0.0.1:${connection.port}`;
  async function request(path, body) {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const action = (action, taskId, input = {}, requestId = randomUUID()) => request('/action', { action, taskId, input, requestId });
  if (command === 'dashboard') return `${url}/#${connection.token}`;
  if (command === 'list') return (await request('/tasks')).map(t => ({ id: t.id, title: t.title ?? null, status: t.status, repo: t.repo, workspace: t.workspace ?? null, branch: t.integration?.branch ?? null, worktree: t.integration?.cwd ?? null, url: t.hosted?.url ?? null }));
  if (command === 'submit') return action('submit', null, { repo: await resolveRepo(rest[0]), text: await readFile(rest[1], 'utf8'), requestId: rest[2] ?? randomUUID() });
  if (command === 'launch') {
    assert(rest.length === 3, 'Usage: agent-plan launch ALIAS BRIEF_FILE REQUEST_ID');
    const requestId = rest[2];
    const task = await action('submit', null, { repo: await resolveAlias(rest[0]), text: await readFile(resolve(rest[1]), 'utf8'), requestId });
    try {
      const started = await action('start', task.id, {}, requestId);
      const agent = started.agents.find(a => a.role === 'orchestrator');
      assert(agent && agent.status !== 'failed', agent?.error ?? 'Orchestrator did not start');
      return { id: task.id, status: started.status, workspace: started.workspace, worktree: started.integration.cwd };
    } catch (e) { throw new Error(`Task ${task.id}: ${e.message}. Retry with the same request ID or inspect this task; never create a replacement.`); }
  }
  let taskId;
  if (command === 'start' && rest.length >= 2) {
    const task = await action('submit', null, { repo: await resolveRepo(rest[0]), text: rest.slice(1).join(' '), ...selection, requestId: selection.requestId ?? randomUUID() }); taskId = task.id;
  } else {
    const matches = (await request('/tasks')).filter(t => t.id === rest[0] || t.id.startsWith(rest[0]));
    assert(matches.length === 1, matches.length ? 'Task prefix is ambiguous; use more of its ID' : 'Unknown task'); taskId = matches[0].id;
  }
  if (command === 'start') {
    try {
      const task = await action('start', taskId, {}, selection.requestId ?? randomUUID()); const agent = task.agents.find(a => a.role === 'orchestrator');
      assert(agent && agent.status !== 'failed', agent?.error ?? 'Orchestrator did not start');
      const place = await action('open', taskId); return { id: taskId, status: task.status, ...place, worktree: task.integration.cwd };
    } catch (e) { throw new Error(`Task ${taskId}: ${e.message}. Inspect this task before retrying; do not submit it again.`); }
  }
  if (command === 'accept') { const task = await action('inspect', taskId); assert(!task.config.hosting || rest[1], 'Hosted approval requires the exact published commit'); return action('accept', taskId, { commit: rest[1] ?? task.verification?.commit, target: selection.target ?? task.config.hosting?.target ?? 'main' }); }
  if (command === 'preview') return action('preview', taskId, { stop: rest.includes('--stop') });
  if (command === 'feedback') { const path = `feedback-${randomUUID()}.md`; await action('write', taskId, { area: 'artifacts', path, content: await readFile(rest[1], 'utf8') }); return action('feedback', taskId, { artifact: path }); }
  if (command === 'answer') {
    const content = await readFile(rest[2], 'utf8'); const path = `answer-${randomUUID()}.md`;
    await action('write', taskId, { area: 'artifacts', path, content }); return action('answer', taskId, { decisionId: rest[1], artifact: path });
  }
  if (command === 'artifact') return action('read', taskId, { area: 'artifacts', path: rest[1], limit: 100000 });
  if (command === 'recover') { const task = await action('inspect', taskId); return action('recover', taskId, { outcome: rest[1], expectedOperation: task.operation, ...(rest[2] ? { evidence: rest[2] } : {}) }); }
  if (command === 'resume') return action('resume', taskId, { agentId: rest[1] });
  return action(command === 'stop' ? 'cancel' : command, taskId);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) main().then(value => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n'), error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
