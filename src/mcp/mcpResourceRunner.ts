import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, McpToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { McpManager } from './mcpManager.js';

export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResources';
export const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResource';

const listInputSchema = z.object({
  server: z.string().optional()
});

const readInputSchema = z.object({
  server: z.string(),
  uri: z.string()
});

export class McpResourceRunner implements ToolRunner<McpToolCallRecord> {
  private connectedServers: string[] = [];

  constructor(private readonly mcp: McpManager) {}

  async refresh(): Promise<void> {
    this.connectedServers = this.mcp.connectedServerNames();
  }

  definitions(): ChatToolDefinition[] {
    if (this.connectedServers.length === 0) return [];
    return [
      {
        type: 'function',
        function: {
          name: LIST_MCP_RESOURCES_TOOL_NAME,
          description: [
            '列出已连接 MCP server 暴露的只读 resources。',
            '可传 server 只列出某个 server。结果包含 server、uri、name、mimeType 和 description。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              server: {
                type: 'string',
                description: '可选。MCP server 名称。'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: READ_MCP_RESOURCE_TOOL_NAME,
          description: [
            '读取某个 MCP resource 的内容。这个工具是只读的。',
            '必须先知道 server 名称和 resource uri；如果不知道，先调用 ListMcpResources。'
          ].join('\n'),
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              server: {
                type: 'string',
                description: 'MCP server 名称。'
              },
              uri: {
                type: 'string',
                description: '要读取的 MCP resource URI。'
              }
            },
            required: ['server', 'uri']
          }
        }
      }
    ];
  }

  canExecute(name: string): boolean {
    return name === LIST_MCP_RESOURCES_TOOL_NAME || name === READ_MCP_RESOURCE_TOOL_NAME;
  }

  executionMode(): 'serial' {
    return 'serial';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<{ content: string; record: McpToolCallRecord }> {
    throwIfAborted(options.signal);
    const start = Date.now();
    if (call.function.name === LIST_MCP_RESOURCES_TOOL_NAME) {
      const input = listInputSchema.parse(parseJsonObject(call.function.arguments));
      const resources = await this.mcp.listResources(input.server);
      throwIfAborted(options.signal);
      const content = truncate(JSON.stringify({
        tool: LIST_MCP_RESOURCES_TOOL_NAME,
        resources,
        instruction: resources.length === 0
          ? '没有发现 MCP resources。MCP server 仍可能提供 tools。'
          : '如需读取具体资源，请调用 ReadMcpResource，并传入 server 和 uri。'
      }, null, 2), 100_000);
      return {
        content,
        record: {
          name: LIST_MCP_RESOURCES_TOOL_NAME,
          serverName: input.server ?? '*',
          toolName: 'resources/list',
          resultChars: content.length,
          durationMs: Date.now() - start
        }
      };
    }

    const input = readInputSchema.parse(parseJsonObject(call.function.arguments));
    const contents = await this.mcp.readResource(input.server, input.uri);
    throwIfAborted(options.signal);
    const content = truncate(JSON.stringify({
      tool: READ_MCP_RESOURCE_TOOL_NAME,
      server: input.server,
      uri: input.uri,
      contents: contents.map(item => ({
        uri: item.uri,
        mimeType: item.mimeType,
        text: item.text,
        blobBytes: item.blobBytes,
        note: item.blobBytes ? '二进制 blob 没有直接写入上下文，只记录字节数。' : undefined
      }))
    }, null, 2), 100_000);
    return {
      content,
      record: {
        name: READ_MCP_RESOURCE_TOOL_NAME,
        serverName: input.server,
        toolName: 'resources/read',
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }
}

export function getMcpResourcePrompt(): string {
  return [
    '# MCP Resources',
    '- 如果 MCP server 提供 resources，你可以用 ListMcpResources 查看可读取资源，用 ReadMcpResource 读取指定 URI。',
    '- MCP resources 是只读信息源；读取后要基于内容回答，不要声称修改了外部系统。',
    '- 二进制资源不会直接进入上下文，只会返回元数据或保存提示。'
  ].join('\n');
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`MCP resource 工具参数不是有效 JSON：${rawArguments.slice(0, 300)}`);
  }
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}
