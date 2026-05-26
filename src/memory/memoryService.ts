import type { AppConfig, MemoryCategory, MemoryHit, MemoryRecord } from '../types.js';
import { LocalMemory } from './localMemory.js';
import { OpenVikingMemory } from './openVikingMemory.js';
import type { Logger } from '../logging/logger.js';

export type RememberOptions = {
  category?: MemoryCategory;
  tags?: string[];
  origin?: MemoryRecord['origin'];
  pinned?: boolean;
  metadata?: Record<string, unknown>;
};

export class MemoryService {
  readonly local: LocalMemory;
  readonly openViking: OpenVikingMemory;

  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {
    this.local = new LocalMemory(config);
    this.openViking = new OpenVikingMemory(config);
  }

  async search(query: string): Promise<MemoryHit[]> {
    const start = Date.now();
    const openVikingHits = this.config.memory.backend === 'local' ? [] : await this.openViking.search(query).catch(error => {
      this.logger?.warn('memory.openviking.search.offline', { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const localHits = this.config.memory.backend === 'openviking' && openVikingHits.length > 0 ? [] : await this.local.search(query);
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

  async remember(content: string, tagsOrOptions: string[] | RememberOptions = []): Promise<MemoryRecord> {
    const options: RememberOptions = Array.isArray(tagsOrOptions) ? { tags: tagsOrOptions } : tagsOrOptions;
    const record = await this.local.remember({ content, ...options });
    if (this.config.memory.backend !== 'local') {
      const result = await this.openViking.store(record);
      if (result.pending) this.logger?.warn('memory.openviking.store.pending', { uri: record.uri });
    }
    this.logger?.debug('memory.remember', {
      category: record.category,
      origin: record.origin,
      tags: record.tags,
      contentChars: content.length,
      uri: record.uri
    });
    return record;
  }

  async list(limit = 20, category?: MemoryCategory): Promise<MemoryRecord[]> {
    if (this.config.memory.backend !== 'local') {
      const records = await this.openViking.list(limit, category).catch(() => []);
      if (records.length > 0) return records;
    }
    return this.local.list({ limit, category });
  }

  async update(idOrUri: string, updates: Partial<Pick<MemoryRecord, 'content' | 'category' | 'tags' | 'pinned' | 'status' | 'metadata'>>): Promise<MemoryRecord | undefined> {
    const record = await this.local.update(idOrUri, updates);
    if (record && this.config.memory.backend !== 'local') {
      const result = await this.openViking.store(record);
      if (result.pending) this.logger?.warn('memory.openviking.update.pending', { uri: record.uri });
    }
    this.logger?.debug('memory.update', {
      found: Boolean(record),
      idOrUri,
      category: record?.category,
      pinned: record?.pinned,
      status: record?.status
    });
    return record;
  }

  async forget(idOrUri: string): Promise<MemoryRecord | undefined> {
    const record = await this.local.forget(idOrUri);
    if (this.config.memory.backend !== 'local') {
      const result = await this.openViking.forget(record?.uri ?? idOrUri);
      if (result.pending) this.logger?.warn('memory.openviking.forget.pending', { idOrUri });
    }
    this.logger?.debug('memory.forget', { found: Boolean(record), idOrUri });
    return record;
  }

  async delete(idOrUri: string): Promise<MemoryRecord | undefined> {
    const record = await this.local.delete(idOrUri);
    if (this.config.memory.backend !== 'local') {
      const result = await this.openViking.forget(record?.uri ?? idOrUri);
      if (result.pending) this.logger?.warn('memory.openviking.delete.pending', { idOrUri });
    }
    this.logger?.debug('memory.delete', { found: Boolean(record), idOrUri });
    return record;
  }

  async openVikingHealth(): Promise<import('./openVikingMemory.js').OpenVikingHealth> {
    return this.openViking.health();
  }

  async syncOpenVikingPending(): Promise<{ attempted: number; synced: number; remaining: number }> {
    return this.openViking.syncPending();
  }

  async openVikingPendingCount(): Promise<number> {
    return this.openViking.pendingCount();
  }
}
