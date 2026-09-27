import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd(), out = path.join(root,'plans/skill-smoke');
const fixture = await mkdtemp('/private/tmp/agent-plan-skill-smoke-');
const rawDir = await mkdtemp('/private/tmp/agent-plan-skill-smoke-raw-');
await mkdir(out,{recursive:true}); await mkdir(fixture,{recursive:true});
const git = (...args) => { const r = spawnSync('git',args,{cwd:fixture,encoding:'utf8'}); if(r.status) throw Error(r.stderr); return r.stdout; };
git('init'); git('config','user.name','Smoke Test'); git('config','user.email','smoke@example.invalid');
await writeFile(path.join(fixture,'README.md'),'# Fixture cache\nA tiny in-process cache for customer lookup. No external sources or remote are configured.\n');
await writeFile(path.join(fixture,'cache.mjs'),`export const TTL_MS = 30000;
export function createLookup(load, now = Date.now) {
  const cached = new Map();
  const pending = new Map();
  return async function lookup(id) {
    const hit = cached.get(id);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    if (pending.has(id)) return pending.get(id);
    const promise = Promise.resolve().then(() => load(id)).then(value => {
      cached.set(id, { value, at: now() });
      return value;
    }).finally(() => pending.delete(id));
    pending.set(id, promise);
    return promise;
  };
}
`);
git('add','.'); git('commit','-m','Add customer lookup cache');
await writeFile(path.join(fixture,'decision.md'),'Decision: coalesce concurrent misses for the same customer id. Duplicate upstream calls exhausted our fixture rate limit during bursts. Remove failed pending requests so the next call retries. This record does not explain the TTL value.\n');
await writeFile(path.join(fixture,'cache.test.mjs'),`import assert from 'node:assert/strict';
import { createLookup } from './cache.mjs';
let calls = 0, time = 0;
const lookup = createLookup(async id => { calls++; return id.toUpperCase(); }, () => time);
assert.deepEqual(await Promise.all([lookup('a'), lookup('a')]), ['A','A']);
assert.equal(calls, 1);
time = 29999; await lookup('a'); assert.equal(calls, 1);
time = 30000; await lookup('a'); assert.equal(calls, 2);
let fails = 0; const retry = createLookup(async () => { if (++fails === 1) throw Error('transient'); return 'ok'; });
await assert.rejects(retry('a')); assert.equal(await retry('a'),'ok'); assert.equal(fails, 2);
console.log('fixture passes');
`);
git('add','.'); git('commit','-m','Document burst rate limit rationale and failed request retry','-m','Coalescing concurrent requests avoids duplicate calls; retry after failure needs pending eviction. TTL selection is not recorded.');
const check = spawnSync('node',['cache.test.mjs'],{cwd:fixture,stdio:'inherit'}); if (check.status !== 0) throw Error('Fixture check failed');
await writeFile(path.join(out,'ground-truth.md'),`Fixture: ${fixture}\n\nHow: process-local Map; exact id key; hit only while age < 30000; equality expires; coalesced same-id concurrent miss; load invoked through Promise.resolve().then; cache timestamp captured at success; pending removed on success/failure; rejected calls not cached and retry; no cross-process sharing or capacity eviction.\nWhy: decision.md and second commit document burst upstream rate limit, same-id coalescing and retry. Exact 30000 TTL rationale UNKNOWN. Six external evidence categories and forge discussion unavailable in this scoped fixture. Direct leaf smoke; task/delegation not enabled.\n\nHistory:\n${git('log','--format=%H %s')}\n`);
const models = [['grok','xai-oauth','grok-4.7'],['terra','openai-codex','gpt-5.6-terra'],['luna','openai-codex','gpt-6-luna']];
const prompts = {
 how:'/skill:how How does createLookup work, including concurrent misses, expiry boundaries, failures, and where the state lives? This is a simple direct read-only leaf smoke test: use the skill simple path without subagents. Only inspect this fixture and the loaded skill package; no external data or writes. Cite files/lines.',
 why:'/skill:why Why does createLookup coalesce requests, remove pending failures, and use a 30000ms TTL? I assume all three choices are for performance. This is a direct read-only leaf smoke test without delegation. Only this fixture Git history, files, and loaded skill package are in scope. No remote/forge/external MCP data available; record the six missing evidence categories. Apply the actual skill confidence framework and do not edit files.'
};
async function run(name, provider, model, prompt){
 await writeFile(path.join(out,name+'.prompt.md'),prompt);
 const args=['--cwd',fixture,'--provider',provider,'--model',model,'--plugin-dir',path.join(root,'codex/agent-plan'),'--skills','how,why','--no-extensions','--no-rules','--no-lsp','--no-title','--no-prewalk','--no-session','--tools','read,grep,glob,bash','--max-time','180','--mode','json','-p',prompt];
 const start=Date.now(); let stdout='',stderr='',timeout=false;
 const p=spawn(path.join(root,'node_modules/.bin/omp'),args,{cwd:fixture,stdio:['ignore','pipe','pipe'],env:{...process.env,PI_NO_PTY:'1'}});
 p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);
 const timer=setTimeout(()=>{timeout=true;p.kill('SIGTERM');setTimeout(()=>p.kill('SIGKILL'),2000).unref();},190000);
 const code=await new Promise(resolve=>p.on('close',resolve));clearTimeout(timer);
 await writeFile(path.join(rawDir,name+'.jsonl'),stdout); await writeFile(path.join(rawDir,name+'.stderr.txt'),stderr);
 const events=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const assistant=events.filter(e=>e.type==='message_end' && e.message?.role==='assistant').map(e=>e.message);
 const final=assistant.filter(m=>!(m.content??[]).some(c=>c.type==='toolCall')).at(-1);
 await writeFile(path.join(out,name+'.answer.md'),(final?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
 await writeFile(path.join(out,name+'.tools.json'),JSON.stringify(assistant.flatMap(m=>(m.content??[]).filter(c=>c.type==='toolCall').map(c=>({name:c.name,arguments:c.arguments}))),null,2));
 const result={name,provider,model,seconds:(Date.now()-start)/1000,code,timeout,fixtureStatus:git('status','--porcelain'),args:args.slice(0,-1),promptFile:name+'.prompt.md'};
 await writeFile(path.join(out,name+'.meta.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));return result;
}
const results=[];
for(const [name,provider,model] of models) results.push(...await Promise.all(Object.entries(prompts).map(([skill,prompt])=>run(name+'-'+skill,provider,model,prompt))));
await writeFile(path.join(out,'runs.json'),JSON.stringify(results,null,2));
const material = (await Promise.all(results.map(async r => {
 const events=(await readFile(path.join(rawDir,r.name+'.jsonl'),'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const assistants=events.filter(e=>e.type==='message_end' && e.message?.role==='assistant').map(e=>e.message);
 const final=assistants.filter(m=>!(m.content??[]).some(c=>c.type==='toolCall')).at(-1);
 const toolCalls=assistants.flatMap(m=>(m.content??[]).filter(c=>c.type==='toolCall').map(c=>({name:c.name,arguments:c.arguments})));
 const text=(final?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 await writeFile(path.join(out,r.name+'.answer.md'),text);
 await writeFile(path.join(out,r.name+'.tools.json'),JSON.stringify(toolCalls,null,2));
 return `\n## ${r.name}\nStatus ${r.code}; ${r.seconds}s\n${text}\nTools: ${JSON.stringify(toolCalls)}`;
}))).join('\n');
const synthesis='Read only. Synthesize these live direct leaf how/why smoke outputs against the ground truth. They used actual skill package loading, without task delegation or external sources. Distinguish transport failures, skill activation evidence, code tracing, expiry/concurrency/error accuracy, confidence calibration (TTL rationale unknown), source coverage and citations. Do not claim a benchmark or full dispatch validation. Only inspect the fixture and supplied evidence, no external data.\nGROUND TRUTH\n'+await readFile(path.join(out,'ground-truth.md'),'utf8')+'\nRAW RUNS\n'+material;
await run('sol-synthesis','openai-codex','gpt-6-sol',synthesis);
