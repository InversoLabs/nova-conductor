'use strict';

function repairAddFilePatch(text, report = () => {}) {
  if (typeof text !== 'string') return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let duplicateEnds=0;
  while(lines.at(-1)==='*** End Patch' && lines.at(-2)==='*** End Patch'){
    lines.pop();duplicateEnds++;
  }
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch' || !lines[1]?.startsWith('*** Add File: ')) return text;
  const file = lines[1].slice(14), body = lines.slice(2,-1);
  // Only one new relative file with wholly unprefixed content. Mixed valid
  // prefixes, multiple operations, and updates remain Codex's responsibility.
  if (!file || file.includes(':') || file.startsWith('/') || file.startsWith('\\') || file.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')) return text;
  if (!body.length || body.some(line=>line.startsWith('+') || line.startsWith('*** '))) return text;
  if(duplicateEnds)report({rule:'add_file_duplicate_end_marker',tool:'apply_patch'});
  report({rule:'add_file_missing_plus_prefixes',tool:'apply_patch'});
  return [lines[0],lines[1],...body.map(line=>'+'+line),lines.at(-1)].join('\n');
}

// Repair only a complete, recognized tool argument object. Never infer a
// command, rename a tool, or introduce/change a permission request.
function repairExecArguments(raw, report = () => {}) {
  if (typeof raw !== 'string') return raw;
  let args;
  try { args = JSON.parse(raw); } catch { return raw; }
  if (!args || Array.isArray(args) || typeof args !== 'object') return raw;
  if (!Object.hasOwn(args, 'justification') || Object.hasOwn(args, 'sandbox_permissions')) return raw;
  if (typeof args.cmd !== 'string') return raw;
  // Keep every other value byte-for-byte, including number precision and
  // quoting. Reject duplicate top-level keys rather than resolving ambiguity.
  const open = raw.indexOf('{'), members = [];
  let depth = 0, start = open + 1, close;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '"') { for (i++; i < raw.length; i++) { if (raw[i] === '\\') i++; else if (raw[i] === '"') break; } }
    else if (raw[i] === '{' || raw[i] === '[') depth++;
    else if (raw[i] === '}' && depth === 0) { members.push(raw.slice(start, i)); close = i; break; }
    else if (raw[i] === '}' || raw[i] === ']') depth--;
    else if (raw[i] === ',' && depth === 0) { members.push(raw.slice(start, i)); start = i + 1; }
  }
  const names = new Set(), kept = [];
  for (const member of members) {
    const match = /^\s*("(?:\\.|[^"\\])*")\s*:/.exec(member);
    if (!match) return raw;
    const name = JSON.parse(match[1]);
    if (names.has(name)) return raw;
    names.add(name);
    if (name !== 'justification') kept.push(member);
  }
  if (close === undefined) return raw;
  report({ rule: 'exec_justification_without_permission_mode', tool: 'exec_command' });
  return raw.slice(0, open + 1) + kept.join(',') + raw.slice(close);
}

function repairFunctionCalls(value, report, skipped = new Set()) {
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'function_call' && value.name === 'exec_command' && !skipped.has(value.id) && !skipped.has(value.call_id)) {
    value.arguments = repairExecArguments(value.arguments, report);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') repairFunctionCalls(child, report, skipped);
  }
  return value;
}

