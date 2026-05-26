import path from 'node:path';
import { defaultConfig, loadConfig } from '../config.js';
import type { AppConfig, McpServerConfig } from '../types.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { McpManager } from './mcpManager.js';

type RawUserConfig = Record<string, unknown> & {
  mcp?: Record<string, unknown> & {
    servers?: Record<string, McpServerConfig>;
    projectApprovals?: Record<string, string[]>;
    permissions?: {
      allowedTools?: string[];
      deniedTools?: string[];
    };
  };
};

type RawProjectMcpConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type McpConfigScope = 'user' | 'project';

export type McpConfigEntry = {
  name: string;
  server: McpServerConfig;
  scope: McpConfigScope;
  approved: boolean;
};

export async function listConfiguredMcpServers(options: { scope?: McpConfigScope; cwd?: string } = {}): Promise<{ filePath: string; entries: McpConfigEntry[] }> {
  const userFilePath = getUserConfigPath();
  const projectFilePath = getProjectMcpConfigPath(options.cwd);
  const userConfig = await readRawUserConfig(userFilePath);
  const approvedProjectServers = new Set(userConfig.mcp?.projectApprovals?.[getProjectApprovalKey(options.cwd)] ?? []);
  const entries: McpConfigEntry[] = [];
  if (!options.scope || options.scope === 'user') {
    entries.push(...Object.entries(userConfig.mcp?.servers ?? {}).map(([name, server]) => ({ name, server, scope: 'user' as const, approved: true })));
  }
  if (!options.scope || options.scope === 'project') {
    const projectConfig = await readRawProjectMcpConfig(projectFilePath);
    entries.push(...Object.entries(projectConfig.mcpServers ?? {}).map(([name, server]) => ({ name, server, scope: 'project' as const, approved: approvedProjectServers.has(name) })));
  }
  return {
    filePath: options.scope === 'project' ? projectFilePath : options.scope === 'user' ? userFilePath : `${userFilePath} + ${projectFilePath}`,
    entries: entries.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
  };
}

export async function addConfiguredMcpServer(input: {
  name: string;
  scope?: McpConfigScope;
  cwd?: string;
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  oauthTokenEnv?: string;
  env?: Record<string, string>;
  disabled?: boolean;
}): Promise<{ filePath: string; server: McpServerConfig; approved: boolean }> {
  validateServerName(input.name);
  const type = input.type ?? 'stdio';
  if (type === 'stdio' && !input.command?.trim()) throw new Error('MCP stdio server command 不能为空。');
  if ((type === 'http' || type === 'sse') && !input.url?.trim()) throw new Error(`MCP ${type} server url 不能为空。`);
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
  const scope = input.scope ?? 'user';
  const filePath = scope === 'project' ? getProjectMcpConfigPath(input.cwd) : getUserConfigPath();
  if (scope === 'project') {
    const config = await readRawProjectMcpConfig(filePath);
    config.mcpServers ??= {};
    config.mcpServers[input.name] = server;
    await writeRawProjectMcpConfig(filePath, config);
  } else {
    const config = await readRawUserConfig(filePath);
    const mcp = ensureMcpConfig(config);
    mcp.servers[input.name] = server;
    await writeRawUserConfig(filePath, config);
  }
  return { filePath, server, approved: scope === 'user' };
}

export async function removeConfiguredMcpServer(name: string, options: { scope?: McpConfigScope; cwd?: string } = {}): Promise<{ filePath: string; removed: boolean }> {
  validateServerName(name);
  const scope = options.scope ?? 'user';
  const filePath = scope === 'project' ? getProjectMcpConfigPath(options.cwd) : getUserConfigPath();
  let removed = false;
  if (scope === 'project') {
    const config = await readRawProjectMcpConfig(filePath);
    removed = Boolean(config.mcpServers?.[name]);
    if (config.mcpServers) delete config.mcpServers[name];
    await writeRawProjectMcpConfig(filePath, config);
    if (removed) await updateProjectApprovalList(name, { approved: false, cwd: options.cwd });
  } else {
    const config = await readRawUserConfig(filePath);
    const mcp = ensureMcpConfig(config);
    removed = Boolean(mcp.servers[name]);
    delete mcp.servers[name];
    await writeRawUserConfig(filePath, config);
  }
  return { filePath, removed };
}

export async function updateProjectMcpServerApproval(input: {
  name: string;
  approved: boolean;
  cwd?: string;
}): Promise<{ filePath: string; projectKey: string; approvedServers: string[] }> {
  validateServerName(input.name);
  const projectFilePath = getProjectMcpConfigPath(input.cwd);
  const projectConfig = await readRawProjectMcpConfig(projectFilePath);
  if (!projectConfig.mcpServers?.[input.name]) throw new Error(`没有找到项目 MCP server：${input.name}`);
  return updateProjectApprovalList(input.name, { approved: input.approved, cwd: input.cwd });
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
  const approval = entry.scope === 'project' ? ` approval=${entry.approved ? 'approved' : 'pending'}` : '';
  const target = type === 'stdio' ? `${entry.server.command ?? ''}${args}` : `${entry.server.url ?? ''}`;
  return `${entry.name}${disabled}: ${type} ${target}${env}${headers}${oauth} scope=${entry.scope}${approval}`;
}

function getUserConfigPath(): string {
  const defaults = defaultConfig();
  return path.join(defaults.homeDir, 'config.json');
}

function getProjectMcpConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, '.mcp.json');
}

function getProjectApprovalKey(cwd = process.cwd()): string {
  return path.resolve(cwd);
}

async function readRawUserConfig(filePath: string): Promise<RawUserConfig> {
  return readJsonFile<RawUserConfig>(filePath, {});
}

async function readRawProjectMcpConfig(filePath: string): Promise<RawProjectMcpConfig> {
  return readJsonFile<RawProjectMcpConfig>(filePath, {});
}

async function writeRawUserConfig(filePath: string, config: RawUserConfig): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeJsonFile(filePath, config);
}

async function writeRawProjectMcpConfig(filePath: string, config: RawProjectMcpConfig): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeJsonFile(filePath, config);
}

function ensureMcpConfig(config: RawUserConfig): {
  servers: Record<string, McpServerConfig>;
  projectApprovals?: Record<string, string[]>;
  permissions?: { allowedTools?: string[]; deniedTools?: string[] };
} {
  config.mcp ??= {};
  config.mcp.servers ??= {};
  return config.mcp as Record<string, unknown> & {
    servers: Record<string, McpServerConfig>;
    projectApprovals?: Record<string, string[]>;
    permissions?: { allowedTools?: string[]; deniedTools?: string[] };
  };
}

async function updateProjectApprovalList(name: string, options: { approved: boolean; cwd?: string }): Promise<{ filePath: string; projectKey: string; approvedServers: string[] }> {
  const filePath = getUserConfigPath();
  const projectKey = getProjectApprovalKey(options.cwd);
  const config = await readRawUserConfig(filePath);
  const mcp = ensureMcpConfig(config);
  mcp.projectApprovals ??= {};
  const current = mcp.projectApprovals[projectKey] ?? [];
  const next = options.approved
    ? Array.from(new Set([...current, name])).sort()
    : current.filter(serverName => serverName !== name);
  if (next.length > 0) mcp.projectApprovals[projectKey] = next;
  else delete mcp.projectApprovals[projectKey];
  await writeRawUserConfig(filePath, config);
  return { filePath, projectKey, approvedServers: next };
}

function validateServerName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('MCP server 名称只能包含字母、数字、下划线和短横线，长度 1-64。');
  }
}
