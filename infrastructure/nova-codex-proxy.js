const http = require('http');
const { repairExecArguments, createSseRepair, repairAddFilePatch } = require('./nova-codex-repairs.cjs');

function reportRepair(event) {
  // Metadata only: never persist command arguments, prompts or authorization.
  console.log(JSON.stringify({ at: new Date().toISOString(), type: 'nova.compatibility', ...event }));
}

const listenHost = '127.0.0.1';
const listenPort = 8788;
const upstreamHost = '192.168.86.51';
const upstreamPort = 8787;

function normalizePatch(value) {
  if (typeof value !== 'string') return value;
  let text = value.trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    const lines = text.split(/\r?\n/);
    text = lines.slice(1, -1).join('\n').trim();
  }
  if (text.startsWith('*** Begin Patch')) return repairAddFilePatch(text, reportRepair);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 4 || lines[0].trim() !== '---' || lines[2].trim() !== '+++') return text;
  const match = /^new file:\s*(.+)$/i.exec(lines[1].trim());
  if (!match) return text;
  const filename = match[1].trim().replace(/\\/g, '/');
  const parts = filename.split('/');
  if (!filename || filename.startsWith('/') || filename.includes(':') || parts.some((part) => !part || part === '.' || part === '..')) return text;
  const body = lines.slice(3);
  if (!body.every((line) => !line || line.startsWith('+'))) return text;
  return ['*** Begin Patch', `*** Add File: ${filename}`, ...body.map((line) => line.startsWith('+') ? line : '+'), '*** End Patch'].join('\n');
}

function repairPayload(value, skipped = new Set()) {
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'function_call' && value.name === 'exec_command' && !skipped.has(value.id) && !skipped.has(value.call_id)) value.arguments = repairExecArguments(value.arguments, reportRepair);
  if (value.type === 'custom_tool_call' && value.name === 'apply_patch' && !skipped.has(value.id) && !skipped.has(value.call_id)) value.input = normalizePatch(value.input);
  if (value.type === 'response.custom_tool_call_input.done' && !skipped.has(value.item_id)) value.input = normalizePatch(value.input);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') repairPayload(child, skipped);
  }
  return value;
}

function repairDataLine(line) {
  if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return line;
  try {
    const value = JSON.parse(line.slice(5).trim());
    return `data: ${JSON.stringify(repairPayload(value))}`;
  } catch {
    return line;
  }
}

// Codex sometimes emits the Chat Completions-style `text` content part in a
// Responses request. The NOVA bridge accepts the Responses spelling,
// `input_text`, so normalize only the request input tree before forwarding.
function normalizeResponsesInput(value) {
  if (Array.isArray(value)) return value.map(normalizeResponsesInput);
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (copy.type === 'text') copy.type = 'input_text';
  for (const [key, child] of Object.entries(copy)) copy[key] = normalizeResponsesInput(child);
  return copy;
}

const patchContract = [
  'For apply_patch, input must use Codex patch grammar exactly.',
  'The first line must be *** Begin Patch and the final line must be *** End Patch.',
  'For a new file, use: *** Add File: relative/path.ext followed by content lines beginning with +.',
  'For an existing file, use: *** Update File: relative/path.ext with a valid @@ hunk.',
  'Never use Git headers such as ---, +++, /dev/null, new file:, or a bare @@ marker.',
].join(' ');

function strengthenRequest(value) {
  if (!value || typeof value !== 'object') return value;
  // Codex 0.155 adds the optional Responses `text` configuration object.
  // NOVA's current bridge rejects that top-level field, and the local models
  // do not require it, so omit it before forwarding.
  delete value.text;
  // NOVA serializes inference at the bridge. Ollama rejects an explicit false
  // capability flag even though the model can still choose one tool at a time.
  value.parallel_tool_calls = true;
  if (Object.prototype.hasOwnProperty.call(value, 'input')) value.input = normalizeResponsesInput(value.input);
  value.instructions = `${String(value.instructions || '').trim()}\n\n${patchContract}`.trim();
  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      if (tool && tool.type === 'custom' && tool.name === 'apply_patch') tool.description = patchContract;
    }
  }
  return value;
}

