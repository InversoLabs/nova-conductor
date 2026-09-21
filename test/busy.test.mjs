import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run,isBusy} from '../src/conductor.mjs';
test('busy retry exhaustion stops without charging planner failures',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-busy-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build a page.');s.busyRetries=3;fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
 const c=new EventEmitter();c.close=()=>{};
 c.request=async(method,p)=>{
  if(method==='thread/start')return {thread:{id:'busy'}};
  if(method==='turn/start'){setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'failed',error:{message:'429 Too Many Requests'}}}}));return {turn:{id:'turn'}};}return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'})});
 assert.equal(result.status,'NEEDS_ATTENTION');assert.equal(result.failures,0);assert.equal(result.busyRetries,4);assert.match(result.feedback,/NOVA remained busy/);
 assert.equal(isBusy(Error('invalid tool arguments')),false);
});
