import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './types.js';
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from './utils/fs.js';

const modelSchema = z.object({
  model: z.string(),
  apiKey: z.string().optional(),
  apiBase: z.string(),
  temperature: z.number(),
  maxTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  retryBaseDelayMs: z.number().int().positive()
});

export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;
export const MIMO_MAX_OUTPUT_TOKENS = 131_072;

export const appConfigSchema: z.ZodType<AppConfig> = z.object({
  homeDir: z.string(),
  models: z.object({
    main: modelSchema,
    small: modelSchema,
    vision: modelSchema
  }),
  routing: z.object({
    smallModelMaxChars: z.number().int().positive(),
    forceMainKeywords: z.array(z.string())
  }),
  conversation: z.object({
    maxHistoryChars: z.number().int().positive(),
    maxMessageChars: z.number().int().positive(),
    compactEnabled: z.boolean(),
    compactThresholdRatio: z.number().positive().max(1),
    compactKeepRecentChars: z.number().int().positive(),
    compactMaxSummaryChars: z.number().int().positive()
  }),
  memory: z.object({
    backend: z.enum(['local', 'openviking', 'hybrid']),
    openVikingUrl: z.string(),
    maxHits: z.number().int().positive()
  }),
  dreaming: z.object({
    enabled: z.boolean(),
    minHours: z.number().positive(),
    minSessions: z.number().int().positive(),
    maxSessions: z.number().int().positive(),
    transcriptTailLines: z.number().int().positive(),
    maxMemories: z.number().int().positive(),
    modelKind: z.enum(['main', 'small'])
  }),
  web: z.object({
    provider: z.literal('tavily'),
    apiKey: z.string().optional(),
    apiBase: z.string(),
    autoSearch: z.boolean(),
    toolLoopEnabled: z.boolean(),
    maxToolRounds: z.number().int().positive(),
    plannerEnabled: z.boolean(),
    plannerModelKind: z.enum(['main', 'small']),
    searchDepth: z.enum(['basic', 'advanced']),
    extractDepth: z.enum(['basic', 'advanced']),
    maxResults: z.number().int().positive(),
    maxContextChars: z.number().int().positive(),
    maxDownloadChars: z.number().int().positive(),
    maxDepth: z.number().int().positive(),
    maxBreadth: z.number().int().positive(),
    maxPages: z.number().int().positive(),
    allowExternal: z.boolean(),
    allowedDomains: z.array(z.string()),
    blockedDomains: z.array(z.string()),
    blockPrivateAddresses: z.boolean(),
    selectPaths: z.array(z.string()),
    excludePaths: z.array(z.string()),
    selectDomains: z.array(z.string()),
    excludeDomains: z.array(z.string()),
    respectRobotsTxt: z.boolean(),
    timeoutMs: z.number().int().positive()
  }),
  workspace: z.object({
    dir: z.string().min(1)
  }),
  files: z.object({
    additionalReadDirs: z.array(z.string()),
    additionalWriteDirs: z.array(z.string())
  }),
  toolResults: z.object({
    enabled: z.boolean(),
    dir: z.string(),
    maxInlineChars: z.number().int().positive(),
    previewChars: z.number().int().positive()
  }),
  skills: z.object({
    autoCreate: z.boolean(),
    autoCreateThreshold: z.number().int().positive()
  }),
  mcp: z.object({
    servers: z.record(z.object({
      type: z.enum(['stdio', 'http', 'sse']).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string()).optional(),
      oauth: z.object({
        accessTokenEnv: z.string().optional(),
        accessToken: z.string().optional()
      }).optional(),
      disabled: z.boolean().optional()
    })),
    projectApprovals: z.record(z.array(z.string())),
    toolSearchThreshold: z.number().int().positive(),
    permissions: z.object({
      mode: z.enum(['readOnly', 'allowAll']),
      allowedTools: z.array(z.string()),
      deniedTools: z.array(z.string())
    })
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    file: z.string(),
    console: z.boolean(),
    maxBytes: z.number().int().positive(),
    retentionDays: z.number().int().nonnegative(),
    maxFiles: z.number().int().nonnegative()
  }),
  transcripts: z.object({
    enabled: z.boolean(),
    dir: z.string(),
    maxTailLines: z.number().int().positive()
  }),
  usage: z.object({
    enabled: z.boolean(),
    file: z.string(),
    prices: z.record(z.object({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
      currency: z.string().min(1)
    }))
  })
});

