import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, LogLevel } from '../types.js';

type LogFields = Record<string, unknown>;

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};

export class Logger {
  readonly filePath: string;
  private readonly level: LogLevel;
  private readonly consoleEnabled: boolean;
  private readonly maxBytes: number;
  private readonly retentionDays: number;
  private readonly maxFiles: number;
  private cleanupDone = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(config: AppConfig) {
    this.level = config.logging.level;
    this.consoleEnabled = config.logging.console;
    this.maxBytes = config.logging.maxBytes;
    this.retentionDays = config.logging.retentionDays;
    this.maxFiles = config.logging.maxFiles;
    this.filePath = path.isAbsolute(config.logging.file)
      ? config.logging.file
      : path.join(config.homeDir, config.logging.file);
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.write('error', event, {
      ...fields,
      error: serializeError(error)
    });
  }

  async tail(lines = 80): Promise<string> {
    await this.flush();
    try {
      const fileStat = await stat(this.filePath);
      const maxRead = Math.min(fileStat.size, 256 * 1024);
      const raw = await readFile(this.filePath, 'utf8');
      return raw
        .slice(Math.max(0, raw.length - maxRead))
        .trimEnd()
        .split('\n')
        .slice(-lines)
        .join('\n');
    } catch {
      return '';
    }
  }

  async flush(): Promise<void> {
    await this.pendingWrite.catch(() => undefined);
  }

  private write(level: Exclude<LogLevel, 'silent'>, event: string, fields: LogFields): void {
    if (levelRank[level] < levelRank[this.level]) return;

    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(fields) as LogFields)
    };
    const line = `${JSON.stringify(record)}\n`;

    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const rotated = await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      if (!this.cleanupDone || rotated) {
        this.cleanupDone = true;
        await this.cleanupArchives();
      }
      await appendFile(this.filePath, line, 'utf8');
    }).catch(() => undefined);

    if (this.consoleEnabled) {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`[${record.ts}] ${level} ${event}\n`);
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<boolean> {
    if (this.maxBytes <= 0) return false;
    try {
      const fileStat = await stat(this.filePath);
      if (fileStat.size + incomingBytes <= this.maxBytes) return false;
      const rotatedPath = this.rotatedPath(new Date());
      await rename(this.filePath, rotatedPath);
      return true;
    } catch {
      // Missing or unreadable log files should not block application flow.
      return false;
    }
  }

  private async cleanupArchives(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const files = await readdir(dir, { withFileTypes: true });
      const archives = await Promise.all(
        files
          .filter(file => file.isFile() && file.name.startsWith(`${base}.`))
          .map(async file => {
            const filePath = path.join(dir, file.name);
            const fileStat = await stat(filePath);
            return { filePath, mtimeMs: fileStat.mtimeMs };
          })
      );

      const now = Date.now();
      const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
      const expired = this.retentionDays === 0
        ? []
        : archives.filter(item => now - item.mtimeMs > retentionMs);
      const sorted = archives
        .filter(item => !expired.some(exp => exp.filePath === item.filePath))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const overflow = this.maxFiles === 0 ? sorted : sorted.slice(this.maxFiles);

      for (const item of [...expired, ...overflow]) {
        await unlink(item.filePath).catch(() => undefined);
      }
    } catch {
      // Log cleanup is best effort.
    }
  }

  private rotatedPath(date: Date): string {
    const stamp = date.toISOString().replace(/[:.]/g, '-');
    return `${this.filePath}.${stamp}`;
  }
}

export function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack).split('\n').slice(0, 8).join('\n') : undefined
    };
  }
  return {
    name: 'UnknownError',
    message: redactString(String(error))
  };
}

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/api[-_]?key|authorization|token|secret|password/i.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (/^(arguments|args|params|parameters)$/i.test(key)) {
      output[key] = summarizeRedactedValue(nested);
      continue;
    }
    output[key] = redact(nested);
  }
  return output;
}

function redactString(input: string): string {
  return redactUrlQueries(input)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
    .replace(/tp-[A-Za-z0-9_-]{12,}/g, 'tp-[REDACTED]')
    .replace(/tvly-[A-Za-z0-9_-]{12,}/g, 'tvly-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[REDACTED];base64,[REDACTED]');
}

function redactUrlQueries(input: string): string {
  return input.replace(/https?:\/\/[^\s"'<>]+/gi, rawUrl => {
    try {
      const url = new URL(rawUrl);
      if (!url.search) return rawUrl;
      return `${url.origin}${url.pathname}?[REDACTED]${url.hash}`;
    } catch {
      return rawUrl;
    }
  });
}

function summarizeRedactedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return {
      redacted: true,
      chars: value.length,
      keys: Object.keys(safeParseObject(value)).sort()
    };
  }
  if (Array.isArray(value)) {
    return {
      redacted: true,
      items: value.length
    };
  }
  if (value && typeof value === 'object') {
    return {
      redacted: true,
      keys: Object.keys(value as Record<string, unknown>).sort()
    };
  }
  return '[REDACTED]';
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
