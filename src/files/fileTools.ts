import { spawn } from 'node:child_process';
import { appendFile, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, FileToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { HookBus } from '../hooks/hookBus.js';
import { evaluateFileWritePermission } from '../permissions/permissions.js';

export const READ_TOOL_NAME = 'Read';
export const GLOB_TOOL_NAME = 'Glob';
export const GREP_TOOL_NAME = 'Grep';
export const WRITE_TOOL_NAME = 'Write';
export const APPEND_TOOL_NAME = 'Append';
export const EDIT_TOOL_NAME = 'Edit';
export const LIST_TOOL_NAME = 'List';
export const MKDIR_TOOL_NAME = 'Mkdir';
export const COPY_TOOL_NAME = 'Copy';
export const MOVE_TOOL_NAME = 'Move';
export const DELETE_TOOL_NAME = 'Delete';

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

const appendInputSchema = z.object({
  file_path: z.string(),
  content: z.string(),
  mode: z.enum(['create', 'append']).optional()
});

const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

const listInputSchema = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  limit: z.number().int().positive().max(1000).optional()
});

const mkdirInputSchema = z.object({
  path: z.string()
});

const copyInputSchema = z.object({
  source_path: z.string(),
  target_path: z.string(),
  overwrite: z.boolean().optional()
});

const moveInputSchema = z.object({
  source_path: z.string(),
  target_path: z.string(),
  overwrite: z.boolean().optional()
});

const deleteInputSchema = z.object({
  path: z.string(),
  permanent: z.boolean().optional()
});

const ignoredDirectories = new Set(['.git', '.svn', '.hg', '.jj', 'node_modules', 'dist', 'build', '.neo-agent']);
const maxReadBytes = 512 * 1024;
const maxReadOutputChars = 100_000;
const maxGlobResults = 100;
const defaultGrepLimit = 250;
const maxSearchFiles = 5000;
const grepTimeoutMs = 10_000;
const maxGrepOutputChars = 100_000;
const pdfExtensions = new Set(['.pdf']);
const imageExtensions = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);
const knownBinaryExtensions = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.dll', '.dmg', '.doc', '.docx', '.exe', '.gz', '.ico',
  '.jar', '.mp3', '.mp4', '.o', '.obj', '.odt', '.ppt', '.pptx', '.rar', '.so', '.sqlite', '.tar', '.tgz',
  '.wasm', '.xls', '.xlsx', '.zip'
]);