if (process.argv.includes('--self-test')) {
  const malformed = '---\nnew file: novadrift/index.html\n+++\n+<h1>NOVA DRIFT</h1>\n+';
  const expected = '*** Begin Patch\n*** Add File: novadrift/index.html\n+<h1>NOVA DRIFT</h1>\n+\n*** End Patch';
  if (normalizePatch(malformed) !== expected) throw new Error('Patch repair self-test failed.');
  if (normalizePatch('---\nnew file: ../outside.txt\n+++\n+bad') !== '---\nnew file: ../outside.txt\n+++\n+bad') throw new Error('Unsafe path self-test failed.');
  const strengthened = strengthenRequest({ instructions: 'Build it.', tools: [{ type: 'custom', name: 'apply_patch' }] });
  if (strengthened.parallel_tool_calls !== true || !strengthened.instructions.includes('*** Begin Patch') || !strengthened.tools[0].description.includes('Never use Git headers')) throw new Error('Request strengthening self-test failed.');
  const normalized = strengthenRequest({ input: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  if (normalized.input[0].content[0].type !== 'input_text') throw new Error('Responses content normalization self-test failed.');
  const withoutTextConfig = strengthenRequest({ text: { format: { type: 'text' } }, input: 'hello' });
  if (Object.prototype.hasOwnProperty.call(withoutTextConfig, 'text')) throw new Error('Unsupported Responses text field self-test failed.');
  const streamRepair = createSseRepair({ repairPayload });
  const patchEvent = { type: 'response.custom_tool_call_input.done', item_id: 'patch-test', input: malformed };
  const streamedPatch = streamRepair.push(`event: ${patchEvent.type}\ndata: ${JSON.stringify(patchEvent)}\n\n`) + streamRepair.end();
  const patchedEvent = JSON.parse(streamedPatch.split('\n').find(line => line.startsWith('data:')).slice(5));
  if (patchedEvent.input !== expected) throw new Error('Streaming patch repair regression.');
  console.log('NOVA Codex proxy self-test passed.');
  process.exit(0);
}

const server = http.createServer((request, response) => {
  let knownTools = [];
  const forward = (requestBody) => {
    const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
    if (requestBody) headers['content-length'] = Buffer.byteLength(requestBody);
    const upstream = http.request({ host: upstreamHost, port: upstreamPort, method: request.method, path: request.url, headers }, (remote) => {
    const outgoingHeaders = { ...remote.headers };
    delete outgoingHeaders['content-length'];
    response.writeHead(remote.statusCode || 502, outgoingHeaders);
    const contentType = String(remote.headers['content-type'] || '');
    if (contentType.includes('text/event-stream')) {
      const repair = createSseRepair({ repairPayload, report: reportRepair, knownTools });
      remote.setEncoding('utf8');
      remote.on('data', (chunk) => {
        const output = repair.push(chunk);
        if (output) response.write(output);
      });
      remote.on('end', () => { response.end(repair.end()); });
      return;
    }
    const chunks = [];
    remote.on('data', (chunk) => chunks.push(chunk));
    remote.on('end', () => {
      const body = Buffer.concat(chunks);
      if (contentType.includes('application/json')) {
        try { return response.end(JSON.stringify(repairPayload(JSON.parse(body.toString('utf8'))))); } catch {}
      }
      response.end(body);
    });
    });
    // Ctrl+C closes Codex's downstream request. Propagate that disconnect to
    // NOVA immediately so its streaming response closes and Ollama cancels the
    // active generation instead of continuing invisibly in the background.
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.on('error', (error) => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `NOVA-SERVER unavailable: ${error.message}`, code: 'nova_unavailable' } }));
    });
    if (requestBody) upstream.end(requestBody); else request.pipe(upstream);
  };

  if (request.method === 'POST' && request.url === '/v1/responses') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        knownTools = (body.tools || []).map(tool => tool.name).filter(Boolean);
        forward(JSON.stringify(strengthenRequest(body)));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Invalid Responses request: ${error.message}` } }));
      }
    });
    return;
  }
  forward(null);
});

server.listen(listenPort, listenHost, () => console.log(`NOVA Codex compatibility proxy: http://${listenHost}:${listenPort}`));
