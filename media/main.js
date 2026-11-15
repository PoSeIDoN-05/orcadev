// main.js -- webview UI, plain DOM, no framework.
const vscode = acquireVsCodeApi();

const logEl = document.getElementById('log');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const newBtn = document.getElementById('newBtn');
const statusEl = document.getElementById('status');
const modelEl = document.getElementById('model');

let assistant = null; // { wrap, bubble, raw }
let toolCards = new Map();
let busy = false;

const post = (m) => vscode.postMessage(m);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setBusy(v) {
  busy = v;
  stopBtn.disabled = !v;
  sendBtn.disabled = v;
  statusEl.textContent = v ? 'thinking...' : 'ready';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function scrollDown() {
  logEl.scrollTop = logEl.scrollHeight;
}

function newAssistant() {
  const wrap = el('div', 'msg msg-assistant');
  const bubble = el('div', 'bubble');
  wrap.appendChild(bubble);
  logEl.appendChild(wrap);
  assistant = { wrap, bubble, raw: '' };
  scrollDown();
  return assistant;
}

// Minimal formatting: fenced code blocks + inline `code`, everything else as text.
function renderRich(container, text) {
  container.textContent = '';
  const parts = String(text).split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[\w+.-]*\r?\n/, '');
      const pre = el('pre', 'pre', body.replace(/\s+$/, ''));
      container.appendChild(pre);
      return;
    }
    if (!part) return;
    const span = document.createElement('span');
    part.split(/(`[^`\n]+`)/g).forEach((chunk) => {
      if (/^`[^`\n]+`$/.test(chunk)) {
        span.appendChild(el('code', '', chunk.slice(1, -1)));
      } else if (chunk) {
        span.appendChild(document.createTextNode(chunk));
      }
    });
    container.appendChild(span);
  });
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['path', 'command', 'pattern', 'url'];
  for (const k of keys) {
    if (typeof input[k] === 'string') return String(input[k]).slice(0, 120);
  }
  return '';
}

function addUser(text) {
  const wrap = el('div', 'msg msg-user');
  const bubble = el('div', 'bubble', text);
  wrap.appendChild(bubble);
  logEl.appendChild(wrap);
  assistant = null;
  scrollDown();
}

function addError(text) {
  const node = el('div', 'error-line', text);
  logEl.appendChild(node);
  scrollDown();
}

function addHint() {
  const wrap = el('div', 'hint');
  wrap.appendChild(document.createTextNode('No API key yet. Run the command: '));
  const b1 = el('code', '', 'OrcaDev: Set API Key');
  wrap.appendChild(b1);
  wrap.appendChild(document.createTextNode(' — or press the button.'));
  const box = el('div');
  box.style.marginTop = '8px';
  const btn = el('button', 'primary', 'Set API key');
  btn.addEventListener('click', () => post({ type: 'setKey' }));
  box.appendChild(btn);
  wrap.appendChild(box);
  logEl.appendChild(wrap);
}

function addToolCard(id, name, input) {
  const wrap = el('div', 'tool');
  const head = el('div', 'tool-head');
  const state = el('span', 'state', '...');
  head.appendChild(state);
  head.appendChild(el('span', 'name', ' ' + name));
  const summary = summarizeInput(input);
  if (summary) head.appendChild(document.createTextNode('  ' + summary));

  const body = el('div', 'tool-body');
  body.style.display = 'none';
  head.addEventListener('click', () => {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });

  wrap.appendChild(head);
  wrap.appendChild(body);
  logEl.appendChild(wrap);
  toolCards.set(id, { wrap, state, body });
  scrollDown();
}

function finishTool(id, ok, text) {
  const card = toolCards.get(id);
  if (!card) return;
  card.state.textContent = ok ? 'OK' : 'ERR';
  card.state.className = ok ? 'state state-ok' : 'state state-err';
  card.body.appendChild(el('pre', 'pre', String(text).slice(0, 8000)));
  scrollDown();
}

function addApproval(m) {
  const wrap = el('div', 'approval');
  wrap.appendChild(el('div', 'title', m.title));
  wrap.appendChild(el('div', 'detail', m.detail));
  if (m.hasDiff) wrap.appendChild(el('div', 'detail', 'diff opened in the editor'));

  const actions = el('div', 'actions');
  const decide = (label, cls, decision) => {
    const b = el('button', cls, label);
    b.addEventListener('click', () => {
      post({ type: 'approval', id: m.id, decision });
      actions.remove();
      wrap.appendChild(el('div', 'detail', decision === 'deny' ? 'denied' : 'allowed'));
    });
    return b;
  };
  actions.appendChild(decide('Allow', 'primary', 'allow'));
  actions.appendChild(decide('Always this session', 'ghost', 'allow_all'));
  actions.appendChild(decide('Deny', 'danger', 'deny'));
  wrap.appendChild(actions);
  logEl.appendChild(wrap);
  scrollDown();
}

// ---------- host messages ----------

window.addEventListener('message', (event) => {
  const m = event.data || {};
  switch (m.type) {
    case 'init':
      modelEl.textContent = m.model || '—';
      if (!m.hasCredential) addHint();
      break;

    case 'root':
      statusEl.title = m.root || '';
      break;

    case 'user':
      addUser(m.text);
      setBusy(true);
      break;

    case 'delta': {
      const a = assistant || newAssistant();
      a.raw += m.text;
      a.bubble.textContent = a.raw;
      scrollDown();
      break;
    }

    case 'tool_start':
      addToolCard(m.id, m.name, m.input);
      break;

    case 'tool_end':
      finishTool(m.id, m.ok, m.text);
      break;

    case 'approval':
      addApproval(m);
      break;

    case 'usage': {
      const u = m.usage || {};
      const extra = m.stopReason === 'max_tokens' ? ' · cut off at max_tokens' : '';
      setStatus(`step ${m.step} · in ${u.input_tokens || 0} · out ${u.output_tokens || 0}${extra}`);
      break;
    }

    case 'done':
      if (assistant) renderRich(assistant.bubble, assistant.raw);
      assistant = null;
      setBusy(false);
      break;

    case 'stopped':
      if (assistant) renderRich(assistant.bubble, assistant.raw + '\n\n[stopped]');
      assistant = null;
      setBusy(false);
      break;

    case 'error':
      addError(m.text);
      setBusy(false);
      break;

    case 'reset':
      logEl.textContent = '';
      toolCards.clear();
      assistant = null;
      setBusy(false);
      break;
  }
});

// ---------- wiring ----------

function submit() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  post({ type: 'send', text });
}

sendBtn.addEventListener('click', submit);

newBtn.addEventListener('click', () => {
  if (busy) return;
  post({ type: 'newSession' });
});

stopBtn.addEventListener('click', () => {
  post({ type: 'stop' });
  setStatus('stopping...');
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

inputEl.focus();
post({ type: 'ready' });


