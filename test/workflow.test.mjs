import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, run } from '../src/conductor.mjs';
import {EventEmitter} from 'node:events';
import {waitUntilResumable} from '../src/wait-viewer.mjs';
import {nextPhase,reviewDecision,assertRoleChanges,rolePrompt,snapshot} from '../src/workflow.mjs';

for(const lostSocket of [false,true])test(`disconnect recovery preserves edits and retries fresh (${lostSocket?'controller socket':'model stream'})`,async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-retry-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project');const s=initialize(root,'Build a tested page.');
  s.role='BUILDER';s.config.retryDelayMs=0;fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
  let threads=0,starts=0;const work=path.join(root,'work');
  const start=async()=>{
    starts++;const c=new EventEmitter();c.close=()=>{};
    c.request=async(method,p)=>{
      if(method==='thread/start')return {thread:{id:`fresh-${++threads}`}};
      if(method==='turn/start'){
        if(threads===1)fs.writeFileSync(path.join(work,'partial.txt'),'preserved');
        if(threads===2){assert.equal(fs.readFileSync(path.join(work,'partial.txt'),'utf8'),'preserved');assert.match(p.input[0].text,/Partial files are preserved/);}
        if(threads===3)fs.writeFileSync(path.join(work,'REVIEW.md'),'# PASS\nI executed the complete requested behavior and verified every original requirement with successful results.');
        setImmediate(()=>{
          if(threads===1 && lostSocket)c.emit('disconnected');
          else c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:threads===1?'failed':'completed',error:threads===1?{message:'stream disconnected before completion: stream closed before response.completed'}:null}}});
        });
        return {turn:{id:`turn-${threads}`}};
      }
      return {};
    };
    return {connection:c,url:'mock'};
  };
  const result=await run(root,{visible:false,start,check:async()=>({passed:true,results:[]})});
  assert.equal(result.status,'COMPLETE');assert.equal(threads,3);assert.equal(starts,lostSocket?2:1);
  assert.deepEqual(result.runs.map(r=>r.role),['BUILDER','BUILDER','REVIEWER']);
  assert.equal(result.failures,0);assert.equal(result.disconnectFailures,0);
});

test('Markdown planner/build/review/revise cycle cannot PASS failed checks', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');const state=initialize(project,'Make a landing page.');const work=path.join(project,'work');
  assert.equal(state.role,'PLANNER');assert.equal(state.config.contextTokens,16384);
  assert.throws(()=>nextPhase('PLANNER',work),/AGENTS/);
  fs.writeFileSync(path.join(work,'AGENTS.md'),'Project rules, build instructions and tests. '.repeat(4));
  fs.writeFileSync(path.join(work,'BUILD_PLAN.md'),'Implement every requirement and execute acceptance checks. '.repeat(4));
  assert.equal(nextPhase('PLANNER',work),'BUILDER');
  assert.equal(nextPhase('BUILDER',work),'REVIEWER');
  fs.writeFileSync(path.join(work,'REVIEW.md'),'# PASS\nI tested every requirement and observed the complete product working with all required behavior.');
  assert.equal(nextPhase('REVIEWER',work,{passed:false}),'REVIEWER');
  assert.equal(nextPhase('REVIEWER',work,{passed:true}),'COMPLETE');
  fs.writeFileSync(path.join(work,'REVIEW.md'),'# REVISE\nThe contact action does not work and needs a correction before the product satisfies the request.');
  assert.throws(()=>nextPhase('REVIEWER',work,{passed:true}),/checklist|unchecked/i);
  fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),'- [ ] Wire contact action in script.js; click it and confirm the contact panel opens.');
  assert.equal(nextPhase('REVIEWER',work,{passed:true}),'BUILDER');
  assert.equal(snapshot(work)['REQUEST.md'],state.expected['REQUEST.md']);
});
test('role boundaries reject product edits by reviewer and plan edits by builder',()=>{
  assert.throws(()=>assertRoleChanges('REVIEWER',{'index.html':'old'},{'index.html':'new'}),/unauthorized/);
  assert.throws(()=>assertRoleChanges('BUILDER',{'BUILD_PLAN.md':'old'},{'BUILD_PLAN.md':'new'}),/protected/);
  assert.doesNotThrow(()=>assertRoleChanges('REVIEWER',{}, {'BUILD_CHECKLIST.md':'new'}));
  assert.equal(reviewDecision('Looks good!'),null);
  const prompt=rolePrompt({role:'REVIEWER',config:{verification:[['node','--test']]}});
  assert.match(prompt,/EVERY original requirement/);assert.match(prompt,/No JSON/);
});

test('Conductor creates a new Codex thread on every role change and loops via Markdown',async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-engine-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project');initialize(root,'Build a tested product.');
  const work=path.join(root,'work');let threads=0,reviews=0;
  const connection=new EventEmitter();connection.close=()=>{};
  connection.request=async(method,params)=>{
    if(method==='thread/start'){assert.equal(params.config.model_context_window,16384);return {thread:{id:`fresh-${++threads}`}};}
    if(method==='turn/start'){
      assert.notEqual(JSON.parse(fs.readFileSync(path.join(root,'viewer.json'))).threadId,params.threadId,'Viewer must not attach before first turn starts');
      const text=params.input[0].text;
      assert.ok(text.startsWith('Original user request (also saved in REQUEST.md):\nBuild a tested product.\n\n'), 'Every fresh role must receive the original request without a file-read prerequisite');
      if(text.includes('You are the PLANNER')){
        fs.writeFileSync(path.join(work,'AGENTS.md'),'Use local tests and follow the original request. '.repeat(4));
        fs.writeFileSync(path.join(work,'BUILD_PLAN.md'),'Implement all requested behaviors and execute acceptance checks. '.repeat(4));
      }else if(text.includes('You are the BUILDER')){
        assert.match(text,reviews?/Build mode: reviewer repairs/:/Build mode: initial implementation/);
        fs.writeFileSync(path.join(work,'product.txt'),reviews?'fixed':'first');
      }
      else {
        reviews++;
        fs.writeFileSync(path.join(work,'REVIEW.md'),reviews===1?'# REVISE\nThe product needs a concrete correction to satisfy the requested behavior before it can be accepted.':'# PASS\nEvery requested behavior was executed and verified against the original prompt and the complete build plan.');
        fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),reviews===1?'- [ ] Correct product.txt and verify its observable behavior.':'All corrections verified.');
      }
      setImmediate(()=>connection.emit('notice',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:`turn-${threads}`,status:'completed'}}}));
      return {turn:{id:`turn-${threads}`}};
    }
    return {};
  };
  const state=await run(root,{visible:false,start:async()=>({connection,url:'mock'}),check:async()=>({passed:true,results:[]})});
  assert.equal(state.status,'COMPLETE');assert.equal(threads,5);
  assert.deepEqual(state.runs.map(r=>r.role),['PLANNER','BUILDER','REVIEWER','BUILDER','REVIEWER']);
  assert.equal(new Set(state.runs.map(r=>r.threadId)).size,5);
  assert.equal(fs.readFileSync(path.join(work,'product.txt'),'utf8'),'fixed');
});

test('viewer waits for a persisted first turn rather than just a new thread ID',async()=>{
  let calls=0,closed=0;
  const ready=await waitUntilResumable('mock','fresh',{
    timeoutMs:2000,exists:()=>true,
    connect:async()=>({close:()=>closed++,request:async()=>({thread:{id:'fresh',path:'rollout.jsonl',turns:++calls===1?[]:[{id:'turn'}]}})}),
  });
  assert.equal(ready,true);assert.equal(calls,2);assert.equal(closed,2);
});
