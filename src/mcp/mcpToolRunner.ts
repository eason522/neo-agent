import type { AppConfig, ChatToolCall, ChatToolDefinition, McpToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { McpManager, McpToolDetail } from './mcpManager.js';

export type McpPermissionDecision = 'allow_once' | 'allow_always' | 'deny' | 'deny_always';

export type McpPermissionAskRequest = {
  toolName: string;
  fullName: string;
  serverName: string;
  description?: string;
  reason: string;
  risk: string;
  argumentKeys: string[];
  argumentChars: number;
};

export type McpPermissionAsker = (request: McpPermissionAskRequest) => Promise<McpPermissionDecision>;
export type McpPermissionPersister = (toolName: string, behavior: 'allow' | 'deny') => Promise<void>;

type McpPermissionEvaluation =
  | { allowed: true; reason: string; code: 'explicit_allowed' | 'allow_all' | 'read_only' | 'allowed_once' }
  | { allowed: false; reason: string; code: 'explicit_denied' | 'needs_user_permission' };

export class McpToolRunner implements ToolRunner<McpToolCallRecord> {
  private tools: McpToolDetail[] = [];
  private activeToolNames = new Set<string>();
  private permissionAsker?: McpPermissionAsker;

  constructor(
    private readonly mcp: McpManager,
    private readonly permissions: AppConfig['mcp']['permissions'],
    private readonly toolSearchThreshold: number,
    permissionAsker?: McpPermissionAsker,
    private readonly permissionPersister?: McpPermissionPersister
  ) {
    this.permissionAsker = permissionAsker;
  }

  setPermissionAsker(permissionAsker: McpPermissionAsker | undefined): void {
    this.permissionAsker = permissionAsker;
  }

  async refresh(): Promise<void> {
    this.tools = await this.mcp.listToolDetails().catch(() => []);
    if (!this.shouldDeferTools()) {
      this.activeToolNames = new Set(this.tools.map(tool => tool.fullName));
      return;
    }
    this.activeToolNames = new Set([...this.activeToolNames].filter(name => this.tools.some(tool => tool.fullName === name)));
  }

  definitions(): ChatToolDefinition[] {
    return this.tools.filter(tool => this.activeToolNames.has(tool.fullName)).map(tool => ({
      type: 'function',
      function: {
        name: tool.fullName,
        description: buildDescription(tool),
        parameters: normalizeInputSchema(tool.inputSchema)
      }
    }));
  }

  canExecute(name: string): boolean {
    return this.activeToolNames.has(name) && this.tools.some(tool => tool.fullName === name);
  }

  executionMode(): 'serial' {
    return 'serial';
  }

  hasDeferredTools(): boolean {
    return this.shouldDeferTools() && this.tools.some(tool => !this.activeToolNames.has(tool.fullName));
  }

  deferredToolCount(): number {
    return this.tools.filter(tool => !this.activeToolNames.has(tool.fullName)).length;
  }

  searchDeferredTools(query: string, maxResults: number): ChatToolDefinition[] {
    const matches = this.findDeferredTools(query, maxResults);
    for (const tool of matches) this.activeToolNames.add(tool.fullName);
    return matches.map(tool => ({
      type: 'function',
      function: {
        name: tool.fullName,
        description: buildDescription(tool),
        parameters: normalizeInputSchema(tool.inputSchema)
      }
    }));
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<{ content: string; record: McpToolCallRecord }> {
    throwIfAborted(options.signal);
    const tool = this.tools.find(item => item.fullName === call.function.name);
    if (!tool) throw new Error(`未知 MCP 工具：${call.function.name}`);
    const initialPermission = evaluateMcpToolPermission(tool, this.permissions);
    if (!initialPermission.allowed && initialPermission.code !== 'needs_user_permission') throw new Error(initialPermission.reason);
    if (!initialPermission.allowed && !this.permissionAsker) throw new Error(initialPermission.reason);
    const args = parseArguments(call.function.arguments);
    const permission = await this.resolvePermission(tool, call.function.arguments, args, initialPermission);
    throwIfAborted(options.signal);
    if (!permission.allowed) throw new Error(permission.reason);
    const start = Date.now();
    const result = await this.mcp.callTool(`${tool.serverName}.${tool.toolName}`, args, { signal: options.signal });
    const content = truncate(formatMcpResult(result), 100_000);
    return {
      content,
      record: {
        name: tool.fullName,
        serverName: tool.serverName,
        toolName: tool.toolName,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  private async resolvePermission(
    tool: McpToolDetail,
    rawArguments: string,
    args: Record<string, unknown>,
    permission: McpPermissionEvaluation
  ): Promise<McpPermissionEvaluation> {
    if (permission.allowed || permission.code !== 'needs_user_permission' || !this.permissionAsker) return permission;

    const decision = await this.permissionAsker({
      toolName: tool.toolName,
      fullName: tool.fullName,
      serverName: tool.serverName,
      description: tool.description,
      reason: permission.reason,
      risk: describeMcpToolRisk(tool),
      argumentKeys: Object.keys(args).sort(),
      argumentChars: rawArguments.length
    });
    if (decision === 'allow_once') {
      return {
        allowed: true,
        reason: '用户已允许本次执行',
        code: 'allowed_once'
      };
    }
    if (decision === 'allow_always') {
      addPermissionRule(this.permissions.allowedTools, tool.fullName);
      removePermissionRule(this.permissions.deniedTools, tool.fullName);
      await this.permissionPersister?.(tool.fullName, 'allow');
      return {
        allowed: true,
        reason: '用户已持久允许执行',
        code: 'explicit_allowed'
      };
    }
    if (decision === 'deny_always') {
      addPermissionRule(this.permissions.deniedTools, tool.fullName);
      removePermissionRule(this.permissions.allowedTools, tool.fullName);
      await this.permissionPersister?.(tool.fullName, 'deny');
    }
    return {
      allowed: false,
      reason: `用户拒绝执行 MCP 工具：${tool.fullName}`,
      code: 'needs_user_permission'
    };
  }

  private shouldDeferTools(): boolean {
    return this.tools.length > this.toolSearchThreshold;
  }

  private findDeferredTools(query: string, maxResults: number): McpToolDetail[] {
    const deferred = this.tools.filter(tool => !this.activeToolNames.has(tool.fullName));
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    if (normalizedQuery.startsWith('select:')) {
      const requested = normalizedQuery.slice('select:'.length)
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
      return deferred.filter(tool => requested.includes(tool.fullName.toLowerCase()) || requested.includes(`${tool.serverName}.${tool.toolName}`.toLowerCase()));
    }
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return deferred
      .map(tool => ({ tool, score: scoreTool(tool, terms, normalizedQuery) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.fullName.localeCompare(b.tool.fullName))
      .slice(0, Math.max(1, maxResults))
      .map(item => item.tool);
  }
}

export function getMcpToolPrompt(): string {
  return [
    '# MCP 工具',
    '- 已连接的 MCP server 会以 `mcp__server__tool` 形式暴露为工具。',
    '- MCP 工具来自外部系统，可能读取或修改外部数据。使用前要根据工具描述、输入 schema 和 annotations 判断风险。',
    '- 默认只自动执行明确标记为 readOnly 且非 destructive 的 MCP 工具；其它工具在 REPL 中可能需要用户确认本次执行，非交互模式下需要用户显式加入 allowedTools。',
    '- 如果工具因权限被拒绝，要直接说明无法执行该外部操作，不要伪造执行结果。'
  ].join('\n');
}

export function evaluateMcpToolPermission(
  tool: Pick<McpToolDetail, 'fullName' | 'serverName' | 'toolName' | 'readOnlyHint' | 'destructiveHint'>,
  permissions: AppConfig['mcp']['permissions']
): McpPermissionEvaluation {
  const qualifiedName = `${tool.serverName}.${tool.toolName}`;
  if (matchesToolRule(tool.fullName, qualifiedName, permissions.deniedTools)) {
    return {
      allowed: false,
      reason: `MCP 工具已被配置拒绝：${tool.fullName}`,
      code: 'explicit_denied'
    };
  }
  if (matchesToolRule(tool.fullName, qualifiedName, permissions.allowedTools)) {
    return {
      allowed: true,
      reason: '显式允许',
      code: 'explicit_allowed'
    };
  }
  if (permissions.mode === 'allowAll') {
    return {
      allowed: true,
      reason: '权限模式允许所有 MCP 工具',
      code: 'allow_all'
    };
  }
  if (tool.readOnlyHint === true && tool.destructiveHint !== true) {
    return {
      allowed: true,
      reason: '只读 MCP 工具',
      code: 'read_only'
    };
  }
  return {
    allowed: false,
    reason: [
      `MCP 工具未获授权：${tool.fullName}`,
      '默认只自动执行 readOnly 且非 destructive 的 MCP 工具。',
      `如确认需要允许，请在 ~/.neo-agent/config.json 的 mcp.permissions.allowedTools 加入 "${tool.fullName}"，`,
      '或临时设置 NEO_AGENT_MCP_PERMISSION_MODE=allowAll。'
    ].join(' '),
    code: 'needs_user_permission'
  };
}

function buildDescription(tool: McpToolDetail): string {
  const hints = [
    tool.readOnlyHint ? 'readOnly' : '',
    tool.destructiveHint ? 'destructive' : '',
    tool.openWorldHint ? 'openWorld' : ''
  ].filter(Boolean);
  const permission = tool.readOnlyHint === true && tool.destructiveHint !== true ? '默认允许执行' : '默认需要显式授权';
  return [
    `${tool.serverName}.${tool.toolName}`,
    tool.description ?? 'MCP tool',
    hints.length > 0 ? `Hints: ${hints.join(', ')}` : '',
    `Permission: ${permission}`
  ].filter(Boolean).join('\n');
}

function describeMcpToolRisk(tool: Pick<McpToolDetail, 'readOnlyHint' | 'destructiveHint' | 'openWorldHint'>): string {
  if (tool.destructiveHint === true) return '该工具声明为 destructive，可能删除、覆盖或执行难以回退的外部操作。';
  if (tool.openWorldHint === true) return '该工具声明为 openWorld，可能访问或影响当前上下文之外的外部系统。';
  if (tool.readOnlyHint !== true) return '该工具没有明确声明为只读，可能修改外部系统或产生副作用。';
  return '该工具风险语义不完整，需要用户确认。';
}

function scoreTool(tool: McpToolDetail, terms: string[], query: string): number {
  const haystack = [
    tool.fullName,
    tool.serverName,
    tool.toolName,
    tool.description ?? ''
  ].join(' ').toLowerCase();
  if (tool.fullName.toLowerCase() === query || `${tool.serverName}.${tool.toolName}`.toLowerCase() === query) return 100;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 10;
    if (tool.fullName.toLowerCase().includes(term)) score += 5;
    if (tool.toolName.toLowerCase().includes(term)) score += 3;
    if (tool.serverName.toLowerCase().includes(term)) score += 2;
  }
  return score;
}

function matchesToolRule(fullName: string, qualifiedName: string, rules: string[]): boolean {
  return rules.some(rule => {
    const trimmed = rule.trim();
    if (!trimmed) return false;
    if (trimmed === fullName || trimmed === qualifiedName) return true;
    if (trimmed.endsWith('*')) {
      const prefix = trimmed.slice(0, -1);
      return fullName.startsWith(prefix) || qualifiedName.startsWith(prefix);
    }
    return false;
  });
}

function addPermissionRule(rules: string[], rule: string): void {
  if (!rules.includes(rule)) rules.push(rule);
}

function removePermissionRule(rules: string[], rule: string): void {
  const index = rules.indexOf(rule);
  if (index >= 0) rules.splice(index, 1);
}

function normalizeInputSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {}
    };
  }
  return inputSchema;
}

function parseArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MCP 工具参数必须是 JSON object。');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`MCP 工具参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}

function formatMcpResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}
