import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './types.js';
import { loadConfigSources, mergeConfigSources } from './config.js';
import { readJsonFile, writeJsonFile } from './utils/fs.js';

type ConfigScope = 'user' | 'project';

const sensitivePathPattern = /(^|\.)(apiKey|api_key|token|secret|password|authorization)(\.|$)/i;
const blockedPathSegments = new Set(['__proto__', 'prototype', 'constructor']);

export async function showConfig(input: {
  cwd?: string;
  redacted?: boolean;
  source?: 'merged' | ConfigScope;
} = {}): Promise<{ source: string; path?: string; config: unknown }> {
  const cwd = input.cwd ?? process.cwd();
  const sources = await loadConfigSources(cwd);
  const source = input.source ?? 'merged';
  const config = source === 'merged'
    ? mergeConfigSources(sources.defaults, sources.userConfig, sources.projectConfig)
    : source === 'user'
      ? sources.userConfig
      : sources.projectConfig;
  const filePath = source === 'user' ? sources.userConfigPath : source === 'project' ? sources.projectConfigPath : undefined;
  return {
    source,
    path: filePath,
    config: input.redacted === false ? config : redactConfig(config)
  };
}

export async function setConfigValue(input: {
  keyPath: string;
  rawValue: string;
  scope?: ConfigScope;
  cwd?: string;
}): Promise<{ scope: ConfigScope; path: string; value: unknown; keyPath: string }> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? 'user';
  const sources = await loadConfigSources(cwd);
  const targetPath = scope === 'user' ? sources.userConfigPath : sources.projectConfigPath;
  const current = await readJsonFile<Record<string, unknown>>(targetPath, {});
  const next = structuredCloneJson(current);
  const value = parseConfigValue(input.rawValue);
  setNestedValue(next, input.keyPath, value);

  const userConfig = scope === 'user' ? next as Partial<AppConfig> : sources.userConfig;
  const projectConfig = scope === 'project' ? next as Partial<AppConfig> : sources.projectConfig;
  mergeConfigSources(sources.defaults, userConfig, projectConfig);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeJsonFile(targetPath, next);
  return { scope, path: targetPath, value, keyPath: input.keyPath };
}

export function redactConfig(input: unknown): unknown {
  return redactValue(input, '');
}

export function parseConfigValue(input: string): unknown {
  const trimmed = input.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return JSON.parse(trimmed);
  }
  return input;
}

function redactValue(input: unknown, keyPath: string): unknown {
  if (Array.isArray(input)) return input.map((value, index) => redactValue(value, `${keyPath}.${index}`));
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string' && sensitivePathPattern.test(keyPath)) return maskSecret(input);
    return input;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    output[key] = sensitivePathPattern.test(childPath) ? maskSecret(value) : redactValue(value, childPath);
  }
  return output;
}

function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '[未设置]';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function setNestedValue(target: Record<string, unknown>, keyPath: string, value: unknown): void {
  const segments = keyPath.split('.').map(item => item.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('配置 key 不能为空。');
  for (const segment of segments) {
    if (blockedPathSegments.has(segment)) throw new Error(`拒绝不安全的配置 key：${segment}`);
  }
  let current: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function structuredCloneJson<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}
