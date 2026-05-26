import path from 'node:path';
import type { AppConfig, MemoryCategory, MemoryHit, MemoryRecord } from '../types.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';

type PendingOperation =
  | { type: 'store'; record: MemoryRecord; markdown: string; queuedAt: string }
  | { type: 'forget'; idOrUri: string; queuedAt: string };

export type OpenVikingHealth = {
  ok: boolean;
  mode: 'mcp' | 'http-search' | 'offline';
  message: string;
};

export function getOpenVikingLocalServiceSetupHint(url = 'http://localhost:1933'): string {
  const healthUrl = new URL('/health', url).toString();
  return [
    '按 OpenViking 官方 GitHub 文档，本地服务推荐流程：',
    '1. pip install openviking --upgrade --force-reinstall',
    '2. openviking-server init',
    '3. openviking-server doctor',
    '4. openviking-server',
    `5. curl ${healthUrl}`,
    'OpenViking /mcp 与 REST API 共用同一个 openviking-server 进程和端口；本地 localhost 开发模式不需要额外 API key。'
  ].join('\n');
}

export class OpenVikingMemory {
  private readonly pendingPath: string;

  constructor(private readonly config: AppConfig) {
    this.pendingPath = path.join(config.homeDir, 'memory', 'openviking-pending.json');
  }

  async health(): Promise<OpenVikingHealth> {
    const mcp: unknown | { error: string } = await this.callMcpTool('health', {}).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    if (!hasError(mcp)) return { ok: true, mode: 'mcp', message: 'OpenViking /mcp health 可用。' };
    const healthUrl = new URL('/health', this.config.memory.openVikingUrl);
    const http = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    if (http?.ok) return { ok: true, mode: 'http-search', message: 'OpenViking /health 可访问；/mcp 不可用，将仅尝试旧 search 接口。' };
    return {
      ok: false,
      mode: 'offline',
      message: [
        `OpenViking 主存储离线，写入会进入待同步队列：${this.config.memory.openVikingUrl}`,
        getOpenVikingLocalServiceSetupHint(this.config.memory.openVikingUrl)
      ].join('\n')
    };
  }

  async search(query: string, limit = this.config.memory.maxHits): Promise<MemoryHit[]> {
    if (this.config.memory.backend === 'local') return [];

    const mcpHits = await this.searchMcp(query, limit).catch(() => []);
    if (mcpHits.length > 0) return mcpHits;

    return this.searchHttp(query, limit).catch(() => []);
  }

  async list(limit = 20, category?: MemoryCategory): Promise<MemoryRecord[]> {
    const prefix = category ? memoryUriPrefix(category) : 'viking://';
    const payload = await this.callMcpTool('list', { uri: prefix, limit }).catch(() => undefined);
    const items = extractResultArray(payload);
    return items.map((item, index) => memoryRecordFromUnknown(item, index)).filter(Boolean).slice(0, limit) as MemoryRecord[];
  }

  async store(record: MemoryRecord): Promise<{ stored: boolean; pending: boolean }> {
    const markdown = memoryToMarkdown(record);
    const stored = await this.callMcpTool('remember', {
      messages: [
        { role: 'user', content: markdown }
      ]
    }).then(() => true).catch(() => false);
    if (stored) return { stored: true, pending: false };
    await this.enqueue({ type: 'store', record, markdown, queuedAt: new Date().toISOString() });
    return { stored: false, pending: true };
  }

  async forget(idOrUri: string): Promise<{ forgotten: boolean; pending: boolean }> {
    const forgotten = await this.callMcpTool('forget', { uri: idOrUri }).then(() => true).catch(() => false);
    if (forgotten) return { forgotten: true, pending: false };
    await this.enqueue({ type: 'forget', idOrUri, queuedAt: new Date().toISOString() });
    return { forgotten: false, pending: true };
  }

  async pendingCount(): Promise<number> {
    return (await this.readPending()).length;
  }

  async syncPending(): Promise<{ attempted: number; synced: number; remaining: number }> {
    const pending = await this.readPending();
    const remaining: PendingOperation[] = [];
    let synced = 0;
    for (const item of pending) {
      const ok = item.type === 'store'
        ? await this.callMcpTool('remember', { messages: [{ role: 'user', content: item.markdown }] }).then(() => true).catch(() => false)
        : await this.callMcpTool('forget', { uri: item.idOrUri }).then(() => true).catch(() => false);
      if (ok) synced += 1;
      else remaining.push(item);
    }
    await writeJsonFile(this.pendingPath, { version: 1, operations: remaining });
    return { attempted: pending.length, synced, remaining: remaining.length };
  }

  private async searchMcp(query: string, limit: number): Promise<MemoryHit[]> {
    const payload = await this.callMcpTool('search', { query, limit });
    const items = extractResultArray(payload);
    return items.map((item, index) => memoryHitFromUnknown(item, index)).filter(Boolean).slice(0, limit) as MemoryHit[];
  }

