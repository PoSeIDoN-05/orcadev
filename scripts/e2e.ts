// scripts/e2e.ts -- end-to-end check of the agent loop against a local mock of the
// Anthropic streaming API. Covers: SSE parsing, tool_use -> tool_result -> answer,
// the HTTP 429 error path, user stop, and the maxSteps guard. No network, no credentials.
// Run: node node_modules\esbuild\bin\esbuild scripts\e2e.ts --bundle --platform=node
//        --format=cjs --outfile=dist-test\e2e.cjs ; node dist-test\e2e.cjs
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Agent } from '../src/agent';
import { createClient } from '../src/client';
import { ToolHost } from '../src/tools';

const root = process.env.E2E_ROOT || process.cwd();
const MODEL = 'claude-sonnet-5-5';

let failures = 0;

function check(name: string, ok: boolean, extra?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : ' :: ' + String(extra).slice(0, 200)}`);
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function messageStart(model: string): unknown {
  return {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 1 }
    }
  };
}

function toolUseReply(res: http.ServerResponse, id: string, name: string, input: unknown): void {
  sse(res, 'message_start', messageStart(MODEL));
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} }
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 12 }
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function textReply(res: http.ServerResponse, text: string): void {
  sse(res, 'message_start', messageStart(MODEL));
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  });
  for (const chunk of text.match(/[\s\S]{1,4}/g) ?? []) {
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk }
    });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 9 }
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

interface Mock {
  port: number;
  bodies: any[];
  close: () => Promise<void>;
}

/** Starts a throwaway HTTP server that mimics POST /v1/messages (streaming SSE). */
function startMock(handler: (body: any, index: number, res: http.ServerResponse) => void): Promise<Mock> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore malformed */
      }
      const index = bodies.length;
      bodies.push(body);
      handler(body, index, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        bodies,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function makeAgent(port: number, maxSteps: number, sink: any[]): Agent {
  const host: ToolHost = { root: () => root, approve: async () => true, proxy: () => undefined };
  return new Agent(
    () => createClient({ apiKey: 'sk-ant-mock', baseURL: `http://127.0.0.1:${port}` }),
    host,
    () => ({ model: MODEL, maxTokens: 256, maxSteps, system: 'mock system prompt' }),
    (m) => sink.push(m)
  );
}



async function main(): Promise<void> {
  // 1. Full cycle: streamed tool_use -> tool runs for real -> tool_result -> streamed answer.
  const mock1 = await startMock((_body, index, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (index === 0) {
      toolUseReply(res, 'toolu_mock_1', 'read_file', { path: 'package.json', start_line: 1, end_line: 3 });
      return;
    }
    textReply(res, 'orcadev');
  });

  const events1: any[] = [];
  await makeAgent(mock1.port, 4, events1).send('Read package.json and reply with the package name.');
  const text1 = events1.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const tools1 = events1.filter((e) => e.type === 'tool_start').map((e) => e.name);
  const end1 = events1.filter((e) => e.type === 'tool_end');
  const usage1 = events1.filter((e) => e.type === 'usage');
  const errors1 = events1.filter((e) => e.type === 'error');

  check('streamed text is reassembled', text1.trim() === 'orcadev', text1.trim());
  check('model asked for read_file', tools1.includes('read_file'), tools1.join(',') || 'no tools');
  check(
    'tool ran and returned file content',
    end1.length === 1 && end1[0].ok === true && String(end1[0].text).includes('"name": "orcadev"'),
    end1[0] ? String(end1[0].text).split('\n')[0] : 'no tool_end'
  );
  check('usage reported per step', usage1.length === 2 && !!usage1[0].usage?.input_tokens, `steps=${usage1.length}`);
  check('cycle finished without errors', errors1.length === 0, errors1.map((e) => e.text).join('; '));
  check('two API calls in the loop', mock1.bodies.length === 2, `${mock1.bodies.length} calls`);

  const second = mock1.bodies[1] ?? {};
  const roles = (second.messages ?? []).map((m: any) => m.role).join(',');
  const resultBlock = (second.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b?.type === 'tool_result');
  check(
    'tool_result was sent back with real content',
    roles === 'user,assistant,user' &&
      resultBlock?.tool_use_id === 'toolu_mock_1' &&
      String(resultBlock?.content).includes('orcadev'),
    `${roles} | ${String(resultBlock?.content ?? '').split('\n')[0]}`
  );
  check(
    'system prompt and tools are on the wire',
    typeof second.system === 'string' && Array.isArray(second.tools) && second.tools.length >= 5,
    `${(second.tools ?? []).length} tools`
  );
  await mock1.close();


  // 2. HTTP 429 must surface as a readable error event, not a hang.
  const mock2 = await startMock((_body, _index, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'mock rate limit' } }));
  });
  const events2: any[] = [];
  await makeAgent(mock2.port, 2, events2).send('hi');
  const err2 = events2.filter((e) => e.type === 'error').map((e) => e.text).join('; ');
  check('HTTP 429 becomes an error event', /429/.test(err2) && /mock rate limit/.test(err2), err2);
  await mock2.close();

  // 3. Stop must abort the in-flight request and report it.
  const mock3 = await startMock((_body, _index, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'message_start', messageStart(MODEL));
    setTimeout(() => textReply(res, 'too late'), 3000);
  });
  const events3: any[] = [];
  const agent3 = makeAgent(mock3.port, 2, events3);
  const pending = agent3.send('slow request');
  setTimeout(() => agent3.stop(), 250);
  await pending;
  check(
    'stop emits "stopped" and no error',
    events3.some((e) => e.type === 'stopped') && !events3.some((e) => e.type === 'error'),
    events3.map((e) => e.type).join(',')
  );
  check('agent is idle again after stop', agent3.isBusy === false);
  await mock3.close();

  // 4. maxSteps guard stops runaway tool loops.
  const mock4 = await startMock((_body, index, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    toolUseReply(res, `toolu_mock_${index}`, 'list_dir', { path: '.', depth: 1 });
  });
  const events4: any[] = [];
  await makeAgent(mock4.port, 1, events4).send('loop forever');
  const err4 = events4.filter((e) => e.type === 'error').map((e) => e.text).join('; ');
  check('maxSteps guard fires after the limit', /Step limit reached/.test(err4) && mock4.bodies.length === 1, err4.slice(0, 80));
  await mock4.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
