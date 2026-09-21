import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {initialize,reopen} from '../src/conductor.mjs';import {snapshot} from '../src/workflow.mjs';
test('reopen preserves product and archives review; refuses running or externally changed projects',t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nova-reopen-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));const root=path.join(parent,'project');const s=initialize(root,'Build a page.');
 fs.writeFileSync(root+'/work/index.html','existing product');fs.writeFileSync(root+'/work/REVIEW.md','# PASS\nPrevious review');s.expected=snapshot(root+'/work');s.status='COMPLETE';s.role='COMPLETE';s.failures=2;fs.writeFileSync(root+'/state.json',JSON.stringify(s));
 const result=reopen(root,'Fix the invisible button.');assert.equal(result.role,'BUILDER');assert.equal(result.failures,0);assert.equal(fs.readFileSync(root+'/work/index.html','utf8'),'existing product');assert.match(fs.readFileSync(root+'/work/BUILD_CHECKLIST.md','utf8'),/invisible button/);assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('reopened-')).length,1);
 fs.writeFileSync(root+'/conductor.lock',String(process.pid));assert.throws(()=>reopen(root,'fix'),/lock/);assert.ok(fs.existsSync(root+'/conductor.lock'));fs.unlinkSync(root+'/conductor.lock');
 fs.writeFileSync(root+'/work/index.html','external change');assert.throws(()=>reopen(root,'fix'),/outside/);assert.equal(fs.existsSync(root+'/conductor.lock'),false);
});
