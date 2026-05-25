import type {
  AppConfig,
  WebExtractDepth,
  WebExtractResponse,
  WebMapResponse,
  WebCrawlResponse,
  WebSearchDepth,
  WebSearchResponse,
  WebContext
} from '../types.js';
import type { Logger } from '../logging/logger.js';
import { buildSearchDomainPolicy, domainRulesToRegexPatterns, normalizeAndValidateWebUrl } from './urlPolicy.js';

type TavilySearchOptions = {
  maxResults?: number;
  depth?: WebSearchDepth;
  includeAnswer?: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

type TavilyExtractOptions = {
  depth?: WebExtractDepth;
};

type TavilyMapOptions = {
  instructions?: string;
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  allowExternal?: boolean;
  selectPaths?: string[];
  excludePaths?: string[];
  selectDomains?: string[];
  excludeDomains?: string[];
};

type TavilyCrawlOptions = TavilyMapOptions & {
  extractDepth?: WebExtractDepth;
};

type TavilySearchPayload = {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
  response_time?: number;
};

type TavilyExtractPayload = {
  results?: Array<{
    url?: string;
    raw_content?: string;
    content?: string;
  }>;
  failed_results?: Array<{
    url?: string;
    error?: string;
  }>;
  response_time?: number;
};

type TavilyMapPayload = {
  base_url?: string;
  results?: string[];
  response_time?: number;
};

type TavilyCrawlPayload = {
  base_url?: string;
  results?: Array<{
    url?: string;
    raw_content?: string;
    content?: string;
  }>;
  response_time?: number;
};

export class TavilyClient {
  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {}

  async search(query: string, options: TavilySearchOptions = {}): Promise<WebSearchResponse> {
    const start = Date.now();
    const domainPolicy = buildSearchDomainPolicy(this.config.web, options.allowedDomains, options.blockedDomains);
    const body = {
      query,
      search_depth: options.depth ?? this.config.web.searchDepth,
      max_results: options.maxResults ?? this.config.web.maxResults,
      include_answer: options.includeAnswer ?? true,
      include_raw_content: false,
      include_domains: domainPolicy.allowedDomains,
      exclude_domains: domainPolicy.blockedDomains
    };
    this.logger?.info('web.search.start', {
      provider: this.config.web.provider,
      queryChars: query.length,
      searchDepth: body.search_depth,
      maxResults: body.max_results
    });
    const payload = await this.request<TavilySearchPayload>('search', body);
    const results = (payload.results ?? [])
      .map(item => ({
        title: item.title ?? '',
        url: item.url ?? '',
        content: item.content ?? '',
        score: item.score,
        publishedDate: item.published_date
      }))
      .filter(item => item.url && (item.title || item.content));
    this.logger?.info('web.search.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      hasAnswer: Boolean(payload.answer)
    });
    return {
      query,
      answer: payload.answer,
      results,
      responseTime: payload.response_time
    };
  }

  async extract(urls: string[], options: TavilyExtractOptions = {}): Promise<WebExtractResponse> {
    const cleanUrls = urls
      .map(url => url.trim())
      .filter(Boolean)
      .map(url => normalizeAndValidateWebUrl(url, this.config.web, 'Tavily Extract'));
    const start = Date.now();
    this.logger?.info('web.extract.start', {
      provider: this.config.web.provider,
      urlCount: cleanUrls.length,
      extractDepth: options.depth ?? this.config.web.extractDepth
    });
    const payload = await this.request<TavilyExtractPayload>('extract', {
      urls: cleanUrls,
      extract_depth: options.depth ?? this.config.web.extractDepth
    });
    const results = (payload.results ?? [])
      .map(item => ({
        url: item.url ?? '',
        content: item.raw_content ?? item.content ?? ''
      }))
      .filter(item => item.url && item.content);
    const failedResults = (payload.failed_results ?? [])
      .map(item => ({ url: item.url ?? '', error: item.error }))
      .filter(item => item.url);
    this.logger?.info('web.extract.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      failedCount: failedResults.length
    });
    return {
      results,
      failedResults,
      responseTime: payload.response_time
    };
  }

  async map(url: string, options: TavilyMapOptions = {}): Promise<WebMapResponse> {
    const body = this.buildCrawlerBody(url, options);
    const start = Date.now();
    this.logger?.info('web.map.start', {
      provider: this.config.web.provider,
      maxDepth: body.max_depth,
      limit: body.limit,
      allowExternal: body.allow_external,
      selectPathCount: Array.isArray(body.select_paths) ? body.select_paths.length : 0,
      excludePathCount: Array.isArray(body.exclude_paths) ? body.exclude_paths.length : 0,
      selectDomainCount: Array.isArray(body.select_domains) ? body.select_domains.length : 0,
      excludeDomainCount: Array.isArray(body.exclude_domains) ? body.exclude_domains.length : 0,
      hasInstructions: Boolean(body.instructions)
    });
    const payload = await this.request<TavilyMapPayload>('map', body);
    const results = (payload.results ?? []).filter(item => typeof item === 'string' && item.length > 0);
    this.logger?.info('web.map.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length
    });
    return {
      baseUrl: payload.base_url,
      results,
      responseTime: payload.response_time
    };
  }

  async crawl(url: string, options: TavilyCrawlOptions = {}): Promise<WebCrawlResponse> {
    const crawlerBody = this.buildCrawlerBody(url, options);
    const body: Record<string, unknown> = {
      ...crawlerBody,
      extract_depth: options.extractDepth ?? this.config.web.extractDepth,
      include_images: false,
      format: 'markdown'
    };
    const start = Date.now();
    this.logger?.info('web.crawl.start', {
      provider: this.config.web.provider,
      maxDepth: crawlerBody.max_depth,
      limit: crawlerBody.limit,
      allowExternal: crawlerBody.allow_external,
      extractDepth: body.extract_depth,
      selectPathCount: Array.isArray(crawlerBody.select_paths) ? crawlerBody.select_paths.length : 0,
      excludePathCount: Array.isArray(crawlerBody.exclude_paths) ? crawlerBody.exclude_paths.length : 0,
      selectDomainCount: Array.isArray(crawlerBody.select_domains) ? crawlerBody.select_domains.length : 0,
      excludeDomainCount: Array.isArray(crawlerBody.exclude_domains) ? crawlerBody.exclude_domains.length : 0,
      hasInstructions: Boolean(crawlerBody.instructions)
    });
    const payload = await this.request<TavilyCrawlPayload>('crawl', body);
    const results = (payload.results ?? [])
      .map(item => ({ url: item.url ?? '', content: item.raw_content ?? item.content ?? '' }))
      .filter(item => item.url && item.content);
    this.logger?.info('web.crawl.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length
    });
    return {
      baseUrl: payload.base_url,
      results,
      responseTime: payload.response_time
    };
  }

  private buildCrawlerBody(url: string, options: TavilyMapOptions): Record<string, unknown> {
    const safeUrl = normalizeAndValidateWebUrl(url, this.config.web, 'Tavily crawler');
    const filters = buildCrawlerFilters(this.config.web, options);
    return {
      url: safeUrl,
      instructions: options.instructions,
      max_depth: clampInt(options.maxDepth ?? this.config.web.maxDepth, 1, 5),
      max_breadth: clampInt(options.maxBreadth ?? this.config.web.maxBreadth, 1, 500),
      limit: Math.max(1, options.limit ?? this.config.web.maxPages),
      select_paths: filters.selectPaths,
      exclude_paths: filters.excludePaths,
      select_domains: filters.selectDomains,
      exclude_domains: filters.excludeDomains,
      allow_external: options.allowExternal ?? this.config.web.allowExternal,
      timeout: clampInt(Math.ceil(this.config.web.timeoutMs / 1000), 10, 150),
      include_usage: true
    };
  }

  private async request<T>(endpoint: 'search' | 'extract' | 'map' | 'crawl', body: Record<string, unknown>): Promise<T> {
    if (!this.config.web.apiKey) {
      throw new Error('缺少 Tavily API key。请设置 TAVILY_API_KEY，或写入 ~/.neo-agent/config.json 的 web.apiKey。');
    }
    const url = new URL(endpoint, ensureTrailingSlash(this.config.web.apiBase));
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.web.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.web.timeoutMs)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tavily ${endpoint} 请求失败：${response.status} ${response.statusText} ${text.slice(0, 800)}`);
    }
    return response.json() as Promise<T>;
  }
}

export type TavilyCrawlerFilterOptions = Pick<
  TavilyMapOptions,
  'selectPaths' | 'excludePaths' | 'selectDomains' | 'excludeDomains'
>;

export function buildCrawlerFilters(
  config: Pick<AppConfig['web'], 'selectPaths' | 'excludePaths' | 'selectDomains' | 'excludeDomains' | 'allowedDomains' | 'blockedDomains'>,
  options: TavilyCrawlerFilterOptions = {}
): {
  selectPaths?: string[];
  excludePaths?: string[];
  selectDomains?: string[];
  excludeDomains?: string[];
} {
  const selectPaths = mergePatternLists(config.selectPaths, options.selectPaths);
  const excludePaths = mergePatternLists(config.excludePaths, options.excludePaths);
  const configuredAllowedDomains = domainRulesToRegexPatterns(config.allowedDomains);
  const configuredBlockedDomains = domainRulesToRegexPatterns(config.blockedDomains);
  const requestedSelectDomains = mergePatternLists(config.selectDomains, options.selectDomains);
  const selectDomains = configuredAllowedDomains.length > 0 ? configuredAllowedDomains : requestedSelectDomains;
  const excludeDomains = uniqueStrings([
    ...configuredBlockedDomains,
    ...mergePatternLists(config.excludeDomains, options.excludeDomains)
  ]);

  validateRegexList('select_paths', selectPaths);
  validateRegexList('exclude_paths', excludePaths);
  validateRegexList('select_domains', selectDomains);
  validateRegexList('exclude_domains', excludeDomains);

  return {
    selectPaths: selectPaths.length > 0 ? selectPaths : undefined,
    excludePaths: excludePaths.length > 0 ? excludePaths : undefined,
    selectDomains: selectDomains.length > 0 ? selectDomains : undefined,
    excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined
  };
}

export function formatWebSearch(response: WebSearchResponse): string {
  const lines = [`搜索：${response.query}`];
  if (response.answer) {
    lines.push('', response.answer.trim());
  }
  if (response.results.length > 0) {
    lines.push('', '来源：');
    response.results.forEach((result, index) => {
      const date = result.publishedDate ? ` (${result.publishedDate})` : '';
      lines.push(`${index + 1}. ${result.title || result.url}${date}`);
      lines.push(`   ${result.url}`);
      if (result.content) lines.push(`   ${truncate(result.content, 420)}`);
    });
  }
  if (response.responseTime !== undefined) lines.push('', `耗时：${response.responseTime}s`);
  return lines.join('\n');
}

export function formatWebContext(context: WebContext, maxChars: number): string {
  const lines = [
    `联网时间：${context.searchedAt}`,
    `联网原因：${context.reason}`
  ];
  if (context.query) lines.push(`搜索词：${context.query}`);
  if (context.search) {
    lines.push('', '## 搜索摘要');
    if (context.search.answer) lines.push(context.search.answer.trim());
    lines.push('', '## 搜索来源');
    context.search.results.forEach((result, index) => {
      const date = result.publishedDate ? `，published=${result.publishedDate}` : '';
      lines.push(`${index + 1}. ${result.title || result.url}${date}`);
      lines.push(`URL: ${result.url}`);
      if (result.content) lines.push(`摘要: ${result.content}`);
    });
  }
  if (context.extracts?.results.length) {
    lines.push('', '## 网页正文');
    context.extracts.results.forEach((result, index) => {
      lines.push(`${index + 1}. URL: ${result.url}`);
      lines.push(truncate(result.content.trim(), Math.max(1000, Math.floor(maxChars / context.extracts!.results.length))));
    });
  }
  if (context.extracts?.failedResults.length) {
    lines.push('', '## 读取失败');
    context.extracts.failedResults.forEach(item => lines.push(`- ${item.url}${item.error ? `: ${item.error}` : ''}`));
  }
  return truncate(lines.join('\n'), maxChars);
}

export function formatWebExtract(response: WebExtractResponse, maxChars = 5000): string {
  const lines: string[] = [];
  for (const result of response.results) {
    lines.push(`URL：${result.url}`);
    lines.push(truncate(result.content.trim(), maxChars));
    lines.push('');
  }
  if (response.failedResults.length > 0) {
    lines.push('失败：');
    for (const item of response.failedResults) lines.push(`- ${item.url}${item.error ? `：${item.error}` : ''}`);
  }
  if (response.responseTime !== undefined) lines.push(`耗时：${response.responseTime}s`);
  return lines.join('\n').trim() || '没有提取到网页正文。';
}

export function formatWebMap(response: WebMapResponse): string {
  const lines = [response.baseUrl ? `站点：${response.baseUrl}` : '站点 map：'];
  response.results.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
  if (response.responseTime !== undefined) lines.push('', `耗时：${response.responseTime}s`);
  return lines.join('\n');
}

export function formatWebCrawl(response: WebCrawlResponse, maxChars = 1200): string {
  const lines = [response.baseUrl ? `站点：${response.baseUrl}` : '站点 crawl：'];
  response.results.forEach((result, index) => {
    lines.push('', `${index + 1}. ${result.url}`);
    lines.push(truncate(result.content.trim(), maxChars));
  });
  if (response.responseTime !== undefined) lines.push('', `耗时：${response.responseTime}s`);
  return lines.join('\n').trim() || '没有爬取到网页正文。';
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function mergePatternLists(configured: string[], requested: string[] | undefined): string[] {
  return uniqueStrings([...(configured ?? []), ...(requested ?? [])].map(item => item.trim()).filter(Boolean));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function validateRegexList(name: string, patterns: string[]): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tavily ${name} 包含无效正则：${pattern}。${message}`);
    }
  }
}
