# OrcaDev

An AI coding agent panel for VS Code. Chat with a model, let it read your project, edit files and run commands — with a diff preview and an approval prompt for every write and every command.

Bring your own **Anthropic API key**. OrcaDev talks to the API directly; it does not use any other tool's login.

> OrcaDev is an independent, community project. It is not affiliated with, endorsed by or sponsored by Anthropic. "Claude" and "Anthropic" are trademarks of their owners and are used only to describe compatibility.
>
> *Русская версия — ниже.*

## Features

- Chat panel in the activity bar with streaming answers.
- Agent loop: the model calls a tool, OrcaDev runs it, returns the result, and the model continues (up to `orcaDev.maxSteps` steps; **Stop** interrupts at any step).
- Six tools: `read_file`, `list_dir`, `grep`, `write_file`, `run_command`, `web_fetch`.
- Approvals: **Allow** / **Always this session** / **Deny** for every file write and every command. A before/after diff opens in the editor before a file is written.
- Paths are limited to the workspace root: `..` and absolute paths outside it are rejected.
- Your API key is stored in VS Code SecretStorage — never in `settings.json`, never logged.
- Optional HTTP proxy and custom API base URL.
- Model picker backed by `GET /v1/models` (falls back to a built-in list).

## Getting started

1. Install the extension and open a folder (a trusted workspace is required).
2. Run **OrcaDev: Set API Key** from the Command Palette and paste your key (`sk-ant-api03-...`). Alternatively set the `ANTHROPIC_API_KEY` environment variable before starting VS Code.
3. Optionally run **OrcaDev: Choose Model**.
4. Open the OrcaDev icon in the activity bar and start chatting.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `orcaDev.model` | `claude-sonnet-5-5` | Model id (use *Choose Model* for the real list) |
| `orcaDev.baseUrl` | `https://api.anthropic.com` | API base URL (your own gateway, if any) |
| `orcaDev.proxy` | empty | HTTP proxy for API requests, e.g. `http://127.0.0.1:3128` |
| `orcaDev.maxTokens` | `8192` | Max tokens per model response |
| `orcaDev.maxSteps` | `25` | Max agent steps per message |
| `orcaDev.contextFiles` | `40` | Workspace files listed in the system prompt (0 = off) |
| `orcaDev.autoApprove` | `false` | Skip confirmations (**dangerous**: allows commands without asking) |
| `orcaDev.systemPrompt` | empty | Extra instructions appended to the system prompt |

## Security and privacy

- `run_command` runs an **arbitrary** shell command (PowerShell on Windows, the default shell elsewhere) in the workspace root. Approve commands only when you understand them. `orcaDev.autoApprove` removes the only safeguard.
- `write_file` replaces the whole file. A diff is shown first and you can deny it.
- Command timeout is 600 s; output is truncated at 60,000 characters.
- OrcaDev is disabled in untrusted workspaces and virtual workspaces.
- Your prompts, the files the model reads and tool output are sent to the API endpoint you configure (Anthropic by default). Do not use OrcaDev on code you are not allowed to send there.
- OrcaDev has no telemetry and sends nothing anywhere else.
- You are responsible for your API usage costs.

## Known limitations

- Anthropic models only. No MCP client, no background tasks, no multi-agent mode.
- No code indexing or semantic search — only regex `grep`.
- Conversation history lives in memory and is lost when the window reloads.
- Diffs are shown as before/after temporary files, not as a patch in the source-control tree.

## Development

```bash
npm install
node esbuild.mjs            # build dist/extension.js
```

Press **F5** with the folder open to start an Extension Development Host.

Checks that need no VS Code and no network:

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/esbuild/bin/esbuild scripts/e2e.ts --bundle --platform=node --format=cjs --outfile=dist-test/e2e.cjs
node dist-test/e2e.cjs      # agent loop against a local mock API: ALL CHECKS PASSED
node esbuild.mjs && node scripts/activate.cjs   # real activation with a stubbed vscode module
```

Optional live check (spends tokens): set `ANTHROPIC_API_KEY` (and `SMOKE_LIVE=1`) and run `scripts/smoke.ts` the same way.

Build a `.vsix`:

```bash
npm run package             # produces orcadev-<version>.vsix
code --install-extension orcadev-<version>.vsix --force
```

## License

MIT — see [LICENSE](LICENSE).

---

# OrcaDev (по-русски)

Панель AI-агента для VS Code: чат с моделью, агент читает проект, правит файлы и запускает команды. Перед каждой записью — diff, перед каждой командой — подтверждение.

Нужен ваш **API-ключ Anthropic**. Расширение обращается к API напрямую и не использует вход других программ.

## Возможности

- Панель чата в activity bar, ответ приходит потоком.
- Цикл агента: модель вызывает инструмент → OrcaDev выполняет → результат уходит модели (до `orcaDev.maxSteps` шагов, **Stop** прерывает на любом шаге).
- Инструменты: `read_file`, `list_dir`, `grep`, `write_file`, `run_command`, `web_fetch`.
- Подтверждения: **Allow** / **Always this session** / **Deny** на каждую запись и команду; перед записью открывается diff.
- Пути ограничены корнем workspace.
- Ключ хранится в SecretStorage VS Code — не в настройках и не в логах.
- Прокси и свой базовый URL API; выбор модели из `/v1/models`.

## Быстрый старт

1. Установите расширение и откройте папку (нужен доверенный workspace).
2. **OrcaDev: Set API Key** в палитре команд — вставьте ключ `sk-ant-api03-...` (или задайте переменную `ANTHROPIC_API_KEY` до запуска VS Code).
3. При желании — **OrcaDev: Choose Model**.
4. Откройте иконку OrcaDev в activity bar.

## Безопасность

- `run_command` выполняет **произвольную** команду в корне workspace. Разрешайте осознанно; `orcaDev.autoApprove` отключает единственную защиту.
- Ваши запросы, прочитанные файлы и вывод инструментов отправляются на настроенный API (по умолчанию Anthropic). Не используйте на коде, который нельзя туда отправлять.
- Телеметрии нет. За расходы на API отвечаете вы.

## Ограничения

Только модели Anthropic; нет MCP, фоновых задач и мультиагентности; нет индексации кода; история диалога живёт в памяти и теряется при перезагрузке окна.

## Лицензия

MIT — см. [LICENSE](LICENSE).
