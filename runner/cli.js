#!/usr/bin/env node
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { json, assert, atomic } from './io.js';
import { connect, dataRoot } from './connection.js';
import { repos, resolveRepo } from './repos.js';
import { validateWebhook } from './notifications.js';
const help = `agent-plan — launch Pi tasks in your running Herdr

agent-plan start <repo> "task description"       Create a workspace and open its orchestrator
agent-plan repo add <alias> <path>                Save a repository alias
agent-plan repo list                              List saved repositories
agent-plan repo remove <alias>                    Forget an alias
agent-plan onboard <repo>                        Explore the repo and create onboarding docs
agent-plan feedback <task> <file>                 Send feedback to its coordinator
agent-plan list                                  Show tasks
agent-plan open <task>                            Focus the task's Herdr session
agent-plan accept <task> [commit] [--target main] Rebase, verify and merge an accepted result
agent-plan verify <task>                          Verify a recovered candidate
agent-plan stop <task>                            Stop agents; preserve worktrees and artifacts
agent-plan init <repo> '<verification argv JSON>' Configure a repository once

The background runtime starts automatically. No daemon terminal or copied submission ID.
Repositories accept saved aliases or paths (use ./name to bypass an alias).
Tasks accept a full ID or a unique prefix. Answer pending questions in the Pi terminal.
State: ~/.local/state/agent-plan (override with RUNNER_DATA).

Advanced:
agent-plan submit <repo> <brief-file> [request-id] Save a draft without model work
agent-plan start <task>                           Start a saved draft and open its session
agent-plan inspect <task>
agent-plan answer <task> <decision-id> <answer-file>
agent-plan resume <task> <agent-id>
agent-plan recover <task> [applied|aborted]
agent-plan cleanup <task>
agent-plan artifact <task> <relative-path>
agent-plan dashboard
agent-plan notifications
agent-plan webhook <private-config-file>          Configure owner notifications

start/onboard accept --model MODEL and --provider PROVIDER.
Stage defaults: --discovery-model/--discovery-provider, --planning-model/--planning-provider.
Starting work uses your configured Pi model and the repo's committed HEAD.
`;
const topics = {
  accept: `agent-plan accept TASK [COMMIT] [--target main]

Accept a completed candidate, rebase its task changes onto local main, rerun checks,
and fast-forward merge. The source repo must be clean with the target checked out.
Conflicts or failed checks stop for inspection. No remote fetch or push is performed.
An explicit COMMIT rejects stale approval. Without it, accept selects the verified commit.`,
  start: `agent-plan start REPO "Task description" [--model MODEL] [--provider PROVIDER]
agent-plan start TASK

REPO is a saved alias or path. TASK is a saved draft ID or unique prefix.
Start Herdr and configure Pi credentials first. The runtime starts automatically.
New tasks use committed HEAD and snapshot .runner/project.json plus the workflow.
Model/provider flags select the coordinator for a new task.

Example: agent-plan start demo "Add a dark mode toggle"`,
  repo: `agent-plan repo add NAME PATH
agent-plan repo list
agent-plan repo remove NAME

Save a Git repository root once, then use NAME with start, submit, init or onboard.
Use ./NAME to bypass an alias. Removing an alias does not delete the repository.

Example: agent-plan repo add demo /path/to/demo`,
  onboard: `agent-plan onboard REPO [--model MODEL] [--provider PROVIDER]

Launch an agent task to produce verify.sh, a .runner/feature-map.md index with
.runner/features/ documents, and conceptual .runner/architecture.md for existing code.
Missing .runner/project.json is scaffolded; existing configuration is preserved.
The result stays in its integration worktree for review; it is not merged.`,
  init: `agent-plan init REPO 'VERIFY_ARGV_JSON'

Create .runner/project.json without launching an agent. Existing config is preserved.
Example: agent-plan init demo '["bun","test"]'`,
  feedback: `agent-plan feedback TASK FILE
agent-plan answer TASK DECISION_ID FILE

Feedback sends a saved text file to an unfinished task's coordinator.
Use answer for an exact pending decision; feedback does not resume a waiting agent.`,
  dashboard: `agent-plan dashboard

Print the private authenticated inspector URL. Open it in your browser to view
assignments, reports, images, verification and worker handoffs.`,
  recovery: `agent-plan inspect TASK
agent-plan resume TASK AGENT_ID
agent-plan recover TASK [applied|aborted]
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
export async function main(args = process.argv.slice(2)) {
  const [command, ...raw] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) return showHelp(raw[0]);
  if (raw.includes('--help') || raw.includes('-h')) return showHelp(command);
  const rest = [], selection = {};
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--onboarding') selection.onboarding = true;
    else if (['--model', '--provider', '--target', '--discovery-model', '--discovery-provider', '--planning-model', '--planning-provider'].includes(raw[i])) { const key = raw[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); assert(raw[i + 1] && !raw[i + 1].startsWith('--'), `Missing ${raw[i]} value`); selection[key] = raw[++i]; }
    else rest.push(raw[i]);
  }
  assert(['init', 'start', 'list', 'open', 'stop', 'submit', 'inspect', 'answer', 'resume', 'recover', 'cleanup', 'artifact', 'dashboard', 'notifications', 'cancel', 'feedback', 'onboard', 'repo', 'accept', 'verify', 'webhook'].includes(command), `Unknown command: ${command}\n${help}`);
  if (command === 'webhook') { assert(rest.length === 1, 'Usage: agent-plan webhook PRIVATE_CONFIG_FILE'); const config = await json(resolve(rest[0])); validateWebhook(config); config.since ??= new Date().toISOString(); await atomic(join(dataRoot(), 'supervisor.json'), config); return { configured: true, format: config.webhook.format ?? 'references', since: config.since }; }
  if (command === 'repo') return repos(rest);
  if (command === 'init') {
    assert(rest.length === 2, "Usage: agent-plan init <repo> '<verification argv JSON>'");
    const root = await resolveRepo(rest[0]); const argv = JSON.parse(rest[1]);
    if (!Array.isArray(argv) || !argv.length || !argv.every(v => typeof v === 'string' && v.length)) throw new Error('Verification command must be an argv array');
    await mkdir(join(root, '.runner'), { recursive: true });
    await writeFile(join(root, '.runner', 'project.json'), JSON.stringify({ commands: { test: argv }, verify: ['test'], maxWorkers: 2 }, null, 2) + '\n', { flag: 'wx' });
    return { configured: root };
  }
  if (!['list', 'dashboard', 'notifications'].includes(command)) assert(rest[0], `Missing arguments. Run agent-plan help.`);
  if (command === 'onboard') {
    const repo = await resolveRepo(rest[0]); await mkdir(join(repo, '.runner'), { recursive: true });
    try { await writeFile(join(repo, '.runner', 'project.json'), JSON.stringify({ commands: { test: ['bash', 'verify.sh'] }, verify: ['test'], maxWorkers: 2 }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return main(['start', repo, await readFile(new URL('./onboarding.md', import.meta.url), 'utf8'), '--onboarding', ...Object.entries(selection).filter(([k]) => k !== 'onboarding').flatMap(([k,v]) => ['--' + k.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()),v])]);
  }
  const root = dataRoot();
  if (command === 'notifications') { try { return await json(join(root, 'notifications.json')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  const connection = await connect(root); const url = `http://127.0.0.1:${connection.port}`;
  async function request(path, body) {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const action = (action, taskId, input = {}, requestId = randomUUID()) => request('/action', { action, taskId, input, requestId });
  if (command === 'dashboard') return `${url}/#${connection.token}`;
  if (command === 'list') return (await request('/tasks')).map(t => ({ id: t.id, status: t.status, repo: t.repo, workspace: t.workspace ?? null }));
  if (command === 'submit') return action('submit', null, { repo: await resolveRepo(rest[0]), text: await readFile(rest[1], 'utf8'), requestId: rest[2] ?? randomUUID() });
  let taskId;
  if (command === 'start' && rest.length >= 2) {
    const task = await action('submit', null, { repo: await resolveRepo(rest[0]), text: rest.slice(1).join(' '), ...selection, requestId: randomUUID() }); taskId = task.id;
  } else {
    const matches = (await request('/tasks')).filter(t => t.id === rest[0] || t.id.startsWith(rest[0]));
    assert(matches.length === 1, matches.length ? 'Task prefix is ambiguous; use more of its ID' : 'Unknown task'); taskId = matches[0].id;
  }
  if (command === 'start') {
    try {
      const task = await action('start', taskId); const agent = task.agents.find(a => a.role === 'orchestrator');
      assert(agent && agent.status !== 'failed', agent?.error ?? 'Orchestrator did not start');
      const place = await action('open', taskId); return { id: taskId, status: task.status, ...place, worktree: task.integration.cwd };
    } catch (e) { throw new Error(`Task ${taskId}: ${e.message}. Inspect this task before retrying; do not submit it again.`); }
  }
  if (command === 'accept') { const task = await action('inspect', taskId); return action('accept', taskId, { commit: rest[1] ?? task.verification?.commit, target: selection.target ?? 'main' }); }
  if (command === 'feedback') { const path = `feedback-${randomUUID()}.md`; await action('write', taskId, { area: 'artifacts', path, content: await readFile(rest[1], 'utf8') }); return action('feedback', taskId, { artifact: path }); }
  if (command === 'answer') {
    const content = await readFile(rest[2], 'utf8'); const path = `answer-${randomUUID()}.md`;
    await action('write', taskId, { area: 'artifacts', path, content }); return action('answer', taskId, { decisionId: rest[1], artifact: path });
  }
  if (command === 'artifact') return action('read', taskId, { area: 'artifacts', path: rest[1], limit: 100000 });
  if (command === 'recover') return action('recover', taskId, { outcome: rest[1] });
  if (command === 'resume') return action('resume', taskId, { agentId: rest[1] });
  return action(command === 'stop' ? 'cancel' : command, taskId);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) main().then(value => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n'), error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
