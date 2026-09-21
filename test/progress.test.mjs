import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {BuilderProgress} from '../src/progress.mjs';
import {initialize,run} from '../src/conductor.mjs';
const event=(method,item)=>({method,params:{item}});
test('watchdog separates thinking, read loops, active tools, product edits and user pause',()=>{
 const p=new BuilderProgress({}, {builderIdleMs:40,builderNoChangeMs:80},0);
 assert.equal(p.check({},40),'no tool activity');
 p.notice(event('item/completed',{type:'commandExecution',id:'r'}),50);
 assert.equal(p.check({'BUILD_NOTES.md':'notes'},81),'no product-file changes');
 assert.equal(p.check({'index.html':'content'},82),null);
 p.notice(event('item/started',{type:'commandExecution',id:'long'}),85);
 assert.equal(p.check({'index.html':'content'},1000),null);
 p.notice(event('item/completed',{type:'commandExecution',id:'long'}),1010);
 assert.equal(p.check({'index.html':'content'},1020),null);
 p.notice({method:'turn/completed',params:{turn:{status:'interrupted'}}},1025);
 assert.equal(p.check({'index.html':'content'},2000),null);
 p.notice({method:'turn/started',params:{turn:{}}},2010);
 assert.equal(p.check({'index.html':'content'},2020),null);
});
test('stalled builder closes old server, preserves files, retries once then stops',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-progress-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),s=initialize(root,'Build a page.');s.role='BUILDER';
 s.config.builderIdleMs=25;s.config.builderNoChangeMs=60;s.config.progressPollMs=5;
 fs.writeFileSync(root+'/state.json',JSON.stringify(s));let threads=0,closed=0;
 const result=await run(root,{visible:false,start:async()=>{
  const c=new EventEmitter();c.close=()=>closed++;
  c.request=async(method,p)=>{
   if(method==='thread/start')return {thread:{id:'thread-'+(++threads)}};
   if(method==='turn/interrupt'){setImmediate(()=>c.emit('notice',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}}));return {};}
   if(method==='turn/start'){
    if(threads===2)assert.match(p.input[0].text,/smallest unfinished/);
    return {turn:{id:'turn'}};
   }return {};
  };return {connection:c,url:'mock'};
 }});
 assert.equal(threads,2);assert.equal(closed,2);assert.equal(result.status,'NEEDS_ATTENTION');
 assert.match(result.feedback,/stalled again/);assert.equal(fs.readFileSync(root+'/work/REQUEST.md','utf8'),'Build a page.');
 assert.equal(fs.existsSync(root+'/conductor.lock'),false);
});
