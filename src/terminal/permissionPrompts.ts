import chalk from 'chalk';
import type { FilePermissionRequest } from '../files/fileTools.js';
import type { ExecutionPermissionRequest } from '../tools/executionTools.js';
import type { McpPermissionAskRequest } from '../mcp/mcpToolRunner.js';
import { formatPermissionPrompt, type PermissionPromptInput } from './rendering.js';

export function buildMcpPermissionPromptInput(request: McpPermissionAskRequest): PermissionPromptInput {
  const keys = request.argumentKeys.length > 0 ? request.argumentKeys.join(', ') : '无';
  return {
    title: chalk.yellow('权限确认：MCP 工具'),
    subtitle: '外部 MCP server 将收到这次工具调用。',
    fields: [
      { label: '工具', value: request.fullName },
      { label: '来源', value: `${request.serverName}.${request.toolName}` },
      { label: '说明', value: request.description },
      { label: '原因', value: request.reason },
      { label: '风险', value: request.risk },
      { label: '参数', value: `${request.argumentChars} 字符；字段：${keys}` }
    ],
    question: '是否允许 neo 调用这个 MCP 工具？',
    actions: [
      { key: 'y', label: '允许本次' },
      { key: 'a', label: '始终允许这个工具（写入用户配置）' },
      { key: 'n', label: '拒绝本次' },
      { key: 'd', label: '始终拒绝这个工具（写入用户配置）' }
    ],
    footer: [
      `持久允许命令：neo mcp permission allow ${request.fullName}`,
      `持久拒绝命令：neo mcp permission deny ${request.fullName}`
    ]
  };
}

export function formatMcpPermissionPrompt(request: McpPermissionAskRequest): string {
  return formatPermissionPrompt(buildMcpPermissionPromptInput(request));
}

export function parseMcpPermissionAnswer(answer: string): 'allow_once' | 'allow_always' | 'deny' | 'deny_always' {
  const normalized = answer.trim().toLowerCase();
  if (/^(a|always|始终允许|永久允许|总是允许)$/i.test(normalized)) return 'allow_always';
  if (/^(d|deny always|始终拒绝|永久拒绝|总是拒绝)$/i.test(normalized)) return 'deny_always';
  if (/^(y|yes|允许|同意)$/i.test(normalized)) return 'allow_once';
  return 'deny';
}

export function buildFilePermissionPromptInput(request: FilePermissionRequest): PermissionPromptInput {
  return {
    title: chalk.yellow('权限确认：文件写入'),
    subtitle: '文件内容将被创建、覆盖或编辑。',
    fields: [
      { label: '工具', value: request.toolName },
      { label: '路径', value: request.path },
      { label: '操作', value: request.operation },
      { label: '摘要', value: request.summary },
      { label: '原内容/匹配', value: request.oldChars === undefined ? undefined : `${request.oldChars} 字符` },
      { label: '新内容', value: `${request.newChars} 字符` }
    ],
    question: '是否允许这次文件写入？',
    actions: [
      { key: 'y', label: '允许本次' },
      { key: 'n', label: '拒绝' }
    ],
    footer: [
      '文件写入暂只支持本次确认；长期授权请配置 workspace.dir 或 files.additionalWriteDirs。'
    ]
  };
}

export function formatFilePermissionPrompt(request: FilePermissionRequest): string {
  return formatPermissionPrompt(buildFilePermissionPromptInput(request));
}

export function parseFilePermissionAnswer(answer: string): 'allow' | 'deny' {
  return /^(y|yes|允许|同意)$/i.test(answer.trim()) ? 'allow' : 'deny';
}

export function buildExecutionPermissionPromptInput(request: ExecutionPermissionRequest): PermissionPromptInput {
  return {
    title: chalk.yellow(`权限确认：${request.toolName}`),
    subtitle: '命令将在 workspace 内执行。',
    fields: [
      { label: '工具', value: request.toolName },
      { label: 'cwd', value: request.cwd },
      { label: '说明', value: request.description },
      { label: '风险', value: request.risk },
      { label: '原因', value: request.reason },
      { label: '命令', value: request.command }
    ],
    question: '是否允许这次执行？',
    actions: [
      { key: 'y', label: '允许本次' },
      { key: 'n', label: '拒绝' }
    ],
    footer: [
      '只读低风险 Bash 会自动执行；高风险 Bash 和 Python 只支持本次确认。'
    ]
  };
}

export function formatExecutionPermissionPrompt(request: ExecutionPermissionRequest): string {
  return formatPermissionPrompt(buildExecutionPermissionPromptInput(request));
}

export function parseExecutionPermissionAnswer(answer: string): 'allow' | 'deny' {
  return /^(y|yes|允许|同意)$/i.test(answer.trim()) ? 'allow' : 'deny';
}
