import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {repairAddFilePatch,createSseRepair}=createRequire(import.meta.url)('../infrastructure/nova-codex-repairs.cjs');
const raw='*** Begin Patch\n*** Add File: AGENTS.md\n# Rules\n\n- Test the page\n*** End Patch';
test('repair only wholly unprefixed single-file additions',()=>{
  const result=repairAddFilePatch(raw);
  assert.equal(result,'*** Begin Patch\n*** Add File: AGENTS.md\n+# Rules\n+\n+- Test the page\n*** End Patch');
  for(const input of [result,raw.replace('# Rules','+# Rules'),raw.replace('AGENTS.md','../escape.md'),raw.replace('Add File','Update File'),raw.replace('\n*** End Patch','\n*** Add File: other.md\ntext\n*** End Patch')])assert.equal(repairAddFilePatch(input),input);
});
test('fragmented native patch stream has consistent repaired delta, done and final item',()=>{
  const repairPayload=value=>{
    if(value?.type==='custom_tool_call'&&value.name==='apply_patch')value.input=repairAddFilePatch(value.input);
    for(const child of Object.values(value||{}))if(child&&typeof child==='object')repairPayload(child);
    return value;
  };
  const s=createSseRepair({repairPayload});
  const frames=[{type:'response.output_item.added',output_index:0,item:{id:'p',type:'custom_tool_call',name:'apply_patch',input:''}},
    ...[raw.slice(0,23),raw.slice(23)].map(delta=>({type:'response.custom_tool_call_input.delta',item_id:'p',delta})),
    {type:'response.custom_tool_call_input.done',item_id:'p',input:raw},
    {type:'response.output_item.done',item:{id:'p',type:'custom_tool_call',name:'apply_patch',input:raw}}];
  const stream=frames.map(data=>`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  let out='';for(const char of stream)out+=s.push(char);out+=s.end();
  const events=out.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  const fixed=repairAddFilePatch(raw);
  assert.equal(events.find(e=>e.type.endsWith('.delta')).delta,fixed);
  assert.equal(events.find(e=>e.type==='response.custom_tool_call_input.done').input,fixed);
  assert.equal(events.at(-1).item.input,fixed);
});
