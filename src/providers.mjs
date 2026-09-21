import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const presets={ollama:'http://127.0.0.1:11434/v1',lmstudio:'http://127.0.0.1:1234/v1',nova:'http://127.0.0.1:8787/v1'};
export function validateProvider(value){
 if(!value || !['ollama','lmstudio','custom','nova'].includes(value.kind))throw Error('Provider must be ollama, lmstudio, custom, or nova');
 const u=new URL(value.baseUrl || presets[value.kind]);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Use an HTTP(S) API base URL without credentials, query parameters, or fragments');
 u.pathname=u.pathname.replace(/\/+$/,'');if(!u.pathname||u.pathname==='/')u.pathname='/v1';
 const keyEnv=value.keyEnv || '';
 if(keyEnv&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))throw Error('API key setting must be an environment variable name, not the key');
 return {kind:value.kind,baseUrl:u.toString().replace(/\/$/,''),keyEnv};
}
export function providerFile(){return process.env.NOVA_CONDUCTOR_PROVIDER_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.config'),'NovaConductor','provider.json');}
export function loadProvider(){const file=providerFile();return fs.existsSync(file)?validateProvider(JSON.parse(fs.readFileSync(file,'utf8'))):validateProvider({kind:'ollama'});}
export function providerDefaults(kind){
 const current=loadProvider();if(current.kind===kind)return current;
 const file=providerFile()+'.profiles.json';const profiles=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 return profiles[kind]?validateProvider(profiles[kind]):{kind,baseUrl:presets[kind]||'',keyEnv:''};
}
export function saveProvider(value){
 const p=validateProvider(value),file=providerFile(),history=file+'.profiles.json';
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const profiles=fs.existsSync(history)?JSON.parse(fs.readFileSync(history,'utf8')):{};
 if(fs.existsSync(file)){const prior=loadProvider();profiles[prior.kind]=prior;}
 profiles[p.kind]=p;fs.writeFileSync(history,JSON.stringify(profiles,null,2));fs.writeFileSync(file,JSON.stringify(p,null,2));return p;
}
export function providerKey(p,env=process.env){if(!p.keyEnv)return '';const key=env[p.keyEnv];if(!key)throw Error(`Set ${p.keyEnv} in this terminal before connecting to this provider`);return key;}
export async function listModels(provider){
 const p=validateProvider(provider),key=providerKey(p);let r;
 try{r=await fetch(p.baseUrl+'/models',{headers:key?{Authorization:`Bearer ${key}`}:{},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Error('Cannot reach provider /models. Start its server and check the API base URL.');}
 if(!r.ok)throw Error(`Provider /models returned HTTP ${r.status}. Check its URL and authentication.`);
 const body=await r.json();return (body.data||[]).map(m=>m.id).filter(x=>typeof x==='string').sort();
}
