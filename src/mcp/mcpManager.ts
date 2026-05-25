import type { AppConfig } from '../types.js';
import type { Logger } from '../logging/logger.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpToolDetail = {
  serverName: string;
  toolName: string;
  fullName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export type McpResourceDetail = {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blobBytes?: number;
};

type ConnectedServer = {
  name: string;
  client: {
    listTools: () => Promise<{ tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
    }> }>;
    callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    listResources?: () => Promise<{ resources?: Array<{
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
    }> }>;
    readResource?: (input: { uri: string }) => Promise<{ contents?: Array<{
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }> }>;
    close?: () => Promise<void>;
  };
};

export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();

  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {}

  async connectAll(): Promise<void> {
    const enabled = Object.entries(this.config.mcp.servers).filter(([, server]) => !server.disabled);
    if (enabled.length === 0) {
      this.logger?.debug('mcp.connect.skip', { reason: 'no_enabled_servers' });
      return;
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    for (const [name, server] of enabled) {
      const start = Date.now();
      const client = new Client({ name: 'neo-agent', version: '0.1.0' });
      const transport = await createTransport(name, server);
      try {
        await client.connect(transport);
      } catch (error) {
        this.logger?.error('mcp.connect.error', error, { server: name, type: server.type ?? 'stdio', command: server.command, url: server.url });
        throw error;
      }
      this.servers.set(name, { name, client });
      this.logger?.info('mcp.connect.success', {
        server: name,
        type: server.type ?? 'stdio',
        durationMs: Date.now() - start
      });
    }
  }

  async listTools(): Promise<string[]> {
    const details = await this.listToolDetails();
    const output = details.map(tool => `${tool.serverName}.${tool.toolName}${tool.description ? ` - ${tool.description}` : ''}`);
    return output;
  }

  async listToolDetails(): Promise<McpToolDetail[]> {
    const output: McpToolDetail[] = [];
    for (const server of this.servers.values()) {
      const result = await server.client.listTools();
      for (const tool of result.tools ?? []) {
        output.push({
          serverName: server.name,
          toolName: tool.name,
          fullName: buildMcpToolName(server.name, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          readOnlyHint: tool.annotations?.readOnlyHint,
          destructiveHint: tool.annotations?.destructiveHint,
          openWorldHint: tool.annotations?.openWorldHint
        });
      }
    }
    this.logger?.debug('mcp.tools.list', { connectedServers: this.servers.size, toolCount: output.length });
    return output;
  }

  connectedServerNames(): string[] {
    return [...this.servers.keys()];
  }

  async listResources(serverName?: string): Promise<McpResourceDetail[]> {
    const servers = this.getTargetServers(serverName);
    const output: McpResourceDetail[] = [];
    for (const server of servers) {
      if (!server.client.listResources) continue;
      const result = await server.client.listResources();
      for (const resource of result.resources ?? []) {
        output.push({
          serverName: server.name,
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType
        });
      }
    }
    this.logger?.debug('mcp.resources.list', { server: serverName, resourceCount: output.length });
    return output;
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceContent[]> {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server is not connected: ${serverName}`);
    if (!server.client.readResource) throw new Error(`MCP server does not support resources/read: ${serverName}`);
    const result = await server.client.readResource({ uri });
    return (result.contents ?? []).map(content => ({
      uri: content.uri,
      mimeType: content.mimeType,
      text: content.text,
      blobBytes: content.blob ? Buffer.byteLength(content.blob, 'base64') : undefined
    }));
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const [serverName, toolName] = qualifiedName.split('.', 2);
    if (!serverName || !toolName) throw new Error('Use qualified MCP tool name: server.tool');
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server is not connected: ${serverName}`);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('MCP 工具已取消');
    return await this.abortableMcpRequest(server, () => server.client.callTool({ name: toolName, arguments: args }), options.signal);
  }

  async close(): Promise<void> {
    for (const server of this.servers.values()) {
      await server.client.close?.();
    }
    this.servers.clear();
  }

  private getTargetServers(serverName?: string): ConnectedServer[] {
    if (!serverName) return [...this.servers.values()];
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server is not connected: ${serverName}`);
    return [server];
  }

  private async abortableMcpRequest<T>(server: ConnectedServer, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return run();
    let settled = false;
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        void server.client.close?.().catch(error => {
          this.logger?.warn('mcp.abort.close_error', {
            server: server.name,
            errorMessage: error instanceof Error ? error.message : String(error)
          });
        });
        this.servers.delete(server.name);
        reject(signal.reason instanceof Error ? signal.reason : new Error(`MCP 请求已取消：${server.name}`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      run().then(
        result => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        error => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

async function createTransport(name: string, server: AppConfig['mcp']['servers'][string]): Promise<Transport> {
  const type = server.type ?? 'stdio';
  if (type === 'stdio') {
    if (!server.command?.trim()) throw new Error(`MCP stdio server 缺少 command：${name}`);
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: {
        ...process.env,
        ...(server.env ?? {})
      } as Record<string, string>
    });
  }

  if (!server.url?.trim()) throw new Error(`MCP ${type} server 缺少 url：${name}`);
  const url = new URL(server.url);
  const headers = buildRemoteHeaders(server);
  if (type === 'http') {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined
    });
  }
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  return new SSEClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    eventSourceInit: Object.keys(headers).length > 0 ? { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }) } : undefined
  });
}

function buildRemoteHeaders(server: AppConfig['mcp']['servers'][string]): Record<string, string> {
  const headers: Record<string, string> = { ...(server.headers ?? {}) };
  const token = server.oauth?.accessTokenEnv
    ? process.env[server.oauth.accessTokenEnv]
    : server.oauth?.accessToken;
  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
