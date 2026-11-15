// scripts/smoke.ts -- offline smoke test for the tool layer + optional live model list.
// Run: node node_modules\esbuild\bin\esbuild scripts\smoke.ts --bundle --platform=node
//        --format=cjs --outfile=%TEMP%\smoke.cjs ; node %TEMP%\smoke.cjs
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTool, ToolHost } from '../src/tools';
import { createClient, fetchModels, listModels } from '../src/client';
import { Agent } from '../src/agent';
import { buildSystemPrompt } from '../src/prompt';

const root = process.env.SMOKE_ROOT || process.cwd();

const host: ToolHost = {
  root: () => root,
  approve: async () => true,
  proxy: () => process.env.SMOKE_PROXY || undefined
};

let failures = 0;

function check(name: string, ok: boolean, extra?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : ' :: ' + String(extra).slice(0, 160)}`);
}

async function main(): Promise<void> {
  const firstLines = await runTool('read_file', { path: 'package.json', start_line: 1, end_line: 3 }, host);
  check('read_file returns numbered lines', firstLines.includes('"name": "orcadev"'), firstLines.split('\n')[0]);

  const listing = await runTool('list_dir', { path: '.', depth: 2 }, host);
  check(
    'list_dir lists dirs and files',
    listing.includes('src/') && listing.includes('src/extension.ts') && listing.includes('media/main.js') && !listing.includes('node_modules'),
    listing.split('\n').length + ' rows'
  );

  const grep = await runTool('grep', { pattern: '"name": "orcadev"', glob: '.json', max_results: 5 }, host);
  check('grep finds package.json name', /^package\.json:\d+:/m.test(grep) && !grep.includes('node_modules'), grep.split('\n')[0]);

  let escaped = false;
  try {
    await runTool('read_file', { path: '../package.json' }, host);
  } catch (e: any) {
    escaped = /escapes the workspace/.test(String(e?.message));
  }
  check('path traversal is rejected', escaped);

  await runTool('write_file', { path: '.smoke-out.txt', content: 'hello smoke\n' }, host);
  const back = await runTool('read_file', { path: '.smoke-out.txt' }, host);
  check('write_file then read_file round-trip', back.includes('hello smoke'));
  fs.unlinkSync(path.join(root, '.smoke-out.txt'));

  const cmd = await runTool('run_command', { command: 'Write-Output smoke-ok', timeout_sec: 20 }, host);
  check('run_command executes and reports exit code', /smoke-ok/.test(cmd) && /exit code: 0/.test(cmd), cmd.split('\n')[0]);

  // Optional live check: proxy + credential, no generation requested.
  const cfg = {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
    baseURL: 'https://api.anthropic.com',
    proxy: process.env.SMOKE_PROXY || undefined
  };
  if (cfg.apiKey) {
    try {
      const ids = await fetchModels(cfg);
      check('live /v1/models through proxy', ids.length > 0, ids.slice(0, 5).join(', '));
    } catch (e: any) {
      check('live /v1/models through proxy', false, e?.message || String(e));
    }
  } else {
    console.log('SKIP  live /v1/models (set ANTHROPIC_API_KEY to enable)');
  }

  const fallback = await listModels({ apiKey: 'sk-ant-bogus', baseURL: 'https://api.anthropic.com' });
  check('listModels falls back to a default list', fallback.length > 0, fallback[0]);

  // Optional end-to-end: real model call that must use the read_file tool.
  if (cfg.apiKey && process.env.SMOKE_LIVE === '1') {
    const events: any[] = [];
    const agent = new Agent(
      () => createClient(cfg),
      { ...host, approve: async () => true },
      () => ({
        model: process.env.SMOKE_MODEL || 'claude-sonnet-5-5',
        maxTokens: 512,
        maxSteps: 4,
        system: buildSystemPrompt('', root, 'orcadev')
      }),
      (m) => events.push(m)
    );
    const started = Date.now();
    await agent.send('Read package.json with read_file and reply with only the package name, nothing else.');
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    const tools = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    const errors = events.filter((e) => e.type === 'error').map((e) => e.text);
    check('live agent used read_file', tools.includes('read_file'), tools.join(',') || 'no tools');
    check('live agent answered with the package name', /orcadev/.test(text), text.trim().slice(0, 120));
    check('live agent finished without errors', errors.length === 0, errors.join('; ') || `done in ${Date.now() - started}ms`);
  } else {
    console.log('SKIP  live agent run (set SMOKE_LIVE=1 with a token to enable)');
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
