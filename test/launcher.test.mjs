import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('real PowerShell launcher preserves NOVA config when starting the native app server',{skip:process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conductor-launcher-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const captured=path.join(root,'captured.json');
  fs.writeFileSync(path.join(root,'codex.ps1'),"[IO.File]::WriteAllText($env:CONDUCTOR_TEST_CAPTURE,(ConvertTo-Json -InputObject @($args) -Compress)); exit 0");
  // Isolate only the mutex name in a temporary copy so this mocked argv test
  // cannot contend with the user's live model session.
  const original=fileURLToPath(new URL('../infrastructure/nova-codex-interactive.ps1',import.meta.url));
  const launcher=path.join(root,'launcher.ps1');
  fs.writeFileSync(launcher,fs.readFileSync(original,'utf8').replace('Local\\NOVA.Codex.Remote.Session',`Local\\NOVA.Conductor.Test.${process.pid}.${Date.now()}`));
  fs.copyFileSync(path.join(path.dirname(original),'nova-codex-models.json'),path.join(root,'nova-codex-models.json'));
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',launcher,'-Model','gpt-oss:20b','-Workspace',root,'-BaseUrl','https://nova.inversolabs.us','-ContextTokens','16384','-AppServerPort','8799'],{
    encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,PATH:root+path.delimiter+process.env.PATH,LOCALAPPDATA:root,NOVA_DESKTOP_API_KEY:'test-placeholder',CONDUCTOR_TEST_CAPTURE:captured},
  });
  assert.equal(result.status,0,result.stderr);
  const args=JSON.parse(fs.readFileSync(captured));
  assert.equal(args[0],'app-server');assert.ok(args.includes('ws://127.0.0.1:8799'));
  assert.ok(args.some(a=>a==='model_context_window=16384'));
  assert.ok(args.includes('model_provider="nova_remote"'));
  assert.ok(!args.includes('exec'));assert.ok(!args.includes('--json'));assert.ok(!args.includes(root));
  for(let i=0;i<args.length;i++)if(args[i]==='-c')assert.ok(args[++i].includes('='));
});
