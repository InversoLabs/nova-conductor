import test from 'node:test';
import assert from 'node:assert/strict';
import {builderMode,rolePrompt} from '../src/workflow.mjs';
const state={role:'BUILDER',prompt:'Build a page.',config:{verification:[]}};
test('old projects infer builder mode from successful transitions, ignoring failed retries',()=>{
 const planner={role:'PLANNER',status:'FINISHED',next:'BUILDER'};
 const reviewer={role:'REVIEWER',status:'FINISHED',next:'BUILDER'};
 assert.equal(builderMode({...state,runs:[planner]}),'implementation');
 const resumed=JSON.parse(JSON.stringify({...state,runs:[planner,reviewer,{role:'BUILDER',status:'FAILED'}],feedback:'Codex disconnected'}));
 assert.equal(builderMode(resumed),'repair');
 assert.match(rolePrompt(resumed),/Read REVIEW.md and BUILD_CHECKLIST.md/);
 assert.equal(builderMode({...resumed,builderMode:'user'}),'user');
 assert.doesNotMatch(rolePrompt({...resumed,builderMode:'user'}),/Read REVIEW.md and BUILD_CHECKLIST.md/);
});
