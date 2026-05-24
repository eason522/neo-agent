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
    return (payload.results ?? []).map((item, index): MemoryHit => ({
      id: item.uri ?? `openviking_${index}`,
      uri: item.uri ?? 'viking://unknown',
      kind: 'user',
      content: item.content ?? '',
      tags: ['openviking'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
    const hit: MemoryHit = {
      id: 'openviking_cli',
      uri: 'viking://openviking/cli/find',
      kind: 'user',
      content: content.slice(0, 6000),
      tags: ['openviking', 'cli'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      score: 1,
      source: 'openviking'
    };
    return [hit].slice(0, limit);
  }
}
