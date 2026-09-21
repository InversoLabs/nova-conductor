import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
const { repairExecArguments, repairFunctionCalls, createSseRepair } = createRequire(import.meta.url)('../infrastructure/nova-codex-repairs.cjs');
const frame = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const events = text => text.split('\n\n').flatMap(block => {
  const line = block.split('\n').find(line => line.startsWith('data:'));
  return line && line.slice(5).trim() !== '[DONE]' ? [JSON.parse(line.slice(5))] : [];
});
const added = (id = 'one', name = 'exec_command', index = 0) => ({ type: 'response.output_item.added', output_index: index, item: { id, call_id: `call_${id}`, type: 'function_call', name, arguments: '' } });
const delta = (value, id = 'one') => ({ type: 'response.function_call_arguments.delta', item_id: id, delta: value });
const done = (args, id = 'one') => ({ type: 'response.function_call_arguments.done', item_id: id, arguments: args });
const options = report => ({ report, knownTools: ['exec_command', 'apply_patch'], repairPayload: (value, skipped) => repairFunctionCalls(value, report, skipped) });

test('proxy repairs optional metadata without changing commands, paths or explicit permissions', () => {
  const input = { cmd: 'node -e "console.log(\'$literal\')"', workdir: 'C:\\space dir\\café', yield_time_ms: 1000, justification: 'run a local test' };
  const reports = [];
  const repaired = JSON.parse(repairExecArguments(JSON.stringify(input), event => reports.push(event)));
  const { justification, ...expected } = input;
  assert.deepEqual(repaired, expected); assert.equal(reports.length, 1);
  for (const permissions of ['require_escalated', 'use_default', null]) {
    const raw = JSON.stringify({ ...input, sandbox_permissions: permissions });
    assert.equal(repairExecArguments(raw), raw);
  }
  for (const raw of ['{"cmd":', 'null', '[]', '"text"', JSON.stringify(expected)]) assert.equal(repairExecArguments(raw), raw);
  const duplicate = '{"cmd":"one","cmd":"two","justification":"why"}';
  assert.equal(repairExecArguments(duplicate), duplicate);
  const precise = '{"justification":"why", "cmd":"echo {,}", "unknown":9007199254740993}';
  assert.equal(repairExecArguments(precise), '{ "cmd":"echo {,}", "unknown":9007199254740993}');
});

test('proxy repairs fragmented SSE arguments consistently and streams keepalives', () => {
  const raw = JSON.stringify({ cmd: 'echo café', justification: 'why', workdir: 'C:\\project' });
  const reports = [], repair = createSseRepair(options(event => reports.push(event)));
  let output = repair.push(frame({ ...added(), sequence_number: 0 }));
  assert.equal(repair.push(frame({ ...delta(raw.slice(0, 13)), sequence_number: 1 })), '');
  assert.equal(repair.push(': heartbeat\n\n'), ': heartbeat\n\n');
  output += repair.push(frame({ type: 'response.output_text.delta', sequence_number: 2, delta: 'visible update' }));
  const tail = frame({ ...delta(raw.slice(13)), sequence_number: 3 }) + frame({ ...done(raw), sequence_number: 4 })
    + frame({ type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: { id: 'one', type: 'function_call', name: 'exec_command', arguments: raw } });
  for (const character of tail) output += repair.push(character);
  output += repair.end();
  const received = events(output), args = received.filter(e => e.type.endsWith('arguments.delta')).map(e => e.delta).join('');
  assert.deepEqual(JSON.parse(args), { cmd: 'echo café', workdir: 'C:\\project' });
  assert.equal(received.find(e => e.type.endsWith('arguments.done')).arguments, args);
  assert.equal(received.find(e => e.type === 'response.output_item.done').item.arguments, args);
  assert.deepEqual(received.map(e => e.sequence_number), [0, 1, 2, 3, 4]);
  assert.ok(reports.every(e => !('arguments' in e) && !('cmd' in e)));
});

