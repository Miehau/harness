// Opt-in live architecture smoke: normal OMP credentials, disposable repository.
import { mkdtemp, mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '../runner/server.js';
import { git, id, assert } from '../runner/io.js';

const root = await mkdtemp(join(tmpdir(), 'agent-plan-architecture-smoke-'));
const repo = join(root, 'repo');
const output = new URL('../plans/architecture-smoke/', import.meta.url);
await mkdir(output, { recursive: true });
await mkdir(join(repo, '.agent-plan'), { recursive: true });
await mkdir(join(repo, 'docs'), { recursive: true });
await writeFile(join(repo, 'queue.js'), `export class Queue {
  constructor() { this.items = []; this.nextId = 1; }
  enqueue(payload) { const job = { id: this.nextId++, payload }; this.items.push(job); return job.id; }
  take() { return this.items.shift() ?? null; }
}
`);
await writeFile(join(repo, 'worker.js'), `export async function drain(queue, deliver) {
  let job;
  while ((job = queue.take())) await deliver(job.payload);
}
`);
await writeFile(join(repo, 'test.mjs'), `import assert from 'node:assert/strict';
import { Queue } from './queue.js'; import { drain } from './worker.js';
const q = new Queue(); assert.equal(q.enqueue('a'), 1); q.enqueue('b');
const got=[]; await drain(q, async p => got.push(p)); assert.deepEqual(got,['a','b']); assert.equal(q.take(), null);
`);
await writeFile(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
await writeFile(join(repo, 'docs/decision.md'), '# Current design\nAn in-memory FIFO was chosen for a single-process prototype to avoid infrastructure and keep enqueue synchronous. There was no durability requirement. Jobs are removed before delivery; failed delivery loses that job. We have no evidence explaining why identifiers start at 1.\n');
await writeFile(join(repo, 'AGENTS.md'), 'This is a preparation-only architecture smoke test. Read repository code and history. Do not modify repository files or run implementation. Save proposals through runner artifact tools. No external services or credentials are relevant.\n');
await writeFile(join(repo, '.agent-plan/project.json'), JSON.stringify({
 execution: { mode: 'runner', runtime: 'omp' },
 agents: { coordinator: { model: 'gpt-6-sol', provider: 'openai-codex' }, discovery: { model: 'gpt-6-luna', provider: 'openai-codex' } },
 workerModels: {
  proposal_grok: { model: 'grok-4.7', provider: 'xai-oauth', purpose: 'Independent architecture proposal A' },
  proposal_terra: { model: 'gpt-5.6-terra', provider: 'openai-codex', purpose: 'Independent architecture proposal B' },
  proposal_sol: { model: 'gpt-6-sol', provider: 'openai-codex', purpose: 'Independent architecture proposal C' },
  judge: { model: 'grok-4.7', provider: 'xai-oauth', purpose: 'Separate cross-family judge after all proposals finish' }
 }, commands: { test: [process.execPath, 'test.mjs'] }, verify: ['test'], maxWorkers: 3, maxAttempts: 100,
}, null, 2));
await git(repo,'init','-b','main'); await git(repo,'config','user.name','Skill Smoke'); await git(repo,'config','user.email','smoke@example.invalid');
await git(repo,'add','.'); await git(repo,'commit','-m','Prototype queue uses memory to avoid infrastructure before durability is required');
let app, taskId;
const startedAt = new Date().toISOString();
try {
 app = await serve(join(root, 'data'));
 const submitted = await app.runtime.execute('owner', { action: 'submit', input: { repo, requestId: id(), text: `Preparation only: smoke-test the packaged how, why, architect and arena skills on this queue. Do not implement, publish, merge or choose on behalf of the owner.
Design durable job delivery for one local process with restart recovery, FIFO best effort, and at-least-once delivery. A crash after external delivery but before acknowledgement may duplicate a job: do not promise exactly-once unless the external receiver explicitly supports idempotency. No external broker service is allowed; built-in/local storage is fine. Existing enqueue API is synchronous today; proposals must explain compatibility or migration. No need to ask preliminary scope questions: all constraints for this experiment are here.
First load the actual packaged skill instructions. Delegate one bounded discovery worker using how and why to trace queue.js and worker.js, inspect Git/docs, distinguish documented rationale from inference, and record unavailable evidence sources. Read that grounding yourself.
Then give THREE independent stage=architecture mode=explore workers the SAME grounded brief, committed base and rubric in separate worktrees, using modelChoice proposal_grok, proposal_terra, proposal_sol respectively. Each reads architect/references/runner-prompt.md, rationale-template.md and design-red-flags.md. Do not expose other candidates' proposals before all authors finish. Ask for concise but complete proposals, caller usage and interface sketches, crash/ack recovery behavior, ordering, alternatives, risks and verification. Rubric: recovery/delivery semantics, compatibility, operational simplicity, evidence-grounded tradeoffs, testability.
After all three proposals complete, run a separate read-only planning worker with modelChoice judge to score all three by the rubric and screen design red flags. You (Sol coordinator) must read every original proposal and the judge, synthesize a recommendation, explain rejected alternatives and useful grafts, record convergence honestly, and verify against constraints. End with ask requiresOwner=true referencing one comparison artifact that links all three proposals, grounding, judge and exact base. That expected design decision is the successful terminal condition for this PREPARATION-ONLY smoke test. No implementation worker and no report-completed pretending that implementation occurred. Keep it bounded; no unnecessary documentation or polling loops.` } });
 taskId = submitted.id; console.log(JSON.stringify({ startedAt, taskId, root }));
 await app.runtime.execute('owner', { action: 'start', taskId, requestId: id() });
 const deadline = Date.now() + 20*60*1000;
 while (true) {
  const task = app.runtime.task(taskId);
  if (task.decisions.some(d => !d.answer && d.requiresOwner)) break;
  if (task.decisions.some(d => !d.answer && d.audience === 'owner')) break;
  assert(!['failed','cancelled','completed'].includes(task.status), `Unexpected terminal status ${task.status}`);
  assert(!task.agents.some(a => a.role === 'orchestrator' && a.status === 'failed'), 'Coordinator failed');
  assert(Date.now() < deadline, 'Architecture smoke timed out');
  await sleep(2000);
 }
 const task = app.runtime.task(taskId);
 const proposals = task.agents.filter(a => a.stage === 'architecture' && a.status === 'completed');
 const judge = task.agents.filter(a => a.stage === 'planning' && a.modelChoice === 'judge' && a.status === 'completed');
 const checks = {
  threeCompletedProposals: proposals.length === 3,
  separateWorktrees: new Set(proposals.map(a=>a.cwd)).size === 3,
  sameBase: proposals.every(a=>a.base===task.base),
  requestedModels: ['grok-4.7','gpt-5.6-terra','gpt-6-sol'].every(m=>proposals.some(a=>a.modelSelection?.model===m)),
  separateCompletedJudge: judge.length === 1,
  noWriters: !task.agents.some(a=>a.mode==='write'),
  unchangedRepository: (await git(repo,'status','--porcelain')) === '' && await git(repo,'rev-parse','HEAD') === task.base,
  ownerDecisionPending: task.decisions.some(d=>!d.answer && d.requiresOwner),
 };
 for (const agent of task.agents) if (agent.cwd) checks.unchangedRepository &&= (await git(agent.cwd,'status','--porcelain')) === '' && await git(agent.cwd,'rev-parse','HEAD') === task.base;
 // Retain only task artifacts, never state tokens or connection credentials.
 await cp(join(app.runtime.dir(task),'artifacts'), new URL('artifacts/', output), {recursive:true, filter: path => !['pstack', 'skills', 'workflow'].includes(path.split('/').at(-1))});
 const evidence={startedAt,finishedAt:new Date().toISOString(),taskId,base:task.base,checks,passed:Object.values(checks).every(Boolean),agents:task.agents.map(a=>({id:a.id,role:a.role,stage:a.stage,status:a.status,model:a.modelSelection,modelChoice:a.modelChoice,base:a.base,cwd:a.cwd,assignment:a.assignment,artifactDir:a.artifactDir})),decisions:task.decisions.map(d=>({id:d.id,artifact:d.artifact,requiresOwner:d.requiresOwner,answered:Boolean(d.answer)}))};
 await writeFile(new URL('result.json',output),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
 assert(evidence.passed,'Architecture smoke structural checks failed; inspect retained artifacts');
} catch(error) {
 console.error(error.message); process.exitCode=1;
 if (app && taskId) {
  const task = app.runtime.task(taskId);
  await cp(join(app.runtime.dir(task),'artifacts'), new URL('artifacts/',output), {recursive:true, filter: path => !['pstack','skills','workflow'].includes(path.split('/').at(-1))});
  await writeFile(new URL('result.json',output), JSON.stringify({passed:false,error:error.message,startedAt,finishedAt:new Date().toISOString(),taskId,base:task.base,agents:task.agents.map(a=>({id:a.id,role:a.role,stage:a.stage,status:a.status,model:a.modelSelection,error:a.error,artifactDir:a.artifactDir})),decisions:task.decisions.map(d=>({id:d.id,artifact:d.artifact,requiresOwner:d.requiresOwner,answered:Boolean(d.answer)}))},null,2)+'\n');
 }
}
finally {
 if(app && taskId) await app.runtime.execute('owner',{action:'cancel',taskId,requestId:id()}).catch(()=>{});
 if(app) await app.close();
 console.log(JSON.stringify({retained:root,reason:'Read-only preparation evidence retained; no approval or implementation executed'}));
}