export function defaultConfig(): AppConfig {
  const homeDir = process.env.NEO_AGENT_HOME || path.join(os.homedir(), '.neo-agent');
  const deepseekApiBase = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';

  return {
    homeDir,
    models: {
      main: {
        model: process.env.NEO_AGENT_MAIN_MODEL || 'deepseek-v4-pro',
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiBase: deepseekApiBase,
        temperature: 0.2,
        maxTokens: Number.parseInt(process.env.NEO_AGENT_MAIN_MAX_TOKENS || String(DEEPSEEK_MAX_OUTPUT_TOKENS), 10),
        requestTimeoutMs: Number.parseInt(process.env.NEO_AGENT_MODEL_TIMEOUT_MS || '60000', 10),
        maxRetries: Number.parseInt(process.env.NEO_AGENT_MODEL_MAX_RETRIES || '2', 10),
        retryBaseDelayMs: Number.parseInt(process.env.NEO_AGENT_MODEL_RETRY_BASE_DELAY_MS || '500', 10)
      },
      small: {
        model: process.env.NEO_AGENT_SMALL_MODEL || 'deepseek-v4-flash',
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiBase: deepseekApiBase,
        temperature: 0.2,
        maxTokens: Number.parseInt(process.env.NEO_AGENT_SMALL_MAX_TOKENS || String(DEEPSEEK_MAX_OUTPUT_TOKENS), 10),
        requestTimeoutMs: Number.parseInt(process.env.NEO_AGENT_MODEL_TIMEOUT_MS || '45000', 10),
        maxRetries: Number.parseInt(process.env.NEO_AGENT_MODEL_MAX_RETRIES || '2', 10),
        retryBaseDelayMs: Number.parseInt(process.env.NEO_AGENT_MODEL_RETRY_BASE_DELAY_MS || '500', 10)
      },
      vision: {
        model: process.env.NEO_AGENT_VISION_MODEL || 'mimo-v2.5',
        apiKey: process.env.MIMO_API_KEY,
        apiBase: process.env.MIMO_API_BASE || 'https://token-plan-cn.xiaomimimo.com/v1',
        temperature: 0.0,
        maxTokens: Number.parseInt(process.env.NEO_AGENT_VISION_MAX_TOKENS || String(MIMO_MAX_OUTPUT_TOKENS), 10),
        requestTimeoutMs: Number.parseInt(process.env.NEO_AGENT_MODEL_TIMEOUT_MS || '60000', 10),
        maxRetries: Number.parseInt(process.env.NEO_AGENT_MODEL_MAX_RETRIES || '2', 10),
        retryBaseDelayMs: Number.parseInt(process.env.NEO_AGENT_MODEL_RETRY_BASE_DELAY_MS || '500', 10)
      }
    },
    routing: {
      smallModelMaxChars: 900,
      forceMainKeywords: [
        '开发',
        '实现',
        '架构',
        '重构',
        '调试',
        'PRD',
        '设计',
        '代码',
        'HTML',
        'CSS',
        'JS',
        'JavaScript',
        '落地页',
        '单文件',
        '写入文件',
        '生成文件',
        '网页',
        '页面',
        '多步',
        '分析'
      ]
    },
    conversation: {
      maxHistoryChars: Number.parseInt(process.env.NEO_AGENT_CONVERSATION_MAX_HISTORY_CHARS || '300000', 10),
      maxMessageChars: Number.parseInt(process.env.NEO_AGENT_CONVERSATION_MAX_MESSAGE_CHARS || '50000', 10),
      compactEnabled: process.env.NEO_AGENT_CONVERSATION_COMPACT_ENABLED !== '0',
      compactThresholdRatio: Number.parseFloat(process.env.NEO_AGENT_CONVERSATION_COMPACT_THRESHOLD_RATIO || '0.85'),
      compactKeepRecentChars: Number.parseInt(process.env.NEO_AGENT_CONVERSATION_COMPACT_KEEP_RECENT_CHARS || '120000', 10),
      compactMaxSummaryChars: Number.parseInt(process.env.NEO_AGENT_CONVERSATION_COMPACT_MAX_SUMMARY_CHARS || '20000', 10)
    },
    memory: {
      backend: (process.env.NEO_AGENT_MEMORY_BACKEND as AppConfig['memory']['backend']) || 'hybrid',
      openVikingUrl: process.env.NEO_AGENT_OPENVIKING_URL || 'http://localhost:1933',
      maxHits: 6
    },
    dreaming: {
      enabled: process.env.NEO_AGENT_DREAM_ENABLED === '1',
      minHours: Number.parseFloat(process.env.NEO_AGENT_DREAM_MIN_HOURS || '24'),
      minSessions: Number.parseInt(process.env.NEO_AGENT_DREAM_MIN_SESSIONS || '5', 10),
      maxSessions: Number.parseInt(process.env.NEO_AGENT_DREAM_MAX_SESSIONS || '5', 10),
      transcriptTailLines: Number.parseInt(process.env.NEO_AGENT_DREAM_TRANSCRIPT_TAIL_LINES || '80', 10),
      maxMemories: Number.parseInt(process.env.NEO_AGENT_DREAM_MAX_MEMORIES || '80', 10),
      modelKind: (process.env.NEO_AGENT_DREAM_MODEL_KIND as AppConfig['dreaming']['modelKind']) || 'main'
    },
    web: {
      provider: 'tavily',
      apiKey: process.env.TAVILY_API_KEY,
      apiBase: process.env.TAVILY_API_BASE || 'https://api.tavily.com',
      autoSearch: process.env.NEO_AGENT_WEB_AUTO_SEARCH !== '0',
      toolLoopEnabled: process.env.NEO_AGENT_WEB_TOOL_LOOP_ENABLED !== '0',
      maxToolRounds: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_TOOL_ROUNDS || '8', 10),
      plannerEnabled: process.env.NEO_AGENT_WEB_PLANNER_ENABLED !== '0',
      plannerModelKind: (process.env.NEO_AGENT_WEB_PLANNER_MODEL_KIND as AppConfig['web']['plannerModelKind']) || 'small',
      searchDepth: (process.env.NEO_AGENT_WEB_SEARCH_DEPTH as AppConfig['web']['searchDepth']) || 'basic',
      extractDepth: (process.env.NEO_AGENT_WEB_EXTRACT_DEPTH as AppConfig['web']['extractDepth']) || 'basic',
      maxResults: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_RESULTS || '5', 10),
      maxContextChars: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_CONTEXT_CHARS || '8000', 10),
      maxDownloadChars: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_DOWNLOAD_CHARS || '200000', 10),
      maxDepth: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_DEPTH || '1', 10),
      maxBreadth: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_BREADTH || '20', 10),
      maxPages: Number.parseInt(process.env.NEO_AGENT_WEB_MAX_PAGES || '20', 10),
      allowExternal: process.env.NEO_AGENT_WEB_ALLOW_EXTERNAL === '1',
      allowedDomains: parseCommaList(process.env.NEO_AGENT_WEB_ALLOWED_DOMAINS),
      blockedDomains: parseCommaList(process.env.NEO_AGENT_WEB_BLOCKED_DOMAINS),
      blockPrivateAddresses: process.env.NEO_AGENT_WEB_BLOCK_PRIVATE_ADDRESSES !== '0',
      selectPaths: parseCommaList(process.env.NEO_AGENT_WEB_SELECT_PATHS),
      excludePaths: parseCommaList(process.env.NEO_AGENT_WEB_EXCLUDE_PATHS),
      selectDomains: parseCommaList(process.env.NEO_AGENT_WEB_SELECT_DOMAINS),
      excludeDomains: parseCommaList(process.env.NEO_AGENT_WEB_EXCLUDE_DOMAINS),
      respectRobotsTxt: process.env.NEO_AGENT_WEB_RESPECT_ROBOTS_TXT !== '0',
      timeoutMs: Number.parseInt(process.env.NEO_AGENT_WEB_TIMEOUT_MS || '12000', 10)
    },
    workspace: {
      dir: process.env.NEO_AGENT_WORKSPACE_DIR || 'workspace'
    },
    files: {
      additionalReadDirs: parseCommaList(process.env.NEO_AGENT_FILE_READ_DIRS),
      additionalWriteDirs: parseCommaList(process.env.NEO_AGENT_FILE_WRITE_DIRS)
    },
    toolResults: {
      enabled: process.env.NEO_AGENT_TOOL_RESULTS_ENABLED !== '0',
      dir: process.env.NEO_AGENT_TOOL_RESULTS_DIR || '.neo-agent/tool-results',
      maxInlineChars: Number.parseInt(process.env.NEO_AGENT_TOOL_RESULTS_MAX_INLINE_CHARS || '60000', 10),
      previewChars: Number.parseInt(process.env.NEO_AGENT_TOOL_RESULTS_PREVIEW_CHARS || '12000', 10)
    },
    skills: {
      autoCreate: true,
      autoCreateThreshold: 2
    },
    mcp: {
      servers: {},
      projectApprovals: {},
      toolSearchThreshold: Number.parseInt(process.env.NEO_AGENT_MCP_TOOL_SEARCH_THRESHOLD || '20', 10),
      permissions: {
        mode: getMcpPermissionMode(),
        allowedTools: parseCommaList(process.env.NEO_AGENT_MCP_ALLOWED_TOOLS),
        deniedTools: parseCommaList(process.env.NEO_AGENT_MCP_DENIED_TOOLS)
      }
    },
    logging: {
      level: (process.env.NEO_AGENT_LOG_LEVEL as AppConfig['logging']['level']) || 'info',
      file: process.env.NEO_AGENT_LOG_FILE || 'logs/neo-agent.log',
      console: process.env.NEO_AGENT_LOG_CONSOLE === '1',
      maxBytes: Number.parseInt(process.env.NEO_AGENT_LOG_MAX_BYTES || String(5 * 1024 * 1024), 10),
      retentionDays: Number.parseInt(process.env.NEO_AGENT_LOG_RETENTION_DAYS || '14', 10),
      maxFiles: Number.parseInt(process.env.NEO_AGENT_LOG_MAX_FILES || '20', 10)
    },
    transcripts: {
      enabled: process.env.NEO_AGENT_TRANSCRIPTS_ENABLED !== '0',
      dir: process.env.NEO_AGENT_TRANSCRIPTS_DIR || 'transcripts',
      maxTailLines: Number.parseInt(process.env.NEO_AGENT_TRANSCRIPTS_TAIL_LINES || '80', 10)
    },
    usage: {
      enabled: process.env.NEO_AGENT_USAGE_ENABLED !== '0',
      file: process.env.NEO_AGENT_USAGE_FILE || 'usage/model-usage.jsonl',
      prices: parseUsagePrices(process.env.NEO_AGENT_USAGE_PRICES_JSON)
    }
  };
}

