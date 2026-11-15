// tools.ts -- the tools the agent can call, and their executor.
// Every path is forced to stay inside the workspace root; anything that mutates
// disk or runs a process asks the user first (see ToolHost.approve).
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export interface DiffPreview {
  file: string;
  before: string;
  after: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  diff?: DiffPreview;
}

export interface ToolHost {
  root(): string;
  approve(req: ApprovalRequest): Promise<boolean>;
  proxy(): string | undefined;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode-test', 'coverage', '.cache'
]);

const MAX_READ_CHARS = 60_000;
const MAX_GREP_RESULTS = 200;
const MAX_FETCH_CHARS = 20_000;

export const TOOLS: any[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace. Returns lines prefixed with 1-based line numbers. ' +
      'Use start_line/end_line for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root, e.g. src/index.ts' },
        start_line: { type: 'integer', description: 'Optional 1-based first line' },
        end_line: { type: 'integer', description: 'Optional 1-based last line' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_dir',
    description: 'List files and directories under a path (node_modules, .git, dist are skipped).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root; default "."' },
        depth: { type: 'integer', description: 'Recursion depth, default 2, max 5' }
      },
      required: []
    }
  },
  {
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression. Returns path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'Directory to search, default "."' },
        glob: { type: 'string', description: 'Optional file-name substring filter, e.g. ".ts"' },
        max_results: { type: 'integer', description: 'Default 100, max 200' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or fully overwrite a workspace file with the given content. The user is shown a diff first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        content: { type: 'string', description: 'Full new file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root (PowerShell on Windows, bash elsewhere). ' +
      'The user approves it first. Returns stdout, stderr and the exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute' },
        timeout_sec: { type: 'integer', description: 'Default 120, max 600' }
      },
      required: ['command']
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return readable text (HTML tags and scripts stripped).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url']
    }
  }
];

// ---------- helpers ----------

function resolveInRoot(root: string, p?: string): string {
  const abs = path.resolve(root, p && p.length ? p : '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`);
  }
  return abs;
}

function toInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function walk(
  dir: string,
  depth: number,
  visit: (file: string, rel: string, isDir: boolean) => void,
  root: string,
  glob?: string
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      visit(abs, rel, true);
      if (depth > 1) walk(abs, depth - 1, visit, root, glob);
    } else if (e.isFile()) {
      if (glob && !e.name.includes(glob)) continue;
      visit(abs, rel, false);
    }
  }
}

// ---------- read_file ----------

function readFile(root: string, input: any): string {
  const abs = resolveInRoot(root, input.path);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${input.path}`);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error(`${input.path} is a directory, use list_dir`);
  if (st.size > 2 * 1024 * 1024) throw new Error(`file too large (${st.size} bytes), read a line range`);

  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const start = toInt(input.start_line, 1, 1, lines.length || 1);
  const end = toInt(input.end_line, lines.length, start, lines.length || 1);
  const slice = lines.slice(start - 1, end);

  let out = slice.map((l, i) => `${String(start + i).padStart(6)}  ${l}`).join('\n');
  if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + '\n... [truncated by OrcaDev]';
  return out || '(empty file)';
}

// ---------- list_dir ----------

function listDir(root: string, input: any): string {
  const abs = resolveInRoot(root, input.path);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${input.path}`);
  const depth = toInt(input.depth, 2, 1, 5);
  const rows: string[] = [];
  walk(abs, depth, (_abs, rel, isDir) => rows.push(isDir ? rel + '/' : rel), root);
  rows.sort();
  const shown = rows.slice(0, 500);
  const more = rows.length > shown.length ? `\n... and ${rows.length - shown.length} more` : '';
  return (shown.join('\n') || '(empty)') + more;
}

// ---------- grep ----------

