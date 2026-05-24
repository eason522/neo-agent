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
  maxTokens: z.number().int().positive()
});

const appConfigSchema: z.ZodType<AppConfig> = z.object({
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
  memory: z.object({
    backend: z.enum(['local', 'openviking', 'hybrid']),
    openVikingUrl: z.string(),
    maxHits: z.number().int().positive()
  }),
  skills: z.object({
    autoCreate: z.boolean(),
    autoCreateThreshold: z.number().int().positive()
  }),
  mcp: z.object({
    servers: z.record(z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      disabled: z.boolean().optional()
    }))
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    file: z.string(),
    console: z.boolean()
  }),
  transcripts: z.object({
    enabled: z.boolean(),
    dir: z.string(),
    maxTailLines: z.number().int().positive()
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
        maxTokens: 4096
      },
      small: {
        model: process.env.NEO_AGENT_SMALL_MODEL || 'deepseek-v4-flash',
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiBase: deepseekApiBase,
        temperature: 0.2,
        maxTokens: 2048
      },
      vision: {
        model: process.env.NEO_AGENT_VISION_MODEL || 'mimo-v2.5',
        apiKey: process.env.MIMO_API_KEY,
        apiBase: process.env.MIMO_API_BASE || 'https://token-plan-cn.xiaomimimo.com/v1',
        temperature: 0.0,
        maxTokens: 2048
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
        '多步',
        '分析'
      ]
    },
    memory: {
      backend: (process.env.NEO_AGENT_MEMORY_BACKEND as AppConfig['memory']['backend']) || 'hybrid',
      openVikingUrl: process.env.NEO_AGENT_OPENVIKING_URL || 'http://localhost:1933',
      maxHits: 6
    },
    skills: {
      autoCreate: true,
      autoCreateThreshold: 2
    },
    mcp: {
      servers: {}
    },
    logging: {
      level: (process.env.NEO_AGENT_LOG_LEVEL as AppConfig['logging']['level']) || 'info',
      file: process.env.NEO_AGENT_LOG_FILE || 'logs/neo-agent.log',
      console: process.env.NEO_AGENT_LOG_CONSOLE === '1'
    },
    transcripts: {
      enabled: process.env.NEO_AGENT_TRANSCRIPTS_ENABLED !== '0',
      dir: process.env.NEO_AGENT_TRANSCRIPTS_DIR || 'transcripts',
      maxTailLines: Number.parseInt(process.env.NEO_AGENT_TRANSCRIPTS_TAIL_LINES || '80', 10)
    }
  };
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
  const defaults = defaultConfig();
  const userConfigPath = path.join(defaults.homeDir, 'config.json');
  const projectConfigPath = path.join(cwd, 'neo-agent.config.json');

  const userConfig = await readJsonFile<Partial<AppConfig>>(userConfigPath, {});
  const projectConfig = await readJsonFile<Partial<AppConfig>>(projectConfigPath, {});
  const merged = deepMerge(deepMerge(defaults, userConfig), projectConfig);
  const parsed = appConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid neo-agent config: ${parsed.error.message}`);
  }
  return parsed.data;
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
