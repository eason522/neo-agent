import path from 'node:path';
import type { AppConfig, MemoryHit, MemoryRecord } from '../types.js';
import { readJsonFile, stableId, writeJsonFile } from '../utils/fs.js';

type MemoryStore = {
  records: MemoryRecord[];
};

export class LocalMemory {
  private readonly filePath: string;

  constructor(private readonly config: AppConfig) {
    this.filePath = path.join(config.homeDir, 'memory', 'memories.json');
  }

  async search(query: string, limit = this.config.memory.maxHits): Promise<MemoryHit[]> {
    const store = await this.readStore();
    const queryTerms = tokenize(query);
    return store.records
      .map(record => ({
        ...record,
        score: scoreRecord(record, queryTerms),
        source: 'local' as const
      }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async remember(content: string, tags: string[] = [], kind: MemoryRecord['kind'] = 'user'): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: stableId('mem'),
      uri: `viking://user/memories/${now.slice(0, 10)}/${stableId('item')}`,
      kind,
      content: content.trim(),
      tags,
      createdAt: now,
      updatedAt: now
    };
    const store = await this.readStore();
    store.records.unshift(record);
    await writeJsonFile(this.filePath, store);
    return record;
  }

  async list(limit = 20): Promise<MemoryRecord[]> {
    const store = await this.readStore();
    return store.records.slice(0, limit);
  }

  private async readStore(): Promise<MemoryStore> {
    const store = await readJsonFile<MemoryStore>(this.filePath, { records: [] });
    return {
      records: Array.isArray(store.records) ? store.records : []
    };
  }
}

function tokenize(input: string): string[] {
  const lower = input.toLowerCase();
  const ascii = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fa5]{1,2}/g) ?? [];
  return [...new Set([...ascii, ...cjk])];
}

function scoreRecord(record: MemoryRecord, queryTerms: string[]): number {
  const haystack = `${record.content} ${record.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += term.length > 2 ? 2 : 1;
  }
  const ageMs = Date.now() - Date.parse(record.updatedAt);
  const recencyBoost = Math.max(0, 1 - ageMs / (1000 * 60 * 60 * 24 * 30));
  return score + recencyBoost;
}
