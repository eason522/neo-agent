import type { Logger } from '../logging/logger.js';
import type { AppConfig } from '../types.js';
import { normalizeAndValidateWebUrl } from './urlPolicy.js';

export type WebPreflightResult = {
  url: string;
  warnings: string[];
};

const MAX_PREFLIGHT_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BINARY_CONTENT_TYPE = /^(application\/pdf|application\/octet-stream|image\/|audio\/|video\/|application\/zip|application\/x-)/i;

export async function preflightWebUrl(input: {
  url: string;
  operation: string;
  config: AppConfig['web'];
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<WebPreflightResult> {
  const normalized = normalizeAndValidateWebUrl(input.url, input.config, input.operation);
  return inspectUrl(normalized, input, 0);
}

async function inspectUrl(url: string, input: {
  operation: string;
  config: AppConfig['web'];
  logger?: Logger;
  signal?: AbortSignal;
}, depth: number): Promise<WebPreflightResult> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`${input.operation} 重定向次数超过 ${MAX_REDIRECTS} 次：${url}`);
  }

  const timeoutSignal = AbortSignal.timeout(Math.max(1000, Math.min(input.config.timeoutMs, 5000)));
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        accept: 'text/markdown, text/html, text/plain, application/pdf, */*',
        'user-agent': 'neo-agent'
      },
      signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
    });

    const redirectLocation = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && redirectLocation) {
      const redirectUrl = new URL(redirectLocation, url).toString();
      const normalizedRedirectUrl = normalizeAndValidateWebUrl(redirectUrl, input.config, `${input.operation} redirect`);
      if (!isPermittedRedirect(url, normalizedRedirectUrl)) {
        throw new Error([
          `${input.operation} 检测到跨域或降级重定向，已停止自动读取。`,
          `原 URL：${url}`,
          `重定向 URL：${normalizedRedirectUrl}`,
          `如确认需要读取，请重新用 WebFetch 指定重定向 URL。`
        ].join('\n'));
      }
      input.logger?.debug('web.preflight.redirect_followed', {
        operation: input.operation,
        urlHost: new URL(url).hostname,
        redirectHost: new URL(normalizedRedirectUrl).hostname,
        status: response.status
      });
      return inspectUrl(normalizedRedirectUrl, input, depth + 1);
    }

    const warnings = inspectHeaders(response, url, input.operation);
    input.logger?.debug('web.preflight.checked', {
      operation: input.operation,
      urlHost: new URL(url).hostname,
      status: response.status,
      warningCount: warnings.length
    });
    return { url, warnings };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (error instanceof Error && (
      error.message.includes('跨域或降级重定向') ||
      error.message.includes('重定向次数超过') ||
      error.message.includes('URL 过长') ||
      error.message.includes('URL 无效') ||
      error.message.includes('用户名或密码') ||
      error.message.includes('下载预检拒绝') ||
      error.message.includes('blockedDomains') ||
      error.message.includes('allowedDomains') ||
      error.message.includes('本地、内网') ||
      error.message.includes('非公开域名')
    )) {
      throw error;
    }
    input.logger?.warn('web.preflight.failed', {
      operation: input.operation,
      urlHost: new URL(url).hostname,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      url,
      warnings: [`${input.operation} 预检失败，已继续请求 Tavily；如果读取失败，可能是站点拒绝 HEAD、网络限制或需要登录。`]
    };
  }
}

function inspectHeaders(response: Response, url: string, operation: string): string[] {
  const warnings: string[] = [];
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_PREFLIGHT_DOWNLOAD_BYTES) {
    throw new Error(`${operation} 下载预检拒绝：${url} content-length=${contentLength}，超过 ${MAX_PREFLIGHT_DOWNLOAD_BYTES} 字节上限。`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && BINARY_CONTENT_TYPE.test(contentType)) {
    warnings.push(`${operation} 预检显示内容类型为 ${contentType}，可能不是普通网页正文；必要时改用文件或专用工具处理。`);
  }

  if (response.status === 401 || response.status === 403) {
    warnings.push(`${operation} 预检返回 ${response.status}，页面可能需要登录、授权或禁止自动抓取。`);
  }

  if (response.status >= 400 && response.status !== 401 && response.status !== 403 && response.status !== 405) {
    warnings.push(`${operation} 预检返回 HTTP ${response.status}，后续 Tavily 读取可能失败。`);
  }

  return warnings;
}

function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  const original = new URL(originalUrl);
  const redirect = new URL(redirectUrl);
  if (redirect.protocol !== original.protocol) return false;
  if (redirect.port !== original.port) return false;
  if (redirect.username || redirect.password) return false;
  const stripWww = (hostname: string) => hostname.replace(/^www\./i, '');
  return stripWww(original.hostname) === stripWww(redirect.hostname);
}
