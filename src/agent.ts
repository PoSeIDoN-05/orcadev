// agent.ts -- the tool-use loop: model -> tool_use -> tool_result -> model ...
import type Anthropic from '@anthropic-ai/sdk';
import { TOOLS, runTool, ToolHost } from './tools';

export interface AgentConfig {
  model: string;
  maxTokens: number;
  maxSteps: number;
  system: string;
}

type Emit = (msg: any) => void;

export class Agent {
  private messages: any[] = [];
  private abort?: AbortController;
  private busy = false;

  constructor(
    private readonly getClient: () => Anthropic,
    private readonly host: ToolHost,
    private readonly cfg: () => AgentConfig,
    private readonly emit: Emit
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  reset(): void {
    this.messages = [];
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Sends a user message and runs the tool loop until the model stops asking for tools. */
  async send(text: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: 'error', text: 'The agent is still working — wait for the answer or press Stop.' });
      return;
    }
    this.busy = true;
    try {
      this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
      await this.loop();
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }

  private async loop(): Promise<void> {
    const c = this.cfg();
    for (let step = 1; step <= c.maxSteps; step++) {
      this.abort = new AbortController();
      const signal = this.abort.signal;

      let message: any;
      try {
        const stream = this.getClient().messages.stream(
          {
            model: c.model,
            max_tokens: c.maxTokens,
            system: c.system,
            tools: TOOLS as any,
            messages: this.messages
          } as any,
          { signal }
        );
        stream.on('text', (delta: string) => this.emit({ type: 'delta', text: delta }));
        message = await stream.finalMessage();
      } catch (e: any) {
        if (signal.aborted) {
          this.emit({ type: 'stopped' });
          return;
        }
        this.emit({ type: 'error', text: formatError(e) });
        return;
      }

      this.messages.push({ role: 'assistant', content: message.content });
      this.emit({
        type: 'usage',
        usage: message.usage,
        stopReason: message.stop_reason,
        step
      });

      const toolUses = (message.content ?? []).filter((b: any) => b && b.type === 'tool_use');
      if (!toolUses.length) {
        this.emit({ type: 'done', stopReason: message.stop_reason });
        return;
      }

      const results: any[] = [];
      for (const call of toolUses) {
        if (this.abort?.signal.aborted) {
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'STOPPED by the user before this tool ran.',
            is_error: true
          });
          continue;
        }

        this.emit({ type: 'tool_start', id: call.id, name: call.name, input: call.input });
        let output: string;
        let isError = false;
        try {
          output = await runTool(call.name, call.input, this.host);
        } catch (e: any) {
          output = 'ERROR: ' + (e?.message ?? String(e));
          isError = true;
        }
        this.emit({ type: 'tool_end', id: call.id, ok: !isError, text: output });
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: output.slice(0, 60_000),
          is_error: isError
        });
      }

      this.messages.push({ role: 'user', content: results });
    }

    this.emit({ type: 'error', text: `Step limit reached (${c.maxSteps}). Increase orcaDev.maxSteps or make the task more specific.` });
  }
}

function formatError(e: any): string {
  if (!e) return 'unknown error';
  const status = e.status ? ` [HTTP ${e.status}]` : '';
  let body = '';
  if (typeof e.error === 'string') {
    body = e.error;
  } else if (e.error) {
    body = e.error?.error?.message || JSON.stringify(e.error);
  }
  const msg = body || e?.message || String(e);
  const hint =
    e.status === 429
      ? ' — rate limit reached or the provider balance is empty'
      : e.status === 401 || e.status === 403
        ? ' — check your API key (OrcaDev: Set API Key)'
        : '';
  return `${String(msg).slice(0, 600)}${status}${hint}`;
}
