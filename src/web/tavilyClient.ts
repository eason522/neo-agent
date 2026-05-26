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
import { assertRobotsAllowed } from './robotsPolicy.js';
import { createHash } from 'node:crypto';

type TavilySearchOptions = {
  maxResults?: number;
  depth?: WebSearchDepth;
  includeAnswer?: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
};

type TavilyExtractOptions = {
  depth?: WebExtractDepth;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
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

type WebFailureCategory = 'auth' | 'rate_limit' | 'server' | 'timeout' | 'network' | 'bad_request' | 'unknown';

type CachedPayload = {
  ts: number;
  value: unknown;
};

const requestCache = new Map<string, CachedPayload>();
const cacheTtlMs = 10 * 60 * 1000;
const maxCacheEntries = 100;

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
    const response = await this.request<TavilySearchPayload>('search', body, options.signal);
    const payload = response.payload;
    const results = dedupeSearchResults((payload.results ?? [])
      .map(item => ({
        title: item.title ?? '',
        url: item.url ?? '',
        content: item.content ?? '',
        score: item.score,
        publishedDate: item.published_date
      }))
      .filter(item => item.url && (item.title || item.content)));
    const warnings = detectSearchWarnings(results, payload.answer);
    this.logger?.info('web.search.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      hasAnswer: Boolean(payload.answer),
      cacheHit: response.cacheHit,
      warningCount: warnings.length
    });
    return {
      query,
      answer: payload.answer,
      results,
      warnings,
      cacheHit: response.cacheHit,
      responseTime: payload.response_time
    };
  }

  async extract(urls: string[], options: TavilyExtractOptions = {}): Promise<WebExtractResponse> {
    const cleanUrls = uniqueUrls(urls
      .map(url => url.trim())
      .filter(Boolean)
      .map(url => normalizeAndValidateWebUrl(url, this.config.web, 'Tavily Extract')));
    await this.assertRobotsAllowedForUrls(cleanUrls, 'Tavily Extract', options.signal);
    const start = Date.now();
    this.logger?.info('web.extract.start', {
      provider: this.config.web.provider,
      urlCount: cleanUrls.length,
      extractDepth: options.depth ?? this.config.web.extractDepth
    });
    const response = await this.request<TavilyExtractPayload>('extract', {
      urls: cleanUrls,
      extract_depth: options.depth ?? this.config.web.extractDepth
    }, options.signal);
    const payload = response.payload;
    const results = dedupeExtractResults((payload.results ?? [])
      .map(item => ({
        url: item.url ?? '',
        content: item.raw_content ?? item.content ?? ''
      }))
      .filter(item => item.url && item.content));
    const failedResults = (payload.failed_results ?? [])
      .map(item => ({ url: item.url ?? '', error: item.error, category: classifyFailureText(item.error ?? '') }))
      .filter(item => item.url);
    const warnings = detectExtractWarnings(results, failedResults);
    this.logger?.info('web.extract.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      failedCount: failedResults.length,
      cacheHit: response.cacheHit,
      warningCount: warnings.length
    });
    return {
      results,
      failedResults,
      warnings,
      cacheHit: response.cacheHit,
      responseTime: payload.response_time
    };
  }

  async map(url: string, options: TavilyMapOptions = {}): Promise<WebMapResponse> {
    const body = this.buildCrawlerBody(url, options);
    await this.assertRobotsAllowedForUrls([String(body.url)], 'Tavily Map', options.signal);
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
    const response = await this.request<TavilyMapPayload>('map', body, options.signal);
    const payload = response.payload;
    const results = uniqueUrls((payload.results ?? []).filter(item => typeof item === 'string' && item.length > 0));
    this.logger?.info('web.map.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      cacheHit: response.cacheHit
    });
    return {
      baseUrl: payload.base_url,
      results,
      cacheHit: response.cacheHit,
      responseTime: payload.response_time
    };
  }

  async crawl(url: string, options: TavilyCrawlOptions = {}): Promise<WebCrawlResponse> {
    const crawlerBody = this.buildCrawlerBody(url, options);
    await this.assertRobotsAllowedForUrls([String(crawlerBody.url)], 'Tavily Crawl', options.signal);
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
    const response = await this.request<TavilyCrawlPayload>('crawl', body, options.signal);
    const payload = response.payload;
    const results = dedupeExtractResults((payload.results ?? [])
      .map(item => ({ url: item.url ?? '', content: item.raw_content ?? item.content ?? '' }))
      .filter(item => item.url && item.content));
    this.logger?.info('web.crawl.success', {
      provider: this.config.web.provider,
      durationMs: Date.now() - start,
      resultCount: results.length,
      cacheHit: response.cacheHit
    });
    return {
      baseUrl: payload.base_url,
      results,
      cacheHit: response.cacheHit,
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

  private async assertRobotsAllowedForUrls(urls: string[], operation: string, signal?: AbortSignal): Promise<void> {
    for (const url of urls) {
      await assertRobotsAllowed({
        url,
        operation,
        enabled: this.config.web.respectRobotsTxt,
        timeoutMs: this.config.web.timeoutMs,
        logger: this.logger,
        signal
      });
    }
  }

  private async request<T>(endpoint: 'search' | 'extract' | 'map' | 'crawl', body: Record<string, unknown>, signal?: AbortSignal): Promise<{ payload: T; cacheHit: boolean }> {
    if (!this.config.web.apiKey) {
      throw new Error('缺少 Tavily API key。请设置 TAVILY_API_KEY，或写入 ~/.neo-agent/config.json 的 web.apiKey。');
    }
    const cacheKey = buildCacheKey(endpoint, body);
    const cached = getCached<T>(cacheKey);
    if (cached) {
      this.logger?.debug('web.cache.hit', { endpoint, key: cacheKey });
      return { payload: cached, cacheHit: true };
    }
    const url = new URL(endpoint, ensureTrailingSlash(this.config.web.apiBase));
    const timeoutSignal = AbortSignal.timeout(this.config.web.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.web.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const category = classifyHttpFailure(response.status, text);
        throw new TavilyRequestError(endpoint, category, `Tavily ${endpoint} 请求失败（${category}）：${response.status} ${response.statusText} ${text.slice(0, 800)}`);
      }
      const payload = await response.json() as T;
      setCached(cacheKey, payload);
      return { payload, cacheHit: false };
    } catch (error) {
      if (error instanceof TavilyRequestError) throw error;
      const category = error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout'
        : signal?.aborted
          ? 'timeout'
          : 'network';
      throw new TavilyRequestError(endpoint, category, `Tavily ${endpoint} 请求失败（${category}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class TavilyRequestError extends Error {
  constructor(
    readonly endpoint: string,
    readonly category: WebFailureCategory,
    message: string
  ) {
    super(message);
    this.name = 'TavilyRequestError';
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
  if (response.cacheHit) lines.push('缓存：命中');
  if (response.warnings?.length) {
    lines.push('', '提示：');
    for (const warning of response.warnings) lines.push(`- ${warning}`);
  }
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
    if (context.search.warnings?.length) {
      lines.push('', '## 联网结果提示');
      for (const warning of context.search.warnings) lines.push(`- ${warning}`);
    }
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
    context.extracts.failedResults.forEach(item => lines.push(`- ${item.url}${item.category ? ` [${item.category}]` : ''}${item.error ? `: ${item.error}` : ''}`));
  }
  if (context.extracts?.warnings?.length) {
    lines.push('', '## 网页读取提示');
    for (const warning of context.extracts.warnings) lines.push(`- ${warning}`);
  }
  return truncate(lines.join('\n'), maxChars);
}

export function formatWebExtract(response: WebExtractResponse, maxChars = 5000): string {
  const lines: string[] = [];
  if (response.cacheHit) lines.push('缓存：命中', '');
  if (response.warnings?.length) {
    lines.push('提示：');
    for (const warning of response.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  for (const result of response.results) {
    lines.push(`URL：${result.url}`);
    lines.push(truncate(result.content.trim(), maxChars));
    lines.push('');
  }
  if (response.failedResults.length > 0) {
    lines.push('失败：');
    for (const item of response.failedResults) lines.push(`- ${item.url}${item.category ? ` [${item.category}]` : ''}${item.error ? `：${item.error}` : ''}`);
  }
  if (response.responseTime !== undefined) lines.push(`耗时：${response.responseTime}s`);
  return lines.join('\n').trim() || '没有提取到网页正文。';
}

export function formatWebMap(response: WebMapResponse): string {
  const lines = [response.baseUrl ? `站点：${response.baseUrl}` : '站点 map：'];
  if (response.cacheHit) lines.push('缓存：命中');
  response.results.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
  if (response.responseTime !== undefined) lines.push('', `耗时：${response.responseTime}s`);
  return lines.join('\n');
}

export function formatWebCrawl(response: WebCrawlResponse, maxChars = 1200): string {
  const lines = [response.baseUrl ? `站点：${response.baseUrl}` : '站点 crawl：'];
  if (response.cacheHit) lines.push('缓存：命中');
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

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const url of urls) {
    const key = normalizeUrlForDedupe(url);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(url);
  }
  return output;
}

function dedupeSearchResults(results: WebSearchResponse['results']): WebSearchResponse['results'] {
  const seen = new Set<string>();
  const output: WebSearchResponse['results'] = [];
  for (const result of results) {
    const key = normalizeUrlForDedupe(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function dedupeExtractResults<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const result of results) {
    const key = normalizeUrlForDedupe(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function normalizeUrlForDedupe(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return input.trim().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function detectSearchWarnings(results: WebSearchResponse['results'], answer: string | undefined): string[] {
  const warnings: string[] = [];
  const dates = new Set<string>();
  const text = [answer ?? '', ...results.slice(0, 5).map(result => `${result.title} ${result.content} ${result.publishedDate ?? ''}`)].join('\n');
  for (const match of text.matchAll(/\b20\d{2}(?:[-年/]\d{1,2}(?:[-月/]\d{1,2}日?)?)?/g)) {
    dates.add(match[0]);
  }
  if (dates.size >= 3) {
    warnings.push(`不同来源或摘要中出现多个日期：${[...dates].slice(0, 6).join('、')}。涉及时间线时请交叉核对。`);
  }
  return warnings;
}

function detectExtractWarnings(results: WebExtractResponse['results'], failedResults: WebExtractResponse['failedResults']): string[] {
  const warnings: string[] = [];
  if (failedResults.length > 0 && results.length > 0) {
    warnings.push('部分 URL 读取失败，回答时不要把已读取页面当作完整来源集合。');
  }
  if (failedResults.length > 0 && results.length === 0) {
    warnings.push('所有 URL 均读取失败，需要改用搜索、检查 URL，或说明无法获取页面正文。');
  }
  return warnings;
}

function classifyHttpFailure(status: number, text: string): WebFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return text.toLowerCase().includes('blocked') ? 'auth' : 'bad_request';
  return 'unknown';
}

function classifyFailureText(text: string): WebFailureCategory {
  const lower = text.toLowerCase();
  if (/timeout|timed out|超时/.test(lower)) return 'timeout';
  if (/rate|quota|429|限流|额度/.test(lower)) return 'rate_limit';
  if (/auth|unauthor|forbidden|401|403|登录|权限/.test(lower)) return 'auth';
  if (/server|5\d\d/.test(lower)) return 'server';
  if (/network|dns|连接/.test(lower)) return 'network';
  return 'unknown';
}

function buildCacheKey(endpoint: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(`${endpoint}:${JSON.stringify(body)}`).digest('hex').slice(0, 24);
}

function getCached<T>(key: string): T | undefined {
  const cached = requestCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.ts > cacheTtlMs) {
    requestCache.delete(key);
    return undefined;
  }
  return clonePayload(cached.value) as T;
}

function setCached(key: string, value: unknown): void {
  requestCache.set(key, { ts: Date.now(), value: clonePayload(value) });
  if (requestCache.size <= maxCacheEntries) return;
  const oldest = [...requestCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
  if (oldest) requestCache.delete(oldest);
}

function clonePayload(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
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
