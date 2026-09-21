import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {adaptRequest,adaptResponse,createToolStream}=require('../infrastructure/provider-tools.cjs');
const input='*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch';
test('local provider patch schema and tool-result history round trip',()=>{
 const body=adaptRequest({model:'gpt-oss:20b',reasoning:{effort:'minimal'},tools:[{type:'custom',name:'apply_patch',description:'patch'},{type:'function',name:'exec_command'}],input:[{type:'custom_tool_call',name:'apply_patch',call_id:'c1',input},{type:'custom_tool_call_output',call_id:'c1',output:'ok'}]});
 assert.equal(body.reasoning.effort,'low');
 assert.equal(body.tools[0].type,'function');assert.equal(body.tools[1].name,'exec_command');
 assert.equal(body.input[1].type,'function_call_output');
 assert.equal(JSON.parse(body.input[0].arguments).input,input);
 assert.equal(adaptResponse({output:[body.input[0]]}).output[0].input,input);
 assert.throws(()=>adaptResponse({output:[{type:'function_call',name:'apply_patch',arguments:'{"bad":true}'}]}),/input string/);
});

test('reasoning mapping preserves GPT-OSS effort tiers and isolates Ornith behavior',()=>{
 for(const [model,effort,expected] of [['gpt-oss:20b','none','low'],['gpt-oss:20b','medium','medium'],['gpt-oss:120b','high','high'],['ornith-1.5:9b-text','minimal','none'],['ornith-1.5:9b-text','high','high'],['other','minimal','minimal']])assert.equal(adaptRequest({model,reasoning:{effort}}).reasoning.effort,expected);
 assert.equal(adaptRequest({model:'gpt-oss:20b'}).reasoning,undefined);
});
test('fragmented local provider patch stream converts deltas, done and final output consistently',()=>{
 const args=JSON.stringify({input}),item={type:'function_call',name:'apply_patch',id:'p1',call_id:'c1',arguments:args};
 const events=[{type:'response.output_item.added',output_index:0,item:{...item,arguments:''}},
 ...[args.slice(0,23),args.slice(23)].map(delta=>({type:'response.function_call_arguments.delta',item_id:'p1',output_index:0,delta})),
 {type:'response.function_call_arguments.done',item_id:'p1',arguments:args},
 {type:'response.output_item.done',output_index:0,item},
 {type:'response.completed',response:{output:[item]}}];
 const raw=events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''),s=createToolStream();let out='';
 for(const c of raw)out+=s.push(c);out+=s.end();
 const result=out.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 assert.equal(result[0].item.type,'custom_tool_call');
 assert.equal(result.find(e=>e.type==='response.custom_tool_call_input.delta').delta,input);
 assert.equal(result.find(e=>e.type==='response.custom_tool_call_input.done').input,input);
 assert.equal(result.find(e=>e.type==='response.output_item.done').item.input,input);
 assert.equal(result.at(-1).response.output[0].input,input);
 assert.ok(!out.includes('function_call_arguments'));
});
