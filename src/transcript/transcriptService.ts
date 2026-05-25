import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { redact } from '../logging/logger.js';
import { ensureDir, stableId } from '../utils/fs.js';

export type TranscriptEntryType = 'session_start' | 'session_end' | 'user' | 'assistant' | 'command' | 'error' | 'compact';

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

  async start(): Promise<void> {
    await this.append('session_start', '会话开始', {
      cwd: process.cwd(),
      pid: process.pid,
      node: process.version
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
          summaries.push({
            sessionId: path.basename(file.name, '.jsonl'),
            path: filePath,
            updatedAt: fileStat.mtime.toISOString(),
            sizeBytes: fileStat.size
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
