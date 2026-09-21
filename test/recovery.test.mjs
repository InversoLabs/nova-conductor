import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run} from '../src/conductor.mjs';
test('Continue clears exhausted attempt failures and asks bare-PASS reviewer for evidence in same thread',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-recover-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build a page.');s.role='REVIEWER';s.status='NEEDS_ATTENTION';s.failures=2;fs.writeFileSync(root+'/state.json',JSON.stringify(s));
 const c=new EventEmitter();c.close=()=>{};let threads=0,turns=0;
 c.request=async(method,p)=>{
  if(method==='thread/start'){threads++;return {thread:{id:'review'}};}
  if(method==='turn/start'){
   turns++;const n=turns;
   if(n===2)assert.match(p.input[0].text,/missing evidence/);
   setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed',items:[{type:'agentMessage',text:n===1?'# PASS':'# PASS\nI inspected the page and verified all requested local assets, responsive layout, and absence of dependencies.'}]}}}));return {turn:{id:String(n)}};
  }return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'}),check:async()=>({passed:true,results:[]})});
 assert.equal(result.status,'COMPLETE');assert.equal(threads,1);assert.equal(turns,2);assert.equal(result.failures,0);
 assert.equal(fs.readFileSync(root+'/runs/0001/review-response-0.md','utf8'),'# PASS');
});

test('empty reviewer stops after one clarification instead of creating more review sessions',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-empty-review-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build a page.');s.role='REVIEWER';fs.writeFileSync(root+'/state.json',JSON.stringify(s));
 const c=new EventEmitter();c.close=()=>{};let threads=0,turns=0;
 c.request=async(method,p)=>{
  if(method==='thread/start')return {thread:{id:'review-'+(++threads)}};
  if(method==='turn/start'){turns++;setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:'turn',status:'completed',items:[]}}}));return {turn:{id:'turn'}};}
  return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'})});
 assert.equal(result.status,'NEEDS_ATTENTION');assert.equal(threads,1);assert.equal(turns,2);assert.match(result.feedback,/no usable final review/);
});
