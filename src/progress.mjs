const handoffs=new Set(['REQUEST.md','AGENTS.md','BUILD_PLAN.md','BUILD_NOTES.md','BUILD_CHECKLIST.md','REVIEW.md']);
export function interruptBeforeRecovery(connection,active){
  if(!active)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);connection.off('notice',notice);resolve();};
    const notice=e=>{if(e.method==='turn/completed' && e.params?.threadId===active.threadId && e.params?.turn?.id===active.turnId)done();};
    const timer=setTimeout(done,5000);
    connection.on('notice',notice);
    connection.request('turn/interrupt',active).catch(done);
  });
}
export const productSignature=files=>JSON.stringify(Object.entries(files).filter(([name])=>!handoffs.has(name)).sort(([a],[b])=>a.localeCompare(b)));
export class BuilderProgress {
  constructor(files,config,now=Date.now()){
    this.signature=productSignature(files);this.lastTool=this.lastChange=now;
    this.idleMs=config.builderIdleMs??240000;this.noChangeMs=config.builderNoChangeMs??480000;
    this.tools=new Set();this.paused=false;
  }
  notice(event,now=Date.now()){
    const p=event.params;
    if(event.method==='turn/completed' && p.turn.status==='interrupted'){this.paused=true;this.tools.clear();}
    if(event.method==='turn/started'){this.paused=false;this.lastTool=this.lastChange=now;this.tools.clear();}
    const item=p?.item;
    if(!item || !['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch'].includes(item.type))return;
    if(event.method==='item/started')this.tools.add(item.id);
    if(event.method==='item/completed')this.tools.delete(item.id);
    this.lastTool=now;
  }
  check(files,now=Date.now()){
    const signature=productSignature(files);
    if(signature!==this.signature){this.signature=signature;this.lastChange=now;this.lastTool=now;}
    if(this.paused || this.tools.size){this.lastTool=this.lastChange=now;return null;}
    if(now-this.lastTool>=this.idleMs)return 'no tool activity';
    if(now-this.lastChange>=this.noChangeMs)return 'no product-file changes';
    return null;
  }
}
