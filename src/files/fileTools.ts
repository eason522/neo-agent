import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, FileToolCallRecord } from '../types.js';
import type { ToolRunner } from '../tools/tool.js';

export const READ_TOOL_NAME = 'Read';
export const GLOB_TOOL_NAME = 'Glob';
export const GREP_TOOL_NAME = 'Grep';

const readInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(2000).optional()
});

const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
});

const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  head_limit: z.number().int().nonnegative().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
  '-i': z.boolean().optional()
});

const ignoredDirectories = new Set(['.git', '.svn', '.hg', '.jj', 'node_modules', 'dist', 'build', '.neo-agent']);
const maxReadBytes = 512 * 1024;
const maxGlobResults = 100;
const defaultGrepLimit = 250;
const maxSearchFiles = 5000;

export class FileToolRunner implements ToolRunner<FileToolCallRecord> {
  private rootRealPath: string | undefined;

  constructor(private readonly projectRoot = process.cwd()) {}

  async refresh(): Promise<void> {
    this.rootRealPath = await realpath(this.projectRoot);
  }

  definitions(): ChatToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: READ_TOOL_NAME,
          description: [
            '读取当前项目目录内的文本文件。结果使用 cat -n 风格，带 1 起始行号。',
            '只能读取文件，不能读取目录；大文件请使用 offset 和 limit。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file_path: { type: 'string', description: '要读取的文件路径，可为相对当前项目目录的路径。' },
              offset: { type: 'number', description: '可选。跳过前 N 行。' },
              limit: { type: 'number', description: '可选。最多读取多少行，最大 2000。' }
            },
            required: ['file_path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: GLOB_TOOL_NAME,
          description: '在当前项目目录内按文件名 glob 模式查找文件。只返回路径，不读取正文。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string', description: 'glob 模式，例如 "*.ts"、"src/**/*.ts"。' },
              path: { type: 'string', description: '可选。搜索目录，默认当前项目目录。' }
            },
            required: ['pattern']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: GREP_TOOL_NAME,
          description: '在当前项目目录内搜索文本内容。默认返回匹配文件列表；需要上下文时使用 output_mode=content。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string', description: '要搜索的正则表达式。' },
              path: { type: 'string', description: '可选。文件或目录路径，默认当前项目目录。' },
              glob: { type: 'string', description: '可选。限制文件名 glob，例如 "*.ts"。' },
              output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
              head_limit: { type: 'number', description: '最多返回条数。0 表示不限制，但仍受内部安全上限约束。' },
              offset: { type: 'number', description: '跳过前 N 条结果。' },
              '-i': { type: 'boolean', description: '是否忽略大小写。' }
            },
            required: ['pattern']
          }
        }
      }
    ];
  }

  canExecute(name: string): boolean {
    return name === READ_TOOL_NAME || name === GLOB_TOOL_NAME || name === GREP_TOOL_NAME;
  }

  async execute(call: ChatToolCall): Promise<{ content: string; record: FileToolCallRecord }> {
    if (call.function.name === READ_TOOL_NAME) return this.read(call.function.arguments);
    if (call.function.name === GLOB_TOOL_NAME) return this.glob(call.function.arguments);
    if (call.function.name === GREP_TOOL_NAME) return this.grep(call.function.arguments);
    throw new Error(`未知文件工具：${call.function.name}`);
  }

  private async read(rawArguments: string): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = readInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    const filePath = await this.resolveInsideProject(input.file_path);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`Read 只能读取文件：${input.file_path}`);
    if (fileStat.size > maxReadBytes) throw new Error(`文件过大：${formatBytes(fileStat.size)}。请先用 Grep 定位，或后续实现分块读取。`);
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 2000;
    const selected = lines.slice(offset, offset + limit);
    const content = selected
      .map((line, index) => `${String(offset + index + 1).padStart(6, ' ')}\t${line}`)
      .join('\n') || '[空文件]';
    const truncated = offset + limit < lines.length ? '\n[结果已截断，请使用 offset/limit 继续读取]' : '';
    const output = `${relativeToRoot(filePath, this.rootRealPath!)}\n${content}${truncated}`;
    return {
      content: truncate(output, 100_000),
      record: {
        name: READ_TOOL_NAME,
        path: relativeToRoot(filePath, this.rootRealPath!),
        resultChars: output.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async glob(rawArguments: string): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = globInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    const base = await this.resolveInsideProject(input.path ?? '.');
    const baseStat = await stat(base);
    if (!baseStat.isDirectory()) throw new Error(`Glob path 必须是目录：${input.path ?? '.'}`);
    const matcher = globToRegExp(input.pattern);
    const files = await this.walkFiles(base, maxSearchFiles);
    const matches = files
      .map(file => relativeToRoot(file, this.rootRealPath!))
      .filter(relative => matcher.test(relative) || matcher.test(path.basename(relative)))
      .slice(0, maxGlobResults);
    const content = matches.length > 0
      ? [...matches, files.length > maxSearchFiles ? '[扫描文件数达到上限，结果可能不完整]' : ''].filter(Boolean).join('\n')
      : 'No files found';
    return {
      content,
      record: {
        name: GLOB_TOOL_NAME,
        path: relativeToRoot(base, this.rootRealPath!),
        pattern: input.pattern,
        resultCount: matches.length,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async grep(rawArguments: string): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = grepInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    const target = await this.resolveInsideProject(input.path ?? '.');
    const targetStat = await stat(target);
    const regex = new RegExp(input.pattern, input['-i'] ? 'i' : '');
    const globMatcher = input.glob ? globToRegExp(input.glob) : undefined;
    const files = targetStat.isFile() ? [target] : await this.walkFiles(target, maxSearchFiles);
    const filteredFiles = globMatcher
      ? files.filter(file => globMatcher.test(relativeToRoot(file, this.rootRealPath!)) || globMatcher.test(path.basename(file)))
      : files;
    const mode = input.output_mode ?? 'files_with_matches';
    const offset = input.offset ?? 0;
    const limit = input.head_limit === 0 ? 1000 : input.head_limit ?? defaultGrepLimit;
    const result = await this.searchFiles(filteredFiles, regex, mode, offset, limit);
    const content = formatGrepResult(result, mode);
    return {
      content: truncate(content, 100_000),
      record: {
        name: GREP_TOOL_NAME,
        path: relativeToRoot(target, this.rootRealPath!),
        pattern: input.pattern,
        resultCount: result.count,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async searchFiles(
    files: string[],
    regex: RegExp,
    mode: 'content' | 'files_with_matches' | 'count',
    offset: number,
    limit: number
  ): Promise<{ lines: string[]; count: number; truncated: boolean }> {
    const lines: string[] = [];
    let count = 0;
    for (const file of files) {
      const fileStat = await stat(file).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size > maxReadBytes) continue;
      const raw = await readFile(file, 'utf8').catch(() => undefined);
      if (raw === undefined || raw.includes('\u0000')) continue;
      const fileLines = raw.split(/\r?\n/);
      let fileMatchCount = 0;
      const contentMatches: string[] = [];
      fileLines.forEach((line, index) => {
        if (regex.test(line)) {
          fileMatchCount += 1;
          if (mode === 'content') contentMatches.push(`${relativeToRoot(file, this.rootRealPath!)}:${index + 1}:${line}`);
        }
      });
      if (fileMatchCount === 0) continue;
      if (mode === 'files_with_matches') lines.push(relativeToRoot(file, this.rootRealPath!));
      else if (mode === 'count') lines.push(`${relativeToRoot(file, this.rootRealPath!)}:${fileMatchCount}`);
      else lines.push(...contentMatches);
      count += mode === 'content' ? contentMatches.length : 1;
      if (lines.length >= offset + limit) break;
    }
    const sliced = lines.slice(offset, offset + limit);
    return { lines: sliced, count, truncated: lines.length > offset + limit };
  }

  private async walkFiles(directory: string, limit: number): Promise<string[]> {
    const output: string[] = [];
    const queue = [directory];
    while (queue.length > 0 && output.length < limit) {
      const current = queue.shift()!;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.github') {
          if (ignoredDirectories.has(entry.name)) continue;
        }
        if (ignoredDirectories.has(entry.name)) continue;
        const fullPath = path.join(current, entry.name);
        const entryStat = await lstat(fullPath).catch(() => undefined);
        if (!entryStat || entryStat.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(fullPath);
        else if (entry.isFile()) output.push(fullPath);
        if (output.length >= limit) break;
      }
    }
    return output;
  }

  private async resolveInsideProject(inputPath: string): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const resolved = await realpath(absolute);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`文件工具只能访问当前项目目录内的路径：${inputPath}`);
    }
    return resolved;
  }
}

