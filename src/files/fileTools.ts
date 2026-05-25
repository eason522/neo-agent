import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, FileToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { HookBus } from '../hooks/hookBus.js';

export const READ_TOOL_NAME = 'Read';
export const GLOB_TOOL_NAME = 'Glob';
export const GREP_TOOL_NAME = 'Grep';
export const WRITE_TOOL_NAME = 'Write';
export const EDIT_TOOL_NAME = 'Edit';

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

const writeInputSchema = z.object({
  file_path: z.string(),
  content: z.string()
});

const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

const ignoredDirectories = new Set(['.git', '.svn', '.hg', '.jj', 'node_modules', 'dist', 'build', '.neo-agent']);
const maxReadBytes = 512 * 1024;
const maxGlobResults = 100;
const defaultGrepLimit = 250;
const maxSearchFiles = 5000;
const grepTimeoutMs = 10_000;
const maxGrepOutputChars = 100_000;

export type FilePermissionRequest = {
  toolName: typeof WRITE_TOOL_NAME | typeof EDIT_TOOL_NAME;
  path: string;
  operation: 'create' | 'overwrite' | 'edit';
  summary: string;
  oldChars?: number;
  newChars: number;
  permissionRequired: boolean;
};

export type FilePermissionAsker = (request: FilePermissionRequest) => Promise<'allow' | 'deny'>;

export type FileToolScope = {
  workspaceDir?: string;
  additionalReadDirs?: string[];
  additionalWriteDirs?: string[];
};

export class FileToolRunner implements ToolRunner<FileToolCallRecord> {
  private rootRealPath: string | undefined;
  private workspaceRealPath: string | undefined;
  private readRoots: string[] = [];
  private writeRoots: string[] = [];

  constructor(
    private readonly projectRoot = process.cwd(),
    private permissionAsker?: FilePermissionAsker,
    private readonly hooks?: HookBus,
    private readonly scope: FileToolScope = {}
  ) {}

  setPermissionAsker(permissionAsker: FilePermissionAsker | undefined): void {
    this.permissionAsker = permissionAsker;
  }

  hasPermissionAsker(): boolean {
    return Boolean(this.permissionAsker);
  }

  async refresh(): Promise<void> {
    this.rootRealPath = await realpath(this.projectRoot);
    this.workspaceRealPath = await resolveWorkspaceRoot(this.rootRealPath, this.scope.workspaceDir ?? 'workspace');
    this.readRoots = await resolveScopeRoots(this.rootRealPath, [
      this.workspaceRealPath,
      ...(this.scope.additionalReadDirs ?? []),
      ...(this.scope.additionalWriteDirs ?? [])
    ]);
    this.writeRoots = await resolveScopeRoots(this.rootRealPath, [
      this.workspaceRealPath,
      ...(this.scope.additionalWriteDirs ?? [])
    ]);
  }

