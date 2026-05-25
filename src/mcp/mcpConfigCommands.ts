import path from 'node:path';
import { defaultConfig, loadConfig } from '../config.js';
import type { AppConfig, McpServerConfig } from '../types.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { McpManager } from './mcpManager.js';

type RawUserConfig = Record<string, unknown> & {
  mcp?: Record<string, unknown> & {
    servers?: Record<string, McpServerConfig>;
    permissions?: {
      allowedTools?: string[];
      deniedTools?: string[];
    };
  };
};

export type McpConfigEntry = {
  name: string;
  server: McpServerConfig;
};

export async function listConfiguredMcpServers(): Promise<{ filePath: string; entries: McpConfigEntry[] }> {
  const filePath = getUserConfigPath();
  const config = await readRawUserConfig(filePath);
  const servers = config.mcp?.servers ?? {};
  return {
    filePath,
    entries: Object.entries(servers).map(([name, server]) => ({ name, server }))
  };
}

export async function addConfiguredMcpServer(input: {
  name: string;
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  oauthTokenEnv?: string;
  env?: Record<string, string>;
  disabled?: boolean;
}): Promise<{ filePath: string; server: McpServerConfig }> {
  validateServerName(input.name);
  const type = input.type ?? 'stdio';
  if (type === 'stdio' && !input.command?.trim()) throw new Error('MCP stdio server command 不能为空。');
  if ((type === 'http' || type === 'sse') && !input.url?.trim()) throw new Error(`MCP ${type} server url 不能为空。`);
  const filePath = getUserConfigPath();
  const config = await readRawUserConfig(filePath);
  const mcp = ensureMcpConfig(config);
  const server: McpServerConfig = {
    type,
    ...(input.command ? { command: input.command } : {}),
    ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    ...(input.oauthTokenEnv ? { oauth: { accessTokenEnv: input.oauthTokenEnv } } : {}),
    ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
    ...(input.disabled ? { disabled: true } : {})
  };
  mcp.servers[input.name] = server;
  await writeRawUserConfig(filePath, config);
  return { filePath, server };
}

export async function removeConfiguredMcpServer(name: string): Promise<{ filePath: string; removed: boolean }> {
  validateServerName(name);
  const filePath = getUserConfigPath();
  const config = await readRawUserConfig(filePath);
  const mcp = ensureMcpConfig(config);
  const removed = Boolean(mcp.servers[name]);
  delete mcp.servers[name];
  await writeRawUserConfig(filePath, config);
  return { filePath, removed };
}

export async function updateMcpToolPermission(input: {
  tool: string;
  behavior: 'allow' | 'deny';
  remove?: boolean;
}): Promise<{ filePath: string; allowedTools: string[]; deniedTools: string[] }> {
  const tool = input.tool.trim();
  if (!tool) throw new Error('MCP tool 名称不能为空。');
  const filePath = getUserConfigPath();
  const config = await readRawUserConfig(filePath);
  const mcp = ensureMcpConfig(config);
  mcp.permissions ??= {};
  mcp.permissions.allowedTools ??= [];
  mcp.permissions.deniedTools ??= [];
  const target = input.behavior === 'allow' ? mcp.permissions.allowedTools : mcp.permissions.deniedTools;
  const opposite = input.behavior === 'allow' ? mcp.permissions.deniedTools : mcp.permissions.allowedTools;
  if (input.remove) {
    mcp.permissions.allowedTools = mcp.permissions.allowedTools.filter(rule => rule !== tool);
    mcp.permissions.deniedTools = mcp.permissions.deniedTools.filter(rule => rule !== tool);
  } else {
    if (!target.includes(tool)) target.push(tool);
    const filtered = opposite.filter(rule => rule !== tool);
    if (input.behavior === 'allow') mcp.permissions.deniedTools = filtered;
    else mcp.permissions.allowedTools = filtered;
  }
  await writeRawUserConfig(filePath, config);
  return {
    filePath,
    allowedTools: mcp.permissions.allowedTools,
    deniedTools: mcp.permissions.deniedTools
  };
}

export async function testConfiguredMcpServers(name?: string): Promise<Array<{
  name: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  error?: string;
}>> {
  const config = await loadConfig();
  const entries = Object.entries(config.mcp.servers)
    .filter(([serverName, server]) => !server.disabled && (!name || serverName === name));
  if (name && entries.length === 0) throw new Error(`没有找到启用的 MCP server：${name}`);

  const results = [];
  for (const [serverName, server] of entries) {
    const testConfig: AppConfig = {
      ...config,
      mcp: {
        ...config.mcp,
        servers: {
          [serverName]: server
        }
      }
    };
    const manager = new McpManager(testConfig);
    try {
      await manager.connectAll();
      const tools = await manager.listToolDetails();
      results.push({
        name: serverName,
        status: 'connected' as const,
        toolCount: tools.length
      });
    } catch (error) {
      results.push({
        name: serverName,
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await manager.close().catch(() => undefined);
    }
  }
  return results;
}

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) throw new Error(`环境变量必须使用 KEY=VALUE 格式：${pair}`);
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名无效：${key}`);
    output[key] = value;
  }
  return output;
}

export function parseHeaderPairs(pairs: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) throw new Error(`HTTP header 必须使用 KEY=VALUE 格式：${pair}`);
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) throw new Error(`HTTP header 名称无效：${key}`);
    output[key] = value;
  }
  return output;
}

export function formatMcpServerEntry(entry: McpConfigEntry): string {
  const type = entry.server.type ?? 'stdio';
  const args = entry.server.args?.length ? ` ${entry.server.args.join(' ')}` : '';
  const disabled = entry.server.disabled ? ' [disabled]' : '';
  const envCount = entry.server.env ? Object.keys(entry.server.env).length : 0;
  const env = envCount > 0 ? ` env=${envCount}` : '';
  const headers = entry.server.headers ? ` headers=${Object.keys(entry.server.headers).length}` : '';
  const oauth = entry.server.oauth?.accessTokenEnv ? ` oauth=${entry.server.oauth.accessTokenEnv}` : '';
  const target = type === 'stdio' ? `${entry.server.command ?? ''}${args}` : `${entry.server.url ?? ''}`;
  return `${entry.name}${disabled}: ${type} ${target}${env}${headers}${oauth}`;
}

function getUserConfigPath(): string {
  const defaults = defaultConfig();
  return path.join(defaults.homeDir, 'config.json');
}

async function readRawUserConfig(filePath: string): Promise<RawUserConfig> {
  return readJsonFile<RawUserConfig>(filePath, {});
}

async function writeRawUserConfig(filePath: string, config: RawUserConfig): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeJsonFile(filePath, config);
}

function ensureMcpConfig(config: RawUserConfig): { servers: Record<string, McpServerConfig>; permissions?: { allowedTools?: string[]; deniedTools?: string[] } } {
  config.mcp ??= {};
  config.mcp.servers ??= {};
  return config.mcp as Record<string, unknown> & { servers: Record<string, McpServerConfig>; permissions?: { allowedTools?: string[]; deniedTools?: string[] } };
}

function validateServerName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('MCP server 名称只能包含字母、数字、下划线和短横线，长度 1-64。');
  }
}
