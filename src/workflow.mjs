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
    for (const file of ['AGENTS.md','BUILD_PLAN.md','REVIEW.md','REQUEST.md']) if (before[file]!==after[file]) throw Error(`Builder changed protected requirement/review file: ${file}`);
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
export function rolePrompt(state) {
  const common=`You are the ${state.role} for Nova Conductor in a fresh 16K session. REQUEST.md is the read-only original request. Work within this project. Keep handoffs concise. No JSON report is required.\n`;
  const verification=state.config.verification.length ? `\nIndependent checks: ${JSON.stringify(state.config.verification)}.\n` : '';
  const feedback=state.feedback ? `\nLatest handoff: ${state.feedback.slice(0,3500)}\n` : '';
  const roles={
    PLANNER:'Write only AGENTS.md (project constraints, file conventions, and build/check commands) and BUILD_PLAN.md (requested requirements, ordered build steps, and suitable acceptance checks). Conductor owns role switching; do not invent agent profiles or teams. Do not build yet.',
    BUILDER:'Read AGENTS.md, BUILD_PLAN.md, and any BUILD_CHECKLIST.md. Build the product; prioritize at most three checklist items per batch. Verify your changes, update checklist progress, and record results and remaining work in BUILD_NOTES.md. Preserve REQUEST.md, AGENTS.md, BUILD_PLAN.md, and REVIEW.md. Hand off when the batch is done or blocked.',
    REVIEWER:"Inspect the product read-only against EVERY original requirement, using the build plan and available check evidence. Return your review as your final message: '# PASS' if verified, otherwise '# REVISE', then evidence and gaps. For REVISE add '## Checklist' with ordered '- [ ]' repair steps and verification. Conductor saves the review and checklist. Do not edit files. Distinguish required fixes from optional suggestions; the original request controls scope."
  };
  return common+roles[state.role]+verification+feedback;
}
export function roleInstructions(role, original) {
  if(role==='BUILDER') return original;
  return `You are the Nova Conductor ${role.toLowerCase()} using Codex tools on Windows PowerShell. Follow the role's file boundaries and leave a concise Markdown handoff.`;
}
