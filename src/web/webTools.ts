import { z } from 'zod';
import type { AppConfig, ChatToolCall, ChatToolDefinition, WebToolCallRecord } from '../types.js';
import { TavilyClient } from './tavilyClient.js';

export const WEB_SEARCH_TOOL_NAME = 'WebSearch';
export const WEB_FETCH_TOOL_NAME = 'WebFetch';

type WebToolResult = {
  content: string;
  record: WebToolCallRecord;
};

const webSearchInputSchema = z.object({
  query: z.string().min(2),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional()
});

const webFetchInputSchema = z.object({
  url: z.string().url(),
  prompt: z.string().optional()
});

export function createWebToolDefinitions(): ChatToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: WEB_SEARCH_TOOL_NAME,
        description: [
          '搜索互联网，用于获取最新、当前、近期、政策、价格、新闻、版本、人物行程、公司资料等可能变化的信息。',
          '回答中如果使用了搜索结果，必须列出来源 URL。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: 'string',
              description: '搜索查询词。需要包含足够具体的实体、时间或主题。'
            },
            allowed_domains: {
              type: 'array',
              items: { type: 'string' },
              description: '可选。只包含这些域名的搜索结果。'
            },
            blocked_domains: {
              type: 'array',
              items: { type: 'string' },
              description: '可选。排除这些域名的搜索结果。'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: WEB_FETCH_TOOL_NAME,
        description: [
          '读取一个公开 URL 的网页正文，用于分析网页、核实搜索结果、读取文档或查看用户提供的链接。',
          '不适合读取需要登录的私有页面。回答中如果使用了网页内容，必须列出来源 URL。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: {
              type: 'string',
              description: '要读取的完整 http 或 https URL。'
            },
            prompt: {
              type: 'string',
              description: '希望从页面中提取或关注的信息。'
            }
          },
          required: ['url']
        }
      }
    }
  ];
}

export class WebToolRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly tavily: TavilyClient
  ) {}

  async execute(call: ChatToolCall): Promise<WebToolResult> {
    if (call.function.name === WEB_SEARCH_TOOL_NAME) {
      return this.search(call.function.arguments);
    }
    if (call.function.name === WEB_FETCH_TOOL_NAME) {
      return this.fetch(call.function.arguments);
    }
    return {
      content: JSON.stringify({
        error: `未知联网工具：${call.function.name}`
      }),
      record: {
        name: WEB_SEARCH_TOOL_NAME,
        searchedAt: new Date().toISOString(),
        resultCount: 0,
        failedCount: 1
      }
    };
  }

  private async search(rawArguments: string): Promise<WebToolResult> {
    const input = webSearchInputSchema.parse(parseToolArguments(rawArguments));
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      throw new Error('WebSearch 不能同时指定 allowed_domains 和 blocked_domains。');
    }
    const searchedAt = new Date().toISOString();
    const response = await this.tavily.search(input.query, {
      maxResults: this.config.web.maxResults,
      includeAnswer: true,
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains
    });
    return {
      content: truncate(JSON.stringify({
        tool: WEB_SEARCH_TOOL_NAME,
        searchedAt,
        query: response.query,
        answer: response.answer,
        results: response.results.map(result => ({
          title: result.title,
          url: result.url,
          content: result.content,
          publishedDate: result.publishedDate
        })),
        instruction: '如果回答使用了这些结果，必须在回答末尾列出来源 URL 和联网时间。'
      }), this.config.web.maxContextChars),
      record: {
        name: WEB_SEARCH_TOOL_NAME,
        query: input.query,
        searchedAt,
        resultCount: response.results.length
      }
    };
  }

  private async fetch(rawArguments: string): Promise<WebToolResult> {
    const input = webFetchInputSchema.parse(parseToolArguments(rawArguments));
    const url = normalizeHttpUrl(input.url);
    const searchedAt = new Date().toISOString();
    const response = await this.tavily.extract([url]);
    return {
      content: truncate(JSON.stringify({
        tool: WEB_FETCH_TOOL_NAME,
        searchedAt,
        url,
        prompt: input.prompt,
        results: response.results.map(result => ({
          url: result.url,
          content: result.content
        })),
        failedResults: response.failedResults,
        instruction: '如果回答使用了这个网页内容，必须在回答末尾列出来源 URL 和联网时间。'
      }), this.config.web.maxContextChars),
      record: {
        name: WEB_FETCH_TOOL_NAME,
        url,
        searchedAt,
        resultCount: response.results.length,
        failedCount: response.failedResults.length
      }
    };
  }
}

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || '{}');
  } catch {
    throw new Error(`工具参数不是有效 JSON：${rawArguments.slice(0, 300)}`);
  }
}

function normalizeHttpUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`WebFetch 只支持 http/https URL：${input}`);
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.toString();
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}
