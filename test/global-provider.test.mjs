import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {saveProvider,loadProvider,providerDefaults} from '../src/providers.mjs';
import {initialize,run} from '../src/conductor.mjs';
test('existing projects use the global provider; switching explicitly remembers previous endpoint',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-global-provider-')),prior=process.env.NOVA_CONDUCTOR_PROVIDER_FILE;
 process.env.NOVA_CONDUCTOR_PROVIDER_FILE=path.join(dir,'provider.json');
 t.after(()=>{if(prior===undefined)delete process.env.NOVA_CONDUCTOR_PROVIDER_FILE;else process.env.NOVA_CONDUCTOR_PROVIDER_FILE=prior;fs.rmSync(dir,{recursive:true,force:true});});
 saveProvider({kind:'ollama'});const root=path.join(dir,'old-project');initialize(root,'Build a page.');
 const nova={kind:'nova',baseUrl:'http://192.0.2.10:8787/v1',keyEnv:'TEST_KEY_NAME'};saveProvider(nova);
 const globalBefore=fs.readFileSync(process.env.NOVA_CONDUCTOR_PROVIDER_FILE,'utf8');
 await assert.rejects(run(root,{visible:false,start:async(_root,config)=>{assert.deepEqual(config.provider,nova);throw Error('Test deliberately stops before inference');}}),/deliberately/);
 assert.equal(fs.readFileSync(process.env.NOVA_CONDUCTOR_PROVIDER_FILE,'utf8'),globalBefore);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).config.provider,nova);
 assert.deepEqual(initialize(path.join(dir,'new-project'),'Create another page.').config.provider,nova);
 saveProvider({kind:'ollama'});assert.equal(loadProvider().kind,'ollama');assert.deepEqual(providerDefaults('nova'),nova);
 saveProvider(providerDefaults('nova'));assert.deepEqual(loadProvider(),nova);
});
