import { z } from 'zod';
import type { AppConfig, ChatToolCall, ChatToolDefinition, Skill, ToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolExecutionResult, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';

export const CAPABILITIES_TOOL_NAME = 'Capabilities';

export type CapabilitySnapshot = {
  generatedAt: string;
  cwd: string;
  models: {
    main: string;
    small: string;
    vision: string;
  };
  web: {
    enabled: boolean;
    provider: AppConfig['web']['provider'];
    toolLoopEnabled: boolean;
    apiKeyConfigured: boolean;
    tools: string[];
  };
  files: {
    root: string;
    workspaceDir: string;
    additionalReadDirs: string[];
    additionalWriteDirs: string[];
    toolResultBudget: {
      enabled: boolean;
      dir: string;
      maxInlineChars: number;
      previewChars: number;
    };
    tools: string[];
    canRead: boolean;
    canWrite: boolean;
    writeRequiresInteractiveConfirmation: boolean;
    writeConfirmationAvailable: boolean;
  };
  skills: {
    total: number;
    callable: number;
    names: string[];
  };
  mcp: {
    connectedServers: string[];
    visibleTools: string[];
    permissionMode: AppConfig['mcp']['permissions']['mode'];
    allowedRules: number;
    deniedRules: number;
  };
  subAgents: {
    available: boolean;
    supportsBackground: boolean;
    supportsStop: boolean;
    toolIsolation: 'none';
  };
  hooks: {
    reservedOnly: boolean;
    events: string[];
    recentEventCount: number;
    externalExecutionEnabled: false;
  };
  runtimeTools: Array<{
    name: string;
    description: string;
  }>;
  limitations: string[];
};

const inputSchema = z.object({
  include_details: z.boolean().optional()
});

export class CapabilityToolRunner implements ToolRunner<ToolCallRecord> {
  constructor(private readonly snapshotProvider: () => Promise<CapabilitySnapshot>) {}

  definitions(): ChatToolDefinition[] {
    return [{
      type: 'function',
      function: {
        name: CAPABILITIES_TOOL_NAME,
        description: [
          '读取 neo 当前运行时能力快照，包括模型、工具、文件写入权限、Web、MCP、skills、sub-agent 和 hooks。',
          '当用户询问“你现在能做什么”“当前能力如何”“有哪些工具”“能力范围”时，必须先调用此工具，不能只凭记忆回答。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            include_details: {
              type: 'boolean',
              description: '是否返回更详细的工具列表。默认 true。'
            }
          }
        }
      }
    }];
  }

  canExecute(name: string): boolean {
    return name === CAPABILITIES_TOOL_NAME;
  }

  executionMode(): 'parallel' {
    return 'parallel';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult<ToolCallRecord>> {
    throwIfAborted(options.signal);
    const input = inputSchema.parse(parseJsonObject(call.function.arguments));
    const snapshot = await this.snapshotProvider();
    return {
      content: JSON.stringify(input.include_details === false ? compactSnapshot(snapshot) : snapshot, null, 2)
    };
  }
}

export function buildCapabilitySnapshot(input: {
  config: AppConfig;
  cwd: string;
  skills: Skill[];
  mcpTools: string[];
  connectedMcpServers: string[];
  runtimeTools: ChatToolDefinition[];
  fileWriteConfirmationAvailable: boolean;
  hookRecentEventCount: number;
}): CapabilitySnapshot {
  const toolNames = input.runtimeTools.map(tool => tool.function.name);
  const fileTools = toolNames.filter(name => ['Read', 'Glob', 'Grep', 'Write', 'Edit'].includes(name));
  const webTools = toolNames.filter(name => ['WebSearch', 'WebFetch'].includes(name));
  const callableSkills = input.skills.filter(skill => !skill.disableModelInvocation);
  const mcpVisibleTools = toolNames.filter(name => name.startsWith('mcp__'));
  return {
    generatedAt: new Date().toISOString(),
    cwd: input.cwd,
    models: {
      main: input.config.models.main.model,
      small: input.config.models.small.model,
      vision: input.config.models.vision.model
    },
    web: {
      enabled: input.config.web.autoSearch && input.config.web.toolLoopEnabled && Boolean(input.config.web.apiKey),
      provider: input.config.web.provider,
      toolLoopEnabled: input.config.web.toolLoopEnabled,
      apiKeyConfigured: Boolean(input.config.web.apiKey),
      tools: webTools
    },
    files: {
      root: input.cwd,
      workspaceDir: input.config.workspace.dir,
      additionalReadDirs: input.config.files.additionalReadDirs,
      additionalWriteDirs: input.config.files.additionalWriteDirs,
      toolResultBudget: input.config.toolResults,
      tools: fileTools,
      canRead: fileTools.some(name => ['Read', 'Glob', 'Grep'].includes(name)),
      canWrite: fileTools.some(name => ['Write', 'Edit'].includes(name)),
      writeRequiresInteractiveConfirmation: fileTools.some(name => ['Write', 'Edit'].includes(name)),
      writeConfirmationAvailable: input.fileWriteConfirmationAvailable
    },
    skills: {
      total: input.skills.length,
      callable: callableSkills.length,
      names: input.skills.map(skill => skill.name).sort()
    },
    mcp: {
      connectedServers: input.connectedMcpServers,
      visibleTools: [...new Set([...input.mcpTools, ...mcpVisibleTools])].sort(),
      permissionMode: input.config.mcp.permissions.mode,
      allowedRules: input.config.mcp.permissions.allowedTools.length,
      deniedRules: input.config.mcp.permissions.deniedTools.length
    },
    subAgents: {
      available: true,
      supportsBackground: true,
      supportsStop: true,
      toolIsolation: 'none'
    },
    hooks: {
      reservedOnly: true,
      events: ['PostToolUse', 'PermissionRequest', 'Stop', 'Notification'],
      recentEventCount: input.hookRecentEventCount,
      externalExecutionEnabled: false
    },
    runtimeTools: input.runtimeTools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description
    })).sort((a, b) => a.name.localeCompare(b.name)),
    limitations: buildLimitations(input.config, input.fileWriteConfirmationAvailable, input.connectedMcpServers.length)
  };
}

