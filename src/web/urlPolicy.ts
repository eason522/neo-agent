import net from 'node:net';
import type { AppConfig } from '../types.js';

export type WebAccessPolicy = Pick<AppConfig['web'], 'allowedDomains' | 'blockedDomains' | 'blockPrivateAddresses'>;

export type SearchDomainPolicy = {
  allowedDomains?: string[];
  blockedDomains?: string[];
};

export function normalizeAndValidateWebUrl(input: string, policy: WebAccessPolicy, operation = '联网工具'): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${operation} 只支持 http/https URL：${input}`);
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  validateHostname(url.hostname, policy, operation);
  return url.toString();
}

export function buildSearchDomainPolicy(
  policy: WebAccessPolicy,
  requestedAllowedDomains?: string[],
  requestedBlockedDomains?: string[]
): SearchDomainPolicy {
  const configAllowed = normalizeDomainRules(policy.allowedDomains);
  const configBlocked = normalizeDomainRules(policy.blockedDomains);
  const requestedAllowed = normalizeDomainRules(requestedAllowedDomains ?? []);
  const requestedBlocked = normalizeDomainRules(requestedBlockedDomains ?? []);

  const allowedDomains = configAllowed.length > 0
    ? requestedAllowed.length > 0
      ? requestedAllowed.filter(domain => domainAllowedByPolicy(domain, configAllowed))
      : configAllowed
    : requestedAllowed;

  if (configAllowed.length > 0 && requestedAllowed.length > 0 && allowedDomains.length === 0) {
    throw new Error('WebSearch 请求的 allowed_domains 不在配置允许的域名范围内。');
  }

  const blockedDomains = uniqueDomains([...configBlocked, ...requestedBlocked]);
  for (const domain of [...allowedDomains, ...blockedDomains]) {
    validateDomainRule(domain, policy, 'WebSearch domain policy');
  }

  return {
    allowedDomains: allowedDomains.length > 0 ? uniqueDomains(allowedDomains) : undefined,
    blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined
  };
}

export function validateHostname(hostname: string, policy: WebAccessPolicy, operation = '联网工具'): void {
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new Error(`${operation} URL 缺少有效域名。`);
  if (policy.blockPrivateAddresses && isPrivateOrLocalHostname(normalized)) {
    throw new Error(`${operation} 已阻止访问本地、内网或链路本地地址：${hostname}`);
  }
  if (matchesDomainRules(normalized, policy.blockedDomains)) {
    throw new Error(`${operation} 已被 blockedDomains 拒绝：${hostname}`);
  }
  if (policy.allowedDomains.length > 0 && !matchesDomainRules(normalized, policy.allowedDomains)) {
    throw new Error(`${operation} 不在 allowedDomains 范围内：${hostname}`);
  }
}

export function matchesDomainRules(hostname: string, rules: string[]): boolean {
  const normalized = normalizeHostname(hostname);
  return normalizeDomainRules(rules).some(rule => domainMatchesRule(normalized, rule));
}

function validateDomainRule(domain: string, policy: WebAccessPolicy, operation: string): void {
  if (policy.blockPrivateAddresses && isPrivateOrLocalHostname(domain)) {
    throw new Error(`${operation} 已阻止本地、内网或链路本地域名规则：${domain}`);
  }
}

function domainAllowedByPolicy(domain: string, allowedRules: string[]): boolean {
  return allowedRules.some(rule => domainMatchesRule(domain, rule) || domainMatchesRule(rule, domain));
}

function domainMatchesRule(hostname: string, rule: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedRule = normalizeDomainRule(rule);
  if (!normalizedHost || !normalizedRule) return false;
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

function normalizeDomainRules(rules: string[]): string[] {
  return uniqueDomains(rules.map(normalizeDomainRule).filter(Boolean));
}

function uniqueDomains(domains: string[]): string[] {
  return [...new Set(domains.map(normalizeDomainRule).filter(Boolean))];
}

function normalizeDomainRule(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return normalizeHostname(parsed.hostname);
  } catch {
    return normalizeHostname(trimmed.split('/')[0] ?? '');
  }
}

function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}
