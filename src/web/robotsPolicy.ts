import type { Logger } from '../logging/logger.js';

type RobotsDecision = {
  allowed: boolean;
  robotsUrl: string;
  rule?: string;
  reason?: string;
};

const robotsCache = new Map<string, { ts: number; text?: string; status: number }>();
const robotsCacheTtlMs = 10 * 60 * 1000;

export async function assertRobotsAllowed(input: {
  url: string;
  operation: string;
  enabled: boolean;
  timeoutMs: number;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.enabled) return;
  const decision = await inspectRobots(input.url, {
    timeoutMs: input.timeoutMs,
    logger: input.logger,
    signal: input.signal
  });
  input.logger?.debug('web.robots.checked', {
    operation: input.operation,
    urlHost: new URL(input.url).hostname,
    robotsUrl: decision.robotsUrl,
    allowed: decision.allowed,
    rule: decision.rule,
    reason: decision.reason
  });
  if (!decision.allowed) {
    throw new Error(`${input.operation} 被 robots.txt 拒绝：${input.url}（robots=${decision.robotsUrl}${decision.rule ? `, rule=${decision.rule}` : ''}）`);
  }
}

async function inspectRobots(urlInput: string, options: {
  timeoutMs: number;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<RobotsDecision> {
  const url = new URL(urlInput);
  const robotsUrl = new URL('/robots.txt', url.origin).toString();
  const robots = await fetchRobots(robotsUrl, options);
  if (!robots.text || robots.status === 404 || robots.status === 410) {
    return { allowed: true, robotsUrl, reason: `status=${robots.status}` };
  }
  if (robots.status < 200 || robots.status >= 300) {
    return { allowed: true, robotsUrl, reason: `status=${robots.status}` };
  }
  return evaluateRobotsText(robots.text, url.pathname || '/', robotsUrl);
}

async function fetchRobots(robotsUrl: string, options: {
  timeoutMs: number;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<{ text?: string; status: number }> {
  const cached = robotsCache.get(robotsUrl);
  if (cached && Date.now() - cached.ts < robotsCacheTtlMs) return { text: cached.text, status: cached.status };
  const timeoutSignal = AbortSignal.timeout(Math.max(1000, Math.min(options.timeoutMs, 5000)));
  try {
    const response = await fetch(robotsUrl, {
      method: 'GET',
      headers: { 'user-agent': 'neo-agent' },
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    });
    const text = response.ok ? await response.text().catch(() => '') : undefined;
    const result = { text, status: response.status };
    robotsCache.set(robotsUrl, { ts: Date.now(), ...result });
    return result;
  } catch (error) {
    options.logger?.warn('web.robots.fetch_failed', {
      robotsUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return { status: 0 };
  }
}

function evaluateRobotsText(text: string, pathname: string, robotsUrl: string): RobotsDecision {
  const groups = parseRobotsGroups(text);
  const relevant = groups.filter(group => group.agents.some(agent => agent === '*' || agent === 'neo-agent'));
  const rules = relevant.flatMap(group => group.rules);
  let best: { directive: 'allow' | 'disallow'; path: string } | undefined;
  for (const rule of rules) {
    if (!rule.path) {
      if (rule.directive === 'disallow') continue;
      if (rule.directive === 'allow') continue;
    }
    if (!robotsPathMatches(pathname, rule.path)) continue;
    if (!best || rule.path.length > best.path.length || rule.path.length === best.path.length && rule.directive === 'allow') {
      best = rule;
    }
  }
  if (best?.directive === 'disallow') return { allowed: false, robotsUrl, rule: `Disallow: ${best.path}` };
  return { allowed: true, robotsUrl, rule: best ? `Allow: ${best.path}` : undefined };
}

function parseRobotsGroups(text: string): Array<{ agents: string[]; rules: Array<{ directive: 'allow' | 'disallow'; path: string }> }> {
  const groups: Array<{ agents: string[]; rules: Array<{ directive: 'allow' | 'disallow'; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ directive: 'allow' | 'disallow'; path: string }> } | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ directive: key, path: value });
    }
  }
  return groups;
}

function robotsPathMatches(pathname: string, rulePath: string): boolean {
  if (!rulePath) return false;
  const escaped = rulePath
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const pattern = rulePath.endsWith('$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  return new RegExp(pattern).test(pathname);
}
