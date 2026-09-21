import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {initialize,run} from '../src/conductor.mjs';
import {saveReview,snapshot} from '../src/workflow.mjs';
test('read-only reviewer returns Markdown; controller replaces legacy checklist and preserves product',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-review-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build an HTML and CSS page.');const work=path.join(root,'work');
 fs.writeFileSync(path.join(work,'index.html'),'<h1>Original build</h1>');fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),'| optional logo | ☑ |');
 s.role='REVIEWER';s.config.maxRuns=1;s.expected=snapshot(work);fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(s));
 const c=new EventEmitter();c.close=()=>{};
 c.request=async(method,p)=>{
  if(method==='thread/start'){assert.equal(p.sandbox,'read-only');return {thread:{id:'review'}};}
  if(method==='turn/start'){
   setImmediate(()=>{
    c.emit('notice',{method:'item/completed',params:{threadId:p.threadId,item:{type:'agentMessage',phase:'final_answer',text:'# REVISE\nThe page has a heading but the requested responsive layout is absent and remains unverified.\n## Checklist\n- [ ] Add responsive CSS to index.html; verify narrow and wide layouts.'}}});
    c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed'}}});
   });return {turn:{id:'turn'}};
  }return {};
 };
 const result=await run(root,{visible:false,start:async()=>({connection:c,url:'mock'}),check:async()=>({passed:true,results:[]})});
 assert.equal(result.role,'BUILDER');assert.equal(result.runs[0].status,'FINISHED');assert.equal(result.failures,0);
 assert.equal(fs.readFileSync(path.join(work,'index.html'),'utf8'),'<h1>Original build</h1>');
 assert.match(fs.readFileSync(path.join(work,'BUILD_CHECKLIST.md'),'utf8'),/^- \[ \] Add responsive/);
 assert.throws(()=>saveReview(work,'# REVISE\nThe product still needs fixes and cannot pass review until the missing behavior is implemented.'),/concrete repairs/);
});