function parseUsagePrices(input: string | undefined): AppConfig['usage']['prices'] {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const output: AppConfig['usage']['prices'] = {};
    for (const [model, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const inputPrice = Number(record.inputPerMillion);
      const outputPrice = Number(record.outputPerMillion);
      const currency = typeof record.currency === 'string' && record.currency.trim() ? record.currency.trim() : 'USD';
      if (Number.isFinite(inputPrice) && Number.isFinite(outputPrice) && inputPrice >= 0 && outputPrice >= 0) {
        output[model] = {
          inputPerMillion: inputPrice,
          outputPerMillion: outputPrice,
          currency
        };
      }
    }
    return output;
  } catch {
    return {};
  }
}

function getMcpPermissionMode(): AppConfig['mcp']['permissions']['mode'] {
  const raw = process.env.NEO_AGENT_MCP_PERMISSION_MODE;
  if (raw === 'allowAll') return 'allowAll';
  return 'readOnly';
}

function parseCommaList(input: string | undefined): string[] {
  if (!input) return [];
  return input.split(',').map(item => item.trim()).filter(Boolean);
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!override || typeof override !== 'object') return base;
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const current = output[key];
    if (
      value &&
      current &&
      typeof value === 'object' &&
      typeof current === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(current)
    ) {
      output[key] = deepMerge(current, value as Record<string, unknown>);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}

