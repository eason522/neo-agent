import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ChatMessage } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { redact } from '../logging/logger.js';
import { ensureDir, stableId } from '../utils/fs.js';

export type TranscriptEntryType = 'session_start' | 'session_end' | 'user' | 'assistant' | 'command' | 'error' | 'compact' | 'cancel' | 'skill_suggestion';

export type TranscriptEntry = {
  id: string;
  sessionId: string;
  ts: string;
  type: TranscriptEntryType;
  content: string;
  metadata?: Record<string, unknown>;
};

export type TranscriptSessionSummary = {
  sessionId: string;
  path: string;
  updatedAt: string;
  sizeBytes: number;
  title?: string;
};

export type TranscriptConversationSnapshot = {
  sessionId: string;
  path: string;
  title?: string;
  messages: ChatMessage[];
  compactSummary?: string;
  warnings: string[];
};

export class TranscriptService {
  readonly sessionId = stableId('session');
  readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {
    const day = new Date().toISOString().slice(0, 10);
    const root = path.isAbsolute(config.transcripts.dir)
      ? config.transcripts.dir
      : path.join(config.homeDir, config.transcripts.dir);
    this.filePath = path.join(root, day, `${this.sessionId}.jsonl`);
  }

  async start(metadata: Record<string, unknown> = {}): Promise<void> {
    await this.append('session_start', '会话开始', {
      cwd: process.cwd(),
      pid: process.pid,
      node: process.version,
      ...metadata
    });
  }

  async end(): Promise<void> {
    await this.append('session_end', '会话结束');
    await this.flush();
  }

  async append(type: TranscriptEntryType, content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.config.transcripts.enabled) return;

    const entry: TranscriptEntry = {
      id: stableId('entry'),
      sessionId: this.sessionId,
      ts: new Date().toISOString(),
      type,
      content: redactTranscriptText(content),
      metadata: redact(metadata) as Record<string, unknown>
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.pendingWrite = this.pendingWrite.then(async () => {
      await ensureDir(path.dirname(this.filePath));
      await appendFile(this.filePath, line, 'utf8');
    }).catch(error => {
      this.logger?.error('transcript.write.error', error, { filePath: this.filePath });
    });
    await this.pendingWrite;
  }

  async tail(lines = this.config.transcripts.maxTailLines): Promise<string> {
    await this.flush();
    return tailFile(this.filePath, lines);
  }

  async flush(): Promise<void> {
    await this.pendingWrite.catch(() => undefined);
  }

  async listSessions(limit = 20): Promise<TranscriptSessionSummary[]> {
    const root = path.isAbsolute(this.config.transcripts.dir)
      ? this.config.transcripts.dir
      : path.join(this.config.homeDir, this.config.transcripts.dir);
    const summaries: TranscriptSessionSummary[] = [];

    try {
      const days = await readdir(root, { withFileTypes: true });
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayDir = path.join(root, day.name);
        const files = await readdir(dayDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, file.name);
          const fileStat = await stat(filePath);
          const entries = await readTranscriptEntries(filePath, 30);
          summaries.push({
            sessionId: path.basename(file.name, '.jsonl'),
            path: filePath,
            updatedAt: fileStat.mtime.toISOString(),
            sizeBytes: fileStat.size,
            title: inferTitle(entries)
          });
        }
      }
    } catch {
      return [];
    }

    return summaries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async loadConversationSnapshot(selector?: string): Promise<TranscriptConversationSnapshot | undefined> {
    const session = await this.resolveSession(selector);
    if (!session) return undefined;
    const entries = await readTranscriptEntries(session.path);
    const warnings: string[] = [];
    const compactIndex = findLastCompactIndex(entries);
    const compact = compactIndex >= 0 ? entries[compactIndex] : undefined;
    const compactSummary = typeof compact?.metadata?.summary === 'string' ? compact.metadata.summary : undefined;
    const sourceEntries = compactIndex >= 0 ? entries.slice(compactIndex + 1) : entries;
    const messages: ChatMessage[] = [];
    for (const entry of sourceEntries) {
      if (entry.type === 'user' || entry.type === 'assistant') {
        if (!entry.content.trim()) continue;
        messages.push({ role: entry.type, content: entry.content });
      }
    }
    const toolWarnings = validateToolPairMetadata(entries);
    warnings.push(...toolWarnings);
    return {
      sessionId: session.sessionId,
      path: session.path,
      title: session.title,
      messages,
      compactSummary,
      warnings
    };
  }

  private async resolveSession(selector?: string): Promise<TranscriptSessionSummary | undefined> {
    if (selector) {
      const direct = path.resolve(selector);
      try {
        const fileStat = await stat(direct);
        if (fileStat.isFile()) {
          const entries = await readTranscriptEntries(direct, 30);
          return {
            sessionId: path.basename(direct, '.jsonl'),
            path: direct,
            updatedAt: fileStat.mtime.toISOString(),
            sizeBytes: fileStat.size,
            title: inferTitle(entries)
          };
        }
      } catch {
        // Fall through to session id lookup.
      }
    }
    const sessions = await this.listSessions(200);
    if (!selector || selector === 'latest') {
      return sessions.find(session => session.sessionId !== this.sessionId);
    }
    return sessions.find(session => session.sessionId === selector || path.basename(session.path) === selector || path.basename(session.path, '.jsonl') === selector);
  }
}

export async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.trimEnd().split('\n').slice(-Math.max(1, lines)).join('\n');
  } catch {
    return '';
  }
}

function redactTranscriptText(input: string): string {
  return String(redact(input));
}

async function readTranscriptEntries(filePath: string, maxEntries = Number.POSITIVE_INFINITY): Promise<TranscriptEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const output: TranscriptEntry[] = [];
    for (const line of raw.trimEnd().split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TranscriptEntry;
        if (parsed && typeof parsed.type === 'string' && typeof parsed.content === 'string') output.push(parsed);
      } catch {
        // Ignore malformed transcript lines; resume should be best effort.
      }
      if (output.length >= maxEntries) break;
    }
    return output;
  } catch {
    return [];
  }
}

function inferTitle(entries: TranscriptEntry[]): string | undefined {
  const startTitle = entries.find(entry => entry.type === 'session_start' && typeof entry.metadata?.title === 'string')?.metadata?.title;
  if (typeof startTitle === 'string' && startTitle.trim()) return startTitle.trim();
  const firstUser = entries.find(entry => entry.type === 'user')?.content;
  if (!firstUser) return undefined;
  return firstUser.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function findLastCompactIndex(entries: TranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === 'compact') return index;
  }
  return -1;
}

function validateToolPairMetadata(entries: TranscriptEntry[]): string[] {
  const warnings: string[] = [];
  for (const entry of entries) {
    const pairs = entry.metadata?.toolPairs;
    if (!Array.isArray(pairs)) continue;
    const missingResult = pairs.filter(item => item && typeof item === 'object' && (item as { hasResult?: unknown }).hasResult === false);
    if (missingResult.length > 0) {
      warnings.push(`transcript ${entry.id} 存在 ${missingResult.length} 个未配对 tool result。`);
    }
  }
  return warnings;
}
