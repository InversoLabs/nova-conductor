import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value,null,2)); fs.renameSync(tmp,file);
}
export function readText(work,name) { try { return fs.readFileSync(path.join(work,name),'utf8'); } catch { return ''; } }
export function snapshot(work) {
  const files={};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if (['.git','node_modules','.conductor','.npm-cache'].includes(entry.name)) continue;
      const file=path.join(dir,entry.name), relative=path.relative(work,file).replaceAll('\\','/');
      if (entry.isSymbolicLink()) throw Error(`Unsupported link in project: ${relative}`);
      if (entry.isDirectory()) walk(file);
      else files[relative]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(work); return files;
}
export function assertRoleChanges(role,before,after) {
  const allowed = role==='PLANNER' ? ['AGENTS.md','BUILD_PLAN.md'] : role==='REVIEWER' ? ['REVIEW.md','BUILD_CHECKLIST.md'] : null;
  if (!allowed) {
    for (const file of ['AGENTS.md','REVIEW.md','REQUEST.md']) if (before[file]!==after[file]) throw Error(`Builder changed protected requirement/review file: ${file}`);
    return;
  }
  for (const file of new Set([...Object.keys(before),...Object.keys(after)])) if(before[file]!==after[file]&&!allowed.includes(file)) throw Error(`${role} changed an unauthorized project file: ${file}`);
}
export function reviewDecision(text) {
  const first=text.trim().split(/\r?\n/)[0].replace(/^#+\s*/, '').trim().toUpperCase();
  if (['PASS','REVISE'].includes(first) && text.trim().split(/\s+/).length>=12) return first;
  return null;
}
export function normalizeReview(text) {
  return text.replace(/^\s*\*\*Checklist\*\*:?\s*$/gmi,'## Checklist')
    .replace(/^(\s*[-*]\s+)\*\*(\[[ xX]\])\*\*/gm,'$1$2')
    .replace(/^\s*\* (\[[ xX]\])/gm,'- $1');
}
export function saveReview(work,text) {
  text=normalizeReview(text);
  const decision=reviewDecision(text);
  if(!decision)throw Error('Reviewer must return PASS or REVISE with evidence');
  const checklist=text.match(/^## Checklist\s*\r?\n([\s\S]*)$/m)?.[1]?.trim() || '';
  if(decision==='REVISE' && !/^- \[ \] .+/m.test(checklist))throw Error('Reviewer must return concrete repairs under ## Checklist');
  fs.writeFileSync(path.join(work,'REVIEW.md'),text.trim()+'\n','utf8');
  fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),decision==='REVISE'?checklist+'\n':'All requirements verified.\n','utf8');
}
export function nextPhase(role,work,checks) {
  if(role==='PLANNER') {
    for(const file of ['AGENTS.md','BUILD_PLAN.md']) if(readText(work,file).trim().length<80) throw Error(`Planner must create a useful ${file}`);
    return 'BUILDER';
  }
  if(role==='BUILDER') return 'REVIEWER';
  const decision=reviewDecision(readText(work,'REVIEW.md'));
  if(!decision) throw Error('Reviewer did not write PASS or REVISE with evidence in REVIEW.md');
  if(decision==='PASS' && checks?.passed) return 'COMPLETE';
  if(decision==='PASS' && !checks?.passed) return 'REVIEWER';
  if(decision==='REVISE' && !/- \[ \]/.test(readText(work,'BUILD_CHECKLIST.md'))) throw Error('Reviewer must write concrete unchecked fixes in BUILD_CHECKLIST.md');
  return 'BUILDER';
}
// Status feedback is also used by the CLI for infrastructure diagnostics.
// Only explicitly recognized project guidance belongs in a worker prompt.
export function workerHandoff(state) {
  const text=state.feedback || '';
  if(text.startsWith('User reopened this project at '))return text;
  if(text.startsWith('Configured tests failed.'))return text;
  if(/^Planner must create a useful (AGENTS|BUILD_PLAN)\.md$/.test(text))return 'The required planning files were not saved successfully. Use tools to write and read back AGENTS.md and BUILD_PLAN.md for the original request.';
  if(text.startsWith('The previous builder stalled without useful progress.'))return 'Inspect existing files once and implement the smallest unfinished requirement. Preserve working files and report actual progress.';
  if(/^The previous (PLANNER|BUILDER|REVIEWER) session lost its connection\./.test(text))return 'Partial files are preserved. Inspect existing work and continue without repeating completed edits.';
  if(text.startsWith('The builder timed out. Partial files are preserved.') || /^Previous (PLANNER|BUILDER) reached its time limit\./.test(text)) {
    const evidence=text.match(/(?:Observed verification failures:|Independent verification:)\s*([\s\S]*)$/)?.[1];
    return 'Partial files are preserved. Inspect existing work and identify the remaining requirements. Do not assume the previous role finished.'+(evidence?'\nVerification evidence: '+evidence:'');
  }
  return '';
}
export function builderMode(state) {
  if(['implementation','repair','user'].includes(state.builderMode))return state.builderMode;
  if(state.feedback?.startsWith('User reopened this project at BUILDER.'))return 'user';
  const source=[...(state.runs||[])].reverse().find(run=>run.status==='FINISHED' && run.next==='BUILDER' && ['PLANNER','REVIEWER'].includes(run.role));
  return source?.role==='REVIEWER'?'repair':'implementation';
}
export function rolePrompt(state) {
  const request=state.prompt || 'Read REQUEST.md to obtain the original request before proceeding.';
  const common=`Original user request (also saved in REQUEST.md):\n${request}\n\nYou are the ${state.role} for this project in a fresh session. The original request controls scope; planning documents must not expand or contradict it. Work in the current project directory using Codex tools and Windows PowerShell. Preserve REQUEST.md. Keep handoffs concise. No JSON report is required.\n`;
  const verification=state.config.verification.length ? `\nIndependent checks: ${JSON.stringify(state.config.verification)}.\n` : '';
  const handoff=workerHandoff(state);
  const feedback=handoff ? `\nProject guidance: ${handoff.slice(0,3500)}\n` : '';
  const roles={
    PLANNER:'Plan the requested product. Use file-writing tools to save only AGENTS.md (project constraints and file conventions) and BUILD_PLAN.md (concrete requested requirements, ordered implementation steps, and acceptance checks). In AGENTS.md, state that builders must not edit REQUEST.md, AGENTS.md, or REVIEW.md; generated-file lists, progress, and verification results belong in BUILD_NOTES.md, and repair progress belongs in BUILD_CHECKLIST.md. Inspect existing project files when relevant. Choose the simplest suitable implementation; include build commands only when needed and checks proportionate to the task. Do not invent requirements, agent teams, or placeholder plans. Do not build the product yet. Read back both saved files and confirm they match the request before handing off.',
    BUILDER:'Read AGENTS.md, BUILD_PLAN.md, and any BUILD_CHECKLIST.md; inspect existing work. Use tools to implement the remaining requirements and reviewer repairs, following any latest user guidance. Continue until the requested work is complete or a concrete blocker prevents progress. Check the actual result with proportionate tests; use existing checks where suitable, without adding unnecessary testing infrastructure. Record generated files, verified results, and any unfinished work or blocker in BUILD_NOTES.md; update repair progress in BUILD_CHECKLIST.md. You may update BUILD_PLAN.md to reflect the implementation, even if existing project notes call it read-only; preserve the original requirements. Do not edit REQUEST.md, AGENTS.md, or REVIEW.md. If the plan contradicts the request, report the conflict rather than implementing unrelated work.',
    REVIEWER:"Inspect the actual product read-only against EVERY original requirement and the relevant build-plan checks. Read the files and independently check behavior with available tools; builder reports and passing tests alone do not prove completion. For visual work, inspect the rendered result when possible; state any verification you could not perform. Return '# PASS' only when all required work is verified, otherwise '# REVISE', followed by concise evidence and gaps. For REVISE add '## Checklist' with ordered '- [ ]' concrete repairs and how to verify each. Do not turn optional improvements into requirements. Do not edit files; Conductor saves your final response as the review and checklist."
  };
  const buildTask=state.role==='BUILDER' ? {
    implementation:'\nBuild mode: initial implementation. Implement BUILD_PLAN.md, preserving any existing work. Complete the requested product and verify its acceptance checks.',
    repair:'\nBuild mode: reviewer repairs. Read REVIEW.md and BUILD_CHECKLIST.md. Fix the listed gaps, preserve working behavior, and verify each repair. Then check the original requirements before handing back for review.',
    user:'\nBuild mode: user-directed changes. Follow the user guidance in BUILD_CHECKLIST.md; it supersedes the previous review. Preserve working behavior and verify the requested changes.'
  }[builderMode(state)] : '';
  return common+buildTask+'\n'+roles[state.role]+verification+feedback+(state.role==='REVIEWER'&&state.plannerBaseline?'\nRead ../planner-baseline.md for the original planner requirements. BUILD_PLAN.md may contain builder updates; those updates cannot remove original acceptance requirements.':'');
}
export function roleInstructions(role, original) {
  if(role==='BUILDER') return original;
  return `You are the project ${role.toLowerCase()} using Codex tools on Windows PowerShell. Follow the original user request and this role's file boundaries. Leave a concise Markdown handoff.`;
}

export function preservePlannerBaseline(root,state){
  const baseline=path.join(root,'planner-baseline.md'),plan=path.join(root,'work','BUILD_PLAN.md');
  if(state.role==='BUILDER'&&!fs.existsSync(baseline)&&fs.existsSync(plan))fs.copyFileSync(plan,baseline,fs.constants.COPYFILE_EXCL);
  if(fs.existsSync(baseline))state.plannerBaseline=true;
}