  definitions(): ChatToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: READ_TOOL_NAME,
          description: [
            '读取当前项目目录、workspace 目录和已授权额外目录内的文本文件。结果使用 cat -n 风格，带 1 起始行号。',
            '只能读取文件，不能读取目录；大文件请使用 offset 和 limit。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file_path: { type: 'string', description: '要读取的文件路径，可为相对当前项目目录的路径，或已授权额外目录内的绝对路径。' },
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
          description: '在当前项目目录、workspace 目录或已授权额外目录内按文件名 glob 模式查找文件。只返回路径，不读取正文。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string', description: 'glob 模式，例如 "*.ts"、"src/**/*.ts"。' },
              path: { type: 'string', description: '可选。搜索目录，默认当前项目目录；绝对路径必须位于已授权额外目录内。' }
            },
            required: ['pattern']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: GREP_TOOL_NAME,
          description: '在当前项目目录、workspace 目录或已授权额外目录内搜索文本内容。默认返回匹配文件列表；需要上下文时使用 output_mode=content。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string', description: '要搜索的正则表达式。' },
              path: { type: 'string', description: '可选。文件或目录路径，默认当前项目目录；绝对路径必须位于已授权额外目录内。' },
              glob: { type: 'string', description: '可选。限制文件名 glob，例如 "*.ts"。' },
              output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
              head_limit: { type: 'number', description: '最多返回条数。0 表示不限制，但仍受内部安全上限约束。' },
              offset: { type: 'number', description: '跳过前 N 条结果。' },
              '-i': { type: 'boolean', description: '是否忽略大小写。' }
            },
            required: ['pattern']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: WRITE_TOOL_NAME,
          description: [
            '在 workspace 目录内创建或覆盖文件不需要额外确认；写入项目目录或其它授权写入目录时必须经过用户确认。',
            '不要用它做小范围替换，替换请使用 Edit。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file_path: { type: 'string', description: '目标文件路径，可为相对当前项目目录的路径，或已授权额外写入目录内的绝对路径。' },
              content: { type: 'string', description: '要写入文件的完整内容。' }
            },
            required: ['file_path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: EDIT_TOOL_NAME,
          description: [
            '在 workspace 目录内编辑文件不需要额外确认；编辑项目目录或其它授权写入目录时必须经过用户确认。',
            'old_string 必须在文件中唯一出现，除非 replace_all=true。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file_path: { type: 'string', description: '目标文件路径，可为相对当前项目目录的路径，或已授权额外写入目录内的绝对路径。' },
              old_string: { type: 'string', description: '要替换的原始字符串，必须精确匹配。' },
              new_string: { type: 'string', description: '替换后的字符串。' },
              replace_all: { type: 'boolean', description: '是否替换所有匹配；默认 false，要求 old_string 唯一。' }
            },
            required: ['file_path', 'old_string', 'new_string']
          }
        }
      }
    ];
  }

  canExecute(name: string): boolean {
    return name === READ_TOOL_NAME || name === GLOB_TOOL_NAME || name === GREP_TOOL_NAME || name === WRITE_TOOL_NAME || name === EDIT_TOOL_NAME;
  }

  executionMode(name: string): 'parallel' | 'exclusive' {
    return name === WRITE_TOOL_NAME || name === EDIT_TOOL_NAME ? 'exclusive' : 'parallel';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<{ content: string; record: FileToolCallRecord }> {
    throwIfAborted(options.signal);
    if (call.function.name === READ_TOOL_NAME) return this.read(call.function.arguments, options.signal);
    if (call.function.name === GLOB_TOOL_NAME) return this.glob(call.function.arguments, options.signal);
    if (call.function.name === GREP_TOOL_NAME) return this.grep(call.function.arguments, options.signal);
    if (call.function.name === WRITE_TOOL_NAME) return this.write(call.function.arguments, options.signal);
    if (call.function.name === EDIT_TOOL_NAME) return this.edit(call.function.arguments, options.signal);
    throw new Error(`未知文件工具：${call.function.name}`);
  }

  private async read(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = readInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const filePath = await this.resolveReadablePath(input.file_path);
    throwIfAborted(signal);
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
    const output = `${this.relativeToScope(filePath)}\n${content}${truncated}`;
    return {
      content: truncate(output, 100_000),
      record: {
        name: READ_TOOL_NAME,
        path: this.relativeToScope(filePath),
        operation: 'read',
        resultChars: output.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async glob(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = globInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const base = await this.resolveReadablePath(input.path ?? '.');
    const baseStat = await stat(base);
    if (!baseStat.isDirectory()) throw new Error(`Glob path 必须是目录：${input.path ?? '.'}`);
    const matcher = globToRegExp(input.pattern);
    const files = await this.walkFiles(base, maxSearchFiles, signal);
    throwIfAborted(signal);
    const matches = files
      .map(file => this.relativeToScope(file))
      .filter(relative => matcher.test(relative) || matcher.test(path.basename(relative)))
      .slice(0, maxGlobResults);
    const content = matches.length > 0
      ? [...matches, files.length > maxSearchFiles ? '[扫描文件数达到上限，结果可能不完整]' : ''].filter(Boolean).join('\n')
      : 'No files found';
    return {
      content,
      record: {
        name: GLOB_TOOL_NAME,
        path: this.relativeToScope(base),
        operation: 'glob',
        pattern: input.pattern,
        resultCount: matches.length,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async grep(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = grepInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const target = await this.resolveReadablePath(input.path ?? '.');
    const mode = input.output_mode ?? 'files_with_matches';
    const offset = input.offset ?? 0;
    const limit = input.head_limit === 0 ? 1000 : input.head_limit ?? defaultGrepLimit;
    const result = await runRipgrep({
      root: this.rootRealPath!,
      target: path.relative(this.rootRealPath!, target) || '.',
      pattern: input.pattern,
      ignoreCase: input['-i'] ?? false,
      glob: input.glob,
      mode,
      offset,
      limit,
      signal
    });
    const content = formatGrepResult(result, mode);
    return {
      content: truncate(content, maxGrepOutputChars),
      record: {
        name: GREP_TOOL_NAME,
        path: this.relativeToScope(target),
        operation: 'grep',
        pattern: input.pattern,
        resultCount: result.count,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async write(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = writeInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const target = await this.resolveWritableTarget(input.file_path);
    const existing = await readFile(target, 'utf8').catch(() => undefined);
    await this.requireWritePermission({
      toolName: WRITE_TOOL_NAME,
      path: this.relativeToScope(target),
      operation: existing === undefined ? 'create' : 'overwrite',
      summary: existing === undefined ? '创建新文件' : '完整覆盖已有文件',
      oldChars: existing?.length,
      newChars: input.content.length,
      permissionRequired: !this.isInsideWorkspace(target)
    });
    throwIfAborted(signal);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.content, 'utf8');
    const action = existing === undefined ? 'created' : 'updated';
    const content = `${action} ${this.relativeToScope(target)} (${input.content.length} chars)`;
    return {
      content,
      record: {
        name: WRITE_TOOL_NAME,
        path: this.relativeToScope(target),
        operation: 'write',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async edit(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = editInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const filePath = await this.resolveWritableTarget(input.file_path);
    const raw = await readFile(filePath, 'utf8');
    const matches = countOccurrences(raw, input.old_string);
    if (matches === 0) throw new Error('Edit old_string 没有在文件中找到。');
    if (!input.replace_all && matches !== 1) throw new Error(`Edit old_string 出现 ${matches} 次；请提供更具体上下文，或设置 replace_all=true。`);
    const next = input.replace_all ? raw.split(input.old_string).join(input.new_string) : raw.replace(input.old_string, input.new_string);
    await this.requireWritePermission({
      toolName: EDIT_TOOL_NAME,
      path: this.relativeToScope(filePath),
      operation: 'edit',
      summary: `替换 ${input.replace_all ? matches : 1} 处文本`,
      oldChars: input.old_string.length,
      newChars: input.new_string.length,
      permissionRequired: !this.isInsideWorkspace(filePath)
    });
    throwIfAborted(signal);
    await writeFile(filePath, next, 'utf8');
    const content = `edited ${this.relativeToScope(filePath)} (replacements=${input.replace_all ? matches : 1})`;
    return {
      content,
      record: {
        name: EDIT_TOOL_NAME,
        path: this.relativeToScope(filePath),
        operation: 'edit',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async requireWritePermission(request: FilePermissionRequest): Promise<void> {
    this.hooks?.emit('PermissionRequest', request.toolName, {
      path: request.path,
      operation: request.operation,
      oldChars: request.oldChars,
      newChars: request.newChars,
      permissionRequired: request.permissionRequired
    });
    if (!request.permissionRequired) return;
    if (!this.permissionAsker) throw new Error(`文件写入需要交互式权限确认：${request.path}`);
    const decision = await this.permissionAsker(request);
    if (decision !== 'allow') throw new Error(`用户拒绝文件写入：${request.path}`);
  }

  private async walkFiles(directory: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    const output: string[] = [];
    const queue = [directory];
    while (queue.length > 0 && output.length < limit) {
      throwIfAborted(signal);
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

  private async resolveReadablePath(inputPath: string): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const resolved = await realpath(absolute);
    if (!this.isInsideReadScope(resolved)) {
      throw new Error(`文件工具只能访问当前项目目录、workspace 或已授权额外读取目录内的路径：${inputPath}`);
    }
    return resolved;
  }

  private async resolveWritableTarget(inputPath: string): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
    const parent = await realpath(path.dirname(absolute));
    if (!this.isInsideWriteScope(parent)) {
      throw new Error(`文件工具只能写入当前项目目录、workspace 或已授权额外写入目录内的路径：${inputPath}`);
    }
    const target = path.resolve(parent, path.basename(absolute));
    if (!this.isInsideWriteScope(target)) {
      throw new Error(`文件工具只能写入当前项目目录、workspace 或已授权额外写入目录内的路径：${inputPath}`);
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error(`拒绝写入符号链接：${inputPath}`);
    if (existing && !existing.isFile()) throw new Error(`Write/Edit 只能写入文件：${inputPath}`);
    return target;
  }

  private isInsideReadScope(filePath: string): boolean {
    return [this.rootRealPath!, ...this.readRoots].some(root => pathInsideRoot(filePath, root));
  }

  private isInsideWriteScope(filePath: string): boolean {
    return [this.rootRealPath!, ...this.writeRoots].some(root => pathInsideRoot(filePath, root));
  }

  private isInsideWorkspace(filePath: string): boolean {
    return Boolean(this.workspaceRealPath && pathInsideRoot(filePath, this.workspaceRealPath));
  }

  private relativeToScope(filePath: string): string {
    return relativeToBestRoot(filePath, [this.rootRealPath!, ...this.readRoots, ...this.writeRoots]);
  }
}

export function getFileToolPrompt(): string {
  return [
    '# 项目文件工具',
    '- 你可以使用 Read 读取当前项目目录、workspace 目录和已授权额外目录内的文本文件，使用 Glob 按文件名查找文件，使用 Grep 搜索文件内容。',
    '- workspace 目录是 neo 的默认可写工作区，Write/Edit 在 workspace 内拥有完全访问权限；项目目录和额外写入目录的写入仍必须经过用户权限确认。',
    '- 优先用 Glob/Grep 定位文件，再用 Read 读取必要片段；不要反复读取大文件。',
    '- 文件工具默认只能访问 neo 启动时所在的项目目录、workspace 和显式授权额外目录，不能访问其它路径。'
  ].join('\n');
}

async function resolveWorkspaceRoot(projectRoot: string, input: string): Promise<string> {
  const absolute = path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
  await mkdir(absolute, { recursive: true });
  const resolved = await realpath(absolute);
  const resolvedStat = await stat(resolved);
  if (!resolvedStat.isDirectory()) throw new Error(`workspace 路径必须是目录：${input}`);
  return resolved;
}

async function resolveScopeRoots(projectRoot: string, inputs: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const input of inputs) {
    const absolute = path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
    const resolved = await realpath(absolute).catch(() => undefined);
    const resolvedStat = resolved ? await stat(resolved).catch(() => undefined) : undefined;
    if (resolved && resolvedStat?.isDirectory() && !roots.some(root => root === resolved)) roots.push(resolved);
  }
  return roots;
}

function pathInsideRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}${path.sep}`);
}

function relativeToBestRoot(filePath: string, roots: string[]): string {
  const projectRoot = roots[0];
  if (projectRoot && pathInsideRoot(filePath, projectRoot)) {
    const relative = path.relative(projectRoot, filePath);
    return relative || '.';
  }
  const matches = roots
    .filter(root => pathInsideRoot(filePath, root))
    .sort((a, b) => b.length - a.length);
  const root = matches[0];
  if (!root) return filePath;
  const relative = path.relative(root, filePath);
  if (!relative) return '.';
  if (root === roots[0]) return relative;
  return path.isAbsolute(filePath) ? filePath : relative;
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`文件工具参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
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

type RipgrepOptions = {
  root: string;
  target: string;
  pattern: string;
  ignoreCase: boolean;
  glob?: string;
  mode: 'content' | 'files_with_matches' | 'count';
  offset: number;
  limit: number;
  signal?: AbortSignal;
};

async function runRipgrep(options: RipgrepOptions): Promise<{ lines: string[]; count: number; truncated: boolean }> {
  const args = [
    '--no-messages',
    '--color=never',
    '--hidden',
    ...ignoredRipgrepGlobs(),
    ...(options.ignoreCase ? ['-i'] : []),
    ...(options.glob ? ['--glob', options.glob] : []),
    ...modeArgs(options.mode),
    '--regexp',
    options.pattern,
    options.target
  ];
  const output = await runCommand('rg', args, {
    cwd: options.root,
    timeoutMs: grepTimeoutMs,
    maxOutputChars: maxGrepOutputChars,
    signal: options.signal,
    noMatchExitCode: 1
  });
  if (!output.stdout.trim()) return { lines: [], count: 0, truncated: false };
  const lines = output.stdout.split(/\r?\n/).filter(Boolean);
  const sliced = lines.slice(options.offset, options.offset + options.limit);
  return {
    lines: sliced,
    count: lines.length,
    truncated: output.truncated || lines.length > options.offset + options.limit
  };
}

function modeArgs(mode: 'content' | 'files_with_matches' | 'count'): string[] {
  if (mode === 'files_with_matches') return ['--files-with-matches'];
  if (mode === 'count') return ['--count'];
  return ['--line-number', '--no-heading'];
}

function ignoredRipgrepGlobs(): string[] {
  return [...ignoredDirectories].flatMap(directory => ['--glob', `!${directory}/**`]);
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
    noMatchExitCode?: number;
  }
): Promise<{ stdout: string; truncated: boolean }> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    let truncated = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({ stdout, truncated });
    };
    const kill = (): void => {
      if (process.platform === 'win32') child.kill();
      else {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 2000).unref();
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`${command} 超时：${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const onAbort = (): void => {
      kill();
      finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('工具已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (stdout.length >= options.maxOutputChars) {
        truncated = true;
        kill();
        return;
      }
      stdout += String(chunk);
      if (stdout.length > options.maxOutputChars) {
        stdout = stdout.slice(0, options.maxOutputChars);
        truncated = true;
        kill();
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk).slice(0, 2000);
    });
    child.on('error', error => {
      if ('code' in error && error.code === 'ENOENT') {
        finish(new Error('rg 不可用：请安装 ripgrep，或确认 rg 在 PATH 中。'));
        return;
      }
      finish(error);
    });
    child.on('close', code => {
      closed = true;
      if (truncated) return finish();
      if (code === 0 || code === options.noMatchExitCode) return finish();
      finish(new Error(`${command} 失败：exit=${code ?? 'unknown'} ${stderr.trim()}`.trim()));
    });
  });
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

function countOccurrences(input: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = input.indexOf(search, index);
    if (next < 0) return count;
    count += 1;
    index = next + search.length;
  }
}
