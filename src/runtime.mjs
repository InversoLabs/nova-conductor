import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexConnection } from './rpc.mjs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { validateProvider, providerKey } from './providers.mjs';
const {createProxy}=createRequire(import.meta.url)('../infrastructure/nova-codex-proxy.js');

const base = fileURLToPath(new URL('../', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function killTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}
export function cleanEnvironment(keyEnv) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_')) delete env[key];
  delete env.NOVA_DESKTOP_API_KEY;
  if(keyEnv)delete env[keyEnv];
  env.CODEX_HOME = path.join(process.env.LOCALAPPDATA, 'NOVA-Codex');
  return env;
}
export async function startServer(root, config) {
  const port = config.port;
  const url = `ws://127.0.0.1:${port}`;
  // Refuse to attach to an unrelated running app server.
  const net = await import('node:net');
  const occupied = await new Promise(resolve => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false));
  });
  if (occupied) throw Error(`Port ${port} is in use; stop the other Conductor session first.`);
  const provider=validateProvider(config.provider || {kind:'nova',baseUrl:'http://192.168.86.51:8787/v1',keyEnv:'NOVA_DESKTOP_API_KEY'});
  const key=providerKey(provider),clientToken=randomBytes(32).toString('hex');
  const proxy=createProxy({...provider,apiKey:key,clientToken});
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  const proxyBase=`http://127.0.0.1:${proxy.address().port}`;
  const env={...cleanEnvironment(provider.keyEnv),NOVA_DESKTOP_API_KEY:clientToken};
  if(provider.keyEnv && provider.keyEnv!=='NOVA_DESKTOP_API_KEY')delete env[provider.keyEnv];
  const child = spawn(process.execPath, [path.join(base, 'src/supervisor.mjs'), String(process.pid)], { env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const redact = data => [key,clientToken].filter(Boolean).reduce((out,secret)=>out.split(secret).join('[REDACTED]'),String(data));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => fs.appendFileSync(path.join(root, 'server.log'), redact(data)));
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({ command: 'powershell.exe', cwd: path.join(root,'work'), args: ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(base,'infrastructure/nova-codex-interactive.ps1'),'-Model',config.model,'-Workspace',path.join(root,'work'),'-BaseUrl',proxyBase,'-DirectProvider','-ContextTokens','16384','-AppServerPort',String(port)] }));
  const closeProxy=()=>{proxy.closeAllConnections();proxy.close();};
  child.once('error',closeProxy);child.once('close',closeProxy);
  try {
    for (let i=0;i<180;i++) {
      if (child.exitCode != null) throw Error('Codex launcher exited; inspect server.log');
      try { const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) }); if (response.ok) return { child, connection: await new CodexConnection(url).connect(), url, closeProxy }; } catch {}
      await sleep(500);
    }
    throw Error('Codex server startup timed out; inspect server.log');
  } catch (error) { killTree(child);closeProxy(); throw error; }
}
export function openViewer(root) {
  const script = path.join(base, 'Watch-Codex.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ${quote('"'+script+'"')}, '-Project', ${quote('"'+root+'"')})`;
  execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,env:cleanEnvironment(projectKeyEnv(root))});
}
function projectKeyEnv(root){try{return JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8')).config.provider?.keyEnv;}catch{return undefined;}}
export async function runChecks(root, commands, signal) {
  const results=[];
  for (const [command,...args] of commands) {
    if(signal?.aborted) throw Error('Stopped before verification');
    const result = await new Promise(resolve => {
      const child = spawn(command,args,{cwd:path.join(root,'work'),env:cleanEnvironment(projectKeyEnv(root)),windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';
      const collect = data => { output=(output+String(data)).slice(-20000); };
      child.stdout.on('data',collect); child.stderr.on('data',collect);
      const timer=setTimeout(()=>{killTree(child);},120000);
      const stop=()=>killTree(child);signal?.addEventListener('abort',stop,{once:true});
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
      child.once('error',error=>{cleanup();resolve({command:[command,...args],passed:false,output:error.message});});
      child.once('close',code=>{cleanup();resolve({command:[command,...args],passed:!signal?.aborted && code===0 && !/\btests 0\b/.test(output),exitCode:code,output});});
    });
    results.push(result);
  }
  return {passed:results.every(r=>r.passed),configured:commands.length>0,results};
}
