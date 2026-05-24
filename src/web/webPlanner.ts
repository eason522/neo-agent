import { z } from 'zod';
import type { ChatMessage } from '../types.js';

export type WebPlan = {
  shouldUseWeb: boolean;
  reason: string;
  query?: string;
  urls: string[];
  action: 'none' | 'search' | 'extract' | 'search_and_extract';
  source: 'model' | 'fallback';
  usesPreviousTurn: boolean;
  error?: string;
};

type PlannerModel = {
  chat(options: { messages: ChatMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
};

type ModelPlannerOptions = {
  autoSearchEnabled: boolean;
  plannerEnabled: boolean;
  previousUserInput?: string;
  history: ChatMessage[];
  model?: PlannerModel;
  timeoutMs: number;
};

const modelPlanSchema = z.object({
  needsWeb: z.boolean(),
  action: z.enum(['none', 'search', 'extract', 'search_and_extract']),
  query: z.string().optional(),
  urls: z.array(z.string()).optional(),
  usesPreviousTurn: z.boolean().optional(),
  reason: z.string().optional()
});

const webFollowUpPatterns = [
  /^(你)?(可以|帮我|麻烦)?(联网搜索|联网查|联网验证|联网核实|联网|搜索|搜一下|查一下|检索|验证|核实)(一下|下)?(吧|吗|呢)?[？?。.\s]*$/,
  /^(那|这个|上面|刚才|前面|上一(个|条|轮)问题).*(联网|搜索|搜一下|查一下|验证|核实)/,
  /^(联网|搜索|搜一下|查一下|验证|核实)(这个|一下|下)?[？?。.\s]*$/
];

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
  /普京|习近平|特朗普|拜登|泽连斯基|马克龙|默克尔|金正恩|尹锡悦|石破茂|岸田文雄/,
  /CEO|首席执行官/i,
  /总统|主席|总理|部长|市长/,
  /政策|法规|法律|监管/,
  /模型|API|SDK|框架|库|依赖|npm|package/,
  /融资|财报|收入|估值/,
  /招聘|职位|官网/,
  /访问|访华|来华|出访|行程|会见|会晤|峰会/
];

const questionPatterns = /谁|多少|是否|哪|什么|如何|怎么|有没有|何时|什么时候|几号|哪天|结束|了吗|吗|呢|安排|计划/;

export async function planWebUseWithModel(input: string, options: ModelPlannerOptions): Promise<WebPlan> {
  const fallbackPlan = planWebUse(input, options.autoSearchEnabled, options.previousUserInput);
  if (!options.autoSearchEnabled || !input.trim()) return fallbackPlan;
  if (!options.plannerEnabled || !options.model) return fallbackPlan;

  try {
    const response = await options.model.chat({
      messages: buildPlannerMessages(input, options.previousUserInput, options.history),
      temperature: 0,
      maxTokens: 700,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    return normalizeModelPlan(response, input, options.previousUserInput, fallbackPlan);
  } catch (error) {
    return {
      ...fallbackPlan,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function planWebUse(input: string, autoSearchEnabled: boolean, previousUserInput?: string): WebPlan {
  const trimmed = input.trim();
  const previous = previousUserInput?.trim();
  if (!autoSearchEnabled || !trimmed) {
    return {
      shouldUseWeb: false,
      reason: autoSearchEnabled ? '没有联网信号。' : '自动联网已关闭。',
      urls: [],
      action: 'none',
      source: 'fallback',
      usesPreviousTurn: false
    };
  }

  const urls = extractUrls(input);
  if (urls.length > 0) {
    return {
      shouldUseWeb: true,
      reason: '用户输入中包含 URL，需要读取网页内容。',
      query: stripUrls(input),
      urls,
      action: 'extract',
      source: 'fallback',
      usesPreviousTurn: false
    };
  }

  if (previous && isWebFollowUp(trimmed)) {
    return {
      shouldUseWeb: true,
      reason: '用户要求对上一轮问题联网搜索或验证。',
      query: cleanQuery(previous),
      urls: extractUrls(previous),
      action: extractUrls(previous).length > 0 ? 'search_and_extract' : 'search',
      source: 'fallback',
      usesPreviousTurn: true
    };
  }

  if (explicitWebPatterns.some(pattern => pattern.test(trimmed))) {
    return {
      shouldUseWeb: true,
      reason: '用户显式要求搜索、联网或验证。',
      query: cleanQuery(trimmed),
      urls: [],
      action: 'search',
      source: 'fallback',
      usesPreviousTurn: false
    };
  }

  if (freshnessPatterns.some(pattern => pattern.test(trimmed))) {
    return {
      shouldUseWeb: true,
      reason: '问题包含时间敏感信息，需要联网确认。',
      query: cleanQuery(trimmed),
      urls: [],
      action: 'search',
      source: 'fallback',
      usesPreviousTurn: false
    };
  }

  if (dynamicEntityPatterns.some(pattern => pattern.test(trimmed)) && questionPatterns.test(trimmed)) {
    return {
      shouldUseWeb: true,
      reason: '问题涉及可能变化的实体或资料，需要联网核实。',
      query: cleanQuery(trimmed),
      urls: [],
      action: 'search',
      source: 'fallback',
      usesPreviousTurn: false
    };
  }

  return {
    shouldUseWeb: false,
    reason: '问题看起来不依赖最新外部信息。',
    urls: [],
    action: 'none',
    source: 'fallback',
    usesPreviousTurn: false
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

function isWebFollowUp(input: string): boolean {
  return webFollowUpPatterns.some(pattern => pattern.test(input));
}

function buildPlannerMessages(input: string, previousUserInput: string | undefined, history: ChatMessage[]): ChatMessage[] {
  const compactHistory = history.map(message => ({
    role: message.role,
    content: message.content
  }));
  return [
    {
      role: 'system',
      content: [
        '你是 neo-agent 的联网规划器，只判断当前回复是否需要使用网页工具。',
        '你必须只输出一个 JSON 对象，不要输出 markdown 或解释。',
        '判断原则：',
        '1. 如果问题涉及最新、当前、今天、近期、新闻、价格、天气、政策法规、软件版本、API 文档、体育赛程、公司职位、政治人物行程等可能变化的信息，应联网。',
        '2. 如果用户明确要求搜索、联网、查证、验证、打开链接、读取网页，应联网。',
        '3. 如果当前输入是“你搜一下”“联网验证一下”“查一下这个”等追问，要结合上一轮用户问题和会话历史，把 query 改写为被追问的真实问题，不要搜索追问句本身。',
        '4. 如果输入包含 http 或 https URL，action 用 extract，并返回这些 URL。',
        '5. 静态知识、写作、翻译、代码解释、数学推理通常不联网，除非用户明确要求查证或需要最新事实。',
        '6. 只规划搜索和网页提取，不要回答用户问题。',
        'JSON schema: {"needsWeb":boolean,"action":"none|search|extract|search_and_extract","query":string,"urls":string[],"usesPreviousTurn":boolean,"reason":string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        currentInput: input,
        previousUserInput: previousUserInput ?? '',
        recentConversation: compactHistory
      })
    }
  ];
}

function normalizeModelPlan(response: string, input: string, previousUserInput: string | undefined, fallbackPlan: WebPlan): WebPlan {
  const parsed = modelPlanSchema.parse(JSON.parse(extractJsonObject(response)));
  const inputUrls = extractUrls(input);
  const previousUrls = extractUrls(previousUserInput ?? '');
  const modelUrls = (parsed.urls ?? []).flatMap(url => extractUrls(url));
  const urls = [...new Set([
    ...modelUrls,
    ...(inputUrls.length > 0 ? inputUrls : []),
    ...(parsed.usesPreviousTurn ? previousUrls : [])
  ])];
  const action = parsed.needsWeb ? parsed.action : 'none';
  const querySource = parsed.query?.trim()
    || (parsed.usesPreviousTurn ? cleanQuery(previousUserInput ?? '') : cleanQuery(input));
  const shouldUseWeb = parsed.needsWeb && (action === 'extract' ? urls.length > 0 : Boolean(querySource || urls.length > 0));

  if (!shouldUseWeb) {
    return {
      shouldUseWeb: false,
      reason: parsed.reason?.trim() || '模型规划认为不需要联网。',
      urls: [],
      action: 'none',
      source: 'model',
      usesPreviousTurn: Boolean(parsed.usesPreviousTurn)
    };
  }

  if (action === 'none') {
    return fallbackPlan.shouldUseWeb ? fallbackPlan : {
      shouldUseWeb: false,
      reason: parsed.reason?.trim() || '模型规划没有选择联网动作。',
      urls: [],
      action: 'none',
      source: 'model',
      usesPreviousTurn: Boolean(parsed.usesPreviousTurn)
    };
  }

  return {
    shouldUseWeb: true,
    reason: parsed.reason?.trim() || '模型规划认为需要联网确认。',
    query: action === 'extract' && urls.length > 0 ? cleanQuery(stripUrls(querySource)) : querySource,
    urls,
    action,
    source: 'model',
    usesPreviousTurn: Boolean(parsed.usesPreviousTurn)
  };
}

function extractJsonObject(input: string): string {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('联网规划器没有返回 JSON 对象。');
  }
  return input.slice(start, end + 1);
}
