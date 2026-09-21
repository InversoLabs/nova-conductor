'use strict';

// Local Responses servers commonly accept function tools, but Codex's patch
// tool is freeform. Translate only this known contract in both directions.
function adaptRequest(body) {
  const model=String(body.model||'').toLowerCase().split('/').at(-1);
  const effort=body.reasoning?.effort;
  // GPT-OSS cannot disable thinking; Ornith has an on/off template, not tiers.
  // Unknown models retain their requested controls rather than guessing.
  if((model==='gpt-oss'||model.startsWith('gpt-oss:')) && ['minimal','none'].includes(effort))body.reasoning={...body.reasoning,effort:'low'};
  else if(model==='ornith-1.5:9b-text' && effort==='minimal')body.reasoning={...body.reasoning,effort:'none'};
  body.tools = (body.tools || []).map(tool => tool.type === 'custom' && tool.name === 'apply_patch' ? {
    type: 'function', name: 'apply_patch', description: tool.description,
    parameters: {type:'object',properties:{input:{type:'string',description:'The complete Codex patch text.'}},required:['input'],additionalProperties:false},
  } : tool);
  if (Array.isArray(body.input)) body.input = body.input.map(item => {
    if(item.type === 'custom_tool_call' && item.name === 'apply_patch') {
      const {input,...rest}=item;
      return {...rest,type:'function_call',arguments:JSON.stringify({input})};
    }
    if(item.type === 'custom_tool_call_output') return {...item,type:'function_call_output'};
    return item;
  });
  return body;
}
function patchInput(args) {
  const parsed=JSON.parse(args);
  if(typeof parsed.input !== 'string') throw Error('Provider apply_patch arguments must contain an input string');
  return parsed.input;
}
function adaptItem(item) {
  if(item?.type !== 'function_call' || item.name !== 'apply_patch') return item;
  const {arguments:args,...rest}=item;
  return {...rest,type:'custom_tool_call',input:args ? patchInput(args) : ''};
}
function adaptResponse(body) {
  if(Array.isArray(body.output))body.output=body.output.map(adaptItem);
  return body;
}
function createToolStream() {
  let pending='';
  const calls=new Map();
  const encode=value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  function frame(raw) {
    const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data || data==='[DONE]')return raw+'\n\n';
    let event;
    try{event=JSON.parse(data);}catch{return raw+'\n\n';}
    if(event.type==='response.output_item.added' && event.item?.type==='function_call' && event.item.name==='apply_patch') {
      calls.set(event.item.id,{args:event.item.arguments || '',sent:false});
      event.item={...event.item,type:'custom_tool_call',input:''};delete event.item.arguments;
    } else if(event.type==='response.function_call_arguments.delta' && calls.has(event.item_id)) {
      const call=calls.get(event.item_id);call.args+=event.delta;
      if(call.args.length>1024*1024)throw Error('Provider patch exceeded 1 MiB');
      return '';
    } else if(event.type==='response.function_call_arguments.done' && calls.has(event.item_id)) {
      const call=calls.get(event.item_id),input=patchInput(event.arguments || call.args);call.sent=true;
      const {arguments:args,...rest}=event;
      return encode({...rest,type:'response.custom_tool_call_input.delta',delta:input})+encode({...rest,type:'response.custom_tool_call_input.done',input});
    } else if(event.type==='response.output_item.done' && event.item?.type==='function_call' && event.item.name==='apply_patch') {
      const call=calls.get(event.item.id),item=adaptItem(event.item);
      const prefix=call && !call.sent ? encode({type:'response.custom_tool_call_input.delta',item_id:item.id,output_index:event.output_index,delta:item.input})+encode({type:'response.custom_tool_call_input.done',item_id:item.id,output_index:event.output_index,input:item.input}) : '';
      calls.delete(event.item.id);
      return prefix+encode({...event,item});
    } else if(event.response)adaptResponse(event.response);
    return encode(event);
  }
  return {
    push(chunk){pending+=chunk;pending=pending.replace(/\r\n/g,'\n');let out='',index;
      if(pending.length>2*1024*1024)throw Error('Provider SSE frame exceeded 2 MiB');
      while((index=pending.indexOf('\n\n'))>=0){out+=frame(pending.slice(0,index));pending=pending.slice(index+2);}return out;},
    end(){const out=pending ? frame(pending) : '';pending='';return out;},
  };
}
module.exports={adaptRequest,adaptResponse,createToolStream};
