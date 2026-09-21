import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {validateProvider,providerKey,listModels} from '../src/providers.mjs';
const {createProxy}=createRequire(import.meta.url)('../infrastructure/nova-codex-proxy.js');
test('provider presets and validation require no NOVA credentials',()=>{
 assert.equal(validateProvider({kind:'ollama'}).baseUrl,'http://127.0.0.1:11434/v1');
 assert.equal(validateProvider({kind:'lmstudio'}).baseUrl,'http://127.0.0.1:1234/v1');
 assert.equal(providerKey(validateProvider({kind:'ollama'}),{}),'');
 for(const baseUrl of ['file:///tmp','https://user:secret@example.com/v1','https://example.com/v1?api_key=secret'])assert.throws(()=>validateProvider({kind:'custom',baseUrl}));
 assert.throws(()=>providerKey({keyEnv:'MISSING'},{}),/Set MISSING/);
});
test('owned proxy routes custom base paths, isolates auth, and preserves custom-provider request fields',async t=>{
 const seen=[];
 const upstream=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push({url:req.url,auth:req.headers.authorization,body});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'local-model'}]}:{id:'response',output:[]}));});});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const baseUrl=`http://127.0.0.1:${upstream.address().port}/api/v1`;
 const proxy=createProxy({kind:'custom',baseUrl,clientToken:'local-token',apiKey:'upstream-test-key'});proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 t.after(async()=>{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);});
 assert.deepEqual(await listModels({kind:'custom',baseUrl}),['local-model']);
 const url=`http://127.0.0.1:${proxy.address().port}/v1/responses`;
 assert.equal((await fetch(url,{method:'POST'})).status,401);
 const body={model:'local-model',input:'hello',parallel_tool_calls:false,text:{format:{type:'text'}}};
 assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer local-token','Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
 assert.equal(seen.at(-1).url,'/api/v1/responses');assert.equal(seen.at(-1).auth,'Bearer upstream-test-key');assert.deepEqual(JSON.parse(seen.at(-1).body),body);
});
