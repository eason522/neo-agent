import type { AppConfig, ChatToolCall, ChatToolDefinition, McpToolCallRecord } from '../types.js';
import type { ToolRunner } from '../tools/tool.js';
import type { McpManager, McpToolDetail } from './mcpManager.js';

export class McpToolRunner implements ToolRunner<McpToolCallRecord> {
  private tools: McpToolDetail[] = [];

  constructor(private readonly mcp: McpManager, private readonly permissions: AppConfig['mcp']['permissions']) {}

  async refresh(): Promise<void> {
    this.tools = await this.mcp.listToolDetails().catch(() => []);
  }

  definitions(): ChatToolDefinition[] {
    return this.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.fullName,
        description: buildDescription(tool),
        parameters: normalizeInputSchema(tool.inputSchema)
      }
    }));
  }

  canExecute(name: string): boolean {
    return this.tools.some(tool => tool.fullName === name);
  }

  async execute(call: ChatToolCall): Promise<{ content: string; record: McpToolCallRecord }> {
    const tool = this.tools.find(item => item.fullName === call.function.name);
    if (!tool) throw new Error(`未知 MCP 工具：${call.function.name}`);
    const permission = evaluateMcpToolPermission(tool, this.permissions);
    if (!permission.allowed) throw new Error(permission.reason);
    const args = parseArguments(call.function.arguments);
    const start = Date.now();
    const result = await this.mcp.callTool(`${tool.serverName}.${tool.toolName}`, args);
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
}

export function getMcpToolPrompt(): string {
  return [
    '# MCP 工具',
    '- 已连接的 MCP server 会以 `mcp__server__tool` 形式暴露为工具。',
    '- MCP 工具来自外部系统，可能读取或修改外部数据。使用前要根据工具描述、输入 schema 和 annotations 判断风险。',
    '- 默认只允许执行明确标记为 readOnly 且非 destructive 的 MCP 工具；其它工具需要用户显式加入 allowedTools。',
    '- 如果工具因权限被拒绝，要直接说明无法执行该外部操作，不要伪造执行结果。'
  ].join('\n');
}

export function evaluateMcpToolPermission(
  tool: Pick<McpToolDetail, 'fullName' | 'serverName' | 'toolName' | 'readOnlyHint' | 'destructiveHint'>,
  permissions: AppConfig['mcp']['permissions']
): { allowed: true; reason: string } | { allowed: false; reason: string } {
  const qualifiedName = `${tool.serverName}.${tool.toolName}`;
  if (matchesToolRule(tool.fullName, qualifiedName, permissions.deniedTools)) {
    return {
      allowed: false,
      reason: `MCP 工具已被配置拒绝：${tool.fullName}`
    };
  }
  if (matchesToolRule(tool.fullName, qualifiedName, permissions.allowedTools)) {
    return {
      allowed: true,
      reason: '显式允许'
    };
  }
  if (permissions.mode === 'allowAll') {
    return {
      allowed: true,
      reason: '权限模式允许所有 MCP 工具'
    };
  }
  if (tool.readOnlyHint === true && tool.destructiveHint !== true) {
    return {
      allowed: true,
      reason: '只读 MCP 工具'
    };
  }
  return {
    allowed: false,
    reason: [
      `MCP 工具未获授权：${tool.fullName}`,
      '默认只自动执行 readOnly 且非 destructive 的 MCP 工具。',
      `如确认需要允许，请在 ~/.neo-agent/config.json 的 mcp.permissions.allowedTools 加入 "${tool.fullName}"，`,
      '或临时设置 NEO_AGENT_MCP_PERMISSION_MODE=allowAll。'
    ].join(' ')
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
    throw new Error(`MCP 工具参数不是有效 JSON：${rawArguments.slice(0, 300)}`);
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
