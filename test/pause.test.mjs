import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run} from '../src/conductor.mjs';
test('interrupt pauses same role and accepts a native follow-up turn',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-pause-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build a page.');s.role='BUILDER';s.config.maxRuns=1;s.config.roleTimeoutMs=100;
 fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
 const c=new EventEmitter();let threads=0;c.close=()=>{};
 c.request=async(method,p)=>{
  if(method==='thread/start')return {thread:{id:`thread-${++threads}`}};
  if(method==='turn/start'){
   setImmediate(()=>{
    c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:'first',status:'interrupted'}}});
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).status,'PAUSED');
    setTimeout(()=>{
     c.emit('notice',{method:'turn/started',params:{threadId:p.threadId,turn:{id:'follow-up'}}});
     c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:'follow-up',status:'completed'}}});
    },150);
   });return {turn:{id:'first'}};
  }return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'}),check:async()=>({passed:true,results:[]})});
 assert.equal(threads,1);assert.equal(result.runs[0].status,'FINISHED');assert.equal(result.role,'REVIEWER');assert.equal(result.failures,0);
});
