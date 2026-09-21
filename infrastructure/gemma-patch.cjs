'use strict';
const {randomUUID}=require('node:crypto');
const LIMIT=1024*1024;

// Only the observed Gemma E2B models, and only an explicitly available native
// patch tool. This never interprets prose, shell commands, or fenced examples.
function enabled(request={}) {
  const model=String(request.model||'').toLowerCase().split('/').at(-1);
  const choice=request.tool_choice;
  return ['gemma4:e2b-it-qat','gemma4:e2b'].includes(model)
    && (choice===undefined || choice==='auto' || choice==='required' || (choice?.type==='custom' && choice.name==='apply_patch'))
    && request.tools?.some(t=>t.type==='custom' && t.name==='apply_patch');
}
function parsePatch(text) {
  if(typeof text!=='string' || Buffer.byteLength(text)>LIMIT/2)return null;
  const lines=text.trim().replace(/\r\n/g,'\n').split('\n');
  if(lines.shift()!=='*** Begin Patch' || lines.pop()!=='*** End Patch')return null;
  const output=['*** Begin Patch'],paths=new Set();let inFile=false,bodyLines=0;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    // Observed output closes each file but omits the next Begin Patch.
    // Merge these Add File sections without altering any file content.
    if(line==='*** End Patch') {
      if(!inFile || !bodyLines)return null;
      if(lines[i+1]==='*** Begin Patch')i++;
      if(!lines[i+1]?.startsWith('*** Add File: '))return null;
      continue;
    }
    if(line.startsWith('*** Add File: ')) {
      if(inFile && !bodyLines)return null;
      const path=line.slice(14);
      if(!path || path.trim()!==path || /[\x00-\x1f:]/.test(path) || path.startsWith('/') || path.startsWith('\\') || path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..') || paths.has(path.toLowerCase()))return null;
      paths.add(path.toLowerCase());inFile=true;bodyLines=0;output.push(line);continue;
    }
    if(!inFile || !line.startsWith('+'))return null;
    bodyLines++;output.push(line);
  }
  return inFile && bodyLines ? [...output,'*** End Patch'].join('\n') : null;
}
function promote(response,request,report=()=>{}) {
  if(!enabled(request) || response?.status!=='completed' || response.error || response.incomplete_details || !Array.isArray(response.output))return null;
  if(response.output.some(i=>!['message','reasoning'].includes(i.type)))return null;
  const messages=response.output.filter(i=>i.type==='message');
  if(messages.length!==1)return null;
  const message=messages[0];
  if(message.role!=='assistant' || !message.content?.length || message.content.some(p=>p.type!=='output_text'))return null;
  const input=parsePatch(message.content.map(p=>p.text).join(''));
  if(!input)return null;
  const item={type:'custom_tool_call',id:'ctc_'+randomUUID().replaceAll('-',''),call_id:'call_'+randomUUID().replaceAll('-',''),name:'apply_patch',input,status:'completed'};
  const index=response.output.indexOf(message);
  report({rule:'gemma_bare_add_file_patch',tool:'apply_patch',repaired:true});
  return {item,index,response:{...response,output:response.output.map(i=>i===message?item:i)}};
}
function createGemmaPatchStream(request,report=()=>{}) {
  if(!enabled(request))return {push:chunk=>chunk,end:()=>''};
  let pending='',held=[],bytes=0,sequence=0,bypass=false,terminal=false;
  const encode=e=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:sequence++})}\n\n`;
  const flush=()=>{const out=held.map(encode).join('');held=[];bytes=0;return out;};
  function frame(raw) {
    const payload=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    let e;try{e=JSON.parse(payload);}catch{return raw+'\n\n';}
    if(terminal || bypass)return encode(e);
    if(e.type==='response.completed') {
      terminal=true;const result=promote(e.response,request,report);
      if(!result)return flush()+encode(e);
      held=[];
      const {item,index}=result,base={item_id:item.id,output_index:index};
      return encode({type:'response.output_item.added',output_index:index,item:{...item,input:'',status:'in_progress'}})
        +encode({type:'response.custom_tool_call_input.delta',...base,delta:item.input})
        +encode({type:'response.custom_tool_call_input.done',...base,input:item.input})
        +encode({type:'response.output_item.done',output_index:index,item})
        +encode({...e,response:result.response});
    }
    if(['response.failed','response.incomplete','error'].includes(e.type)) {terminal=true;return flush()+encode(e);}
    if(e.item && !['message','reasoning'].includes(e.item.type)) {bypass=true;return flush()+encode(e);}
    if(e.item?.type==='message' || /^response\.(output_text|content_part|refusal)\./.test(e.type)) {
      held.push(e);bytes+=Buffer.byteLength(raw);
      if(bytes>LIMIT){bypass=true;return flush();}
      return '';
    }
    return encode(e);
  }
  return {
    push(chunk){pending+=chunk;let out='',match;while((match=/\r?\n\r?\n/.exec(pending))){const raw=pending.slice(0,match.index).replace(/\r\n/g,'\n');pending=pending.slice(match.index+match[0].length);out+=frame(raw);}if(pending.length>LIMIT){bypass=true;out+=flush()+pending;pending='';}return out;},
    end(){const out=flush()+pending;pending='';return out;}
  };
}
module.exports={enabled,parsePatch,promote,createGemmaPatchStream};
