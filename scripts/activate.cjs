// scripts/activate.cjs -- loads the built dist/extension.js with a stubbed `vscode`
// module and exercises activate(), the webview provider and every command.
// Run: node scripts/activate.cjs   (after node esbuild.mjs)
const Module = require('module');
const path = require('path');
const root = path.resolve(__dirname, '..');

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : ' :: ' + String(extra).slice(0, 160)}`);
}

// --- stub vscode -------------------------------------------------------------
const cmdImpls = [];
const views = [];
const configListeners = [];
const messages = [];
const config = {
  model: 'claude-sonnet-5-5',
  baseUrl: 'https://api.anthropic.com',
  proxy: '',
  maxTokens: 8192,
  maxSteps: 25,
  contextFiles: 40,
  autoApprove: false,
  systemPrompt: ''
};
let secret = null;
const stub = { inputBox: async () => undefined, quickPick: async () => undefined };

const Uri = {
  file: (p) => ({
    fsPath: p,
    path: p.replace(/\\/g, '/'),
    scheme: 'file',
    toString: () => 'file:///' + p.replace(/\\/g, '/')
  }),
  joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts))
};

const vscode = {
  Uri,
  window: {
    registerWebviewViewProvider(id, provider, opts) {
      views.push({ id, provider, opts });
      return { dispose() {} };
    },
    showInputBox: (o) => stub.inputBox(o),
    showQuickPick: (items) => stub.quickPick(items),
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    withProgress: (_opts, task) => Promise.resolve(task()),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} })
  },
  commands: {
    registerCommand(id, fn) {
      cmdImpls.push({ id, fn });
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') return undefined;
      const c = cmdImpls.find((x) => x.id === id);
      return c ? c.fn(...args) : undefined;
    }
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(root), name: 'orcadev', index: 0 }],
    getConfiguration: () => ({
      get: (k, d) => (config[k] === undefined ? d : config[k]),
      update: async (k, v) => {
        config[k] = v;
      },
      has: (k) => k in config
    }),
    onDidChangeConfiguration: (fn) => {
      configListeners.push(fn);
      return { dispose() {} };
    }
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1, Beside: -2 },
  env: { openExternal: () => Promise.resolve(true) }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return origLoad.call(this, request, parent, isMain);
};

// Keep credential resolution deterministic: no ~/.claude-*-token in this run.
const origHome = process.env.USERPROFILE;
process.env.USERPROFILE = path.join(root, 'dist-test', 'nohome');
if (!require('fs').existsSync(process.env.USERPROFILE)) {
  require('fs').mkdirSync(process.env.USERPROFILE, { recursive: true });
}


async function main() {
  const ext = require(path.join(root, 'dist', 'extension.js'));
  check('bundle exports activate()', typeof ext.activate === 'function');

  const ctx = {
    subscriptions: [],
    secrets: {
      get: async () => secret,
      store: async (_k, v) => {
        secret = v;
      },
      delete: async () => {
        secret = null;
      }
    },
    extensionUri: Uri.file(root),
    globalStorageUri: Uri.file(path.join(root, 'dist-test', 'storage')),
    globalState: { get: () => undefined, update: async () => {} }
  };

  ext.activate(ctx);

  const ids = cmdImpls.map((c) => c.id).sort();
  check(
    'all five commands are registered',
    ['orcaDev.clearApiKey', 'orcaDev.chooseModel', 'orcaDev.newSession', 'orcaDev.setApiKey', 'orcaDev.stop'].every((id) =>
      ids.includes(id)
    ),
    ids.join(',')
  );
  check('views provider registered', views.length === 1 && views[0].id === 'orcaDev.chat', views.map((v) => v.id).join(','));
  check('subscriptions tracked for disposal', ctx.subscriptions.length >= 7, `${ctx.subscriptions.length} disposables`);

  // --- webview ---
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (u) => u,
    postMessage: async (m) => {
      messages.push(m);
      return true;
    },
    onDidReceiveMessage: (cb) => {
      webview.receive = cb;
      return { dispose() {} };
    }
  };
  const view = { webview, onDidDispose: () => ({ dispose() {} }), show() {} };
  views[0].provider.resolveWebviewView(view);
  await new Promise((r) => setTimeout(r, 50));

  check('webview html rendered', /<title>OrcaDev<\/title>/.test(webview.html) && webview.html.includes('id="log"'));
  check('html loads style.css and main.js', /style\.css/.test(webview.html) && /main\.js/.test(webview.html));
  check('html is CSP-locked with a nonce', /script-src 'nonce-[a-z0-9]+'/.test(webview.html));
  check('scripts are enabled', webview.options.enableScripts === true);

  const init = messages.filter((m) => m.type === 'init').pop();
  check(
    'init carries model and credential flag',
    init && init.model === 'claude-sonnet-5-5' && init.hasCredential === false,
    JSON.stringify(init)
  );

  // --- commands ---
  await vscode.commands.executeCommand('orcaDev.newSession');
  check('newSession posts reset', messages.some((m) => m.type === 'reset'));

  await vscode.commands.executeCommand('orcaDev.stop');
  check('stop does not throw', true);

  stub.inputBox = async () => 'sk-ant-api03-abcdefghijklmnop';
  await vscode.commands.executeCommand('orcaDev.setApiKey');
  const init2 = messages.filter((m) => m.type === 'init').pop();
  check('setApiKey stores the secret', secret === 'sk-ant-api03-abcdefghijklmnop');
  check('credential becomes visible to the panel', init2 && init2.hasCredential === true, JSON.stringify(init2));

  await vscode.commands.executeCommand('orcaDev.clearApiKey');
  check('clearApiKey drops the secret', secret === null);

  // chooseModel: no credential -> falls back to the built-in list, no network.
  stub.quickPick = async (items) => (Array.isArray(items) ? items.find((i) => i === 'claude-opus-5-5') : undefined);
  await vscode.commands.executeCommand('orcaDev.chooseModel');
  const init3 = messages.filter((m) => m.type === 'init').pop();
  check('chooseModel writes the setting', config.model === 'claude-opus-5-5', config.model);
  check('panel picks up the new model', init3 && init3.model === 'claude-opus-5-5', JSON.stringify(init3));

  // --- settings change -> refresh ---
  const before = messages.filter((m) => m.type === 'init').length;
  configListeners.forEach((fn) => fn({ affectsConfiguration: (s) => s.startsWith('orcaDev') }));
  await new Promise((r) => setTimeout(r, 50));
  check(
    'configuration change refreshes the panel',
    messages.filter((m) => m.type === 'init').length > before,
    `${before} -> ${messages.filter((m) => m.type === 'init').length}`
  );

  // --- webview -> extension messages ---
  messages.length = 0;
  await webview.receive({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 50));
  check('"ready" triggers init and root', messages.some((m) => m.type === 'init') && messages.some((m) => m.type === 'root'), messages.map((m) => m.type).join(','));
  check('root points at the workspace folder', messages.find((m) => m.type === 'root')?.root === root);

  ext.deactivate();
  check('deactivate() is callable', true);

  process.env.USERPROFILE = origHome;
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FAIL  activation crashed ::', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  process.exitCode = 1;
});
