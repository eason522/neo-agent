import type { ChatToolCall, ChatToolDefinition, McpToolCallRecord } from '../types.js';
import type { ToolRunner } from '../tools/tool.js';
import type { McpManager, McpToolDetail } from './mcpManager.js';

export class McpToolRunner implements ToolRunner<McpToolCallRecord> {
  private tools: McpToolDetail[] = [];

  constructor(private readonly mcp: McpManager) {}

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
    '- MCP 工具来自外部系统，可能读取或修改外部数据。使用前要根据工具描述判断风险。',
    '- 对不确定是否会修改外部状态的 MCP 工具，要在回答中保持谨慎；后续会加入更完整的权限确认。'
  ].join('\n');
}

function buildDescription(tool: McpToolDetail): string {
  const hints = [
    tool.readOnlyHint ? 'readOnly' : '',
    tool.destructiveHint ? 'destructive' : '',
    tool.openWorldHint ? 'openWorld' : ''
  ].filter(Boolean);
  return [
    `${tool.serverName}.${tool.toolName}`,
    tool.description ?? 'MCP tool',
    hints.length > 0 ? `Hints: ${hints.join(', ')}` : ''
  ].filter(Boolean).join('\n');
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
