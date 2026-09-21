import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run} from '../src/conductor.mjs';
import {snapshot} from '../src/workflow.mjs';

test('builder plan rewrite advances to review with original planner baseline preserved',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nova-plan-policy-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));const root=path.join(parent,'project'),work=path.join(root,'work');
 const s=initialize(root,'Build the original requested product.');s.role='BUILDER';fs.writeFileSync(path.join(work,'BUILD_PLAN.md'),'Original planner acceptance criteria.');s.expected=snapshot(work);fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
 let threads=0;const c=new EventEmitter();c.close=()=>{};c.request=async(method,p)=>{
  if(method==='thread/start')return {thread:{id:'plan-'+ ++threads}};
  if(method==='turn/start'){
   if(threads===1){fs.writeFileSync(path.join(work,'BUILD_PLAN.md'),'Rewritten implementation plan.');fs.writeFileSync(path.join(work,'product.txt'),'actual work');}
   else{assert.match(p.input[0].text,/planner-baseline.md/);assert.equal(fs.readFileSync(path.join(root,'planner-baseline.md'),'utf8'),'Original planner acceptance criteria.');}
   setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed',items:threads===2?[{type:'agentMessage',text:'# PASS\nI independently verified the actual product against the original request and original planner acceptance criteria.'}]:[]}}}));return {turn:{id:'turn-'+threads}};
  }return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'}),check:async()=>({passed:true,results:[]})});assert.equal(result.status,'COMPLETE');assert.equal(threads,2);assert.equal(fs.readFileSync(path.join(work,'BUILD_PLAN.md'),'utf8'),'Rewritten implementation plan.');
});
