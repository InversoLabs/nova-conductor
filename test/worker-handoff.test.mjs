import test from 'node:test';
import assert from 'node:assert/strict';
import {rolePrompt,workerHandoff} from '../src/workflow.mjs';

const state={role:'PLANNER',prompt:'Build a static Nova Labs webpage.',config:{verification:[]}};
test('runtime failures remain available in status without becoming worker instructions',()=>{
 for(const feedback of ['Codex server startup timed out; inspect server.log','NOVA rejected the request because inference is busy. Continue this role from existing files when capacity is available.','exceeded retry limit, last status: 429 Too Many Requests','Stopped; partial work preserved','Run budget reached','Unexpected future infrastructure error']){
  const s={...state,feedback};assert.equal(workerHandoff(s),'');
  const prompt=rolePrompt(s);assert(!prompt.includes(feedback));assert(prompt.includes(state.prompt));assert.equal(s.feedback,feedback);
 }
});
test('user steering and observed check failures reach the worker',()=>{
 for(const feedback of ['User reopened this project at BUILDER. The previous review is superseded by this guidance; preserve existing work and follow your selected role:\nRepair only the stylesheet link.','Configured tests failed. Fix them before completion.\nMissing styles.css'])assert(rolePrompt({...state,feedback}).includes(feedback));
});
test('retries describe unfinished work without asking the model to debug its host',()=>{
 const feedback='The previous BUILDER session lost its connection. Partial files are preserved. Inspect existing work and continue without repeating completed edits. stream closed before response.completed';
 const prompt=rolePrompt({...state,feedback});assert(prompt.includes('Partial files are preserved.'));assert(!prompt.includes('response.completed'));assert(!prompt.includes('lost its connection'));
 assert.match(workerHandoff({...state,feedback:'Planner must create a useful AGENTS.md'}),/write and read back AGENTS.md and BUILD_PLAN.md/);
});
