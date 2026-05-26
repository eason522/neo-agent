import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig, ChatToolCall, ChatToolDefinition, ExecutionToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolExecutionResult, ToolRunner } from './tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { HookBus } from '../hooks/hookBus.js';
import { stableId } from '../utils/fs.js';

export const BASH_TOOL_NAME = 'Bash';
export const PYTHON_TOOL_NAME = 'Python';

const bashInputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  description: z.string().optional(),
  cwd: z.string().optional()
});

const pythonInputSchema = z.object({
  code: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  description: z.string().optional()
});

export type ExecutionPermissionRequest = {
  toolName: typeof BASH_TOOL_NAME | typeof PYTHON_TOOL_NAME;
  command: string;
  cwd: string;
  description?: string;
  risk: 'low' | 'high';
  reason: string;
};

export type ExecutionPermissionAsker = (request: ExecutionPermissionRequest) => Promise<'allow' | 'deny'>;

const maxOutputChars = 80_000;
const defaultTimeoutMs = 120_000;

export class ExecutionToolRunner implements ToolRunner<ExecutionToolCallRecord> {
  private projectRealPath: string | undefined;
  private workspaceRealPath: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly projectRoot = process.cwd(),
    private permissionAsker?: ExecutionPermissionAsker,
    private readonly hooks?: HookBus
  ) {}

  setPermissionAsker(permissionAsker: ExecutionPermissionAsker | undefined): void {
    this.permissionAsker = permissionAsker;
  }

  hasPermissionAsker(): boolean {
    return Boolean(this.permissionAsker);
  }

  async refresh(): Promise<void> {
    this.projectRealPath = await realpath(this.projectRoot);
    const workspace = path.isAbsolute(this.config.workspace.dir)
      ? this.config.workspace.dir
      : path.resolve(this.projectRealPath, this.config.workspace.dir);
    await mkdir(workspace, { recursive: true });
    this.workspaceRealPath = await realpath(workspace);
  }

  definitions(): ChatToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: BASH_TOOL_NAME,
          description: [
            '在 workspace 内运行 shell 命令。默认 cwd 是 workspace；cwd 若提供，必须位于 workspace 内。',
            '只读低风险命令会自动执行；写入、删除、安装、网络、git mutation、权限变更、后台进程等高风险命令必须用户确认。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              command: { type: 'string', description: '要执行的 shell 命令。' },
              timeoutMs: { type: 'number', description: '超时时间，默认 120000，最大 600000。' },
              description: { type: 'string', description: '一句话说明为什么需要执行。' },
              cwd: { type: 'string', description: '可选。必须位于 workspace 内。' }
            },
            required: ['command']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: PYTHON_TOOL_NAME,
          description: [
            '在 workspace 内运行临时 Python 脚本。脚本写入 workspace/.neo-agent/tmp/python-*.py，cwd 为 workspace。',
            'Python 默认属于高风险任意代码执行，每次都必须用户确认。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', description: 'Python 代码。' },
              args: { type: 'array', items: { type: 'string' }, description: '传给脚本的命令行参数。' },
              timeoutMs: { type: 'number', description: '超时时间，默认 120000，最大 600000。' },
              description: { type: 'string', description: '一句话说明为什么需要执行。' }
            },
            required: ['code']
          }
        }
      }
    ];
  }

  canExecute(name: string): boolean {
    return name === BASH_TOOL_NAME || name === PYTHON_TOOL_NAME;
  }

  executionMode(): 'exclusive' {
    return 'exclusive';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult<ExecutionToolCallRecord>> {
    throwIfAborted(options.signal);
    if (call.function.name === BASH_TOOL_NAME) return this.runBash(call.function.arguments, options.signal);
    if (call.function.name === PYTHON_TOOL_NAME) return this.runPython(call.function.arguments, options.signal);
    throw new Error(`未知执行工具：${call.function.name}`);
  }

  private async runBash(rawArguments: string, signal?: AbortSignal): Promise<ToolExecutionResult<ExecutionToolCallRecord>> {
    const input = bashInputSchema.parse(parseJsonObject(rawArguments));
    const cwd = await this.resolveWorkspaceCwd(input.cwd);
    const risk = classifyBashCommand(input.command);
    await this.requirePermission({
      toolName: BASH_TOOL_NAME,
      command: input.command,
      cwd: this.relativeToWorkspace(cwd),
      description: input.description,
      risk: risk.risk,
      reason: risk.reason
    });
    return this.spawnProcess(BASH_TOOL_NAME, input.command, [], {
      shell: true,
      cwd,
      timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
      signal
    });
  }

  private async runPython(rawArguments: string, signal?: AbortSignal): Promise<ToolExecutionResult<ExecutionToolCallRecord>> {
    const input = pythonInputSchema.parse(parseJsonObject(rawArguments));
    const workspace = await this.ensureWorkspace();
    const tmpDir = path.join(workspace, '.neo-agent', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const scriptPath = path.join(tmpDir, `${stableId('python')}.py`);
    await writeFile(scriptPath, input.code, 'utf8');
    await this.requirePermission({
      toolName: PYTHON_TOOL_NAME,
      command: `python3 ${this.relativeToWorkspace(scriptPath)} ${(input.args ?? []).join(' ')}`.trim(),
      cwd: this.relativeToWorkspace(workspace),
      description: input.description,
      risk: 'high',
      reason: 'Python 是任意代码执行，默认每次确认。'
    });
    return this.spawnProcess(PYTHON_TOOL_NAME, 'python3', [scriptPath, ...(input.args ?? [])], {
      cwd: workspace,
      timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
      signal
    });
  }

  private async requirePermission(request: ExecutionPermissionRequest): Promise<void> {
    this.hooks?.emit('PermissionRequest', request.toolName, request);
    if (request.risk === 'low') return;
    if (!this.permissionAsker) throw new Error(`${request.toolName} 需要交互式权限确认：${request.reason}`);
    const decision = await this.permissionAsker(request);
    if (decision !== 'allow') throw new Error(`用户拒绝执行：${request.toolName}`);
  }

  private async spawnProcess(
    name: typeof BASH_TOOL_NAME | typeof PYTHON_TOOL_NAME,
    command: string,
    args: string[],
    options: {
      cwd: string;
      timeoutMs: number;
      signal?: AbortSignal;
      shell?: boolean;
    }
  ): Promise<ToolExecutionResult<ExecutionToolCallRecord>> {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const appendStdout = (chunk: Buffer): void => {
      stdout = truncateTail(stdout + chunk.toString(), maxOutputChars);
    };
    const appendStderr = (chunk: Buffer): void => {
      stderr = truncateTail(stderr + chunk.toString(), maxOutputChars);
    };
    child.stdout?.on('data', appendStdout);
    child.stderr?.on('data', appendStderr);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs);
    const abort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code));
    }).finally(() => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    });
    const durationMs = Date.now() - start;
    const content = formatExecutionResult({
      name,
      command: [command, ...args].join(' '),
      cwd: this.relativeToWorkspace(options.cwd),
      exitCode,
      timedOut,
      durationMs,
      stdout,
      stderr
    });
    return {
      content,
      record: {
        name,
        command: [command, ...args].join(' '),
        cwd: this.relativeToWorkspace(options.cwd),
        exitCode,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        durationMs,
        timedOut
      }
    };
  }

  private async resolveWorkspaceCwd(input?: string): Promise<string> {
    const workspace = await this.ensureWorkspace();
    if (!input) return workspace;
    const absolute = path.isAbsolute(input) ? input : path.resolve(workspace, input);
    const resolved = await realpath(absolute);
    if (!pathInsideRoot(resolved, workspace)) throw new Error(`Bash cwd 必须位于 workspace 内：${input}`);
    return resolved;
  }

  private async ensureWorkspace(): Promise<string> {
    if (!this.workspaceRealPath) await this.refresh();
    return this.workspaceRealPath!;
  }

  private relativeToWorkspace(filePath: string): string {
    const workspace = this.workspaceRealPath;
    if (!workspace || !pathInsideRoot(filePath, workspace)) return filePath;
    return path.relative(workspace, filePath) || '.';
  }
}