  private async searchHttp(query: string, limit: number): Promise<MemoryHit[]> {
    const url = new URL('/search', this.config.memory.openVikingUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return [];
    const payload = await response.json() as { results?: Array<{ uri?: string; content?: string; score?: number }> };
    const now = new Date().toISOString();
    return (payload.results ?? []).map((item, index): MemoryHit => ({
      id: item.uri ?? `openviking_${index}`,
      uri: item.uri ?? 'viking://unknown',
      category: categoryFromUri(item.uri),
      content: item.content ?? '',
      tags: ['openviking'],
      origin: 'openviking',
      pinned: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      score: item.score ?? 1,
      source: 'openviking'
    })).filter(hit => hit.content);
  }

  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const request = {
      jsonrpc: '2.0',
      id: `neo-${Date.now()}`,
      method: 'tools/call',
      params: { name, arguments: args }
    };
    const direct = await this.postMcpRpc(request).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Missing session ID')) return undefined;
      throw error;
    });
    if (direct !== undefined) return direct;

    const sessionId = await this.initializeMcpSession();
    return this.postMcpRpc(request, sessionId);
  }

  private async initializeMcpSession(): Promise<string> {
    const response = await fetch(new URL('/mcp', this.config.memory.openVikingUrl), {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `neo-init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'neo-agent', version: '0.1.0' }
        }
      }),
      signal: AbortSignal.timeout(3000)
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (!response.ok || !sessionId) throw new Error(`OpenViking /mcp initialize failed: ${response.status}`);
    const payload = parseMcpResponse(await response.text()) as { error?: unknown };
    if (payload.error) throw new Error(`OpenViking /mcp initialize error: ${JSON.stringify(payload.error)}`);
    await this.postMcpNotification('notifications/initialized', sessionId);
    return sessionId;
  }

  private async postMcpNotification(method: string, sessionId: string): Promise<void> {
    const response = await fetch(new URL('/mcp', this.config.memory.openVikingUrl), {
      method: 'POST',
      headers: mcpHeaders(sessionId),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: {}
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok && response.status !== 202) throw new Error(`OpenViking /mcp ${method} failed: ${response.status}`);
  }

  private async postMcpRpc(request: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const response = await fetch(new URL('/mcp', this.config.memory.openVikingUrl), {
      method: 'POST',
      headers: mcpHeaders(sessionId),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(3000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenViking /mcp ${String(request.method)} failed: ${response.status} ${text.slice(0, 200)}`);
    const payload = parseMcpResponse(text) as { error?: unknown; result?: unknown };
    if (payload.error) throw new Error(`OpenViking /mcp ${String(request.method)} error: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  private async enqueue(operation: PendingOperation): Promise<void> {
    const pending = await this.readPending();
    pending.push(operation);
    await writeJsonFile(this.pendingPath, { version: 1, operations: pending });
  }

  private async readPending(): Promise<PendingOperation[]> {
    const raw = await readJsonFile<{ operations?: PendingOperation[] }>(this.pendingPath, { operations: [] });
    return Array.isArray(raw.operations) ? raw.operations : [];
  }
}

export function memoryUriPrefix(category: MemoryCategory): string {
  if (category === 'preference') return 'viking://user/default/memories/preferences/';
  if (category === 'project_fact') return 'viking://user/default/memories/project_facts/';
  if (category === 'workflow') return 'viking://user/default/memories/workflows/';
  return 'viking://agent/neo-agent/memories/session_summaries/';
}

export function memoryToMarkdown(record: MemoryRecord): string {
  const frontmatter = [
    '---',
    `id: ${yamlString(record.id)}`,
    `uri: ${yamlString(record.uri)}`,
    `category: ${yamlString(record.category)}`,
    `tags: [${record.tags.map(yamlString).join(', ')}]`,
    `pinned: ${record.pinned}`,
    `status: ${yamlString(record.status)}`,
    `origin: ${yamlString(record.origin)}`,
    `createdAt: ${yamlString(record.createdAt)}`,
    `updatedAt: ${yamlString(record.updatedAt)}`,
    `sourceTranscript: ${yamlString(String(record.metadata?.sourceTranscript ?? ''))}`,
    '---'
  ].join('\n');
  return `${frontmatter}\n\n${record.content.trim()}\n`;
}

function extractResultArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.items)) return record.items;
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    const nested = extractResultArray(record.structuredContent);
    if (nested.length > 0) return nested;
  }
  if (record.content && Array.isArray(record.content)) {
    return record.content.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== 'string') return [];
      try {
        const parsed = JSON.parse(text) as unknown;
        return extractResultArray(parsed);
      } catch {
        return [];
      }
    });
  }
  return [];
}

export function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) return JSON.parse(trimmed) as unknown;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.replace(/^data:\s?/, ''));
  if (dataLines.length === 0) return {};
  return JSON.parse(dataLines.join('\n')) as unknown;
}

export function mcpHeaders(sessionId?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {})
  };
}

function memoryHitFromUnknown(item: unknown, index: number): MemoryHit | undefined {
  const record = memoryRecordFromUnknown(item, index);
  if (!record) return undefined;
  const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  return {
    ...record,
    score: typeof raw.score === 'number' ? raw.score : 1,
    source: 'openviking'
  };
}

function memoryRecordFromUnknown(item: unknown, index: number): MemoryRecord | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const raw = item as Record<string, unknown>;
  const uri = typeof raw.uri === 'string' ? raw.uri : typeof raw.path === 'string' ? raw.path : `viking://openviking/${index}`;
  const content = typeof raw.content === 'string' ? raw.content : typeof raw.text === 'string' ? raw.text : '';
  if (!content.trim()) return undefined;
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' ? raw.id : uri.split('/').pop()?.replace(/\.md$/, '') || `openviking_${index}`,
    uri,
    category: categoryFromUri(uri),
    content: stripFrontmatter(content),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : ['openviking'],
    origin: 'openviking',
    pinned: Boolean(raw.pinned),
    status: raw.status === 'archived' ? 'archived' : 'active',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  };
}

function categoryFromUri(uri: string | undefined): MemoryCategory {
  if (uri?.includes('/project_facts/')) return 'project_fact';
  if (uri?.includes('/workflows/')) return 'workflow';
  if (uri?.includes('/session_summaries/')) return 'session_summary';
  return 'preference';
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function yamlString(input: string): string {
  return JSON.stringify(input);
}

function hasError(input: unknown): input is { error: string } {
  return Boolean(input && typeof input === 'object' && 'error' in input);
}
