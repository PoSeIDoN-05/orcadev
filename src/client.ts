// client.ts -- Anthropic client: API key, optional HTTP proxy.
import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export interface ClientConfig {
  apiKey?: string;
  baseURL: string;
  proxy?: string;
}

const FALLBACK_MODELS = [
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-sonnet-4-5',
  'claude-opus-4-1'
];

function proxyFetch(proxy?: string) {
  if (!proxy) return undefined;
  const dispatcher = new ProxyAgent(proxy);
  return ((url: any, init: any = {}) => undiciFetch(url, { ...init, dispatcher })) as any;
}

export function createClient(cfg: ClientConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey ?? null,
    baseURL: cfg.baseURL,
    fetch: proxyFetch(cfg.proxy)
  } as any);
}

export async function fetchModels(cfg: ClientConfig): Promise<string[]> {
  const base = (cfg.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
  if (!cfg.apiKey) throw new Error('no credential');
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
    'x-api-key': cfg.apiKey
  };

  const init: any = { headers };
  if (cfg.proxy) init.dispatcher = new ProxyAgent(cfg.proxy);

  const res = await undiciFetch(`${base}/v1/models?limit=100`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const ids: string[] = (json?.data ?? []).map((m: any) => m.id).filter(Boolean);
  if (!ids.length) throw new Error('empty model list');
  return ids;
}

/** Model list for the picker: real API when possible, curated fallback otherwise. */
export async function listModels(cfg: ClientConfig): Promise<string[]> {
  try {
    return await fetchModels(cfg);
  } catch {
    return FALLBACK_MODELS;
  }
}
