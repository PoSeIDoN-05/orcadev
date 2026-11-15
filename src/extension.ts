// extension.ts -- activation, commands, credential resolution.
import * as vscode from 'vscode';
import { ChatView, Auth } from './chatView';
import { listModels } from './client';

const CREDENTIAL_KEY = 'orcaDev.credential';
let chatView: ChatView | undefined;

/**
 * Credential order:
 *   1. SecretStorage (set via the "OrcaDev: Set API Key" command)
 *   2. ANTHROPIC_API_KEY from the environment
 *
 * Only a regular Anthropic API key is supported. The extension never reads
 * credential files of other tools and never uses OAuth tokens of other apps.
 */
async function resolveAuth(ctx: vscode.ExtensionContext): Promise<Auth> {
  const stored = (await ctx.secrets.get(CREDENTIAL_KEY))?.trim();
  if (stored) return { apiKey: stored };

  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return { apiKey: envKey };

  return {};
}

export function activate(context: vscode.ExtensionContext): void {
  chatView = new ChatView(context, () => resolveAuth(context));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const cmd = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('orcaDev.newSession', () => chatView?.newSession());
  cmd('orcaDev.stop', () => chatView?.stop());

  cmd('orcaDev.setApiKey', async () => {
    const value = await vscode.window.showInputBox({
      title: 'OrcaDev: Anthropic API key',
      prompt:
        'Your Anthropic API key (sk-ant-api03-...). It is stored in VS Code SecretStorage and never written to settings.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 10 ? 'Too short' : undefined)
    });
    if (!value) return;
    await context.secrets.store(CREDENTIAL_KEY, value.trim());
    await chatView?.refresh(true);
    void vscode.window.showInformationMessage('OrcaDev: key saved.');
  });

  cmd('orcaDev.clearApiKey', async () => {
    await context.secrets.delete(CREDENTIAL_KEY);
    await chatView?.refresh(true);
    void vscode.window.showInformationMessage('OrcaDev: stored key removed.');
  });

  cmd('orcaDev.chooseModel', async () => {
    const cfg = vscode.workspace.getConfiguration('orcaDev');
    const auth = await resolveAuth(context);
    const clientCfg = {
      ...auth,
      baseURL: cfg.get<string>('baseUrl') || 'https://api.anthropic.com',
      proxy: cfg.get<string>('proxy') || undefined
    };

    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OrcaDev: loading model list...' },
      () => listModels(clientCfg)
    );

    const pick = await vscode.window.showQuickPick(models, {
      title: 'Model',
      placeHolder: cfg.get<string>('model') || '',
      ignoreFocusOut: true
    });
    if (!pick) return;

    await cfg.update('model', pick, vscode.ConfigurationTarget.Global);
    await chatView?.refresh();
    void vscode.window.showInformationMessage(`OrcaDev: model ${pick}`);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('orcaDev')) void chatView?.refresh();
    })
  );
}

export function deactivate(): void {
  // nothing to dispose manually: everything lives in context.subscriptions
}
