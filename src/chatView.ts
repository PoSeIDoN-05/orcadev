// chatView.ts -- the webview panel: renders the conversation, collects approvals.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from './agent';
import { createClient } from './client';
import { buildSystemPrompt } from './prompt';
import { ApprovalRequest, DiffPreview, ToolHost } from './tools';

export interface Auth {
  apiKey?: string;
}

export class ChatView implements vscode.WebviewViewProvider, ToolHost {
  public static readonly viewType = 'orcaDev.chat';

  private view?: vscode.WebviewView;
  private client?: Anthropic;
  private agent?: Agent;
  private pending = new Map<string, (ok: boolean) => void>();
  private approveAll = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getAuth: () => Promise<Auth>
  ) {}

  // ---------- webview bootstrap ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    void this.refresh(true);
  }

  /** Recreates the client/agent (after a settings or credential change). */
  async refresh(resetConversation = false): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('orcaDev');
    const auth = await this.getAuth();
    const model = cfg.get<string>('model') || 'claude-sonnet-5-5';

    this.client = createClient({
      apiKey: auth.apiKey,
      baseURL: cfg.get<string>('baseUrl') || 'https://api.anthropic.com',
      proxy: cfg.get<string>('proxy') || undefined
    });

    if (!this.agent || resetConversation) {
      this.agent = new Agent(
        () => this.client!,
        this,
        () => this.agentConfig(),
        (msg) => this.post(msg)
      );
    }
    this.post({ type: 'init', model, hasCredential: !!auth.apiKey });
  }

  newSession(): void {
    this.agent?.reset();
    this.approveAll = false;
    this.post({ type: 'reset' });
  }

  stop(): void {
    this.agent?.stop();
  }

  // ---------- ToolHost ----------

  root(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    return ws ? ws.uri.fsPath : process.cwd();
  }

  proxy(): string | undefined {
    return vscode.workspace.getConfiguration('orcaDev').get<string>('proxy') || undefined;
  }

  approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (this.approveAll) return true;
    if (vscode.workspace.getConfiguration('orcaDev').get<boolean>('autoApprove')) return true;

    if (req.diff) void this.showDiff(this.ctx, req.diff);

    return await new Promise<boolean>((resolve) => {
      this.pending.set(req.id, resolve);
      this.post({
        type: 'approval',
        id: req.id,
        tool: req.tool,
        title: req.title,
        detail: req.detail,
        hasDiff: !!req.diff
      });
    });
  };

  // ---------- internals ----------

  private agentConfig() {
    const cfg = vscode.workspace.getConfiguration('orcaDev');
    return {
      model: cfg.get<string>('model') || 'claude-sonnet-5-5',
      maxTokens: cfg.get<number>('maxTokens') || 8192,
      maxSteps: cfg.get<number>('maxSteps') || 25,
      system: buildSystemPrompt(
        cfg.get<string>('systemPrompt') || '',
        this.root(),
        vscode.workspace.workspaceFolders?.[0]?.name || ''
      )
    };
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
        await this.refresh();
        this.post({ type: 'root', root: this.root() });
        break;

      case 'send': {
        const text = String(m.text ?? '').trim();
        if (!text) break;
        if (!this.agent) await this.refresh();
        if (!this.client) break;
        this.approveAll = false;
        this.post({ type: 'user', text });
        await this.agent!.send(text);
        break;
      }

      case 'stop':
        this.stop();
        break;

      case 'newSession':
        this.newSession();
        break;

      case 'approval': {
        const resolve = this.pending.get(String(m.id));
        if (resolve) {
          this.pending.delete(String(m.id));
          const ok = m.decision === 'allow' || m.decision === 'allow_all';
          if (m.decision === 'allow_all') this.approveAll = true;
          resolve(ok);
        }
        break;
      }

      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'orcaDev');
        break;

      case 'setKey':
        await vscode.commands.executeCommand('orcaDev.setApiKey');
        break;
    }
  }

  private async showDiff(ctx: vscode.ExtensionContext, d: DiffPreview): Promise<void> {
    try {
      const dir = path.join(ctx.globalStorageUri.fsPath, 'diffs');
      fs.mkdirSync(dir, { recursive: true });
      const before = path.join(dir, 'before.txt');
      const after = path.join(dir, 'after.txt');
      fs.writeFileSync(before, d.before, 'utf8');
      fs.writeFileSync(after, d.after, 'utf8');
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(before),
        vscode.Uri.file(after),
        `OrcaDev: ${d.file} (${d.before ? 'modified' : 'new file'})`
      );
    } catch {
      // the diff preview is a convenience only
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString();
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${media('style.css')}" />
<title>OrcaDev</title>
</head>
<body>
  <header class="bar">
    <span class="brand">orca<span class="brand-dot">·</span>dev</span>
    <span id="model" class="model" title="Model">—</span>
    <span class="spacer"></span>
    <button id="newBtn" class="icon-btn" title="New chat">+</button>
    <button id="stopBtn" class="icon-btn" title="Stop" disabled>&#9632;</button>
  </header>
  <main id="log" class="log"></main>
  <footer class="composer">
    <textarea id="input" rows="3" placeholder="Ask something... Enter to send, Shift+Enter for a new line"></textarea>
    <div class="row">
      <span id="status" class="status">ready</span>
      <span class="spacer"></span>
      <button id="sendBtn" class="send">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}
