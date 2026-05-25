import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, ToolCallRecord } from '../types.js';
import type { McpToolRunner } from '../mcp/mcpToolRunner.js';
import type { ToolExecutionOptions, ToolExecutionResult, ToolRunner } from './tool.js';
import { throwIfAborted } from '../utils/abort.js';

export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

const inputSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().max(20).optional()
});

export class ToolSearchRunner implements ToolRunner<ToolCallRecord> {
  constructor(private readonly mcpToolRunner: McpToolRunner) {}

  definitions(): ChatToolDefinition[] {
    if (!this.mcpToolRunner.hasDeferredTools()) return [];
    return [{
      type: 'function',
      function: {
        name: TOOL_SEARCH_TOOL_NAME,
        description: [
          '搜索并加载尚未暴露的 MCP 工具 schema。MCP 工具很多时，neo 会先隐藏大部分工具以节省上下文。',
          '用法：query 可写关键词，也可写 select:mcp__server__tool 精确选择。返回的工具会在下一轮变成可调用工具。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: 'string',
              description: '关键词或 select:<tool_name>。例如 github issue 或 select:mcp__github__create_issue。'
            },
            max_results: {
              type: 'number',
              description: '最多加载多少个工具，默认 5，最大 20。'
            }
          },
          required: ['query']
        }
      }
    }];
  }

  canExecute(name: string): boolean {
    return name === TOOL_SEARCH_TOOL_NAME && this.mcpToolRunner.hasDeferredTools();
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult<ToolCallRecord>> {
    throwIfAborted(options.signal);
    const input = inputSchema.parse(parseJsonObject(call.function.arguments));
    const matches = this.mcpToolRunner.searchDeferredTools(input.query, input.max_results ?? 5);
    return {
      content: formatToolSearchResult(input.query, matches, this.mcpToolRunner.deferredToolCount())
    };
  }
}

export function getToolSearchPrompt(): string {
  return [
    '# ToolSearch',
    '- 当 MCP 工具很多时，部分 MCP 工具会先被延迟加载。你可以用 ToolSearch 搜索并加载这些工具。',
    '- 如果你知道工具名，使用 `select:mcp__server__tool`；如果不知道，使用 server 名、动作词或领域词搜索。',
    '- ToolSearch 返回匹配工具 schema 后，下一轮你才能调用这些工具。'
  ].join('\n');
}

function formatToolSearchResult(query: string, matches: ChatToolDefinition[], remaining: number): string {
  if (matches.length === 0) {
    return JSON.stringify({
      query,
      matches: [],
      remainingDeferredTools: remaining,
      instruction: '没有找到匹配的 deferred MCP 工具。请换一个关键词，或使用更具体的 server/tool 名称。'
    }, null, 2);
  }
  return [
    JSON.stringify({
      query,
      matches: matches.map(tool => tool.function.name),
      remainingDeferredTools: remaining,
      instruction: '这些工具已加载到下一轮 tool definitions。请在下一轮直接调用需要的工具。'
    }, null, 2),
    '<functions>',
    ...matches.map(tool => `<function>${JSON.stringify(tool.function)}</function>`),
    '</functions>'
  ].join('\n');
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`ToolSearch 参数不是有效 JSON：${rawArguments.slice(0, 300)}`);
  }
}
