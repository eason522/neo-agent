import type { AppConfig } from '../types.js';

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

  constructor(private readonly config: AppConfig) {}

  async connectAll(): Promise<void> {
    const enabled = Object.entries(this.config.mcp.servers).filter(([, server]) => !server.disabled);
    if (enabled.length === 0) return;

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);

    for (const [name, server] of enabled) {
      const client = new Client({ name: 'neo-agent', version: '0.1.0' });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: {
          ...process.env,
          ...(server.env ?? {})
        } as Record<string, string>
      });
      await client.connect(transport);
      this.servers.set(name, { name, client });
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