export async function loadConfig(cwd = process.cwd()): Promise<AppConfig> {
  const { defaults, userConfig, projectConfig } = await loadConfigSources(cwd);
  const merged = deepMerge(deepMerge(defaults, userConfig), projectConfig);
  applyRuntimeEnvOverrides(merged);
  return validateConfig(merged);
}

export async function loadConfigSources(cwd = process.cwd()): Promise<{
  defaults: AppConfig;
  userConfig: Partial<AppConfig>;
  projectConfig: Partial<AppConfig>;
  userConfigPath: string;
  projectConfigPath: string;
}> {
  const defaults = defaultConfig();
  const userConfigPath = path.join(defaults.homeDir, 'config.json');
  const projectConfigPath = path.join(cwd, 'neo-agent.config.json');
  const projectMcpConfigPath = path.join(cwd, '.mcp.json');
  const userConfig = await readJsonFile<Partial<AppConfig>>(userConfigPath, {});
  const projectConfig = await readJsonFile<Partial<AppConfig>>(projectConfigPath, {});
  const projectMcpConfig = await readProjectMcpConfig(projectMcpConfigPath, userConfig, cwd);
  return {
    defaults,
    userConfig,
    projectConfig: deepMerge(projectConfig, projectMcpConfig),
    userConfigPath,
    projectConfigPath
  };
}

