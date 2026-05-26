import path from 'node:path';
import type { AppConfig, MemoryCategory, MemoryHit, MemoryOrigin, MemoryRecord, MemoryStatus, MemoryTier } from '../types.js';
import { readJsonFile, stableId, writeJsonFile } from '../utils/fs.js';

type MemoryStore = {
  version?: number;
  records: MemoryRecord[];
};

type LegacyMemoryRecord = Partial<MemoryRecord> & {
  kind?: 'user' | 'agent' | 'session';
};

type MemoryWriteInput = {
  content: string;
  category?: MemoryCategory;
  tier?: MemoryTier;
  tags?: string[];
  origin?: MemoryOrigin;
  pinned?: boolean;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
};

type MemoryListOptions = {
  limit?: number;
  category?: MemoryCategory;
  tier?: MemoryTier;
  includeArchived?: boolean;
  includeExpired?: boolean;
};

export class LocalMemory {
  private readonly filePath: string;

  constructor(private readonly config: AppConfig) {
    this.filePath = path.join(config.homeDir, 'memory', 'memories.json');
  }

  async search(query: string, limit = this.config.memory.maxHits): Promise<MemoryHit[]> {
    const store = await this.readStore();
    const queryTerms = tokenize(query);
    const normalizedQuery = normalizeText(query);
    return store.records
      .filter(record => record.status === 'active')
      .filter(record => !isMemoryExpired(record))
      .map(record => ({
        ...record,
        score: scoreRecord(record, queryTerms, normalizedQuery),
        source: 'local' as const
      }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async remember(input: string | MemoryWriteInput, tags: string[] = []): Promise<MemoryRecord> {
    const payload = typeof input === 'string' ? { content: input, tags } : input;
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: stableId('mem'),
      uri: buildMemoryUri(payload.category ?? 'preference', stableId('item')),
      category: payload.category ?? 'preference',
      tier: payload.tier ?? 'long_term',
      content: payload.content.trim(),
      tags: normalizeTags(payload.tags ?? []),
      origin: payload.origin ?? 'manual',
      pinned: payload.pinned ?? false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      expiresAt: payload.expiresAt,
      metadata: payload.metadata
    };
    const store = await this.readStore();
    store.records.unshift(record);
    await writeJsonFile(this.filePath, store);
    return record;
  }

  async list(options: number | MemoryListOptions = 20): Promise<MemoryRecord[]> {
    const resolved = typeof options === 'number' ? { limit: options } : options;
    const store = await this.readStore();
    return store.records
      .filter(record => resolved.includeArchived || record.status === 'active')
      .filter(record => resolved.includeExpired || !isMemoryExpired(record))
      .filter(record => !resolved.category || record.category === resolved.category)
      .filter(record => !resolved.tier || record.tier === resolved.tier)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, resolved.limit ?? 20);
  }

  async update(idOrUri: string, updates: Partial<Pick<MemoryRecord, 'content' | 'category' | 'tier' | 'tags' | 'pinned' | 'status' | 'expiresAt' | 'metadata'>>): Promise<MemoryRecord | undefined> {
    const store = await this.readStore();
    const index = store.records.findIndex(record => matchesRecord(record, idOrUri));
    if (index < 0) return undefined;
    const current = store.records[index];
    const next: MemoryRecord = {
      ...current,
      ...updates,
      content: updates.content?.trim() || current.content,
      tags: updates.tags ? normalizeTags(updates.tags) : current.tags,
      updatedAt: new Date().toISOString()
    };
    store.records[index] = next;
    await writeJsonFile(this.filePath, { ...store, version: 2 });
    return next;
  }

  async forget(idOrUri: string): Promise<MemoryRecord | undefined> {
    return this.update(idOrUri, { status: 'archived' });
  }

  async delete(idOrUri: string): Promise<MemoryRecord | undefined> {
    const store = await this.readStore();
    const index = store.records.findIndex(record => matchesRecord(record, idOrUri));
    if (index < 0) return undefined;
    const [removed] = store.records.splice(index, 1);
    await writeJsonFile(this.filePath, { ...store, version: 2 });
    return removed;
  }

  async find(idOrUri: string): Promise<MemoryRecord | undefined> {
    const store = await this.readStore();
    return store.records.find(record => matchesRecord(record, idOrUri));
  }

  private async readStore(): Promise<MemoryStore> {
    const store = await readJsonFile<{ version?: number; records?: LegacyMemoryRecord[] }>(this.filePath, { records: [] });
    const records = Array.isArray(store.records) ? store.records.map(normalizeRecord).filter(isMemoryRecord) : [];
    return {
      version: 2,
      records
    };
  }
}

function tokenize(input: string): string[] {
  const lower = input.toLowerCase();
  const ascii = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjkSegments = lower.match(/[\u4e00-\u9fa5]+/g) ?? [];
  const cjk = cjkSegments.flatMap(segment => {
    if (segment.length <= 2) return [segment];
    const grams = segment.length <= 8 ? [segment] : [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      grams.push(segment.slice(index, index + 2));
    }
    return grams;
  });
  return [...new Set([...ascii, ...cjk])].filter(term => term.length >= 2);
}

function scoreRecord(record: MemoryRecord, queryTerms: string[], normalizedQuery: string): number {
  if (queryTerms.length === 0) return record.pinned ? 2 : 1;
  const category = normalizeText(record.category);
  const content = normalizeText(record.content);
  const tags = record.tags.map(normalizeText);
  let relevanceScore = 0;
  const matchedTerms = new Set<string>();

  if (normalizedQuery.length >= 4) {
    if (content.includes(normalizedQuery)) relevanceScore += 12;
    if (tags.some(tag => tag === normalizedQuery)) relevanceScore += 8;
  }

  for (const term of queryTerms) {
    let termScore = 0;
    if (category === term) termScore += 5;
    else if (category.includes(term)) termScore += 3;

    for (const tag of tags) {
      if (tag === term) termScore += 6;
      else if (tag.includes(term)) termScore += 4;
    }

    if (content.includes(term)) termScore += term.length > 2 ? 3 : 1.5;
    if (termScore > 0) {
      relevanceScore += termScore;
      matchedTerms.add(term);
    }
  }
  if (matchedTerms.size === 0 && relevanceScore === 0) return 0;

  const coverage = matchedTerms.size / queryTerms.length;
  const ageMs = Date.now() - Date.parse(record.updatedAt);
  const ageDays = Number.isFinite(ageMs) ? Math.max(0, ageMs / (1000 * 60 * 60 * 24)) : 30;
  const recencyBoost = Math.pow(0.5, ageDays / 30);
  const pinnedBoost = record.pinned ? Math.min(2, 0.5 + relevanceScore * 0.15) : 0;
  return relevanceScore * (1 + coverage) + recencyBoost + pinnedBoost;
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRecord(raw: LegacyMemoryRecord): MemoryRecord | undefined {
  if (!raw || typeof raw.content !== 'string' || !raw.content.trim()) return undefined;
  const now = new Date().toISOString();
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  return {
    id: typeof raw.id === 'string' ? raw.id : stableId('mem'),
    uri: typeof raw.uri === 'string' ? raw.uri : `viking://user/memories/${createdAt.slice(0, 10)}/${stableId('item')}`,
    category: normalizeCategory(raw.category ?? categoryFromLegacyKind(raw.kind)),
    tier: normalizeTier(raw.tier),
    content: raw.content.trim(),
    tags: normalizeTags(Array.isArray(raw.tags) ? raw.tags : []),
    origin: normalizeOrigin(raw.origin ?? sourceFromLegacyKind(raw.kind)),
    pinned: Boolean(raw.pinned),
    status: normalizeStatus(raw.status),
    createdAt,
    updatedAt,
    lastAccessedAt: typeof raw.lastAccessedAt === 'string' ? raw.lastAccessedAt : undefined,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined
  };
}

function isMemoryRecord(record: MemoryRecord | undefined): record is MemoryRecord {
  return record !== undefined;
}

function normalizeCategory(value: unknown): MemoryCategory {
  return value === 'preference' || value === 'project_fact' || value === 'workflow' || value === 'session_summary'
    ? value
    : 'preference';
}

function normalizeTier(value: unknown): MemoryTier {
  return value === 'short_term' ? 'short_term' : 'long_term';
}

function normalizeOrigin(value: unknown): MemoryOrigin {
  return value === 'manual' || value === 'session' || value === 'agent' || value === 'imported' || value === 'openviking'
    ? value
    : 'manual';
}

export function isMemoryExpired(record: Pick<MemoryRecord, 'tier' | 'expiresAt'>, now = Date.now()): boolean {
  if (record.tier !== 'short_term' || !record.expiresAt) return false;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizeStatus(value: unknown): MemoryStatus {
  return value === 'archived' ? 'archived' : 'active';
}

function categoryFromLegacyKind(kind: LegacyMemoryRecord['kind']): MemoryCategory {
  if (kind === 'session') return 'session_summary';
  if (kind === 'agent') return 'workflow';
  return 'preference';
}

function sourceFromLegacyKind(kind: LegacyMemoryRecord['kind']): MemoryOrigin {
  if (kind === 'session') return 'session';
  if (kind === 'agent') return 'agent';
  return 'manual';
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 16);
}

function buildMemoryUri(category: MemoryCategory, id: string): string {
  const prefix = category === 'preference'
    ? 'viking://user/default/memories/preferences/'
    : category === 'project_fact'
      ? 'viking://user/default/memories/project_facts/'
      : category === 'workflow'
        ? 'viking://user/default/memories/workflows/'
        : 'viking://agent/neo-agent/memories/session_summaries/';
  return `${prefix}${id}.md`;
}

function matchesRecord(record: MemoryRecord, idOrUri: string): boolean {
  return record.id === idOrUri || record.uri === idOrUri || record.uri.endsWith(`/${idOrUri}`);
}
