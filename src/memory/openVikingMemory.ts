import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig, MemoryHit } from '../types.js';

const execFileAsync = promisify(execFile);

export class OpenVikingMemory {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, limit = this.config.memory.maxHits): Promise<MemoryHit[]> {
    if (this.config.memory.backend === 'local') return [];

    const httpHits = await this.searchHttp(query, limit).catch(() => []);
    if (httpHits.length > 0) return httpHits;

    return this.searchCli(query, limit).catch(() => []);
  }

  async remember(_content: string, _tags: string[] = []): Promise<void> {
    // OpenViking writes are intentionally conservative here because its public
    // CLI/API shape can vary by version. Local memory remains the source of
    // truth, while OpenViking retrieval is used opportunistically when present.
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
      category: 'preference',
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

  private async searchCli(query: string, limit: number): Promise<MemoryHit[]> {
    const { stdout } = await execFileAsync('ov', ['find', query], {
      timeout: 2500,
      maxBuffer: 256 * 1024
    });
    const content = stdout.trim();
    if (!content) return [];
    const now = new Date().toISOString();
    const hit: MemoryHit = {
      id: 'openviking_cli',
      uri: 'viking://openviking/cli/find',
      category: 'preference',
      content: content.slice(0, 6000),
      tags: ['openviking', 'cli'],
      origin: 'openviking',
      pinned: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      score: 1,
      source: 'openviking'
    };
    return [hit].slice(0, limit);
  }
}