export function getFileToolPrompt(): string {
  return [
    '# 项目文件工具',
    '- 你可以使用 Read 读取当前项目目录内的文本文件，使用 Glob 按文件名查找文件，使用 Grep 搜索文件内容。',
    '- 这些工具是只读的，不会修改文件。不要声称已经写入或删除文件。',
    '- 优先用 Glob/Grep 定位文件，再用 Read 读取必要片段；不要反复读取大文件。',
    '- 文件工具只能访问 neo 启动时所在的项目目录，不能读取项目外路径。'
  ].join('\n');
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`文件工具参数不是有效 JSON：${rawArguments.slice(0, 300)}`);
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/');
  let output = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      output += '.*';
      index += 1;
    } else if (char === '*') {
      output += '[^/]*';
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += escapeRegex(char ?? '');
    }
  }
  output += '$';
  return new RegExp(output);
}

function formatGrepResult(result: { lines: string[]; count: number; truncated: boolean }, mode: string): string {
  if (result.lines.length === 0) return 'No matches found';
  return [
    `mode=${mode}, matches=${result.count}`,
    ...result.lines,
    result.truncated ? '[结果已截断，请使用 offset/head_limit 继续查看]' : ''
  ].filter(Boolean).join('\n');
}

function relativeToRoot(filePath: string, root: string): string {
  const relative = path.relative(root, filePath);
  return relative || '.';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}