// Function arguments arrive in arbitrary fragments. Withhold only recognized
// exec_command argument deltas until a complete argument object is available.
// Other events (including keepalives) continue immediately. If a stream ends
// early or exceeds the buffer limit, preserve its original fragments unchanged.
function createSseRepair({ repairPayload = value => value, report = () => {}, knownTools = [] } = {}) {
  let pending = '', lines = [], sequence = 0;
  const calls = new Map(), known = new Set(knownTools);
  const skipped = new Set();
  const lookup = data => calls.get(data.item_id) || calls.get(data.item?.id) || calls.get(data.call_id) || calls.get(`index:${data.output_index}`);
  const encode = data => {
    if (Number.isInteger(data.sequence_number)) data = { ...data, sequence_number: sequence++ };
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  };
  const decode = original => JSON.parse(original.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
  function flush(call, raw, completed) {
    if (!call || call.closed) return '';
    call.closed = true;
    if (!completed) {
      if (call.id) skipped.add(call.id);
      if (call.callId) skipped.add(call.callId);
      return call.frames.map(original => encode(decode(original))).join('');
    }
    const original = typeof raw === 'string' ? raw : call.parts.join('');
    const repaired = call.patch ? repairPayload({type:'custom_tool_call',name:'apply_patch',input:original}).input : repairExecArguments(original, report);
    if (!call.frames.length && !original) return '';
    const first = call.first || { type: call.patch ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: call.id, output_index: call.index };
    return encode({ ...first, delta: repaired });
  }
  function frame(original) {
    const dataLines = original.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (!dataLines.length) return original;
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return original; }
    if (data.type === 'response.output_item.added' && ['function_call','custom_tool_call'].includes(data.item?.type)) {
      const item = data.item;
      if (known.size && !known.has(item.name)) report({ rule: 'unsupported_tool_name', tool: String(item.name).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100), repaired: false });
      if (item.name === 'exec_command' || (item.type==='custom_tool_call' && item.name==='apply_patch')) {
        const patch=item.type==='custom_tool_call', initial=patch?item.input:item.arguments;
        const call = { patch, id: item.id, callId: item.call_id, index: data.output_index, parts: [], frames: [], bytes: 0, closed: !!initial };
        if (initial) { if (item.id) skipped.add(item.id); if (item.call_id) skipped.add(item.call_id); }
        if (item.id) calls.set(item.id, call);
        if (item.call_id) calls.set(item.call_id, call);
        calls.set(`index:${data.output_index}`, call);
      }
    }
    const call = lookup(data);
    if (['response.function_call_arguments.delta','response.custom_tool_call_input.delta'].includes(data.type) && call && !call.closed) {
      call.frames.push(original); call.parts.push(data.delta || ''); call.bytes += Buffer.byteLength(original);
      call.first ||= data;
      if (call.bytes > 1024 * 1024) return flush(call, null, false);
      return '';
    }
    let prefix = '';
    if (['response.function_call_arguments.done','response.custom_tool_call_input.done'].includes(data.type) && call) {
      if (!call.closed) {
        prefix = flush(call, call.patch?data.input:data.arguments, true);
        if(call.patch)data.input=repairPayload({type:'custom_tool_call',name:'apply_patch',input:data.input}).input;
        else data.arguments = repairExecArguments(data.arguments);
      }
    } else if (data.type === 'response.output_item.done' && call && !call.closed) {
      prefix = flush(call, call.patch?data.item?.input:data.item?.arguments, true);
    }
    if (data.type === 'response.completed') {
      for (const state of new Set(calls.values())) {
        const item = data.response?.output?.find(item => item.id === state.id || (state.callId && item.call_id === state.callId));
        const raw=state.patch?item?.input:item?.arguments;
        prefix += flush(state, raw, typeof raw === 'string');
      }
    }
    if (data.type === 'response.failed' || data.type === 'response.incomplete' || data.type === 'error') {
      for (const state of new Set(calls.values())) prefix += flush(state, null, false);
    }
    return prefix + encode(repairPayload(data, skipped));
  }
  return {
    push(chunk) {
      pending += chunk;
      let output = '', at;
      while ((at = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, at).replace(/\r$/, ''); pending = pending.slice(at + 1);
        if (line) lines.push(line);
        else { output += frame(lines.join('\n') + '\n\n'); lines = []; }
      }
      return output;
    },
    end() {
      let output = '';
      for (const state of new Set(calls.values())) output += flush(state, null, false);
      if (pending || lines.length) output += [...lines, pending].join('\n');
      pending = ''; lines = [];
      return output;
    },
  };
}

module.exports = { repairExecArguments, repairFunctionCalls, createSseRepair, repairAddFilePatch };
