import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {killTree} from '../src/runtime.mjs';

// Opt-in: exercises the installed Codex binary and real launcher, against a
// deterministic local Responses server. No model download or credentials.
test('native Codex executes a translated patch through the owned proxy',{
 skip:process.env.CONDUCTOR_NATIVE_TEST!=='1',timeout:60000,
},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-native-'));
 const packageRoot=fileURLToPath(new URL('../',import.meta.url)),copy=path.join(root,'package');
 fs.mkdirSync(copy);fs.copyFileSync(path.join(packageRoot,'package.json'),path.join(copy,'package.json'));
 for(const dir of ['src','infrastructure'])fs.cpSync(path.join(packageRoot,dir),path.join(copy,dir),{recursive:true});
 const launcher=path.join(copy,'infrastructure','nova-codex-interactive.ps1');
 fs.writeFileSync(launcher,fs.readFileSync(launcher,'utf8').replace('Local\\NOVA.Codex.Remote.Session',`Local\\Conductor.Native.Test.${process.pid}`).replace("Join-Path $env:LOCALAPPDATA 'NOVA-Codex'",`'${root.replaceAll("'","''")}/codex-home'`));
 const {startServer}=await import(pathToFileURL(path.join(copy,'src/runtime.mjs')));
 fs.mkdirSync(path.join(root,'work'));let count=0,history;
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=JSON.parse(raw);count++;history=body;
  const patch=body.tools.find(tool=>tool.name==='apply_patch');
  assert.equal(patch?.type,'function');
  const item=count===1 ? {type:'function_call',id:'fc_patch',call_id:'call_patch',name:'apply_patch',arguments:JSON.stringify({input:'*** Begin Patch\n*** Add File: proof.txt\n+provider proxy works\n*** End Patch'})} : {type:'message',id:'msg_done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.',annotations:[]}]};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=value=>res.write('event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n');
  send({type:'response.created',response:{id:'resp_'+count,status:'in_progress',output:[]}});
  send({type:'response.output_item.added',output_index:0,item:count===1?{...item,arguments:''}:item});
  if(count===1){send({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments});send({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});}
  send({type:'response.output_item.done',output_index:0,item});
  send({type:'response.completed',response:{id:'resp_'+count,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}});res.end();
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 let server;
 t.after(()=>{server?.connection.close();killTree(server?.child);server?.closeProxy();upstream.closeAllConnections();upstream.close();});
 // Leave trial files in TEMP for diagnosis; never touch a user project.
 server=await startServer(root,{port:18799,model:'conductor-test',provider:{kind:'ollama',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,keyEnv:''}});
 const {thread}=await server.connection.request('thread/start',{cwd:path.join(root,'work'),model:'conductor-test',modelProvider:'nova_remote',approvalPolicy:'never',sandbox:'workspace-write',selectedCapabilityRoots:[]});
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Native test timed out; inspect '+root)),30000);
  server.connection.on('notice',event=>{if(event.method==='turn/completed'&&event.params?.threadId===thread.id){clearTimeout(timer);resolve(event.params.turn);}});
 });
 await server.connection.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Create proof.txt using apply_patch.',text_elements:[]}]});
 const turn=await done;
 assert.equal(turn.status,'completed',JSON.stringify(turn));
 assert.ok(fs.existsSync(path.join(root,'work','proof.txt')),JSON.stringify(history.input.filter(item=>item.type==='function_call_output')));
 assert.equal(fs.readFileSync(path.join(root,'work','proof.txt'),'utf8').trim(),'provider proxy works');
 assert.equal(count,2);assert.ok(history.input.some(item=>item.type==='function_call_output'&&item.call_id==='call_patch'));
});