export function formatCapabilitySnapshot(snapshot: CapabilitySnapshot): string {
  return [
    `neo capabilities @ ${snapshot.generatedAt}`,
    `cwd: ${snapshot.cwd}`,
    `models: main=${snapshot.models.main}, small=${snapshot.models.small}, vision=${snapshot.models.vision}`,
    `web: ${snapshot.web.enabled ? 'enabled' : 'disabled'} provider=${snapshot.web.provider} tools=${snapshot.web.tools.join(',') || '(none)'}`,
    `files: tools=${snapshot.files.tools.join(',') || '(none)'} workspace=${snapshot.files.workspaceDir} readDirs=${snapshot.files.additionalReadDirs.length} writeDirs=${snapshot.files.additionalWriteDirs.length} toolBudget=${snapshot.files.toolResultBudget.enabled ? snapshot.files.toolResultBudget.maxInlineChars : 'off'} write=${snapshot.files.canWrite ? 'available' : 'unavailable'} confirm=${snapshot.files.writeConfirmationAvailable ? 'interactive' : 'not-interactive'}`,
    `skills: total=${snapshot.skills.total} callable=${snapshot.skills.callable}${snapshot.skills.names.length ? ` names=${snapshot.skills.names.join(',')}` : ''}`,
    `mcp: servers=${snapshot.mcp.connectedServers.join(',') || '(none)'} tools=${snapshot.mcp.visibleTools.length}`,
    `subAgents: background=${snapshot.subAgents.supportsBackground} stop=${snapshot.subAgents.supportsStop} isolation=${snapshot.subAgents.toolIsolation}`,
    `hooks: reservedOnly=${snapshot.hooks.reservedOnly} events=${snapshot.hooks.events.join(',')} externalExecution=${snapshot.hooks.externalExecutionEnabled}`,
    `runtime tools: ${snapshot.runtimeTools.map(tool => tool.name).join(', ') || '(none)'}`,
    snapshot.limitations.length > 0 ? `limitations:\n${snapshot.limitations.map(item => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

export function getCapabilitiesPrompt(): string {
  return [
    '# Capabilities',
    '- 如果用户询问你当前能做什么、能力范围、可用工具、是否能读写文件、是否能联网、是否有 MCP/skill/sub-agent，请先调用 Capabilities 工具读取运行时快照。',
    '- 回答能力问题时，以 Capabilities 返回的事实为准；不要只凭记忆、旧对话或猜测回答。',
    '- 如果 Capabilities 显示某能力需要交互确认或配置缺失，要明确说明边界。'
  ].join('\n');
}

function compactSnapshot(snapshot: CapabilitySnapshot): Partial<CapabilitySnapshot> {
  return {
    generatedAt: snapshot.generatedAt,
    cwd: snapshot.cwd,
    models: snapshot.models,
    web: snapshot.web,
    files: snapshot.files,
    skills: {
      total: snapshot.skills.total,
      callable: snapshot.skills.callable,
      names: snapshot.skills.names.slice(0, 40)
    },
    mcp: snapshot.mcp,
    subAgents: snapshot.subAgents,
    hooks: snapshot.hooks,
    limitations: snapshot.limitations
  };
}

function buildLimitations(config: AppConfig, fileWriteConfirmationAvailable: boolean, connectedMcpServerCount: number): string[] {
  const limitations: string[] = [
    '没有通用 shell/python/git 执行工具；只能通过已暴露工具和命令入口完成操作。',
    `Write/Edit 在 workspace (${config.workspace.dir}) 内无需额外确认；写入项目其它位置或额外授权目录时需要交互式确认。`
  ];
  if (!fileWriteConfirmationAvailable) limitations.push(`当前入口没有文件写入确认回调；模型只能自动写入 workspace (${config.workspace.dir})，项目其它位置的 Write/Edit 会被拒绝。`);
  if (!config.web.apiKey) limitations.push('未配置 Web API key，WebSearch/WebFetch 不会暴露给模型。');
  if (connectedMcpServerCount === 0) limitations.push('当前没有已连接 MCP server。');
  limitations.push('Hooks 目前只记录内部事件，不执行外部 shell、HTTP、prompt 或 agent hook。');
  return limitations;
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`Capabilities 参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}
