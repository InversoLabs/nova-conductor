import fs from 'node:fs';
import {CodexConnection} from './rpc.mjs';

export async function waitUntilResumable(url,threadId,{timeoutMs=30000,connect=async()=>new CodexConnection(url).connect(),exists=fs.existsSync}={}) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    let connection;
    try {
      connection=await connect();
      const {thread}=await connection.request('thread/read',{threadId,includeTurns:true});
      if(thread?.id===threadId && thread.turns?.length && thread.path && exists(thread.path))return true;
    }catch{/* The first turn can be accepted before its rollout becomes readable. */}
    finally{connection?.close();}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  return false;
}
if(process.argv[1]?.endsWith('wait-viewer.mjs')) {
  if(!await waitUntilResumable(process.argv[2],process.argv[3])){console.error('Codex session is not ready for the viewer yet.');process.exitCode=1;}
}