async function readProjectMcpConfig(filePath: string, userConfig: Partial<AppConfig>, cwd: string): Promise<Partial<AppConfig>> {
  const raw = await readJsonFile<{ mcpServers?: unknown }>(filePath, {});
  if (!raw.mcpServers || typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers)) return {};
  const projectKey = path.resolve(cwd);
  const approved = new Set(userConfig.mcp?.projectApprovals?.[projectKey] ?? []);
  const approvedServers = Object.fromEntries(
    Object.entries(raw.mcpServers as AppConfig['mcp']['servers']).filter(([name]) => approved.has(name))
  );
  if (Object.keys(approvedServers).length === 0) return {};
  return {
    mcp: {
      servers: approvedServers
    }
  } as Partial<AppConfig>;
}

export function validateConfig(value: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid neo-agent config: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function mergeConfigSources(defaults: AppConfig, userConfig: Partial<AppConfig>, projectConfig: Partial<AppConfig>): AppConfig {
  const merged = deepMerge(deepMerge(defaults, userConfig), projectConfig);
  applyRuntimeEnvOverrides(merged);
  return validateConfig(merged);
}

export async function initConfigFile(cwd = process.cwd()): Promise<string> {
  const config = defaultConfig();
  await ensureDir(config.homeDir);
  const filePath = path.join(config.homeDir, 'config.json');
  if (await pathExists(filePath)) return filePath;
  await writeJsonFile(filePath, config);
  void cwd;
  return filePath;
}

function applyRuntimeEnvOverrides(config: AppConfig): void {
  if (process.env.NEO_AGENT_MEMORY_BACKEND === 'local' || process.env.NEO_AGENT_MEMORY_BACKEND === 'openviking' || process.env.NEO_AGENT_MEMORY_BACKEND === 'hybrid') {
    config.memory.backend = process.env.NEO_AGENT_MEMORY_BACKEND;
  }
  if (process.env.NEO_AGENT_OPENVIKING_URL) config.memory.openVikingUrl = process.env.NEO_AGENT_OPENVIKING_URL;
  if (process.env.NEO_AGENT_WORKSPACE_DIR) config.workspace.dir = process.env.NEO_AGENT_WORKSPACE_DIR;
  applyPositiveIntegerEnvOverride(config.models.main, 'maxTokens', process.env.NEO_AGENT_MAIN_MAX_TOKENS);
  applyPositiveIntegerEnvOverride(config.models.small, 'maxTokens', process.env.NEO_AGENT_SMALL_MAX_TOKENS);
  applyPositiveIntegerEnvOverride(config.models.vision, 'maxTokens', process.env.NEO_AGENT_VISION_MAX_TOKENS);
}

function applyPositiveIntegerEnvOverride<T extends Record<string, unknown>>(target: T, key: keyof T, raw: string | undefined): void {
  if (!raw) return;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) target[key] = parsed as T[keyof T];
}
