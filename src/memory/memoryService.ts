import type { AppConfig, MemoryHit, MemoryRecord } from '../types.js';
import { LocalMemory } from './localMemory.js';
import { OpenVikingMemory } from './openVikingMemory.js';

export class MemoryService {
  readonly local: LocalMemory;
  private readonly openViking: OpenVikingMemory;

  constructor(private readonly config: AppConfig) {
    this.local = new LocalMemory(config);
    this.openViking = new OpenVikingMemory(config);
  }

  async search(query: string): Promise<MemoryHit[]> {
    const [localHits, openVikingHits] = await Promise.all([
      this.config.memory.backend === 'openviking' ? Promise.resolve([]) : this.local.search(query),
      this.config.memory.backend === 'local' ? Promise.resolve([]) : this.openViking.search(query)
    ]);
    return [...openVikingHits, ...localHits]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.memory.maxHits);
  }

  async remember(content: string, tags: string[] = [], kind: MemoryRecord['kind'] = 'user'): Promise<MemoryRecord> {
    const record = await this.local.remember(content, tags, kind);
    if (this.config.memory.backend !== 'local') {
      await this.openViking.remember(content, tags).catch(() => undefined);
    }
    return record;
  }

  async list(limit = 20): Promise<MemoryRecord[]> {
    return this.local.list(limit);
  }
}
