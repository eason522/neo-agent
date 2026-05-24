export type WebPlan = {
  shouldUseWeb: boolean;
  reason: string;
  query?: string;
  urls: string[];
};

const explicitWebPatterns = [
  /联网/,
  /搜索/,
  /搜一下/,
  /查一下/,
  /查找/,
  /检索/,
  /上网/,
  /网上/,
  /浏览网页/,
  /打开(这个)?链接/,
  /验证/,
  /核实/,
  /确认.*最新/,
  /\bsearch\b/i,
  /\bgoogle\b/i,
  /\bweb\b/i
];

const freshnessPatterns = [
  /最新/,
  /最近/,
  /当前/,
  /现在/,
  /今天/,
  /昨日|昨天/,
  /本周|这周/,
  /今年/,
  /刚刚/,
  /新闻/,
  /发布/,
  /公告/,
  /价格/,
  /股价/,
  /汇率/,
  /天气/,
  /赛程/,
  /版本/,
  /release/i,
  /changelog/i,
  /breaking changes/i,
  /\b20\d{2}\b/
];

const dynamicEntityPatterns = [
  /CEO|首席执行官/i,
  /总统|主席|总理|部长|市长/,
  /政策|法规|法律|监管/,
  /模型|API|SDK|框架|库|依赖|npm|package/,
  /融资|财报|收入|估值/,
  /招聘|职位|官网/
];

export function planWebUse(input: string, autoSearchEnabled: boolean): WebPlan {
  const urls = extractUrls(input);
  if (urls.length > 0) {
    return {
      shouldUseWeb: true,
      reason: '用户输入中包含 URL，需要读取网页内容。',
      query: stripUrls(input),
      urls
    };
  }

  const trimmed = input.trim();
  if (!autoSearchEnabled || !trimmed) {
    return {
      shouldUseWeb: false,
      reason: autoSearchEnabled ? '没有联网信号。' : '自动联网已关闭。',
      urls: []
    };
  }

  if (explicitWebPatterns.some(pattern => pattern.test(trimmed))) {
    return {
      shouldUseWeb: true,
      reason: '用户显式要求搜索、联网或验证。',
      query: cleanQuery(trimmed),
      urls: []
    };
  }

  if (freshnessPatterns.some(pattern => pattern.test(trimmed))) {
    return {
      shouldUseWeb: true,
      reason: '问题包含时间敏感信息，需要联网确认。',
      query: cleanQuery(trimmed),
      urls: []
    };
  }

  if (dynamicEntityPatterns.some(pattern => pattern.test(trimmed)) && /谁|多少|是否|哪|什么|如何|怎么|有没有/.test(trimmed)) {
    return {
      shouldUseWeb: true,
      reason: '问题涉及可能变化的实体或资料，需要联网核实。',
      query: cleanQuery(trimmed),
      urls: []
    };
  }

  return {
    shouldUseWeb: false,
    reason: '问题看起来不依赖最新外部信息。',
    urls: []
  };
}

function extractUrls(input: string): string[] {
  return [...new Set(input.match(/https?:\/\/[^\s"'<>）)]+/g) ?? [])];
}

function stripUrls(input: string): string {
  return input.replace(/https?:\/\/[^\s"'<>）)]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanQuery(input: string): string {
  return stripUrls(input)
    .replace(/^请?(帮我)?(联网|搜索|搜一下|查一下|查找|检索|上网|网上|验证|核实|确认)\s*/g, '')
    .trim() || input.trim();
}
