import type { AppConfig } from '../types.js';
import type { Logger } from '../logging/logger.js';

type ConnectedServer = {
  name: string;
  client: {
    listTools: () => Promise<{ tools?: Array<{ name: string; description?: string }> }>;
    callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
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

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);

    for (const [name, server] of enabled) {
      const start = Date.now();
      const client = new Client({ name: 'neo-agent', version: '0.1.0' });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: {
          ...process.env,
          ...(server.env ?? {})
        } as Record<string, string>
      });
      try {
        await client.connect(transport);
      } catch (error) {
        this.logger?.error('mcp.connect.error', error, { server: name, command: server.command });
        throw error;
      }
      this.servers.set(name, { name, client });
      this.logger?.info('mcp.connect.success', {
        server: name,
        command: server.command,
        durationMs: Date.now() - start
      });
    }
  }

  async listTools(): Promise<string[]> {
    const output: string[] = [];
    for (const server of this.servers.values()) {
      const result = await server.client.listTools();
      for (const tool of result.tools ?? []) {
        output.push(`${server.name}.${tool.name}${tool.description ? ` - ${tool.description}` : ''}`);
      }
    }
    this.logger?.debug('mcp.tools.list', { connectedServers: this.servers.size, toolCount: output.length });
    return output;
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const [serverName, toolName] = qualifiedName.split('.', 2);
    if (!serverName || !toolName) throw new Error('Use qualified MCP tool name: server.tool');
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server is not connected: ${serverName}`);
    return server.client.callTool({ name: toolName, arguments: args });
  }

  async close(): Promise<void> {
    for (const server of this.servers.values()) {
      await server.client.close?.();
    }
    this.servers.clear();
  }
}