export type FilePermissionRequest = {
  toolName: typeof WRITE_TOOL_NAME | typeof APPEND_TOOL_NAME | typeof EDIT_TOOL_NAME | typeof MKDIR_TOOL_NAME | typeof COPY_TOOL_NAME | typeof MOVE_TOOL_NAME | typeof DELETE_TOOL_NAME;
  path: string;
  operation: 'create' | 'overwrite' | 'append' | 'edit' | 'mkdir' | 'copy' | 'move' | 'delete';
  summary: string;
  oldChars?: number;
  newChars: number;
  permissionRequired: boolean;
  permanent?: boolean;
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
            '图片和 PDF 只返回安全元数据摘要；普通二进制文件会被拒绝。大文本文件请先用 Grep 定位，再用 offset/limit 读取必要片段。'
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
          name: LIST_TOOL_NAME,
          description: '列出当前项目目录、workspace 或已授权额外读取目录内的文件和目录。只返回条目摘要，不读取文件正文。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: '可选。要列出的目录，默认 workspace。' },
              recursive: { type: 'boolean', description: '是否递归列出；默认 false。' },
              limit: { type: 'number', description: '最多返回条目数，最大 1000。' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: WRITE_TOOL_NAME,
          description: [
            '在 workspace 目录内创建或覆盖文件不需要额外确认；写入项目目录或其它授权写入目录时必须经过用户确认。',
            '不要用它做小范围替换，替换请使用 Edit。',
            '长 HTML/CSS/JS/落地页/完整单文件不要一次性用 Write 传完整内容；请改用 Append 分块写入。'
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
          name: APPEND_TOOL_NAME,
          description: [
            '分块写入长文件。workspace 目录内不需要额外确认；写入项目目录或其它授权写入目录时必须经过用户确认。',
            '长 HTML/CSS/JS/落地页/完整单文件必须优先使用 Append：第一块 mode=create 创建或清空文件，后续块 mode=append 追加。',
            '每块 content 控制在 4000 字符以内，避免工具参数再次被模型输出长度截断。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file_path: { type: 'string', description: '目标文件路径，可为相对当前项目目录的路径，或已授权额外写入目录内的绝对路径。' },
              content: { type: 'string', description: '本次要写入或追加的一小块内容。建议不超过 4000 字符。' },
              mode: { type: 'string', enum: ['create', 'append'], description: 'create 表示创建或清空后写入第一块；append 表示追加后续块。默认 append。' }
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
      },
      {
        type: 'function',
        function: {
          name: MKDIR_TOOL_NAME,
          description: '在 workspace 内创建目录不需要确认；在项目目录或额外写入目录内创建目录需要用户确认。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: '要创建的目录路径。相对路径按当前项目目录解析。' }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: COPY_TOOL_NAME,
          description: '复制文件。source 必须可读，target 必须位于 workspace、当前项目或额外授权写入目录；workspace 内写入免确认。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source_path: { type: 'string', description: '源文件路径。' },
              target_path: { type: 'string', description: '目标文件路径。' },
              overwrite: { type: 'boolean', description: '目标存在时是否覆盖；默认 false。' }
            },
            required: ['source_path', 'target_path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: MOVE_TOOL_NAME,
          description: '移动或重命名文件。source 和 target 必须位于可写范围；workspace 内操作免确认。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source_path: { type: 'string', description: '源文件路径。' },
              target_path: { type: 'string', description: '目标文件路径。' },
              overwrite: { type: 'boolean', description: '目标存在时是否覆盖；默认 false。' }
            },
            required: ['source_path', 'target_path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: DELETE_TOOL_NAME,
          description: [
            '删除文件或目录。默认移动到 workspace/.neo-trash/<timestamp>-<relativePath>，可恢复。',
            'permanent=true 表示永久删除，必须经过交互确认；没有确认回调时会被拒绝。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: '要删除的文件或目录路径，必须位于可写范围。' },
              permanent: { type: 'boolean', description: '是否永久删除；默认 false，会移动到 workspace trash。' }
            },
            required: ['path']
          }
        }
      }
    ];
  }

  canExecute(name: string): boolean {
    return [
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      WRITE_TOOL_NAME,
      APPEND_TOOL_NAME,
      EDIT_TOOL_NAME,
      LIST_TOOL_NAME,
      MKDIR_TOOL_NAME,
      COPY_TOOL_NAME,
      MOVE_TOOL_NAME,
      DELETE_TOOL_NAME
    ].includes(name);
  }

  executionMode(name: string): 'parallel' | 'exclusive' {
    return [WRITE_TOOL_NAME, APPEND_TOOL_NAME, EDIT_TOOL_NAME, MKDIR_TOOL_NAME, COPY_TOOL_NAME, MOVE_TOOL_NAME, DELETE_TOOL_NAME].includes(name) ? 'exclusive' : 'parallel';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<{ content: string; record: FileToolCallRecord }> {
    throwIfAborted(options.signal);
    if (call.function.name === READ_TOOL_NAME) return this.read(call.function.arguments, options.signal);
    if (call.function.name === GLOB_TOOL_NAME) return this.glob(call.function.arguments, options.signal);
    if (call.function.name === GREP_TOOL_NAME) return this.grep(call.function.arguments, options.signal);
    if (call.function.name === WRITE_TOOL_NAME) return this.write(call.function.arguments, options.signal);
    if (call.function.name === APPEND_TOOL_NAME) return this.append(call.function.arguments, options.signal);
    if (call.function.name === EDIT_TOOL_NAME) return this.edit(call.function.arguments, options.signal);
    if (call.function.name === LIST_TOOL_NAME) return this.list(call.function.arguments, options.signal);
    if (call.function.name === MKDIR_TOOL_NAME) return this.mkdirTool(call.function.arguments, options.signal);
    if (call.function.name === COPY_TOOL_NAME) return this.copy(call.function.arguments, options.signal);
    if (call.function.name === MOVE_TOOL_NAME) return this.move(call.function.arguments, options.signal);
    if (call.function.name === DELETE_TOOL_NAME) return this.delete(call.function.arguments, options.signal);
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
    const fileKind = await inspectReadableFile(filePath, fileStat.size);
    if (fileKind.kind === 'image') {
      const content = formatImageSummary(this.relativeToScope(filePath), fileKind);
      return {
        content,
        record: {
          name: READ_TOOL_NAME,
          path: this.relativeToScope(filePath),
          operation: 'read',
          resultChars: content.length,
          durationMs: Date.now() - start
        }
      };
    }
    if (fileKind.kind === 'pdf') {
      const content = formatPdfSummary(this.relativeToScope(filePath), fileKind);
      return {
        content,
        record: {
          name: READ_TOOL_NAME,
          path: this.relativeToScope(filePath),
          operation: 'read',
          resultChars: content.length,
          durationMs: Date.now() - start
        }
      };
    }
    if (fileKind.kind === 'binary') throw new Error(formatBinaryReadError(this.relativeToScope(filePath), fileKind));
    if (fileStat.size > maxReadBytes) {
      throw new Error([
        `Read 单次最大读取预算为 ${formatBytes(maxReadBytes)}，当前文件 ${this.relativeToScope(filePath)} 为 ${formatBytes(fileStat.size)}。`,
        'offset/limit 只限制返回行数，不能绕过总字节预算。',
        '恢复建议：先用 Grep 定位关键符号或字符串，或把目标内容拆成更小的文本文件后再读取。'
      ].join(' '));
    }
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 2000;
    const selected = lines.slice(offset, offset + limit);
    const content = selected
      .map((line, index) => `${String(offset + index + 1).padStart(6, ' ')}\t${line}`)
      .join('\n') || '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';
    const endLine = Math.min(lines.length, offset + selected.length);
    const pagination = [
      `[Showing lines ${selected.length > 0 ? offset + 1 : offset}-${endLine} of ${lines.length}; offset=${offset}; limit=${limit}]`,
      offset + limit < lines.length ? '[结果已截断，请使用 offset/limit 继续读取]' : ''
    ].filter(Boolean).join('\n');
    const output = `${this.relativeToScope(filePath)}\n${pagination}\n${content}`;
    return {
      content: truncate(output, maxReadOutputChars),
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
    const target = await this.resolveWritableTarget(input.file_path, { allowMissingParentInWorkspace: true });
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

  private async append(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = appendInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const mode = input.mode ?? 'append';
    const target = await this.resolveWritableTarget(input.file_path, { allowMissingParentInWorkspace: true });
    const existing = await readFile(target, 'utf8').catch(() => undefined);
    const nextChars = mode === 'create'
      ? input.content.length
      : (existing?.length ?? 0) + input.content.length;
    await this.requireWritePermission({
      toolName: APPEND_TOOL_NAME,
      path: this.relativeToScope(target),
      operation: mode === 'create' && existing === undefined ? 'create' : 'append',
      summary: mode === 'create'
        ? (existing === undefined ? '创建文件并写入第一块' : '清空文件并写入第一块')
        : '追加文件分块内容',
      oldChars: existing?.length,
      newChars: nextChars,
      permissionRequired: !this.isInsideWorkspace(target)
    });
    throwIfAborted(signal);
    await mkdir(path.dirname(target), { recursive: true });
    if (mode === 'create') await writeFile(target, input.content, 'utf8');
    else await appendFile(target, input.content, 'utf8');
    const content = `${mode === 'create' ? 'initialized' : 'appended'} ${this.relativeToScope(target)} (+${input.content.length} chars, total=${nextChars} chars)`;
    return {
      content,
      record: {
        name: APPEND_TOOL_NAME,
        path: this.relativeToScope(target),
        operation: 'append',
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

  private async list(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = listInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const base = await this.resolveReadablePath(input.path ?? this.workspaceRealPath ?? 'workspace');
    const baseStat = await stat(base);
    if (!baseStat.isDirectory()) throw new Error(`List path 必须是目录：${input.path ?? 'workspace'}`);
    const limit = input.limit ?? 200;
    const entries = input.recursive
      ? await this.walkEntries(base, limit, signal)
      : await this.readDirectoryEntries(base, limit);
    const lines = entries.map(entry => `${entry.kind}\t${entry.path}${entry.size === undefined ? '' : `\t${formatBytes(entry.size)}`}`);
    const content = lines.length > 0 ? lines.join('\n') : 'No entries found';
    return {
      content,
      record: {
        name: LIST_TOOL_NAME,
        path: this.relativeToScope(base),
        operation: 'list',
        resultCount: entries.length,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async mkdirTool(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = mkdirInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const target = await this.resolveWritableDirectoryTarget(input.path);
    await this.requireWritePermission({
      toolName: MKDIR_TOOL_NAME,
      path: this.relativeToScope(target),
      operation: 'mkdir',
      summary: '创建目录',
      newChars: 0,
      permissionRequired: !this.isInsideWorkspace(target)
    });
    throwIfAborted(signal);
    await mkdir(target, { recursive: true });
    const content = `created directory ${this.relativeToScope(target)}`;
    return {
      content,
      record: {
        name: MKDIR_TOOL_NAME,
        path: this.relativeToScope(target),
        operation: 'mkdir',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async copy(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = copyInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const source = await this.resolveReadablePath(input.source_path);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error(`Copy source 只能是文件：${input.source_path}`);
    const target = await this.resolveWritableTarget(input.target_path, { allowMissingParentInWorkspace: true });
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !input.overwrite) throw new Error(`Copy target 已存在，请设置 overwrite=true：${this.relativeToScope(target)}`);
    await this.requireWritePermission({
      toolName: COPY_TOOL_NAME,
      path: this.relativeToScope(target),
      operation: 'copy',
      summary: `复制 ${this.relativeToScope(source)} 到目标路径`,
      oldChars: existing?.size,
      newChars: sourceStat.size,
      permissionRequired: !this.isInsideWorkspace(target)
    });
    throwIfAborted(signal);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const content = `copied ${this.relativeToScope(source)} -> ${this.relativeToScope(target)}`;
    return {
      content,
      record: {
        name: COPY_TOOL_NAME,
        path: this.relativeToScope(source),
        targetPath: this.relativeToScope(target),
        operation: 'copy',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async move(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = moveInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const source = await this.resolveWritableExisting(input.source_path);
    const sourceStat = await stat(source);
    const target = await this.resolveWritableTarget(input.target_path, { allowMissingParentInWorkspace: true });
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !input.overwrite) throw new Error(`Move target 已存在，请设置 overwrite=true：${this.relativeToScope(target)}`);
    await this.requireWritePermission({
      toolName: MOVE_TOOL_NAME,
      path: `${this.relativeToScope(source)} -> ${this.relativeToScope(target)}`,
      operation: 'move',
      summary: '移动或重命名文件/目录',
      oldChars: sourceStat.size,
      newChars: sourceStat.size,
      permissionRequired: !this.isInsideWorkspace(source) || !this.isInsideWorkspace(target)
    });
    throwIfAborted(signal);
    await mkdir(path.dirname(target), { recursive: true });
    if (existing && input.overwrite) await rm(target, { recursive: true, force: true });
    await rename(source, target);
    const content = `moved ${this.relativeToScope(source)} -> ${this.relativeToScope(target)}`;
    return {
      content,
      record: {
        name: MOVE_TOOL_NAME,
        path: this.relativeToScope(source),
        targetPath: this.relativeToScope(target),
        operation: 'move',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async delete(rawArguments: string, signal?: AbortSignal): Promise<{ content: string; record: FileToolCallRecord }> {
    const input = deleteInputSchema.parse(parseJsonObject(rawArguments));
    const start = Date.now();
    throwIfAborted(signal);
    const target = await this.resolveWritableExisting(input.path);
    const targetStat = await stat(target);
    const permanent = input.permanent ?? false;
    const trashTarget = permanent ? undefined : await this.buildTrashTarget(target);
    await this.requireWritePermission({
      toolName: DELETE_TOOL_NAME,
      path: this.relativeToScope(target),
      operation: 'delete',
      summary: permanent ? '永久删除文件或目录' : `移动到 trash：${trashTarget ? this.relativeToScope(trashTarget) : '(unknown)'}`,
      oldChars: targetStat.size,
      newChars: 0,
      permissionRequired: permanent || !this.isInsideWorkspace(target),
      permanent
    });
    throwIfAborted(signal);
    if (permanent) {
      await rm(target, { recursive: true, force: true });
      const content = `permanently deleted ${this.relativeToScope(target)}`;
      return {
        content,
        record: {
          name: DELETE_TOOL_NAME,
          path: this.relativeToScope(target),
          operation: 'delete',
          resultChars: content.length,
          durationMs: Date.now() - start
        }
      };
    }
    await mkdir(path.dirname(trashTarget!), { recursive: true });
    await rename(target, trashTarget!);
    const content = `moved to trash ${this.relativeToScope(target)} -> ${this.relativeToScope(trashTarget!)}`;
    return {
      content,
      record: {
        name: DELETE_TOOL_NAME,
        path: this.relativeToScope(target),
        targetPath: this.relativeToScope(trashTarget!),
        operation: 'delete',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async requireWritePermission(request: FilePermissionRequest): Promise<void> {
    const permission = evaluateFileWritePermission({
      toolName: request.toolName,
      path: request.path,
      operation: request.operation,
      permissionRequired: request.permissionRequired,
      interactive: Boolean(this.permissionAsker)
    });
    this.hooks?.emit('PermissionRequest', request.toolName, {
      path: request.path,
      operation: request.operation,
      oldChars: request.oldChars,
      newChars: request.newChars,
      permissionRequired: request.permissionRequired,
      permissionCode: permission.code
    });
    if (permission.behavior === 'allow') return;
    if (permission.behavior === 'deny') throw new Error(permission.reason);
    const asker = this.permissionAsker;
    if (!asker) throw new Error(permission.reason);
    const decision = await asker(request);
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

  private async readDirectoryEntries(directory: string, limit: number): Promise<Array<{ path: string; kind: string; size?: number }>> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const output: Array<{ path: string; kind: string; size?: number }> = [];
    for (const entry of entries.slice(0, limit)) {
      if (ignoredDirectories.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const entryStat = await lstat(fullPath).catch(() => undefined);
      if (!entryStat || entryStat.isSymbolicLink()) continue;
      output.push({
        path: this.relativeToScope(fullPath),
        kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size: entry.isFile() ? entryStat.size : undefined
      });
      if (output.length >= limit) break;
    }
    return output;
  }

  private async walkEntries(directory: string, limit: number, signal?: AbortSignal): Promise<Array<{ path: string; kind: string; size?: number }>> {
    const output: Array<{ path: string; kind: string; size?: number }> = [];
    const queue = [directory];
    while (queue.length > 0 && output.length < limit) {
      throwIfAborted(signal);
      const current = queue.shift()!;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (ignoredDirectories.has(entry.name)) continue;
        const fullPath = path.join(current, entry.name);
        const entryStat = await lstat(fullPath).catch(() => undefined);
        if (!entryStat || entryStat.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(fullPath);
        output.push({
          path: this.relativeToScope(fullPath),
          kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size: entry.isFile() ? entryStat.size : undefined
        });
        if (output.length >= limit) break;
      }
    }
    return output;
  }

  private async resolveReadablePath(inputPath: string): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const resolved = await realpath(absolute).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        throw new Error(`路径不存在：${inputPath}。当前项目根目录是 ${root}；请先用 Glob 查找文件，或确认传入的是 workspace/项目/额外授权读取目录内的路径。`);
      }
      throw error;
    });
    if (!this.isInsideReadScope(resolved)) {
      throw new Error(`文件工具拒绝读取越界路径：${inputPath}。允许范围：当前项目目录、workspace 和 files.additionalReadDirs / additionalWriteDirs 中的目录。`);
    }
    return resolved;
  }

  private async resolveWritableTarget(inputPath: string, options: { allowMissingParentInWorkspace?: boolean } = {}): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
    const parent = await realpath(path.dirname(absolute)).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        if (options.allowMissingParentInWorkspace && this.workspaceRealPath && pathInsideRoot(path.dirname(absolute), this.workspaceRealPath)) {
          return path.dirname(absolute);
        }
        throw new Error(`写入目标父目录不存在：${path.dirname(inputPath)}。workspace 内会自动创建父目录；项目/授权写入目录需要父目录已存在。`);
      }
      throw error;
    });
    if (!this.isInsideWriteScope(parent)) {
      throw new Error(`文件工具拒绝写入越界路径：${inputPath}。允许范围：当前项目目录、workspace 和 files.additionalWriteDirs 中的目录；项目目录写入仍需要用户确认。`);
    }
    const target = path.resolve(parent, path.basename(absolute));
    if (!this.isInsideWriteScope(target)) {
      throw new Error(`文件工具拒绝写入越界路径：${inputPath}。允许范围：当前项目目录、workspace 和 files.additionalWriteDirs 中的目录；项目目录写入仍需要用户确认。`);
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error(`拒绝写入符号链接：${inputPath}`);
    if (existing && !existing.isFile()) throw new Error(`Write/Edit 只能写入文件：${inputPath}`);
    return target;
  }

  private async resolveWritableExisting(inputPath: string): Promise<string> {
    const resolved = await this.resolveReadablePath(inputPath);
    if (!this.isInsideWriteScope(resolved)) {
      throw new Error(`文件工具拒绝写入越界路径：${inputPath}。允许范围：workspace、当前项目目录和 files.additionalWriteDirs。`);
    }
    return resolved;
  }

  private async resolveWritableDirectoryTarget(inputPath: string): Promise<string> {
    const root = this.rootRealPath ?? await realpath(this.projectRoot);
    this.rootRealPath = root;
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
    const existing = await realpath(absolute).catch(() => undefined);
    if (existing) {
      const existingStat = await stat(existing);
      if (!existingStat.isDirectory()) throw new Error(`Mkdir 目标已存在但不是目录：${inputPath}`);
      if (!this.isInsideWriteScope(existing)) throw new Error(`文件工具拒绝创建越界目录：${inputPath}`);
      return existing;
    }
    const parent = await realpath(path.dirname(absolute)).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        if (this.workspaceRealPath && pathInsideRoot(path.dirname(absolute), this.workspaceRealPath)) return this.workspaceRealPath;
        throw new Error(`Mkdir 父目录不存在：${path.dirname(inputPath)}。workspace 内会自动创建父目录；项目/授权写入目录需要父目录已存在。`);
      }
      throw error;
    });
    if (!this.isInsideWriteScope(parent)) throw new Error(`文件工具拒绝创建越界目录：${inputPath}`);
    if (this.workspaceRealPath && pathInsideRoot(absolute, this.workspaceRealPath)) return absolute;
    return path.resolve(parent, path.relative(parent, absolute));
  }

  private async buildTrashTarget(target: string): Promise<string> {
    if (!this.workspaceRealPath) throw new Error('workspace 尚未初始化，无法使用 trash。');
    const relative = this.relativeToScope(target).replace(/^[./\\]+/, '').replace(/[\\/]+/g, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.workspaceRealPath, '.neo-trash', `${stamp}-${relative || path.basename(target)}`);
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
    '- 你可以使用 Read 读取当前项目目录、workspace 目录和已授权额外目录内的文本文件，使用 List/Glob/Grep 查找文件和内容。',
    '- Read 会拒绝普通二进制文件；图片和 PDF 只返回元数据摘要，不会把原始字节塞进上下文。',
    '- workspace 目录是 neo 的默认可写工作区，Write/Append/Edit/List/Mkdir/Copy/Move/Delete 在 workspace 内拥有完整文件管理能力；项目目录和额外写入目录的写入仍必须经过用户权限确认。',
    '- Write 在 workspace 内会自动创建父目录。它适合短文件或完整覆盖，不适合一次性写入很长代码。',
    '- 长文件、HTML/CSS/JS、落地页和完整单文件应用必须优先写入 workspace/<name>，并使用 Append 分块写入：第一块 mode=create，后续块 mode=append，每块 content 控制在 4000 字符以内。不要把完整长代码直接刷屏。',
    '- Delete 默认移动到 workspace/.neo-trash；只有用户明确要求且权限确认后才能 permanent=true 永久删除。',
    '- 优先用 Glob/Grep 定位文件，再用 Read 读取必要片段；offset/limit 只控制返回行数，不能绕过总字节预算。',
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

type ReadableFileKind =
  | { kind: 'text'; size: number }
  | { kind: 'image'; size: number; mimeType: string; dimensions?: { width: number; height: number } }
  | { kind: 'pdf'; size: number; estimatedPages?: number }
  | { kind: 'binary'; size: number; reason: string; extension?: string };

async function inspectReadableFile(filePath: string, size: number): Promise<ReadableFileKind> {
  const ext = path.extname(filePath).toLowerCase();
  const header = await readFileHeader(filePath, 8192);
  if (isPdf(header, ext)) {
    return {
      kind: 'pdf',
      size,
      estimatedPages: await estimatePdfPages(filePath, size)
    };
  }
  const image = detectImage(header, ext);
  if (image) {
    return {
      kind: 'image',
      size,
      mimeType: image.mimeType,
      dimensions: image.dimensions
    };
  }
  if (knownBinaryExtensions.has(ext)) {
    return {
      kind: 'binary',
      size,
      extension: ext,
      reason: `扩展名 ${ext} 通常是二进制格式`
    };
  }
  if (looksBinary(header)) {
    return {
      kind: 'binary',
      size,
      extension: ext || undefined,
      reason: '文件头包含 NUL 或大量不可打印字节'
    };
  }
  return { kind: 'text', size };
}

async function readFileHeader(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isPdf(header: Buffer, ext: string): boolean {
  return pdfExtensions.has(ext) || header.subarray(0, 5).toString('ascii') === '%PDF-';
}

function detectImage(header: Buffer, ext: string): { mimeType: string; dimensions?: { width: number; height: number } } | undefined {
  const extensionMime = imageExtensions.get(ext);
  if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      mimeType: 'image/png',
      dimensions: { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    };
  }
  if (header.length >= 10 && header.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return {
      mimeType: 'image/gif',
      dimensions: { width: header.readUInt16LE(6), height: header.readUInt16LE(8) }
    };
  }
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp' };
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8) {
    return { mimeType: 'image/jpeg', dimensions: jpegDimensions(header) };
  }
  if (extensionMime) return { mimeType: extensionMime };
  return undefined;
}

function jpegDimensions(header: Buffer): { width: number; height: number } | undefined {
  let index = 2;
  while (index + 8 < header.length) {
    if (header[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = header[index + 1];
    const length = header.readUInt16BE(index + 2);
    if (length < 2) return undefined;
    if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3 && index + 8 < header.length) {
      return {
        height: header.readUInt16BE(index + 5),
        width: header.readUInt16BE(index + 7)
      };
    }
    index += 2 + length;
  }
  return undefined;
}

function looksBinary(header: Buffer): boolean {
  if (header.length === 0) return false;
  let suspicious = 0;
  for (const byte of header) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / header.length > 0.3;
}

async function estimatePdfPages(filePath: string, size: number): Promise<number | undefined> {
  if (size > maxReadBytes) return undefined;
  const raw = await readFile(filePath, 'latin1').catch(() => '');
  const matches = raw.match(/\/Type\s*\/Page\b/g);
  return matches?.length;
}

function formatImageSummary(filePath: string, file: Extract<ReadableFileKind, { kind: 'image' }>): string {
  return [
    `Image file: ${filePath}`,
    `mimeType=${file.mimeType}`,
    `size=${formatBytes(file.size)}`,
    file.dimensions ? `dimensions=${file.dimensions.width}x${file.dimensions.height}` : 'dimensions=unknown',
    'Read does not inline image bytes. 如需视觉分析，请在用户输入中用 @path 附加图片，或让用户明确提供图片附件。'
  ].join('\n');
}

function formatPdfSummary(filePath: string, file: Extract<ReadableFileKind, { kind: 'pdf' }>): string {
  return [
    `PDF file: ${filePath}`,
    `size=${formatBytes(file.size)}`,
    `estimatedPages=${file.estimatedPages ?? 'unknown'}`,
    'Read 目前不直接抽取 PDF 正文。恢复建议：使用专门的 PDF 提取工具或让用户提供已转换文本；大 PDF 应先限定页码或转换为文本片段。'
  ].join('\n');
}

function formatBinaryReadError(filePath: string, file: Extract<ReadableFileKind, { kind: 'binary' }>): string {
  return [
    `Read 拒绝读取二进制文件：${filePath} (${formatBytes(file.size)})。`,
    `原因：${file.reason}。`,
    '恢复建议：如果这是图片或 PDF，请确认扩展名/文件头正确；如果需要分析二进制，请使用专门解析工具生成文本摘要后再读取。'
  ].join(' ');
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
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
