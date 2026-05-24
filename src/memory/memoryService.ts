import type { AppConfig, MemoryHit, MemoryRecord } from '../types.js';
import { LocalMemory } from './localMemory.js';
import { OpenVikingMemory } from './openVikingMemory.js';
import type { Logger } from '../logging/logger.js';

export class MemoryService {
  readonly local: LocalMemory;
  private readonly openViking: OpenVikingMemory;

  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {
    this.local = new LocalMemory(config);
    this.openViking = new OpenVikingMemory(config);
  }

  async search(query: string): Promise<MemoryHit[]> {
    const start = Date.now();
    const [localHits, openVikingHits] = await Promise.all([
      this.config.memory.backend === 'openviking' ? Promise.resolve([]) : this.local.search(query),
      this.config.memory.backend === 'local' ? Promise.resolve([]) : this.openViking.search(query)
    ]);
    const hits = [...openVikingHits, ...localHits]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.memory.maxHits);
    this.logger?.debug('memory.search', {
      backend: this.config.memory.backend,
      queryChars: query.length,
      localHits: localHits.length,
      openVikingHits: openVikingHits.length,
      returnedHits: hits.length,
      durationMs: Date.now() - start
    });
    return hits;
  }

  async remember(content: string, tags: string[] = [], kind: MemoryRecord['kind'] = 'user'): Promise<MemoryRecord> {
    const record = await this.local.remember(content, tags, kind);
    if (this.config.memory.backend !== 'local') {
      await this.openViking.remember(content, tags).catch(() => undefined);
    }
    this.logger?.debug('memory.remember', {
      kind,
      tags,
      contentChars: content.length,
      uri: record.uri
    });
    return record;
  }

  async list(limit = 20): Promise<MemoryRecord[]> {
    return this.local.list(limit);
  }
}
