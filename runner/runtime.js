import { mkdir, readFile, readdir, writeFile, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { atomic, json, id, now, assert, string, git, exec, safePath } from './io.js';
import { Herdr } from './herdr.js';
import { accept, recoverDelivery } from './delivery.js';
import { modelMenu, chooseModel } from './models.js';
import { hookFields } from './notifications.js';
import { selectedSkills } from './skills.js';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const active = a => ['starting', 'running', 'waiting'].includes(a.status);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bundled = name => readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

export class Runtime {
  constructor(root, { transport = new Herdr() } = {}) {
    this.root = resolve(root); this.transport = transport; this.tasks = new Map(); this.tail = Promise.resolve(); this.queues = new Map(); this.processes = new Map(); this.heartbeats = new Map();
  }
  async init() {
    await mkdir(join(this.root, 'tasks'), { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    for (const dir of await readdir(join(this.root, 'tasks'))) {
      if (!/^[a-f0-9-]{36}$/.test(dir)) continue;
      const task = await json(join(this.root, 'tasks', dir, 'state.json'));
      assert(task.id === dir && task.version === 1, `Invalid task ${dir}`);
      for (const agent of task.agents) agent.artifactDir ??= agent.role === 'orchestrator' ? 'orchestrator' : `workers/${agent.id}`;
      this.tasks.set(task.id, task);
    }
  }
  // Serialize each task's state; only Git metadata changes share a repository queue.
  serial(fn, key = 'intake') { const result = (this.queues.get(key) ?? Promise.resolve()).then(fn); const settled = result.catch(() => {}); this.queues.set(key, settled); this.tail = Promise.all([...this.queues.values()]); return result; }
  interrupt(taskId) { for (const [pid, owner] of this.processes) if (owner === taskId) try { process.kill(-pid, 'SIGKILL'); } catch {} }
  dir(task) { return join(this.root, 'tasks', task.id); }
  async save(task) { task.updatedAt = now(); await atomic(join(this.dir(task), 'state.json'), task); this.tasks.set(task.id, task); }
  task(taskId) { const task = this.tasks.get(taskId); assert(task, 'Unknown task'); return structuredClone(task); }
  view(task) {
    const value = structuredClone(task);
    for (const agent of value.agents) { delete agent.token; delete agent.replyToken; }
    value.pendingActions = Object.entries(value.receipts).filter(([, r]) => r.status === 'pending').map(([request, r]) => ({ request, action: r.action }));
    delete value.receipts;
    return value;
  }
  authenticate(token) {
    for (const task of this.tasks.values()) for (const agent of task.agents) if (agent.token === token) return { taskId: task.id, agentId: agent.id };
    return null;
  }
  async artifact(task, content, suffix = 'md', directory = 'runtime') {
    const name = `${directory}/${id()}.${suffix}`;
    await mkdir(join(this.dir(task), 'artifacts', directory), { recursive: true });
    await writeFile(join(this.dir(task), 'artifacts', name), content, { flag: 'wx', mode: 0o600 }); return name;
  }
  async reference(task, path) {
    const target = await safePath(join(this.dir(task), 'artifacts'), path);
    assert((await stat(target)).isFile(), 'Artifact must be a file'); return path;
  }
  message(agent, kind, artifact, extra = {}) { assert(agent, 'No orchestrator available to receive the report'); const message = { id: id(), kind, artifact, ...extra, at: now() }; agent.inbox.push(message); return message; }
  event(task, kind, extra = {}) { task.events.push({ id: id(), kind, at: now(), ...extra }); }
  async create(input) {
    const repo = await realpath(string(input.repo, 'repo', 4096));
    assert(await git(repo, 'rev-parse', '--show-toplevel') === repo, 'repo must be a Git repository root');
    string(input.text, 'task', 100000); string(input.requestId, 'requestId', 200);
    const fingerprint = digest({ repo, text: input.text, model: input.model, provider: input.provider, onboarding: input.onboarding, discoveryModel: input.discoveryModel, discoveryProvider: input.discoveryProvider, planningModel: input.planningModel, planningProvider: input.planningProvider });
    for (const task of this.tasks.values()) if (task.requestId === input.requestId) { assert(task.fingerprint === fingerprint, 'requestId reused with different input'); return this.view(task); }
    let config;
    try { config = await json(join(repo, '.runner', 'project.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; config = { commands: { test: ['bash', 'verify.sh'] }, verify: ['test'], inferredSetup: true }; }
    for (const key of ['model', 'provider']) if (input[key] !== undefined) config[key] = string(input[key], key, 200);
    assert(config.commands && typeof config.commands === 'object' && !Array.isArray(config.commands), 'commands must be a map');
    assert(Array.isArray(config.verify) && config.verify.length, 'Configure at least one verification command');
    for (const [name, argv] of Object.entries(config.commands)) {
      assert(/^[a-z][a-z0-9_-]*$/.test(name), 'Invalid command name');
      assert(Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string' && a.length && !a.includes('\0')), 'Commands must be argv arrays');
    }
    if (input.onboarding) { config.commands.onboard_verify = ['bash', 'verify.sh']; config.verify = [...new Set([...config.verify, 'onboard_verify'])]; }
    for (const name of config.verify) assert(Object.hasOwn(config.commands, name), 'Unknown verification command');
    for (const key of ['setup']) if (config[key]) assert(Object.hasOwn(config.commands, config[key]), 'Unknown setup command');
    for (const key of ['discoveryModel', 'discoveryProvider', 'planningModel', 'planningProvider']) if (input[key] !== undefined) config[key] = string(input[key], key, 200);
    config.discoveryModel ??= 'gpt-5.6-luna'; config.discoveryProvider ??= 'openai-codex';
    for (const key of ['provider', 'model', 'discoveryModel', 'discoveryProvider', 'planningModel', 'planningProvider']) if (config[key]) string(config[key], key, 200);
    config.maxWorkers ??= 2; config.maxAttempts ??= 12; config.timeoutMinutes ??= 60; config.commandTimeoutMs ??= 120000;
    assert(Number.isInteger(config.maxWorkers) && config.maxWorkers >= 1 && config.maxWorkers <= 8, 'maxWorkers must be 1–8');
    assert(Number.isInteger(config.maxAttempts) && config.maxAttempts >= 1 && config.maxAttempts <= 100, 'maxAttempts must be 1–100');
    assert(Number.isFinite(config.timeoutMinutes) && config.timeoutMinutes > 0 && config.timeoutMinutes <= 1440, 'timeoutMinutes must be 0–1440');
    assert(Number.isInteger(config.commandTimeoutMs) && config.commandTimeoutMs >= 100 && config.commandTimeoutMs <= 600000, 'commandTimeoutMs must be 100–600000');
    const task = { version: 1, id: id(), requestId: input.requestId, fingerprint, repo, base: await git(repo, 'rev-parse', 'HEAD'), status: 'queued', stagedWorkflow: true, createdAt: now(), config, agents: [], decisions: [], events: [], receipts: {}, contracts: [], verification: null };
    task.modelMenu = modelMenu(config);
    const skills = await selectedSkills(repo, task.base, config.skills);
    await mkdir(join(this.dir(task), 'artifacts'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dir(task), 'artifacts', 'skills'), { recursive: true });
    for (const skill of skills) await writeFile(join(this.dir(task), 'artifacts', skill.path), skill.content, { flag: 'wx', mode: 0o600 });
    task.skills = 'skills.json';
    await writeFile(join(this.dir(task), 'artifacts', task.skills), JSON.stringify(skills.map(({ source, path }) => ({ source, path }))), { flag: 'wx', mode: 0o600 });
    let workflow;
    try { workflow = await readFile(join(repo, '.runner', 'workflow.md'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; workflow = await bundled('workflow.md'); }
    for (const [name, body] of Object.entries({ 'brief.md': input.text, 'workflow.md': workflow, 'worker.md': await bundled('worker.md'), 'config.json': JSON.stringify(config, null, 2), 'model-menu.json': JSON.stringify(task.modelMenu, null, 2) })) await writeFile(join(this.dir(task), 'artifacts', name), body, { flag: 'wx', mode: 0o600 });
    // Snapshot reference pages too, so later workflow edits cannot change an existing task.
    await mkdir(join(this.dir(task), 'artifacts', 'workflow'), { recursive: true });
    for (const name of await readdir(new URL('./workflow/', import.meta.url))) {
      if (name.endsWith('.md')) await writeFile(join(this.dir(task), 'artifacts', 'workflow', name), await bundled(`workflow/${name}`), { flag: 'wx', mode: 0o600 });
    }
    const files = (await git(repo, 'ls-tree', '-r', '--name-only', task.base, '--', '.runner/feature-map.md', '.runner/architecture.md', '.runner/features')).split('\n').filter(Boolean);
    task.discovery = 'discovery.json';
    await writeFile(join(this.dir(task), 'artifacts', task.discovery), JSON.stringify({
      base: task.base, area: 'repo',
      featureMap: files.includes('.runner/feature-map.md') ? '.runner/feature-map.md' : null,
      architecture: files.includes('.runner/architecture.md') ? '.runner/architecture.md' : null,
      featuresDirectory: files.some(path => path.startsWith('.runner/features/')) ? '.runner/features' : null,
      verificationSetupNeeded: config.inferredSetup === true,
      instruction: 'Read available index/architecture as needed, then only relevant linked feature documents. Missing discovery docs are normal, not a task failure. If verificationSetupNeeded, reuse verify.sh or establish a meaningful verify.sh in the worker worktree. Ask the owner if verification cannot be established; never fake a passing check.'
    }, null, 2), { flag: 'wx', mode: 0o600 });
    task.workflowDigest = digest(workflow); this.event(task, 'submitted'); await this.save(task); return this.view(task);
  }
  async worktree(task, name, base) {
    const cwd = join(this.dir(task), 'worktrees', name);
    await mkdir(dirname(cwd), { recursive: true });
    const branch = `codex/runner-${task.id.slice(0, 8)}-${name}`;
    await this.serial(() => git(task.repo, 'worktree', 'add', '-b', branch, cwd, base), `git:${task.repo}`);
    return { cwd: await realpath(cwd), branch };
  }
  async launch(task, agent) {
    // Save intent and the concrete pane before invoking a non-idempotent launch.
    agent.replyToken ??= id() + id();
    await mkdir(dirname(agent.session), { recursive: true });
    if (agent.artifactDir) await mkdir(join(this.dir(task), 'artifacts', agent.artifactDir), { recursive: true });
    await this.save(task);
    try {
      agent.place = await this.transport.create(task, agent, this.url);
      task.workspace = agent.place.workspace; await this.save(task);
      await this.transport.start(agent, { ...task.config, ...agent.modelSelection });
      agent.status = task.decisions.some(d => d.agentId === agent.id && !d.answer) ? 'waiting' : 'running'; agent.startedAt = now();
    } catch (e) { agent.status = 'failed'; agent.error = `Launch uncertain: ${e.message}. Resume reconciles the recorded attempt.`; this.event(task, 'attention', { agentId: agent.id, error: agent.error }); }
    await this.save(task);
  }
  agent(task, role, cwd, mode = 'explore') {
    assert(task.agents.length < task.config.maxAttempts, 'Attempt budget exhausted');
    const agent = { id: id(), role, mode, cwd, token: id() + id(), replyToken: id() + id(), status: 'starting', createdAt: now(), inbox: [] };
    agent.artifactDir = role === 'orchestrator' ? 'orchestrator' : `workers/${agent.id}`;
    agent.modelSelection = { model: task.config.model, provider: task.config.provider };
    agent.name = `r-${agent.id.slice(0, 16)}`; agent.session = join(this.dir(task), 'sessions', `${agent.id}.jsonl`);
    task.agents.push(agent); return agent;
  }
  async start(task) {
    assert(task.status === 'queued', 'Only queued tasks can start');
    await this.transport.ready?.();
    task.status = 'running'; task.operation = { kind: 'create-integration', at: now() }; await this.save(task);
    task.integration = await this.worktree(task, 'integration', task.base);
    task.operation = null;
    if (task.config.setup) await this.command(task, { cwd: task.integration.cwd }, task.config.setup);
    const agent = this.agent(task, 'orchestrator', task.integration.cwd);
    this.message(agent, 'assignment', 'brief.md', { workflow: 'workflow.md', config: 'config.json', models: 'model-menu.json', discovery: task.discovery, skills: task.skills, artifactDir: agent.artifactDir });
    await this.launch(task, agent); return this.view(task);
  }
  async spawn(task, input) {
    assert(!task.operation, 'Resolve the interrupted operation before spawning');
    assert(task.agents.length < task.config.maxAttempts, 'Attempt budget exhausted');
    assert(task.agents.filter(a => a.role === 'worker' && active(a)).length < task.config.maxWorkers, 'Worker capacity reached');
    assert(['write', 'explore'].includes(input.mode), 'mode must be write or explore');
    for (const key of ['model', 'provider']) if (input[key] !== undefined) string(input[key], key, 200);
    const stage = input.stage ?? (input.mode === 'write' ? 'implementation' : 'discovery');
    assert(['discovery', 'architecture', 'planning', 'implementation'].includes(stage), 'Unknown worker stage');
    assert(stage === 'implementation' || input.mode === 'explore', 'Discovery, architecture and planning workers must be read-only');
    if (stage === 'implementation' && task.stagedWorkflow) assert(task.clarification?.documentsDigest === digest(task.documents ?? {}) && !task.decisions.some(d => !d.answer), 'Coordinator clarification is required before implementation');
    await this.reference(task, input.assignment);
    if (input.contract) { await this.reference(task, input.contract); assert(task.contracts.at(-1)?.artifact === input.contract, 'Use the current shared contract'); }
    if (input.mode === 'write' && task.agents.some(a => a.role === 'worker' && a.mode === 'write' && active(a))) {
      assert(input.contract && task.agents.filter(a => a.role === 'worker' && a.mode === 'write' && active(a)).every(a => a.contract === input.contract), 'Parallel writers must share the same published contract');
    }
    const chosen = chooseModel(task, input, stage);
    if (this.transport.resolveModel) chosen.selection = await this.transport.resolveModel(chosen.selection);
    task.operation = { kind: 'create-worker', at: now() }; await this.save(task);
    const workspace = await this.worktree(task, `w-${id().slice(0, 8)}`, 'refs/heads/' + task.integration.branch);
    task.operation = null;
    if (task.config.setup) await this.command(task, workspace, task.config.setup);
    const agent = this.agent(task, 'worker', workspace.cwd, input.mode);
    Object.assign(agent, { stage, branch: workspace.branch, base: await git(workspace.cwd, 'rev-parse', 'HEAD'), assignment: input.assignment, contract: input.contract ?? null });
    agent.modelSelection = chosen.selection; agent.modelChoice = chosen.choice; agent.modelReason = chosen.reason;
    this.message(agent, 'assignment', input.assignment, { workflow: 'worker.md', discovery: task.discovery, skills: task.skills, contract: agent.contract, artifactDir: agent.artifactDir });
    this.event(task, 'worker-spawned', { agentId: agent.id, artifact: input.assignment, modelSelection: agent.modelSelection });
    await this.launch(task, agent); return { workerId: agent.id, status: agent.status, cwd: agent.cwd, error: agent.error };
  }
  async command(task, agent, name) {
    assert(Object.hasOwn(task.config.commands, name), 'Unknown named command');
    const argv = task.config.commands[name];
    assert(!task.operation, 'Resolve the interrupted operation before running commands');
    const directory = agent.artifactDir ?? 'runtime';
    await mkdir(join(this.dir(task), 'artifacts', directory), { recursive: true });
    const output = `${directory}/${id()}.log`;
    task.operation = { kind: 'command', name, cwd: agent.cwd, output, at: now(), pid: null }; await this.save(task);
    const log = createWriteStream(join(this.dir(task), 'artifacts', output), { flags: 'wx', mode: 0o600 });
    const child = spawnProcess(argv[0], argv.slice(1), { cwd: agent.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error, timedOut = false;
    const logDone = finished(log); logDone.catch(() => {});
    log.once('error', () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    if (child.pid) this.processes.set(child.pid, task.id);
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, task.config.commandTimeoutMs);
    const exited = new Promise(resolve => {
      child.once('error', e => { error = e.message; });
      child.once('close', code => { clearTimeout(timer); this.processes.delete(child.pid); log.end(); resolve({ passed: code === 0 && !timedOut && !error, code, timedOut, ...(error ? { error } : {}) }); });
    });
    task.operation.pid = child.pid ?? null;
    try { await this.save(task); } catch (e) { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; throw e; }
    const result = await exited; await logDone;
    const artifact = await this.artifact(task, JSON.stringify({ command: name, argv, cwd: agent.cwd, at: now(), output, ...result }, null, 2), 'json', directory);
    task.operation = null;
    if (agent.id) agent.lastCommand = artifact;
    this.event(task, 'command-finished', { agentId: agent.id, name, artifact, passed: result.passed }); await this.save(task);
    if (name === task.config.setup) assert(result.passed, `Setup failed; see ${artifact}`);
    return { passed: result.passed, artifact };
  }
  async integrate(task, input) {
    const worker = task.agents.find(a => a.id === input.workerId && a.role === 'worker');
    assert(worker?.status === 'completed' && worker.mode === 'write', 'Worker must have completed writing');
    if (worker.integrated) return { commit: worker.integrated };
    assert(!task.operation, 'An interrupted operation requires owner recovery');
    assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Integration worktree is dirty');
    assert(!task.agents.some(a => a.role === 'worker' && active(a)), 'Wait for current workers before integration');
    const before = await git(task.integration.cwd, 'rev-parse', 'HEAD');
    task.operation = { kind: 'integrate', workerId: worker.id, before, commit: worker.commit, at: now() }; await this.save(task);
    try {
      if (worker.commit !== worker.base) {
        await git(worker.cwd, 'merge-base', '--is-ancestor', worker.base, worker.commit);
        const commits = (await git(worker.cwd, 'rev-list', '--reverse', `${worker.base}..${worker.commit}`)).split('\n');
        await git(task.integration.cwd, 'cherry-pick', ...commits);
      }
      worker.integrated = await git(task.integration.cwd, 'rev-parse', 'HEAD');
      task.operation = null; task.verification = null; await this.save(task); return { commit: worker.integrated };
    } catch (e) { this.event(task, 'attention', { error: 'Integration conflict; retained for owner recovery', workerId: worker.id }); await this.save(task); throw new Error(`Integration stopped: ${e.message}`); }
  }
  async verify(task) {
    assert(!task.operation && !task.agents.some(a => a.role === 'worker' && active(a)), 'Wait for workers and resolve interrupted operations');
    assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Integration worktree is dirty');
    const commit = await git(task.integration.cwd, 'rev-parse', 'HEAD');
    const checks = [];
    for (const name of task.config.verify) checks.push({ name, ...await this.command(task, task.integration, name) });
    const passed = checks.every(c => c.passed) && commit === await git(task.integration.cwd, 'rev-parse', 'HEAD') && !await git(task.integration.cwd, 'status', '--porcelain');
    const artifact = await this.artifact(task, JSON.stringify({ commit, checks, passed, at: now() }, null, 2), 'json');
    task.verification = { commit, passed, artifact }; await this.save(task); return task.verification;
  }
  async report(task, agent, input) {
    assert(['completed', 'failed'].includes(input.status), 'Invalid report status'); await this.reference(task, input.artifact);
    if (agent.role === 'orchestrator' && input.status === 'completed') {
      assert(!task.operation && !task.agents.some(a => a.role === 'worker' && active(a)), 'Unfinished work remains');
      assert(!task.decisions.some(d => !d.answer), 'Unanswered decisions remain');
      assert(task.agents.filter(a => a.role === 'worker' && a.mode === 'write' && a.status === 'completed').every(a => a.integrated), 'Completed writing work must be integrated');
      assert(task.verification?.passed && task.verification.commit === await git(agent.cwd, 'rev-parse', 'HEAD') && !await git(agent.cwd, 'status', '--porcelain'), 'Fresh passing integration verification is required');
    }
    if (agent.role === 'worker' && agent.mode === 'write' && input.status === 'completed') {
      task.operation = { kind: 'worker-commit', agentId: agent.id, at: now() }; await this.save(task);
      await git(agent.cwd, 'add', '-A');
      if (await git(agent.cwd, 'diff', '--cached', '--name-only')) await git(agent.cwd, 'commit', '-m', `Implement runner assignment ${agent.id.slice(0, 8)}`, '-m', `Fulfil the task described in ${agent.assignment}; handoff: ${input.artifact}`);
      agent.commit = await git(agent.cwd, 'rev-parse', 'HEAD'); task.operation = null;
    }
    agent.status = input.status; agent.report = input.artifact;
    if (agent.role === 'orchestrator') { task.status = input.status; task.result = input.artifact; }
    else this.message(task.agents.findLast(a => a.role === 'orchestrator'), 'worker-report', input.artifact, { workerId: agent.id, status: input.status, commit: agent.commit });
    this.event(task, agent.role === 'orchestrator' ? input.status : 'worker-report', { agentId: agent.id, artifact: input.artifact });
    await this.save(task); return { status: input.status, artifact: input.artifact };
  }
  async attachments(task, paths = []) {
    assert(Array.isArray(paths) && paths.length <= 4, 'Attach at most four artifact files');
    for (const path of paths) await this.reference(task, path);
    return paths;
  }
  async ask(task, agent, input) {
    const hook = hookFields(input.hook);
    await this.reference(task, input.artifact); const attachments = await this.attachments(task, input.attachments);
    const decision = { id: id(), agentId: agent.id, audience: agent.role === 'orchestrator' ? 'owner' : 'orchestrator', artifact: input.artifact, attachments, at: now() };
    task.decisions.push(decision); agent.status = 'waiting';
    if (decision.audience === 'owner') { task.status = 'waiting'; this.event(task, 'decision', { decisionId: decision.id, artifact: input.artifact, attachments, ...hook }); }
    else this.message(task.agents.findLast(a => a.role === 'orchestrator'), 'question', input.artifact, { decisionId: decision.id, workerId: agent.id, attachments });
    await this.save(task); return { decisionId: decision.id, status: 'waiting' };
  }
  async answer(task, actor, input) {
    const decision = task.decisions.find(d => d.id === input.decisionId);
    assert(decision, 'Unknown decision');
    assert(actor === 'owner' || decision.audience === 'orchestrator', 'Only the owner may answer user decisions');
    await this.reference(task, input.artifact);
    if (decision.answer) { assert(decision.answer === input.artifact, 'Decision already answered differently'); return { decisionId: decision.id, artifact: decision.answer }; }
    const agent = task.agents.find(a => a.id === decision.agentId);
    assert(agent?.status === 'waiting', 'Decision targets an inactive attempt');
    decision.answer = input.artifact; decision.answeredBy = actor; decision.answeredAt = now(); agent.status = 'running'; agent.startedAt = now();
    if (agent.role === 'orchestrator') task.status = 'running';
    this.message(agent, 'answer', input.artifact, { decisionId: decision.id }); await this.save(task); return { decisionId: decision.id, artifact: input.artifact };
  }
  async terminalAnswer(token, input) {
    let match;
    for (const task of this.tasks.values()) for (const agent of task.agents) if (agent.replyToken === token) match = { taskId: task.id, agentId: agent.id, repo: task.repo };
    assert(match, 'Invalid terminal reply credential'); string(input.text, 'answer', 100000);
    return this.serial(async () => {
      const task = this.task(match.taskId); const decision = task.decisions.find(d => d.id === input.decisionId && d.agentId === match.agentId);
      assert(decision && !terminal.has(task.status), 'No matching active decision');
      if (decision.answer) { assert(decision.terminalTextDigest === digest(input.text), 'Decision already answered differently'); return { decisionId: decision.id, artifact: decision.answer }; }
      const artifact = await this.artifact(task, input.text); decision.terminalTextDigest = digest(input.text);
      return this.answer(task, 'owner', { decisionId: decision.id, artifact });
    }, match.taskId);
  }
  poll(identity) {
    const task = this.task(identity.taskId); const agent = task.agents.find(a => a.id === identity.agentId);
    assert(agent, 'Unknown attempt'); this.heartbeats.set(agent.id, Date.now());
    const status = active(agent) && task.decisions.some(d => d.agentId === agent.id && !d.answer) ? 'waiting' : agent.status;
    return { artifactDir: agent.artifactDir, status, taskStatus: task.status, decision: task.decisions.find(d => d.agentId === agent.id && !d.answer) ?? null, messages: active(agent) && !terminal.has(task.status) ? agent.inbox.filter(m => !m.acknowledgedAt) : [] };
  }
  async files(task, actor, action, input) {
    assert(['repo', 'artifacts'].includes(input.area), 'area must be repo or artifacts');
    assert(actor === 'owner' ? input.area === 'artifacts' : true, 'Owner file API is artifacts-only');
    const root = input.area === 'artifacts' ? join(this.dir(task), 'artifacts') : actor.cwd;
    if (action === 'write') {
      assert(actor === 'owner' || input.area === 'artifacts' || actor.role === 'worker' && actor.mode === 'write', 'This agent cannot write repository files');
      assert(typeof input.content === 'string' && input.content.length <= 1000000, 'content must be at most 1000000 characters');
      const path = await safePath(root, input.path, true);
      if (input.area === 'artifacts' && actor !== 'owner' && actor.role === 'worker') {
        assert(actor.artifactDir && path.startsWith(join(root, actor.artifactDir) + '/'), 'Workers may write only their own artifact directory');
      } await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, { flag: input.area === 'artifacts' ? 'wx' : 'w', mode: 0o600 });
      this.event(task, 'file-written', { agentId: actor.id ?? 'owner', area: input.area, path: input.path, ...(input.area === 'artifacts' ? { artifact: input.path } : {}) }); await this.save(task); return { artifact: input.area === 'artifacts' ? input.path : undefined, path: input.path };
    }
    const path = input.path === '.' ? root : await safePath(root, input.path);
    if ((await stat(path)).isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).filter(e => !['.git', '.pi'].includes(e.name));
      return { entries: entries.map(e => e.name).sort(), directories: entries.filter(e => e.isDirectory()).map(e => e.name) };
    }
    if (path.endsWith('.png')) { assert((await stat(path)).size <= 10000000, 'Image exceeds 10 MB'); const data = await readFile(path); assert(data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Invalid PNG'); return { mimeType: 'image/png', base64: data.toString('base64') }; }
    const content = await readFile(path, 'utf8'); const offset = input.offset ?? 0; const limit = input.limit ?? 20000;
    assert(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100000, 'Invalid read window');
    return { content: content.slice(offset, offset + limit), nextOffset: offset + limit < content.length ? offset + limit : null };
  }
  async resume(task, input) {
    assert(['running', 'waiting'].includes(task.status), 'Only unfinished tasks can resume');
    assert(!task.operation, 'Resolve interrupted operation first with recover');
    const agent = task.agents.find(a => a.id === input.agentId); assert(agent && agent.status !== 'completed' && agent.status !== 'cancelled', 'Unknown or settled attempt');
    let status = await this.transport.status(agent);
    assert(status !== 'unknown', 'Session state unknown; inspect its terminal before retrying');
    if (status !== 'missing' && agent.status !== 'failed') return { resumed: agent.id, existing: true };
    if (status !== 'missing') {
      await this.transport.stop(agent);
      status = await this.transport.status(agent);
      assert(status === 'missing', 'Previous attempt has not stopped; inspect before relaunching');
    }
    const artifact = await this.artifact(task, JSON.stringify({ instruction: 'Resume the saved assignment. Inspect current task state and decisions before changing anything. Reuse completed work.', assignment: agent.assignment ?? 'brief.md', workflow: agent.role === 'orchestrator' ? 'workflow.md' : 'worker.md', contract: agent.contract, decisions: task.decisions.filter(d => d.agentId === agent.id), checkpoint: agent.checkpoint ?? null, lastCommand: agent.lastCommand ?? null, previousFailure: agent.failure ?? agent.error ?? null }, null, 2), 'json');
    this.message(agent, 'resume', artifact);
    // Reuse the durable Pi session and inbox after confirming the previous process is gone.
    agent.status = 'starting'; delete agent.error; await this.launch(task, agent); return { resumed: agent.id, existing: false, status: agent.status };
  }
  async recover(task, input) {
    assert(task.operation, 'No interrupted operation');
    if (['accept-rebase', 'accept-merge'].includes(task.operation.kind)) return recoverDelivery(this, task, input);
    if (task.operation.kind === 'command') {
      assert(task.operation.pid, 'Command launch identity is uncertain; inspect retained work before recovery');
      let alive = true; try { process.kill(-task.operation.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
      assert(!alive, 'Command process group is still alive; stop or await it before recovery');
    }
    assert(task.integration, 'Integration creation interrupted; cancel and inspect retained worktree');
    assert(!await git(task.integration.cwd, 'status', '--porcelain'), 'Resolve/abort Git operation and leave integration clean first');
    try { await git(task.integration.cwd, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD'); throw new Error('Finish or abort cherry-pick first'); } catch (e) { if (e.message === 'Finish or abort cherry-pick first') throw e; }
    if (task.operation.kind === 'integrate') {
      assert(['applied', 'aborted'].includes(input.outcome), 'Specify recovery outcome applied or aborted');
      const operation = task.operation; const worker = task.agents.find(a => a.id === operation.workerId);
      const head = await git(task.integration.cwd, 'rev-parse', 'HEAD');
      if (input.outcome === 'aborted') assert(head === operation.before, 'Integration HEAD differs from the pre-operation commit');
      else { const equivalent = await git(task.integration.cwd, 'cherry', head, worker.commit, worker.base); assert(!equivalent.split('\n').some(line => line.startsWith('+ ')), 'Cannot prove worker commits were applied; resolve Git state first'); worker.integrated = head; }
    }
    this.event(task, 'recovered', { operation: task.operation }); task.operation = null; task.verification = null; await this.save(task); return this.view(task);
  }
  async cancel(task) {
    assert(task.status !== 'completed', 'Completed tasks cannot be cancelled'); task.status = 'cancelled';
    for (const agent of task.agents) if (active(agent) || agent.status === 'failed') agent.status = 'cancelled';
    this.event(task, 'cancelled'); await this.save(task);
    const errors = [];
    for (const agent of task.agents) try { await this.transport.stop(agent); } catch (e) { errors.push({ agentId: agent.id, error: e.message }); }
    return { status: task.status, stopErrors: errors };
  }
  async cleanup(task) {
    assert(terminal.has(task.status), 'Only terminal tasks can be cleaned');
    assert(!task.operation, 'Interrupted operation must be inspected before cleanup');
    for (const agent of task.agents) await this.transport.stop(agent);
    const paths = [...new Set([task.integration?.cwd, ...task.agents.filter(a => a.role === 'worker').map(a => a.cwd)].filter(Boolean))];
    for (const cwd of paths) { try { await stat(cwd); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } assert(!await git(cwd, 'status', '--porcelain'), `Keep dirty worktree: ${cwd}`); }
    for (const cwd of paths) { try { await stat(cwd); } catch { continue; } await git(task.repo, 'worktree', 'remove', cwd); }
    task.cleanedAt = now(); await this.save(task); return { cleanedAt: task.cleanedAt, branchesRetained: true };
  }
  async execute(identity, input) {
    const target = this.tasks.get(identity === 'owner' ? input.taskId : identity.taskId);
    if (identity === 'owner' && input.action === 'open') { assert(target, 'Unknown task'); const agent = target.agents.findLast(a => a.role === 'orchestrator'); assert(agent, 'This task has no orchestrator session'); return { taskId: target.id, ...await this.transport.open(agent) }; }
    if (identity === 'owner' && input.action === 'cancel' && target) this.interrupt(target.id);
    if (input.action === 'read' && target) { const actor = identity === 'owner' ? 'owner' : target.agents.find(a => a.id === identity.agentId); assert(actor === 'owner' || actor && active(actor) && !terminal.has(target.status), 'Inactive attempt'); return this.files(target, actor, 'read', input.input); }
    return this.serial(async () => {
      if (input.action === 'submit') { assert(identity === 'owner', 'Owner access required'); return this.create(input.input); }
      const task = this.task(identity === 'owner' ? input.taskId : identity.taskId);
      const actor = identity === 'owner' ? 'owner' : task.agents.find(a => a.id === identity.agentId);
      const owner = actor === 'owner'; const orchestrator = actor?.role === 'orchestrator';
      const action = input.action; const body = input.input ?? {};
      if (action === 'inspect') return this.view(task);
      if (action === 'peers') { assert(owner || orchestrator, 'Orchestrator access required'); return [...this.tasks.values()].filter(t => t.repo === task.repo && t.id !== task.id).map(t => ({ id: t.id, status: t.status, documents: t.documents ?? {} })); }
      string(input.requestId, 'requestId', 200);
      const key = `${owner ? 'owner' : actor.id}:${input.requestId}`; const fingerprint = digest({ action, body });
      if (task.receipts[key]) { const receipt = task.receipts[key]; assert(receipt.fingerprint === fingerprint, 'requestId reused with different input'); assert(receipt.status === 'completed', receipt.error || 'Previous request outcome is uncertain; inspect before issuing another action'); return receipt.result; }
      assert(owner || active(actor) && !terminal.has(task.status), 'Inactive attempt');
      if (!owner && actor.status === 'waiting') assert(['read', 'ack'].includes(action), 'Waiting for a decision');
      let result;
      if (action !== 'read') { task.receipts[key] = { fingerprint, action, status: 'pending' }; await this.save(task); }
      try {
      if (action === 'read' || action === 'write') result = await this.files(task, actor, action, body);
      else if (action === 'remove') { assert(!owner && actor.role === 'worker' && actor.mode === 'write', 'Writing worker required'); await unlink(await safePath(actor.cwd, body.path)); result = { removed: body.path }; }
      else if (action === 'ack') {
        assert(!owner && Array.isArray(body.ids), 'Invalid acknowledgement');
        for (const message of actor.inbox) if (body.ids.includes(message.id)) message.acknowledgedAt ??= now();
        result = { acknowledged: body.ids }; await this.save(task);
      } else if (action === 'answer') { assert(owner || orchestrator, 'Orchestrator access required'); result = await this.answer(task, owner ? 'owner' : actor.id, body); }
      else if (action === 'start') { assert(owner, 'Owner access required'); result = await this.start(task); }
      else if (action === 'resume') { assert(owner, 'Owner access required'); result = await this.resume(task, body); }
      else if (action === 'recover') { assert(owner, 'Owner access required'); result = await this.recover(task, body); }
      else if (action === 'cancel') { assert(owner, 'Owner access required'); result = await this.cancel(task); }
      else if (action === 'accept') { assert(owner, 'Owner access required'); result = await this.serial(() => accept(this, task, body), `delivery:${task.repo}`); }
      else if (action === 'cleanup') { assert(owner, 'Owner access required'); result = await this.cleanup(task); }
      else if (action === 'surface') {
        assert(orchestrator, 'Orchestrator access required'); await this.reference(task, body.artifact);
        const attachments = await this.attachments(task, body.attachments);
        this.event(task, 'attention', { artifact: body.artifact, attachments, ...hookFields(body.hook) }); await this.save(task); result = { surfaced: true, artifact: body.artifact };
      }
      else if (action === 'clarify') {
        assert(orchestrator, 'Orchestrator access required'); await this.reference(task, body.artifact);
        assert(!task.decisions.some(d => !d.answer) && !task.agents.some(a => a.role === 'worker' && a.mode === 'explore' && active(a)), 'Resolve questions and await planning/discovery workers first');
        task.clarification = { artifact: body.artifact, documentsDigest: digest(task.documents ?? {}), at: now() };
        this.event(task, 'clarified', { artifact: body.artifact }); await this.save(task); result = task.clarification;
      }
      else if (action === 'coordinate') {
        assert(orchestrator, 'Orchestrator access required'); await this.reference(task, body.artifact);
        const peer = this.task(body.taskId);
        assert(peer.id !== task.id && peer.repo === task.repo && !terminal.has(peer.status), 'Choose an unfinished peer task in this repository');
        assert(peer.agents.some(a => a.role === 'orchestrator'), 'Peer coordinator has not started');
        const message = { id: id(), taskId: peer.id, artifact: body.artifact, at: now() };
        task.outbox ??= []; task.outbox.push(message); this.event(task, 'coordination-sent', message); await this.save(task); result = { messageId: message.id, queued: true };
      }
      else if (action === 'publish') {
        assert(!owner, 'Agent access required');
        const path = await safePath(actor.cwd, body.path);
        assert((await stat(path)).size <= 10000000, 'Image exceeds 10 MB');
        const bytes = await readFile(path); assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Only PNG screenshots are supported');
        const artifact = await this.artifact(task, bytes, 'png', actor.artifactDir);
        this.event(task, 'evidence-published', { agentId: actor.id, artifact }); await this.save(task); result = { artifact };
      }
      else if (action === 'checkpoint') {
        assert(!owner, 'Agent access required'); await this.reference(task, body.artifact);
        actor.checkpoint = body.artifact; this.event(task, 'checkpoint', { agentId: actor.id, artifact: body.artifact }); await this.save(task); result = { artifact: body.artifact };
      }
      else if (action === 'revise') {
        assert(owner || orchestrator, 'Orchestrator access required');
        string(body.name, 'document name', 200); assert(/^[a-z][a-z0-9_-]*$/.test(body.name), 'Use a simple document name'); await this.reference(task, body.artifact);
        task.documents ??= {};
        assert((task.documents[body.name] ?? null) === (body.previous ?? null), 'Document revision changed; read current state first');
        task.documents[body.name] = body.artifact;
        this.event(task, 'document-revised', { name: body.name, previous: body.previous ?? null, artifact: body.artifact });
        for (const worker of task.agents.filter(a => a.role === 'worker' && active(a))) this.message(worker, 'document-revised', body.artifact, { name: body.name });
        await this.save(task); result = { name: body.name, artifact: body.artifact };
      }
      else if (action === 'feedback') {
        assert(owner && !terminal.has(task.status), 'Owner feedback requires an unfinished task'); await this.reference(task, body.artifact);
        this.message(task.agents.findLast(a => a.role === 'orchestrator'), 'owner-feedback', body.artifact);
        this.event(task, 'feedback', { artifact: body.artifact }); await this.save(task); result = { artifact: body.artifact };
      }
      else if (action === 'spawn') { assert(orchestrator, 'Orchestrator access required'); result = await this.spawn(task, body); }
      else if (action === 'pause') { assert(orchestrator, 'Orchestrator access required'); const worker = task.agents.find(a => a.id === body.workerId && a.role === 'worker'); assert(worker?.status === 'running', 'Worker must be running'); result = await this.ask(task, worker, body); }
      else if (action === 'contract') {
        assert(orchestrator && !task.agents.some(a => a.role === 'worker' && a.mode === 'write' && ['starting', 'running'].includes(a.status)), 'Pause writing workers before revising shared contracts');
        await this.reference(task, body.artifact); const contract = { artifact: body.artifact, revision: task.contracts.length + 1, at: now() };
        task.contracts.push(contract); for (const worker of task.agents.filter(a => a.role === 'worker' && active(a))) { worker.contract = body.artifact; this.message(worker, 'contract', body.artifact, { revision: contract.revision }); }
        result = contract; await this.save(task);
      } else if (action === 'integrate') { assert(orchestrator, 'Orchestrator access required'); result = await this.integrate(task, body); }
      else if (action === 'verify') { assert(owner || orchestrator, 'Orchestrator access required'); result = await this.verify(task); }
      else if (action === 'command') { assert(!owner && (orchestrator || actor.mode === 'write'), 'Explore workers cannot run commands'); result = await this.command(task, actor, body.name); }
      else if (action === 'ask') { assert(!owner, 'Agent access required'); result = await this.ask(task, actor, body); }
      else if (action === 'fault') { assert(!owner, 'Agent access required'); await this.reference(task, body.artifact); actor.status = 'failed'; actor.error = 'Agent turn failed; see the failure artifact'; actor.failure = body.artifact; this.event(task, 'attention', { agentId: actor.id, artifact: body.artifact }); if (actor.role === 'worker') this.message(task.agents.findLast(a => a.role === 'orchestrator'), 'worker-report', body.artifact, { workerId: actor.id, status: 'failed' }); await this.save(task); result = { status: 'failed' }; }
      else if (action === 'report') { assert(!owner, 'Agent access required'); result = await this.report(task, actor, body); }
      else throw new Error(`Unknown action: ${action}`);
      // Reads do not retain their contents in task state or inflate every future write.
      if (action !== 'read') { const current = this.task(task.id); current.receipts[key] = { fingerprint, action, status: 'completed', result }; await this.save(current); }
      return result;
      } catch (error) { if (action !== 'read') { const current = this.task(task.id); current.receipts[key] = { fingerprint, action, status: 'failed', error: error.message }; await this.save(current); } throw error; }
    }, target?.id ?? 'intake');
  }
  async deliverCoordination() {
    // Deliver outside source task locks: opposite-direction messages cannot deadlock.
    for (const source of [...this.tasks.values()]) for (const message of source.outbox ?? []) {
      if (message.deliveredAt) continue;
      const delivered = await this.serial(async () => {
        const target = this.task(message.taskId); const coordinator = target.agents.findLast(a => a.role === 'orchestrator');
        if (coordinator.inbox.some(m => m.deliveryId === message.id)) return true;
        if (terminal.has(target.status)) return false;
        const content = await readFile(await safePath(join(this.dir(source), 'artifacts'), message.artifact));
        const artifact = await this.artifact(target, content, 'md', `coordination/${source.id}`);
        this.message(coordinator, 'coordination', artifact, { deliveryId: message.id, sourceTaskId: source.id, sourceArtifact: message.artifact });
        this.event(target, 'coordination-received', { sourceTaskId: source.id, artifact }); await this.save(target); return true;
      }, message.taskId);
      await this.serial(async () => { const current = this.task(source.id); const pending = current.outbox.find(m => m.id === message.id); pending.deliveredAt = now(); pending.deliveryStatus = delivered ? 'delivered' : 'undeliverable'; if (!delivered) this.event(current, 'attention', { artifact: message.artifact, error: 'Peer task ended before coordination delivery' }); await this.save(current); }, source.id);
    }
  }
  async reconcile() {
    await this.deliverCoordination();
    for (const original of [...this.tasks.values()]) {
      if (!['running', 'waiting'].includes(original.status)) continue;
      for (const old of original.agents.filter(active)) {
        const overdue = old.status !== 'waiting' && Date.now() - Date.parse(old.startedAt ?? old.createdAt) > original.config.timeoutMinutes * 60000;
        if (!overdue && Date.now() - (this.heartbeats.get(old.id) ?? 0) < 15000) continue;
        const observedStart = old.startedAt;
        const status = await this.transport.status(old);
        await this.serial(async () => {
          const task = this.task(original.id); const agent = task.agents.find(a => a.id === old.id);
          if (!active(agent) || agent.startedAt !== observedStart) return;
          const expired = agent.status !== 'waiting' && Date.now() - Date.parse(agent.startedAt ?? agent.createdAt) > task.config.timeoutMinutes * 60000;
          // Herdr lookup happens outside the task queue: a live Pi may poll while it runs.
          if (!expired && Date.now() - (this.heartbeats.get(agent.id) ?? 0) < 15000) return;
          if (status === 'missing' || expired) {
            agent.status = 'failed'; agent.error = expired ? 'Attempt time budget exceeded' : 'Session disappeared; partial work retained';
            const artifact = await this.artifact(task, JSON.stringify({ agentId: agent.id, error: agent.error, observedStatus: status, lastHeartbeat: this.heartbeats.get(agent.id) ?? null, checkedAt: now(), session: agent.session, place: agent.place }, null, 2), 'json');
            agent.failure = artifact;
            this.event(task, 'attention', { agentId: agent.id, error: agent.error, artifact });
            if (agent.role === 'worker') this.message(task.agents.findLast(a => a.role === 'orchestrator'), 'worker-report', artifact, { workerId: agent.id, status: 'failed' });
            await this.save(task);
            if (expired) await this.transport.stop(agent).catch(() => {});
          }
        }, original.id);
      }
    }
  }
}
