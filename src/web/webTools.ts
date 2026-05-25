import { z } from 'zod';
import type { AppConfig, ChatToolCall, ChatToolDefinition, WebToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import { TavilyClient } from './tavilyClient.js';
import { normalizeAndValidateWebUrl } from './urlPolicy.js';

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

export function getWebToolPrompt(): string {
  return [
    '# 联网工具',
    '- 你可以使用 WebSearch 搜索互联网，使用 WebFetch 读取公开网页正文。它们是只读工具。',
    '- 当用户的问题涉及最新、当前、今天、近期、新闻、价格、天气、政策法规、软件版本、API 文档、体育赛程、公司职位、政治人物行程，或用户明确要求搜索/验证/打开链接时，主动使用联网工具。',
    '- 如果用户说“你搜一下”“联网验证一下”“查一下这个”，要结合当前会话历史判断它指向的上一轮问题，不要搜索追问句本身。',
    '- 如果使用了联网工具，最终回答必须列出来源 URL 和联网时间；不要编造来源。',
    '- 不要尝试读取 localhost、内网地址、链路本地地址或配置禁止的域名；如果工具拒绝访问，要如实说明。',
    '- 联网结果也可能错误或冲突。重要事实要交叉检查，冲突时直接说明。'
  ].join('\n');
}

export class WebToolRunner implements ToolRunner<WebToolCallRecord> {
  constructor(
    private readonly config: AppConfig,
    private readonly tavily: TavilyClient
  ) {}

  definitions(): ChatToolDefinition[] {
    if (!this.isEnabled()) return [];
    return createWebToolDefinitions();
  }

  canExecute(name: string): boolean {
    return this.isEnabled() && (name === WEB_SEARCH_TOOL_NAME || name === WEB_FETCH_TOOL_NAME);
  }

  executionMode(): 'parallel' {
    return 'parallel';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<WebToolResult> {
    throwIfAborted(options.signal);
    if (call.function.name === WEB_SEARCH_TOOL_NAME) {
      return this.search(call.function.arguments, options.signal);
    }
    if (call.function.name === WEB_FETCH_TOOL_NAME) {
      return this.fetch(call.function.arguments, options.signal);
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

  private async search(rawArguments: string, signal?: AbortSignal): Promise<WebToolResult> {
    const input = webSearchInputSchema.parse(parseToolArguments(rawArguments));
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      throw new Error('WebSearch 不能同时指定 allowed_domains 和 blocked_domains。');
    }
    const searchedAt = new Date().toISOString();
    const response = await this.tavily.search(input.query, {
      maxResults: this.config.web.maxResults,
      includeAnswer: true,
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
      signal
    });
    throwIfAborted(signal);
    return {
      content: truncate(JSON.stringify({
        tool: WEB_SEARCH_TOOL_NAME,
        searchedAt,
        query: response.query,
        answer: response.answer,
        warnings: response.warnings,
        cacheHit: response.cacheHit,
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

  private async fetch(rawArguments: string, signal?: AbortSignal): Promise<WebToolResult> {
    const input = webFetchInputSchema.parse(parseToolArguments(rawArguments));
    const url = normalizeAndValidateWebUrl(input.url, this.config.web, WEB_FETCH_TOOL_NAME);
    const searchedAt = new Date().toISOString();
    const response = await this.tavily.extract([url], { signal });
    throwIfAborted(signal);
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
        warnings: response.warnings,
        cacheHit: response.cacheHit,
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

  private isEnabled(): boolean {
    return this.config.web.autoSearch && this.config.web.toolLoopEnabled && Boolean(this.config.web.apiKey);
  }
}

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || '{}');
  } catch {
    throw new Error(`工具参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}
