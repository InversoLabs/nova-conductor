import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {enabled,parsePatch,promote,createGemmaPatchStream}=createRequire(import.meta.url)('../infrastructure/gemma-patch.cjs');
const request={model:'gemma4:e2b-it-qat',tools:[{type:'custom',name:'apply_patch'}]};
const patch='*** Begin Patch\n*** Add File: proof.txt\n+works\n*** End Patch';
const item=text=>({id:'msg_test',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]});
const response=text=>({id:'resp_test',status:'completed',output:[item(text)]});
const frame=e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const events=text=>[
 {type:'response.created',response:{id:'resp_test',status:'in_progress',output:[]}},
 {type:'response.output_item.added',output_index:0,item:{...item(''),status:'in_progress',content:[]}},
 {type:'response.content_part.added',item_id:'msg_test',output_index:0,content_index:0,part:{type:'output_text',text:''}},
 {type:'response.output_text.delta',item_id:'msg_test',output_index:0,content_index:0,delta:text},
 {type:'response.output_text.done',item_id:'msg_test',output_index:0,content_index:0,text},
 {type:'response.content_part.done',item_id:'msg_test',output_index:0,content_index:0,part:item(text).content[0]},
 {type:'response.output_item.done',output_index:0,item:item(text)},
 {type:'response.completed',response:response(text)},
];
const decode=raw=>raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
test('recorded Gemma output becomes one native patch with both files, content unchanged',()=>{
 const raw=fs.readFileSync(new URL('fixtures/gemma-e2b-bare-patch.txt',import.meta.url),'utf8');
 const expected=raw.replace('*** End Patch\n*** Add File:','*** Add File:');
 assert.equal(parsePatch(raw),expected);
 const result=promote(response(raw),request);
 assert.equal(result.item.input,expected);assert.equal(result.item.type,'custom_tool_call');
});
test('no prose, code fences, truncated patches, edits/deletes, unsafe paths, or ambiguous duplicate files',()=>{
 for(const text of ['Here is the patch:\n'+patch,'```\n'+patch+'\n```',patch+'\nDone.',patch.replace('*** Begin Patch\n',''),patch.replace('*** End Patch',''),patch.replace('proof.txt','../outside.txt'),patch.replace('proof.txt','C:/outside.txt'),patch.replace('*** Add File:','*** Delete File:'),patch.replace('*** Add File:','*** Update File:'),patch.replace('+works','works'),patch.replace('*** End Patch','*** Add File: PROOF.txt\n+another\n*** End Patch')])assert.equal(parsePatch(text),null,text);
});
test('GPT, Ornith, unknown Gemma variants, disabled tools, and already-native calls remain untouched',()=>{
 for(const model of ['gpt-oss:20b','gpt-oss-20b:latest','ornith-1.5:9b-text','gemma4:12b','unknown']) {
  const req={...request,model};assert.equal(enabled(req),false);assert.equal(promote(response(patch),req),null);
  const stream=createGemmaPatchStream(req),raw=events(patch).map(frame).join('');assert.equal(stream.push(raw)+stream.end(),raw);
 }
 for(const req of [{...request,tools:[]},{...request,tool_choice:'none'},{...request,tool_choice:{type:'function',name:'exec_command'}}])assert.equal(promote(response(patch),req),null);
 for(const extra of [{type:'function_call',name:'exec_command'},item('Another answer')])assert.equal(promote({...response(patch),output:[item(patch),extra]},request),null);
 assert.equal(promote({...response(patch),status:'incomplete'},request),null);
});
test('fragmented SSE emits exactly one tool call and a consistent completed output',()=>{
 const stream=createGemmaPatchStream(request),raw=events(patch).map(frame).join('').replaceAll('\n','\r\n');let out='';
 for(let i=0;i<raw.length;i+=7)out+=stream.push(raw.slice(i,i+7));out+=stream.end();
 const result=decode(out);assert(!result.some(e=>e.type.startsWith('response.output_text')));
 const added=result.filter(e=>e.type==='response.output_item.added');assert.equal(added.length,1);assert.equal(added[0].item.type,'custom_tool_call');
 assert.equal(result.find(e=>e.type==='response.custom_tool_call_input.delta').delta,patch);
 assert.equal(result.at(-1).response.output[0].call_id,added[0].item.call_id);
 assert.deepEqual(result.map(e=>e.sequence_number),result.map((_,i)=>i));
});
test('disconnects, incomplete responses, ordinary answers, and oversized output never become tools',()=>{
 for(const ending of [[],[{type:'response.incomplete',response:{...response(patch),status:'incomplete'}}],[{type:'error',message:'Disconnected'}]]) {
  const stream=createGemmaPatchStream(request),source=[...events(patch).slice(0,-1),...ending];
  const result=decode(stream.push(source.map(frame).join(''))+stream.end());
  assert(!result.some(e=>e.item?.type==='custom_tool_call'));assert(result.some(e=>e.type==='response.output_text.delta'));
 }
 for(const text of ['I will create a file.', '+'.repeat(1100000)]){const stream=createGemmaPatchStream(request);const result=decode(stream.push(events(text).map(frame).join(''))+stream.end());assert(!result.some(e=>e.item?.type==='custom_tool_call'));}
});
