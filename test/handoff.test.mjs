import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run} from '../src/conductor.mjs';
import {runChecks} from '../src/runtime.mjs';
import {nextPhase,rolePrompt} from '../src/workflow.mjs';

test('no universal test framework; missing review still cannot complete',async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-checks-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project'),s=initialize(root,'Build a simple webpage.');
  assert.deepEqual(s.config.verification,[]);
  assert.equal(s.config.builderTimeoutMs,45*60*1000);
  assert.equal(s.config.roleTimeoutMs,30*60*1000);
  const checks=await runChecks(root,[]);
  assert.equal(checks.configured,false);
  assert.throws(()=>nextPhase('REVIEWER',path.join(root,'work'),checks),/Reviewer/);
  assert.match(rolePrompt({...s,role:'BUILDER'}),/at most three/);
});

test('old ten-minute projects migrate at startup while custom deadlines remain',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-timers-'));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 for(const minutes of [10,20]){
  const root=path.join(parent,String(minutes)),s=initialize(root,'Build a page.');
  s.config.roleTimeoutMs=minutes*60*1000;delete s.config.builderTimeoutMs;
  fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
  await assert.rejects(run(root,{visible:false,start:async(_root,config)=>{
   assert.equal(config.roleTimeoutMs,(minutes===10?30:20)*60*1000);
   assert.equal(config.builderTimeoutMs,minutes===10?45*60*1000:undefined);
   throw Error('test startup stop');
  }}),/test startup stop/);
 }
});

test('builder deadline preserves product and switches to fresh reviewer with failure evidence',async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-deadline-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project'),s=initialize(root,'Build a tested webpage.');
  s.role='BUILDER';s.config.builderTimeoutMs=30;s.config.roleTimeoutMs=30;s.config.maxRuns=2;
  fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
  let threads=0,servers=0,closed=0;
  const start=async()=>{
    servers++;const c=new EventEmitter();c.close=()=>closed++;
    c.request=async(method,p)=>{
      if(method==='thread/start')return {thread:{id:`fresh-${++threads}`}};
      if(method==='turn/start'){
        if(threads===1)fs.writeFileSync(path.join(root,'work/index.html'),'preserved page');
        else {
          assert.match(p.input[0].text,/You are the REVIEWER/);
          assert.match(p.input[0].text,/missing script reference/);
          assert.equal(fs.readFileSync(path.join(root,'work/index.html'),'utf8'),'preserved page');
          fs.writeFileSync(path.join(root,'work/REVIEW.md'),'# REVISE\nThe page is missing its script reference and cannot satisfy the requested working interaction yet.');
          fs.writeFileSync(path.join(root,'work/BUILD_CHECKLIST.md'),'- [ ] Connect script.js in index.html and verify FAQ interaction.');
          setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed'}}}));
        }
        return {turn:{id:`turn-${threads}`}};
      }
      return {};
    };
    return {connection:c,url:'mock'};
  };
  const result=await run(root,{visible:false,start,check:async()=>({passed:false,results:[{passed:false,output:'missing script reference'}]})});
  assert.equal(servers,2);assert.equal(closed,2);
  assert.deepEqual(result.runs.map(r=>r.role),['BUILDER','REVIEWER']);
  assert.equal(result.runs[0].status,'HANDED_OFF');
  assert.equal(result.role,'BUILDER');assert.equal(result.status,'NEEDS_ATTENTION');
  assert.equal(result.deadlineRecoveries,1);
});