function grep(root: string, input: any): string {
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('pattern is required');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'm');
  } catch (e: any) {
    throw new Error(`invalid regex: ${e.message}`);
  }
  const abs = resolveInRoot(root, input.path);
  const limit = toInt(input.max_results, 100, 1, MAX_GREP_RESULTS);
  const glob = input.glob ? String(input.glob) : undefined;
  const hits: string[] = [];

  walk(abs, 8, (file, rel, isDir) => {
    if (isDir) return;
    if (hits.length >= limit) return;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size > 1024 * 1024) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text.indexOf('\u0000') !== -1) return; // binary
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 400)}`);
        re.lastIndex = 0;
      }
    }
  }, root, glob);

  if (!hits.length) return 'no matches';
  const more = hits.length >= limit ? `\n... stopped at ${limit} matches` : '';
  return hits.join('\n') + more;
}

// ---------- write_file ----------

async function writeFile(root: string, input: any, host: ToolHost): Promise<string> {
  const rel = String(input.path ?? '');
  if (!rel) throw new Error('path is required');
  const abs = resolveInRoot(root, rel);
  const content = String(input.content ?? '');

  let before = '';
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`${rel} is a directory`);
    if (st.size <= 2 * 1024 * 1024) before = fs.readFileSync(abs, 'utf8');
  }

  const ok = await host.approve({
    id: `write-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tool: 'write_file',
    title: `Write ${rel}`,
    detail: `${before ? 'overwrite' : 'create'} · ${content.split(/\r?\n/).length} lines · ${content.length} chars`,
    diff: { file: rel, before, after: content }
  });
  if (!ok) return 'DENIED by the user: the file was not written.';

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return `wrote ${content.length} chars to ${rel}`;
}

// ---------- run_command ----------

async function runCommand(root: string, input: any, host: ToolHost): Promise<string> {
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('command is required');

  const ok = await host.approve({
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tool: 'run_command',
    title: 'Run command',
    detail: command
  });
  if (!ok) return 'DENIED by the user: the command was not executed.';

  const timeout = toInt(input.timeout_sec, 120, 5, 600) * 1000;
  return await new Promise<string>((resolve) => {
    cp.exec(
      command,
      {
        cwd: root,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      },
      (err: any, stdout: string, stderr: string) => {
        const parts: string[] = [];
        if (stdout && stdout.trim()) parts.push(stdout.trim());
        if (stderr && stderr.trim()) parts.push('--- stderr ---\n' + stderr.trim());
        parts.push(`--- exit code: ${err ? (err.code ?? 1) : 0}${err && err.killed ? ' (timeout, killed)' : ''} ---`);
        let out = parts.join('\n');
        if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + '\n... [truncated by OrcaDev]';
        resolve(out);
      }
    );
  });
}

// ---------- web_fetch ----------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|code)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function webFetch(input: any, host: ToolHost): Promise<string> {
  const url = String(input.url ?? '');
  if (!/^https?:\/\//i.test(url)) throw new Error('only absolute http(s) URLs are allowed');

  const init: any = { redirect: 'follow', headers: { 'user-agent': 'OrcaDev/0.2' } };
  const proxy = host.proxy();
  if (proxy) init.dispatcher = new ProxyAgent(proxy);

  const res = await undiciFetch(url, init);
  const raw = await res.text();
  const plain = stripHtml(raw);
  const body = plain.length > MAX_FETCH_CHARS ? plain.slice(0, MAX_FETCH_CHARS) + '\n... [truncated]' : plain;
  return `HTTP ${res.status} ${res.statusText}\n${body}`;
}

// ---------- dispatcher ----------

export async function runTool(name: string, input: any, host: ToolHost): Promise<string> {
  const root = host.root();
  const args = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'read_file':
      return readFile(root, args);
    case 'list_dir':
      return listDir(root, args);
    case 'grep':
      return grep(root, args);
    case 'write_file':
      return writeFile(root, args, host);
    case 'run_command':
      return runCommand(root, args, host);
    case 'web_fetch':
      return webFetch(args, host);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