test('proxy keeps interleaved calls separate and never guesses unknown tool names', () => {
  const reports = [], repair = createSseRepair(options(event => reports.push(event)));
  const first = '{"cmd":"first","justification":"test"}', second = '{"cmd":"second","sandbox_permissions":"require_escalated","justification":"test"}';
  const input = [added(), added('two', 'exec_command', 1), delta(first.slice(0, 10)), delta(second, 'two'), delta(first.slice(10)), done(second, 'two'), done(first), added('unknown', 'execinventory', 2), delta('{"cmd":"untouched"}', 'unknown')];
  const received = events(repair.push(input.map(frame).join('')) + repair.end());
  assert.deepEqual(JSON.parse(received.find(e => e.type.endsWith('arguments.done') && e.item_id === 'one').arguments), { cmd: 'first' });
  assert.equal(received.find(e => e.type.endsWith('arguments.done') && e.item_id === 'two').arguments, second);
  assert.equal(received.find(e => e.item?.id === 'unknown').item.name, 'execinventory');
  assert.ok(reports.some(e => e.rule === 'unsupported_tool_name' && e.repaired === false));
});

test('proxy preserves interrupted and oversized argument streams rather than guessing', () => {
  for (const partial of ['{"cmd":"unfinished', JSON.stringify({ cmd: 'x'.repeat(1024 * 1024), justification: 'test' })]) {
    const repair = createSseRepair(options(() => {}));
    const output = repair.push(frame(added()) + frame(delta(partial)) + frame({ type: 'error', message: 'interrupted' })) + repair.end();
    const received = events(output);
    assert.equal(received.find(e => e.type.endsWith('arguments.delta')).delta, partial);
    assert.equal(received.at(-1).type, 'error');
  }
});

test('proxy handles nonstream responses and terminal output without arguments.done', () => {
  const raw = '{"cmd":"node --test","justification":"test"}';
  const response = { type: 'response.completed', response: { output: [{ id: 'one', type: 'function_call', name: 'exec_command', arguments: raw }] } };
  assert.deepEqual(JSON.parse(repairFunctionCalls(structuredClone(response)).response.output[0].arguments), { cmd: 'node --test' });
  const repair = createSseRepair(options(() => {}));
  const received = events(repair.push(frame(added()) + frame(delta(raw)) + frame(response)) + repair.end());
  assert.deepEqual(JSON.parse(received.find(e => e.type.endsWith('arguments.delta')).delta), { cmd: 'node --test' });
  assert.equal(received.at(-1).type, 'response.completed');
});

test('existing proxy HTTP handler preserves keepalives and repairs streamed tool arguments', async () => {
  const raw = '{"cmd":"node --test","justification":"run tests"}';
  const source = frame(added()) + frame(delta(raw.slice(0, 11))) + ': keepalive\n\n' + frame(delta(raw.slice(11))) + frame(done(raw));
  let upstreamRequest, proxyServer;
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      upstreamRequest = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(source.slice(0, 29));
      setImmediate(() => response.end(source.slice(29)));
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxyFile = new URL('../infrastructure/nova-codex-proxy.js', import.meta.url);
  const localRequire = createRequire(proxyFile);
  const wrappedHttp = {
    createServer(handler) {
      proxyServer = http.createServer(handler);
      const listen = proxyServer.listen.bind(proxyServer);
      proxyServer.listen = (_port, _host, callback) => listen(0, '127.0.0.1', callback);
      return proxyServer;
    },
    request(options, callback) { return http.request({ ...options, host: '127.0.0.1', port: upstream.address().port }, callback); },
  };
  try {
    vm.runInNewContext(fs.readFileSync(proxyFile, 'utf8'), { require: name => name === 'http' ? wrappedHttp : localRequire(name), process: { argv: [] }, console: { log() {} }, Buffer, Set });
    await once(proxyServer, 'listening');
    const result = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], text: {}, stream: true, tools: [{ type: 'function', name: 'exec_command', parameters: {} }] }),
    });
    assert.equal(result.status, 200);
    const output = await result.text();
    assert.ok(output.includes(': keepalive'));
    const received = events(output);
    assert.deepEqual(JSON.parse(received.find(e => e.type.endsWith('arguments.delta')).delta), { cmd: 'node --test' });
    assert.equal(upstreamRequest.input[0].content[0].type, 'input_text');
    assert.equal(upstreamRequest.parallel_tool_calls, true);
    assert.ok(!Object.hasOwn(upstreamRequest, 'text'));
  } finally {
    proxyServer?.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([proxyServer ? new Promise(resolve => proxyServer.close(resolve)) : null, new Promise(resolve => upstream.close(resolve))]);
  }
});
