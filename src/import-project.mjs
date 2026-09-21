import fs from 'node:fs';
import path from 'node:path';
import {atomic,snapshot} from './workflow.mjs';

const excluded=new Set(['.git','node_modules','.venv','venv','__pycache__','.conductor']);
const reserved=new Set(['REQUEST.md','BUILD_PLAN.md','BUILD_NOTES.md','BUILD_CHECKLIST.md','REVIEW.md']);
function futurePath(value) {
  if(fs.existsSync(value))return fs.realpathSync(value);
  const parent=path.dirname(value);
  return path.join(futurePath(parent),path.basename(value));
}
export function importProject(root,source,prompt,model,initialize) {
  source=fs.realpathSync(source);root=futurePath(path.resolve(root));
  if(!fs.statSync(source).isDirectory())throw Error('Source must be a codebase folder');
  if(fs.existsSync(root))throw Error('New project folder must not exist');
  const relative=path.relative(source,root);
  if(!relative || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)))throw Error('Import destination must be outside the source folder');
  if(fs.existsSync(path.join(source,'state.json')) && fs.existsSync(path.join(source,'work')))throw Error('This is already a Conductor project; use Continue or Reopen');
  const files=[];
  function scan(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(excluded.has(entry.name))continue;
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error('Source contains a link: '+path.relative(source,file)+'. Import a folder with regular files instead.');
      if(entry.isDirectory())scan(file);
      else if(entry.isFile())files.push(path.relative(source,file));
    }
  }
  scan(source);
  if(!files.length)throw Error('No source files found to import');
  const state=initialize(root,prompt,model),work=path.join(root,'work');
  try {
    for(const file of files) {
      // Preserve pre-existing workflow documents outside the worker's scope;
      // imported AGENTS.md remains active and is never rewritten here.
      const target=path.join(root,reserved.has(file)?'imported-documents':'work',file);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.copyFileSync(path.join(source,file),target,fs.constants.COPYFILE_EXCL);
    }
    if(!fs.existsSync(path.join(work,'AGENTS.md')))fs.writeFileSync(path.join(work,'AGENTS.md'),'# Existing project\nPreserve existing architecture, conventions, and working behavior. Follow REQUEST.md. Record changes and checks in BUILD_NOTES.md. Keep REQUEST.md, AGENTS.md, BUILD_PLAN.md, and REVIEW.md unchanged.\n');
    fs.writeFileSync(path.join(work,'BUILD_PLAN.md'),'# Existing-codebase changes\n\n## Requested work\n'+prompt+'\n\n## Steps\n1. Inspect the existing implementation and relevant project instructions.\n2. Implement the requested changes while preserving unrelated behavior.\n3. Run suitable existing checks and verify the changed behavior.\n\n## Acceptance\nThe request is fulfilled, existing behavior is preserved, and actual verification results and limitations are recorded in BUILD_NOTES.md.\n');
    fs.writeFileSync(path.join(work,'BUILD_CHECKLIST.md'),'# User guidance\n\n'+prompt+'\n\n## Checklist\n- [ ] Inspect the existing codebase, implement the requested changes, and verify the result.\n');
    state.role='BUILDER';state.builderMode='user';state.importedFrom=source;
    state.feedback='User reopened this project at BUILDER. Work on the imported codebase according to the original request; preserve existing functionality.';
    state.expected=snapshot(work);atomic(path.join(root,'state.json'),state);
    return state;
  } catch(error) {
    state.status='NEEDS_ATTENTION';state.feedback='Import failed: '+error.message;
    atomic(path.join(root,'state.json'),state);
    throw Error('Import failed; original source unchanged. Partial copy retained at '+root+': '+error.message);
  }
}
