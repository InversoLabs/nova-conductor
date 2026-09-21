import {importProject} from './import-project.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { preservePlannerBaseline, atomic, snapshot, assertRoleChanges, nextPhase, rolePrompt, roleInstructions, readText, saveReview, reviewDecision, normalizeReview } from './workflow.mjs';
import { startServer, killTree, sleep, openViewer, runChecks } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import {loadProvider,saveProvider,listModels} from './providers.mjs';
import {BuilderProgress,productSignature,interruptBeforeRecovery} from './progress.mjs';

const original=JSON.parse(fs.readFileSync(new URL('../infrastructure/nova-codex-models.json',import.meta.url))).models[0].base_instructions;
export function initialize(root,prompt,model='gpt-oss:20b',verification=[]) {
  root=path.resolve(root);
  if(fs.existsSync(root)) throw Error('New project folder must not exist');
  if(!prompt.trim() || prompt.length>12000) throw Error('Provide a prompt of 1–12000 characters');
  if(!/^[a-zA-Z0-9][\w.:/-]{0,199}$/.test(model)) throw Error('Invalid model name');
  fs.mkdirSync(path.join(root,'work'),{recursive:true}); fs.mkdirSync(path.join(root,'runs'));
  fs.writeFileSync(path.join(root,'work','REQUEST.md'),prompt);
  const state={version:1,prompt,role:'PLANNER',status:'READY',runs:[],feedback:'',failures:0,
    config:{model,provider:loadProvider(),contextTokens:16384,port:8799,maxRuns:60,maxFailures:2,roleTimeoutMs:30*60*1000,builderTimeoutMs:45*60*1000,verification},expected:snapshot(path.join(root,'work'))};
  atomic(path.join(root,'state.json'),state); return state;
}
function log(root,type,data={}) { fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),type,...data})+'\n'); }
export function reopen(root,feedback,role='BUILDER') {
  role=role.toUpperCase();
  if(!['PLANNER','BUILDER','REVIEWER'].includes(role))throw Error('Choose PLANNER, BUILDER, or REVIEWER');
  root=fs.realpathSync(root);
  if(!feedback?.trim() || feedback.length>12000)throw Error('Provide feedback of 1–12000 characters');
  const lock=path.join(root,'conductor.lock');
  let held=false;
  try {
    fs.writeFileSync(lock,String(process.pid),{flag:'wx'});held=true;
    const stateFile=path.join(root,'state.json'),work=path.join(root,'work');
    const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    if(!['COMPLETE','STOPPED','NEEDS_ATTENTION','READY'].includes(state.status))throw Error('Stop the active run before reopening');
    if(JSON.stringify(snapshot(work))!==JSON.stringify(state.expected))throw Error('Project changed outside Conductor; inspect before reopening');
    if(readText(work,'REQUEST.md')!==state.prompt)throw Error('Original request changed');
    const archive=path.join(root,'reopened-'+Date.now());fs.mkdirSync(archive);
    for(const file of ['state.json','work/REVIEW.md','work/BUILD_CHECKLIST.md'])if(fs.existsSync(path.join(root,file)))fs.copyFileSync(path.join(root,file),path.join(archive,path.basename(file)));
    fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),'# User feedback\n\n'+feedback.trim()+'\n\n# Build Checklist\n\n- [ ] Address the user feedback above using the existing project, verify the changes, and hand off for review.\n');
    state.role=role;state.status='STOPPED';state.failures=0;state.disconnectFailures=0;state.busyRetries=0;state.deadlineRecoveries=0;state.stalledBuilds=0;state.nextRetryAt=null;state.lastBuildSignature=null;
    state.progressRecoveries=0;
    if(role==='BUILDER')state.builderMode='user'; else if(role==='PLANNER')delete state.builderMode;
    state.config.maxRuns=Math.max(state.config.maxRuns,state.runs.length+10);
    state.feedback='User reopened this project at '+role+'. The previous review is superseded by this guidance; preserve existing work and follow your selected role:\n'+feedback.trim();
    state.expected=snapshot(work);atomic(stateFile,state);
    log(root,'project.reopened',{role,archive});return state;
  } catch(error) {
    if(error.code==='EEXIST'&&!held)throw Error('Conductor is running or has a lock; stop it before reopening');
    throw error;
  } finally {if(held)fs.unlinkSync(lock);}
}
export function isBusy(error) { return /\b429\b|Too Many Requests|inference is busy/i.test(error.message); }
export function isDisconnect(error) { return /stream (?:disconnected|closed)|response\.completed|Codex.*disconnect|ECONNRESET|ECONNREFUSED|socket hang up|connection.*(?:closed|reset)/i.test(error.message); }
export async function run(root,{visible=true,start=startServer,check=runChecks}={}) {
  root=fs.realpathSync(root); const work=path.join(root,'work'), stateFile=path.join(root,'state.json');
  const lock=path.join(root,'conductor.lock');
  if(fs.existsSync(lock)) {
    const pid=Number(fs.readFileSync(lock,'utf8'));
    try { process.kill(pid,0); throw Error(`Conductor is already running (${pid})`); } catch(e) { if(e.code!=='ESRCH') throw e; }
    fs.renameSync(lock,lock+'.stale-'+Date.now());
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
  let server, stopped=false, active, watcher;
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  // Migrate the former default only; retain explicitly customized deadlines.
  if(state.config.roleTimeoutMs===10*60*1000){
    state.config.roleTimeoutMs=30*60*1000;
    state.config.builderTimeoutMs ??= 45*60*1000;
  }
  state.config.disconnectRetries ??= 3;
  state.config.retryDelayMs ??= 5000;
  state.disconnectFailures ??= 0;
  state.deadlineRecoveries ??= 0;
  state.stalledBuilds ??= 0;
  state.busyRetries ??= 0;
  state.progressRecoveries ??= 0;
  const abort=new AbortController();
  const save=()=>atomic(stateFile,state);
  const stop=()=>{stopped=true; abort.abort(); if(active) server?.connection.request('turn/interrupt',active).catch(()=>{});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    if(state.status==='COMPLETE') { console.log('Project already complete.'); return state; }
    if(!Array.isArray(state.config.verification)||!state.config.verification.every(c=>Array.isArray(c)&&c.length&&c.every(a=>typeof a==='string'&&a.length)))throw Error('Verification must be an array of command argv arrays');
    if(state.config.contextTokens!==16384)throw Error('Conductor requires 16K sessions');
    if(!Number.isInteger(state.config.disconnectRetries)||state.config.disconnectRetries<0||state.config.disconnectRetries>10||!Number.isInteger(state.config.retryDelayMs)||state.config.retryDelayMs<0||state.config.retryDelayMs>60000)throw Error('Invalid disconnect retry settings');
    if(JSON.stringify(snapshot(work))!==JSON.stringify(state.expected)) throw Error('Project changed outside Conductor; inspect it before resuming.');
    if(readText(work,'REQUEST.md')!==state.prompt) throw Error('Original request changed.');
    // Upgrade an already-stopped builder from the old immediate-deadline failure.
    // File integrity was checked above; consume the same bounded recovery budget.
    if(state.status==='NEEDS_ATTENTION' && state.role==='BUILDER' && /^Role deadline exceeded/.test(state.feedback) && state.deadlineRecoveries<3) {
      const checks=await check(root,state.config.verification,abort.signal);
      if(JSON.stringify(snapshot(work))!==JSON.stringify(state.expected))throw Error('Verification modified project files');
      fs.writeFileSync(path.join(root,'recovery-checks.json'),JSON.stringify(checks,null,2));
      state.role='REVIEWER';state.status='READY';state.failures=0;state.deadlineRecoveries++;
      state.feedback='The builder timed out. Partial files are preserved. Inspect the existing product and produce a concrete repair checklist. Independent verification: '+(checks.passed?'Configured checks passed; verify the remaining requirements.':checks.results.filter(r=>!r.passed).map(r=>r.output).join('\n').slice(-2500));
      save();log(root,'deadline.resume',{next:state.role});
    }
    if(['NEEDS_ATTENTION','STOPPED'].includes(state.status)) {
      state.progressRecoveries=0;
      log(root,'run.continued',{previousStatus:state.status,failures:state.failures});
      state.failures=0;state.disconnectFailures=0;state.busyRetries=0;state.nextRetryAt=null;
      state.status='READY';save();
    }
    const stopFile=path.join(root,'stop.request'); if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
    watcher=setInterval(()=>{if(fs.existsSync(stopFile))stop();},300);
    console.log('Starting native Codex and the bundled provider proxy...');
    server=await start(root,state.config);
    atomic(path.join(root,'viewer.json'),{url:server.url,threadId:null,role:state.role});
    if(visible) openViewer(root);
    while(!stopped && state.runs.length<state.config.maxRuns && state.status!=='COMPLETE') {
      if(state.failures>=state.config.maxFailures) {state.status='NEEDS_ATTENTION';break;}
      if(state.disconnectFailures>state.config.disconnectRetries){state.status='NEEDS_ATTENTION';break;}
      if(state.nextRetryAt){
        while(!stopped && Date.now()<Date.parse(state.nextRetryAt))await sleep(Math.min(250,Math.max(1,Date.parse(state.nextRetryAt)-Date.now())));
        if(stopped)break;
        state.nextRetryAt=null;save();
      }
      if(!server)server=await start(root,state.config);
      if(JSON.stringify(snapshot(work))!==JSON.stringify(state.expected)) throw Error('Project changed between roles.');
      preservePlannerBaseline(root,state);
      const role=state.role, id=String(state.runs.length+1).padStart(4,'0'), dir=path.join(root,'runs',id);
      fs.mkdirSync(dir);
      if(role==='REVIEWER' && fs.existsSync(path.join(work,'REVIEW.md'))) {
        fs.copyFileSync(path.join(work,'REVIEW.md'),path.join(dir,'previous-review.md'));
        fs.unlinkSync(path.join(work,'REVIEW.md'));
      }
      const before=snapshot(work), record={id,role,startedAt:new Date().toISOString(),status:'RUNNING'};
      state.runs.push(record);state.status=role;state.expected=before;save();
      console.log(`\n${role} | fresh 16K session | run ${id}`);log(root,'role.started',{id,role});
      try {
        const started=await server.connection.request('thread/start',{cwd:work,model:state.config.model,modelProvider:'nova_remote',approvalPolicy:'never',sandbox:role==='REVIEWER'?'read-only':'workspace-write',baseInstructions:roleInstructions(role,original),config:{model_context_window:16384,model_auto_compact_token_limit:12000},selectedCapabilityRoots:[]});
        record.threadId=started.thread.id;save();
        // Each role starts a NEW thread. Resume is used only by the display to
        // attach to that just-created thread, never to carry old role context.
        const prompt=rolePrompt(state);fs.writeFileSync(path.join(dir,'prompt.md'),prompt);
        let cancelCompletion;
        let reviewOutput='';
        let reviewClarifications=0;
        const completion=new Promise((resolve,reject)=>{
          const progress=role==='BUILDER'?new BuilderProgress(before,state.config):null;
          const progressTimer=progress?setInterval(()=>{
            try{
              const reason=progress.check(snapshot(work));
              if(reason && active && !stopped){
                log(root,'builder.stalled',{id,reason});
                cleanup();reject(Error('Builder stalled: '+reason+'; partial files preserved'));
              }
            }catch(error){cleanup();reject(error);}
          },state.config.progressPollMs??15000):null;
          const deadline=()=>{ if(active)server.connection.request('turn/interrupt',active).catch(()=>{}); cleanup();reject(Error('Role deadline exceeded; partial files preserved'));};
          const timeoutMs=role==='BUILDER' ? (state.config.builderTimeoutMs ?? state.config.roleTimeoutMs) : state.config.roleTimeoutMs;
          let timer=setTimeout(deadline,timeoutMs);
          const cancelled=()=>{cleanup();reject(Error('Stopped; partial work preserved'));};
          const disconnect=()=>{cleanup();reject(Error('Codex disconnected'));};
          const notice=event=>{
            const p=event.params;
            if(p?.threadId!==record.threadId)return;
            progress?.notice(event);
            if(['item/started','item/completed'].includes(event.method) && ['commandExecution','fileChange'].includes(p.item?.type))log(root,'tool.activity',{run:id,event:event.method,type:p.item.type,status:p.item.status});
            if(role==='REVIEWER' && event.method==='item/completed' && p.item?.type==='agentMessage' && p.item.phase!=='commentary') reviewOutput=p.item.text || reviewOutput;
            if(event.method==='turn/started') {
              active={threadId:record.threadId,turnId:p.turn.id};record.turnEnded=false;
              if(state.status==='PAUSED') {
                state.status=role;save();timer=setTimeout(deadline,timeoutMs);
                log(root,'role.resumed',{id,role});
              }
            }
            if(event.method==='turn/completed' && p.turn.status==='interrupted' && !stopped) {
              clearTimeout(timer);active=null;record.turnEnded=true;
              state.status='PAUSED';save();
              console.log('Worker paused. Type your guidance in the Codex window and submit to continue this role.');
              log(root,'role.paused',{id,role});return;
            }
            if(event.method==='turn/completed') {
              if(role==='REVIEWER' && p.turn.status==='completed') {
                reviewOutput=(p.turn.items||[]).filter(i=>i.type==='agentMessage' && i.phase!=='commentary').at(-1)?.text || reviewOutput;
                fs.writeFileSync(path.join(dir,'review-response-'+reviewClarifications+'.md'),reviewOutput,'utf8');
                reviewOutput=normalizeReview(reviewOutput);
                const decision=reviewDecision(reviewOutput);
                const usable=decision && (decision==='PASS' || /^## Checklist\s*\r?\n[\s\S]*^- \[ \] .+/m.test(reviewOutput));
                if(!usable && !readText(work,'REVIEW.md') && reviewClarifications++===0 && !stopped) {
                  reviewOutput='';active=null;
                  console.log('Asking reviewer for missing evidence in the same session...');
                  server.connection.request('turn/start',{threadId:record.threadId,input:[{type:'text',text:'Your review is missing evidence or a repair checklist. Return the complete review based on what you already inspected: # PASS or # REVISE, then concrete observed evidence. If anything is unverified, use REVISE and add ## Checklist with - [ ] repair or verification steps. Do not repeat the investigation or edit files.',text_elements:[]}],effort:'minimal'}).then(r=>{active={threadId:record.threadId,turnId:r.turn.id};}).catch(e=>{cleanup();reject(e);});
                  return;
                }
                if(!usable && !readText(work,'REVIEW.md')){cleanup();reject(Error('Reviewer returned no usable final review after clarification; inspect provider output limits or model tool/reply behavior.'));return;}
              }
              cleanup();resolve(p.turn);
            }
          };
          const cleanup=()=>{clearTimeout(timer);clearInterval(progressTimer);abort.signal.removeEventListener('abort',cancelled);server.connection.off('notice',notice);server.connection.off('disconnected',disconnect);};
          cancelCompletion=()=>{cleanup();reject(Error('Turn startup failed'));};
          server.connection.on('notice',notice);server.connection.on('disconnected',disconnect);
          abort.signal.addEventListener('abort',cancelled,{once:true});
        });
        completion.catch(()=>{});
        let response;
        try {response=await server.connection.request('turn/start',{threadId:record.threadId,input:[{type:'text',text:prompt,text_elements:[]}],effort:'minimal'});}catch(error){cancelCompletion();throw error;}
        active={threadId:record.threadId,turnId:response.turn.id};
        // A new thread has no resumable rollout until its first turn starts.
        atomic(path.join(root,'viewer.json'),{url:server.url,threadId:record.threadId,role});
        const turn=await completion;active=null;record.turnEnded=true;
        if(stopped || turn.status==='interrupted') throw Error('Stopped; partial work preserved');
        if(turn.status!=='completed') throw Error(turn.error?.message || `Codex turn ${turn.status}`);
        let after=snapshot(work);assertRoleChanges(role,before,after);
        if(role==='REVIEWER') {
          if(!reviewOutput)reviewOutput=(turn.items||[]).filter(i=>i.type==='agentMessage' && i.phase!=='commentary').at(-1)?.text || '';
          if(reviewOutput){saveReview(work,reviewOutput);after=snapshot(work);}
        }
        if(readText(work,'REQUEST.md')!==state.prompt)throw Error('Original request changed');
        state.expected=after;
        let checks;
        if(role!=='PLANNER') {
          console.log('Running independent project checks...');checks=await check(root,state.config.verification,abort.signal);
          fs.writeFileSync(path.join(dir,'checks.json'),JSON.stringify(checks,null,2));
          if(JSON.stringify(snapshot(work))!==JSON.stringify(after))throw Error('Verification modified project files');
        }
        const next=nextPhase(role,work,checks);
        if(role==='BUILDER') {
          if(productSignature(before)!==productSignature(after))state.progressRecoveries=0;
          const product=Object.fromEntries(Object.entries(after).filter(([name])=>!['BUILD_PLAN.md','BUILD_NOTES.md','BUILD_CHECKLIST.md','REVIEW.md'].includes(name)));
          const signature=JSON.stringify(product);
          state.stalledBuilds=signature===state.lastBuildSignature?state.stalledBuilds+1:0;
          state.lastBuildSignature=signature;
          if(state.stalledBuilds>=2)throw Error('Builder made no product progress across three attempts; inspect the review checklist.');
        }
        if(stopped)throw Error('Stopped after verification; partial work preserved');
        state.feedback=checks && !checks.passed ? 'Configured tests failed. Fix them before completion.\n'+checks.results.filter(r=>!r.passed).map(r=>r.output).join('\n').slice(-3000) : '';
        if(next==='BUILDER')state.builderMode=role==='REVIEWER'?'repair':'implementation';
        state.role=next;state.status=next==='COMPLETE'?'COMPLETE':'READY';state.failures=0;state.disconnectFailures=0;state.nextRetryAt=null;state.busyRetries=0;
        record.status='FINISHED';record.next=next;
      } catch(error) {
        record.status=stopped?'STOPPED':'FAILED';record.error=error.message;
        const disconnected=isDisconnect(error);
        const stalled=/^Builder stalled:/.test(error.message);
        const deadline=/Role deadline exceeded/.test(error.message);
        // If no terminal turn event arrived, the server might still be editing.
        // Stop our owned tree before capturing files or starting another role.
        if((disconnected || deadline || stopped || stalled) && !record.turnEnded){
          if(stalled)await interruptBeforeRecovery(server.connection,active);
          killTree(server?.child);
          if(server?.child?.pid){
            let alive=false;try{process.kill(server.child.pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}
            if(alive)throw Error('Cannot confirm old Codex worker stopped; refusing a duplicate retry');
          }
          server?.connection.close();server?.closeProxy?.();server=null;active=null;
        }
        const after=snapshot(work);
        try {assertRoleChanges(role,before,after);state.expected=after;}catch(unsafe){state.status='NEEDS_ATTENTION';state.feedback=unsafe.message;break;}
        state.feedback=error.message;
        console.log(error.message);
        if(!stopped && stalled){
          state.progressRecoveries++;
          if(state.progressRecoveries>1){state.status='NEEDS_ATTENTION';state.feedback='Builder stalled again after a focused recovery. Files preserved. Inspect the model/provider or provide guidance before continuing.';break;}
          state.feedback='The previous builder stalled without useful progress. Read the existing files once, then use apply_patch to implement the smallest unfinished build-plan or checklist step immediately. Do not redesign or restate the plan. Preserve working files. Verify this small change and hand off with remaining work.';
          state.status='READY';record.next='BUILDER';
          log(root,'builder.progress-retry',{id,attempt:state.progressRecoveries});
        }else if(!stopped && deadline && role!=='REVIEWER' && state.deadlineRecoveries<3){
          state.deadlineRecoveries++;
          const checks=role==='PLANNER'?null:await check(root,state.config.verification,abort.signal);
          if(JSON.stringify(snapshot(work))!==JSON.stringify(after))throw Error('Verification modified project files');
          if(checks)fs.writeFileSync(path.join(dir,'checks.json'),JSON.stringify(checks,null,2));
          state.feedback='Previous '+role+' reached its time limit. Partial files are preserved. Inspect the existing work; do not restart it. '+(checks&&!checks.passed?'Observed verification failures:\n'+checks.results.filter(r=>!r.passed).map(r=>r.output).join('\n').slice(-2500):'Check remaining requirements and write a short concrete handoff.');
          state.role=role==='BUILDER'?'REVIEWER':role;
          record.next=state.role;record.status='HANDED_OFF';state.status='READY';
          log(root,'deadline.handoff',{role,next:state.role,attempt:state.deadlineRecoveries});
         }else if(!stopped && isBusy(error)){
          state.busyRetries++;
          if(state.busyRetries>3){state.status='NEEDS_ATTENTION';state.feedback='NOVA remained busy after three delayed retries. Check for another active model request, then Continue.';break;}
          const delayMs=30000*2**(state.busyRetries-1);
          state.nextRetryAt=new Date(Date.now()+delayMs).toISOString();
          state.status='WAITING_FOR_MODEL';
          state.feedback='NOVA rejected the request because inference is busy. Continue this role from existing files when capacity is available.';
          console.log('NOVA busy: retry '+state.busyRetries+'/3 in '+delayMs/1000+' seconds.');
          log(root,'model.busy',{role,attempt:state.busyRetries,delayMs});
        }else if(!stopped && disconnected){
          if(role==='BUILDER'){
            state.progressRecoveries=productSignature(before)===productSignature(after)?state.progressRecoveries+1:0;
            if(state.progressRecoveries>1){state.status='NEEDS_ATTENTION';state.feedback='Builder repeatedly disconnected without product changes. Files preserved; inspect the provider/model before continuing.';break;}
          }
          state.disconnectFailures++;
          if(state.disconnectFailures>state.config.disconnectRetries){state.status='NEEDS_ATTENTION';break;}
          const delayMs=Math.min(60000,state.config.retryDelayMs*2**(state.disconnectFailures-1));
          state.nextRetryAt=new Date(Date.now()+delayMs).toISOString();
          state.feedback=`The previous ${role} session lost its connection. Partial files are preserved. Inspect existing work and continue without repeating completed edits. ${error.message}`;
          if(role==='BUILDER' && state.progressRecoveries)state.feedback+=' Implement the smallest unfinished plan/checklist step with apply_patch now, verify that small change, then hand off. Do not restate or redesign the plan.';
          console.log(`Connection recovery ${state.disconnectFailures}/${state.config.disconnectRetries}: fresh ${role} in ${delayMs/1000}s; files preserved.`);
          log(root,'connection.retry',{role,run:id,attempt:state.disconnectFailures,delayMs});
        }else {
          if(!stopped)state.failures++;
          if(/deadline|timed out|startup failed|no product progress|no usable final review/i.test(error.message)){state.status='NEEDS_ATTENTION';break;}
        }
      } finally {record.endedAt=new Date().toISOString();save();log(root,'role.finished',record);}
      if(visible)await sleep(2000);
    }
    if(stopped)state.status='STOPPED';
    else if(state.status!=='COMPLETE')state.status='NEEDS_ATTENTION';
    if(state.runs.length>=state.config.maxRuns)state.feedback='Run budget reached';
    save();return state;
  } catch(error) {state.status='NEEDS_ATTENTION';state.feedback=error.message;save();throw error;}
  finally {
    clearInterval(watcher);process.off('SIGINT',stop);process.off('SIGTERM',stop);
    atomic(path.join(root,'viewer.json'),{done:true,status:state.status});
    if(active)await server?.connection.request('turn/interrupt',active).catch(()=>{});
    server?.connection.close();killTree(server?.child);server?.closeProxy?.();
    fs.unlinkSync(lock);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,root,...args]=process.argv.slice(2);
  try {
    if(command==='provider') {if(root)saveProvider({kind:root,baseUrl:args[0],keyEnv:args[1]});console.log(JSON.stringify(loadProvider(),null,2));}
    else if(command==='models') {console.log(JSON.stringify(await listModels(loadProvider())));}
    else if(command==='set-provider') {
      const lock=path.join(root,'conductor.lock');let held=false;
      try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});held=true;
        const file=path.join(root,'state.json'),s=JSON.parse(fs.readFileSync(file));
        if(!['COMPLETE','STOPPED','NEEDS_ATTENTION','READY'].includes(s.status))throw Error('Stop the project first');
        if(args[0] && !/^[a-zA-Z0-9][\w.:/-]{0,199}$/.test(args[0]))throw Error('Invalid model name');
        s.config.provider=loadProvider();if(args[0])s.config.model=args[0];atomic(file,s);console.log('Project provider updated; model: '+s.config.model);
      }finally{if(held)fs.unlinkSync(lock);}
    }
    else if(command==='init') {initialize(root,fs.readFileSync(args[0],'utf8'),args[1]);console.log(path.resolve(root));}
    else if(command==='import') {importProject(root,args[0],fs.readFileSync(args[1],'utf8'),args[2],initialize);console.log('Imported into '+path.resolve(root)+'; ready at BUILDER. Original folder unchanged.');}
    else if(command==='reopen') {const s=reopen(root,fs.readFileSync(args[1],'utf8'),args[0]);console.log('Reopened at '+s.role+'. Use run or Continue to start.');}
    else if(command==='run') {const s=await run(root,{visible:!args.includes('--headless')});console.log(`${s.status}: ${s.feedback||path.join(root,'work')}`);if(s.status!=='COMPLETE')process.exitCode=2;}
    else if(command==='stop') {if(!fs.existsSync(path.join(root,'state.json')))throw Error('Unknown project');fs.writeFileSync(path.join(root,'stop.request'),'stop');}
    else if(command==='status') {const s=JSON.parse(fs.readFileSync(path.join(root,'state.json')));console.log(JSON.stringify({status:s.status,role:s.role,runs:s.runs.length,feedback:s.feedback},null,2));}
    else throw Error('Usage: conductor provider [ollama|lmstudio|custom|nova BASE_URL [KEY_ENV]] | models | set-provider PROJECT [MODEL] | init PROJECT PROMPT_FILE [MODEL] | import PROJECT SOURCE_FOLDER PROMPT_FILE [MODEL] | reopen PROJECT ROLE FEEDBACK_FILE | run PROJECT [--headless] | stop PROJECT | status PROJECT');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
