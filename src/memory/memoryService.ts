import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, MemoryCategory, MemoryHit, MemoryRecord, MemoryTier, RecallExpansion } from '../types.js';
import { isMemoryExpired, LocalMemory } from './localMemory.js';
import { OpenVikingMemory } from './openVikingMemory.js';
import type { Logger } from '../logging/logger.js';
import { tailFile } from '../transcript/transcriptService.js';

export type RememberOptions = {
  category?: MemoryCategory;
  tier?: MemoryTier;
  tags?: string[];
  origin?: MemoryRecord['origin'];
  pinned?: boolean;
  expiresAt?: string;
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
    const candidateLimit = Math.max(this.config.memory.maxHits * 4, this.config.memory.longTermMaxHits + this.config.memory.shortTermMaxHits);
    const openVikingHits = this.config.memory.backend === 'local' ? [] : await this.openViking.search(query, candidateLimit).catch(error => {
      this.logger?.warn('memory.openviking.search.offline', { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const localHits = this.config.memory.backend === 'openviking' && openVikingHits.length > 0 ? [] : await this.local.search(query, candidateLimit);
    const hits = balancedMemoryHits([...openVikingHits, ...localHits], {
      total: this.config.memory.maxHits,
      longTerm: this.config.memory.longTermMaxHits,
      shortTerm: this.config.memory.shortTermMaxHits
    });
    this.logger?.debug('memory.search', {
      backend: this.config.memory.backend,
      queryChars: query.length,
      localHits: localHits.length,
      openVikingHits: openVikingHits.length,
      returnedHits: hits.length,
      longTermHits: hits.filter(hit => hit.tier !== 'short_term').length,
      shortTermHits: hits.filter(hit => hit.tier === 'short_term').length,
      durationMs: Date.now() - start
    });
    return hits;
  }

  async searchTier(query: string, tier: MemoryTier, limit: number): Promise<MemoryHit[]> {
    return (await this.search(query)).filter(hit => hit.tier === tier).slice(0, limit);
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
      tier: record.tier,
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
      const active = records.filter(record => record.status === 'active' && !isMemoryExpired(record));
      if (active.length > 0) return active.slice(0, limit);
    }
    return this.local.list({ limit, category });
  }

  async update(idOrUri: string, updates: Partial<Pick<MemoryRecord, 'content' | 'category' | 'tier' | 'tags' | 'pinned' | 'status' | 'expiresAt' | 'metadata'>>): Promise<MemoryRecord | undefined> {
    const record = await this.local.update(idOrUri, updates);
    if (record && this.config.memory.backend !== 'local') {
      const result = await this.openViking.store(record);
      if (result.pending) this.logger?.warn('memory.openviking.update.pending', { uri: record.uri });
    }
    this.logger?.debug('memory.update', {
      found: Boolean(record),
      idOrUri,
      category: record?.category,
      tier: record?.tier,
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

  async expandRecall(query: string, seeds: MemoryHit[]): Promise<RecallExpansion[]> {
    const candidates = seeds
      .filter(shouldExpandRecall)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const expansions: RecallExpansion[] = [];
    for (const seed of candidates) {
      const fragments: RecallExpansion['fragments'] = [];
      const related = await this.findRelatedMemories(seed, query);
      for (const memory of related.slice(0, 3)) {
        fragments.push({
          source: 'memory',
          title: `${memory.category}/${memory.tier} ${memory.id}`,
          content: memory.content
        });
      }
      const sourceTranscript = typeof seed.metadata?.sourceTranscript === 'string' ? seed.metadata.sourceTranscript : undefined;
      if (sourceTranscript) {
        const tail = await tailFile(sourceTranscript, 40).catch(() => '');
        if (tail.trim()) {
          fragments.push({
            source: 'transcript',
            title: path.basename(sourceTranscript),
            content: tail.trim()
          });
        }
      }
      const reportId = typeof seed.metadata?.reportId === 'string' ? seed.metadata.reportId : undefined;
      if (reportId) {
        const report = await this.readDreamReportFragment(reportId);
        if (report) fragments.push(report);
      }
      if (fragments.length > 0) {
        expansions.push({
          seedId: seed.id,
          seedUri: seed.uri,
          reason: recallExpansionReason(seed),
          fragments
        });
      }
    }
    return expansions;
  }

  private async findRelatedMemories(seed: MemoryHit, query: string): Promise<MemoryRecord[]> {
    const terms = [
      query,
      seed.tags.join(' '),
      seed.content.slice(0, 120)
    ].join(' ').trim();
    if (!terms) return [];
    return (await this.local.search(terms, 8))
      .filter(hit => hit.id !== seed.id && hit.uri !== seed.uri)
      .map(hit => hit as MemoryRecord);
  }

  private async readDreamReportFragment(reportId: string): Promise<RecallExpansion['fragments'][number] | undefined> {
    const reportsDir = path.join(this.config.homeDir, 'dream', 'reports');
    const reports = await this.findDreamReportFiles(reportsDir).catch(() => []);
    for (const filePath of reports) {
      const raw = await readFile(filePath, 'utf8').catch(() => '');
      if (!raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw) as {
          id?: string;
          plan?: { summary?: string; insights?: string[]; soulUpdates?: string[] };
        };
        if (parsed.id !== reportId) continue;
        const content = [
          parsed.plan?.summary ? `summary: ${parsed.plan.summary}` : '',
          ...(parsed.plan?.insights ?? []).slice(0, 5).map(item => `insight: ${item}`),
          ...(parsed.plan?.soulUpdates ?? []).slice(0, 3).map(item => `soul: ${item}`)
        ].filter(Boolean).join('\n');
        if (!content) return undefined;
        return {
          source: 'dream_report',
          title: `${reportId} (${path.basename(filePath)})`,
          content
        };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async findDreamReportFiles(dir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => path.join(dir, entry.name));
  }
}

function balancedMemoryHits(hits: MemoryHit[], budgets: { total: number; longTerm: number; shortTerm: number }): MemoryHit[] {
  const deduped = dedupeMemoryHits(hits)
    .filter(hit => hit.status === 'active' && !isMemoryExpired(hit))
      .sort((a, b) => b.score - a.score)
      .map(hit => ({
        ...hit,
        score: hit.score + (hit.pinned ? 0.8 : 0) + (hit.tier === 'short_term' ? shortTermFreshnessBoost(hit) : 0.2)
      }));
  const shortTerm = deduped.filter(hit => hit.tier === 'short_term');
  const longTerm = deduped.filter(hit => hit.tier !== 'short_term');
  const selected = [
    ...longTerm.slice(0, budgets.longTerm),
    ...shortTerm.slice(0, budgets.shortTerm)
  ];
  const selectedKeys = new Set(selected.map(memoryKey));
  for (const hit of deduped) {
    if (selected.length >= budgets.total) break;
    if (!selectedKeys.has(memoryKey(hit))) {
      selected.push(hit);
      selectedKeys.add(memoryKey(hit));
    }
  }
  return selected.sort((a, b) => b.score - a.score).slice(0, budgets.total);
}

function dedupeMemoryHits(hits: MemoryHit[]): MemoryHit[] {
  const byKey = new Map<string, MemoryHit>();
  for (const hit of hits) {
    const key = memoryKey(hit);
    const existing = byKey.get(key);
    if (!existing || hit.score > existing.score) byKey.set(key, hit);
  }
  return [...byKey.values()];
}

function memoryKey(hit: Pick<MemoryHit, 'id' | 'uri'>): string {
  return hit.uri || hit.id;
}

function shortTermFreshnessBoost(hit: MemoryHit): number {
  const updatedAt = Date.parse(hit.updatedAt);
  if (!Number.isFinite(updatedAt)) return 0;
  const ageDays = Math.max(0, (Date.now() - updatedAt) / 86_400_000);
  return Math.max(0, 1.2 - ageDays * 0.2);
}

function shouldExpandRecall(hit: MemoryHit): boolean {
  if (hit.tier === 'short_term') return false;
  const updatedAt = Date.parse(hit.updatedAt);
  const ageDays = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 86_400_000) : 0;
  const hasTrace = Boolean(hit.metadata?.sourceTranscript || hit.metadata?.reportId);
  return hasTrace || hit.content.length < 180 || ageDays >= 60;
}

function recallExpansionReason(hit: MemoryHit): string {
  const reasons = [];
  if (hit.content.length < 180) reasons.push('命中记忆较短，可能只是线索');
  const updatedAt = Date.parse(hit.updatedAt);
  if (Number.isFinite(updatedAt) && (Date.now() - updatedAt) / 86_400_000 >= 60) reasons.push('命中的是较久远长期记忆');
  if (hit.metadata?.sourceTranscript) reasons.push('存在 sourceTranscript 可回看');
  if (hit.metadata?.reportId) reasons.push('存在 dream report 可回看');
  return reasons.join('；') || '命中长期记忆后展开关联上下文';
}