function classifyBashCommand(command: string): { risk: 'low' | 'high'; reason: string } {
  const normalized = command.trim();
  const first = normalized.split(/\s+/)[0]?.replace(/^command\s+/, '') ?? '';
  const lowRisk = /^(pwd|ls|find|rg|grep|cat|head|tail|wc|stat|file|du|tree)$/;
  const highRiskPattern = /(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|sudo|su|git\s+(commit|push|pull|merge|rebase|reset|checkout|switch|branch|tag|clean|add|restore)|npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go\s+(get|install)|curl|wget|ssh|scp|rsync|export|set\s+-|nohup|systemctl|service)\b|[>&|;`$()]|&&|\|\|/i;
  if (!lowRisk.test(first) || highRiskPattern.test(normalized)) {
    return { risk: 'high', reason: '命令可能写入、删除、联网、安装、修改 git/权限、启动后台进程，或包含 shell 组合/重定向。' };
  }
  return { risk: 'low', reason: '只读低风险命令。' };
}

function formatExecutionResult(input: {
  name: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}): string {
  return [
    `${input.name} command: ${redactSecrets(input.command)}`,
    `cwd: ${input.cwd}`,
    `exitCode: ${input.exitCode}${input.timedOut ? ' (timed out)' : ''}`,
    `durationMs: ${input.durationMs}`,
    'stdout:',
    input.stdout || '(empty)',
    'stderr:',
    input.stderr || '(empty)'
  ].join('\n');
}

function truncateTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `[truncated ${input.length - maxChars} chars]\n${input.slice(-maxChars)}`;
}

function redactSecrets(input: string): string {
  return input.replace(/(api[_-]?key|token|password|secret)=\S+/gi, '$1=[redacted]');
}

function pathInsideRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}${path.sep}`);
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`执行工具参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}

export function getExecutionToolPrompt(): string {
  return [
    '# Shell/Python 工具',
    '- Bash 默认在 workspace 内执行；cwd 必须位于 workspace 内。只读低风险命令可自动执行，高风险命令需要用户确认。',
    '- Python 会写入 workspace/.neo-agent/tmp/python-*.py 并在 workspace 内运行；Python 默认每次确认。',
    '- 所有命令都有超时、stdout/stderr 截断、退出码和耗时。不要用 Bash/Python 绕过文件工具权限；文件生成优先使用 Write。'
  ].join('\n');
}
