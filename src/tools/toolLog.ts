import type { ChatToolCall, FileToolCallRecord, McpToolCallRecord, ToolCallRecord, ToolProgressEvent, WebToolCallRecord } from '../types.js';

export function summarizeToolArguments(call: ChatToolCall): Record<string, unknown> {
  const base = {
    name: call.function.name,
    argumentChars: call.function.arguments.length
  };
  const parsed = safeParseJsonObject(call.function.arguments);
  if (!parsed) return base;

  return {
    ...base,
    argumentKeys: Object.keys(parsed).sort(),
    queryChars: typeof parsed.query === 'string' ? parsed.query.length : undefined,
    urlDomain: typeof parsed.url === 'string' ? getUrlDomain(parsed.url) : undefined,
    urlCount: Array.isArray(parsed.urls) ? parsed.urls.length : undefined
  };
}

export function summarizeToolResult(record: ToolCallRecord | undefined, content: string): Record<string, unknown> {
  if (!record) {
    return {
      resultChars: content.length,
      resultKind: 'unknown'
    };
  }
  if (isMcpRecord(record)) {
    return {
      resultKind: 'mcp',
      name: record.name,
      serverName: record.serverName,
      toolName: record.toolName,
      resultChars: record.resultChars,
      durationMs: record.durationMs
    };
  }
  if (isFileRecord(record)) {
    return {
      resultKind: 'file',
      name: record.name,
      path: record.path,
      patternChars: record.pattern?.length,
      resultCount: record.resultCount,
      resultChars: record.resultChars,
      durationMs: record.durationMs
    };
  }
  return summarizeWebRecord(record, content);
}

export function summarizeToolError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : 'Error',
    errorMessageChars: message.length,
    errorCategory: categorizeError(message)
  };
}

export function createToolStartEvent(call: ChatToolCall, round: number): ToolProgressEvent {
  const metadata = summarizeToolArguments(call);
  return {
    phase: 'start',
    round,
    name: call.function.name,
    summary: formatToolStartSummary(call.function.name, metadata),
    metadata
  };
}

export function createToolSuccessEvent(name: string, record: ToolCallRecord | undefined, content: string, round: number): ToolProgressEvent {
  const metadata = summarizeToolResult(record, content);
  return {
    phase: 'success',
    round,
    name,
    summary: formatToolSuccessSummary(name, metadata),
    metadata
  };
}

export function createToolErrorEvent(name: string, error: unknown, round: number): ToolProgressEvent {
  const metadata = summarizeToolError(error);
  return {
    phase: 'error',
    round,
    name,
    summary: `${name} 失败：${String(metadata.errorCategory ?? 'unknown')}，错误信息 ${String(metadata.errorMessageChars ?? 0)} 字符`,
    metadata
  };
}

export function createUnknownToolEvent(name: string, round: number): ToolProgressEvent {
  const metadata = {
    errorCategory: 'unknown_tool'
  };
  return {
    phase: 'unknown',
    round,
    name,
    summary: `${name} 不可用：当前工具集中没有这个工具`,
    metadata
  };
}

export function createMaxRoundsEvent(maxToolRounds: number, toolCallCount: number): ToolProgressEvent {
  const metadata = { maxToolRounds, toolCallCount };
  return {
    phase: 'max_rounds',
    round: maxToolRounds,
    name: 'tool_loop',
    summary: `工具调用达到上限：${toolCallCount} 次调用，最多 ${maxToolRounds} 轮`,
    metadata
  };
}

export function buildToolErrorResult(name: string, error: unknown, round: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const metadata = summarizeToolError(error);
  return JSON.stringify({
    error: {
      tool: name,
      message,
      category: metadata.errorCategory,
      messageChars: message.length,
      round
    },
    recoveryHint: buildRecoveryHint(String(metadata.errorCategory ?? 'unknown'))
  });
}

export function buildUnknownToolResult(name: string, round: number): string {
  return JSON.stringify({
    error: {
      tool: name,
      category: 'unknown_tool',
      message: `未知工具：${name}`,
      round
    },
    recoveryHint: '这个工具当前不可用。请使用已暴露的工具继续；如果需要 MCP deferred 工具，先使用 ToolSearch 加载；如果无法继续，要明确说明未执行。'
  });
}

function summarizeWebRecord(record: WebToolCallRecord, content: string): Record<string, unknown> {
  return {
    resultKind: 'web',
    name: record.name,
    queryChars: record.query?.length,
    urlDomain: record.url ? getUrlDomain(record.url) : undefined,
    searchedAt: record.searchedAt,
    resultCount: record.resultCount,
    failedCount: record.failedCount,
    resultChars: content.length
  };
}

function formatToolStartSummary(name: string, metadata: Record<string, unknown>): string {
  if (name === 'WebSearch') return `WebSearch 搜索：query ${metadata.queryChars ?? 0} 字符`;
  if (name === 'WebFetch') return `WebFetch 读取：${metadata.urlDomain ?? '未知域名'}`;
  if (name === 'Read') return `Read 读取文件：${metadata.argumentKeys ? '参数已解析' : '参数未解析'}`;
  if (name === 'Glob') return 'Glob 查找文件';
  if (name === 'Grep') return `Grep 搜索内容：pattern ${metadata.argumentKeys ? '已提供' : '未解析'}`;
  if (name.startsWith('mcp__')) return `MCP 工具：${name}`;
  return `${name} 调用中`;
}

function formatToolSuccessSummary(name: string, metadata: Record<string, unknown>): string {
  const kind = metadata.resultKind;
  if (kind === 'web') {
    const target = metadata.urlDomain ? ` ${metadata.urlDomain}` : '';
    return `${name} 完成：${metadata.resultCount ?? 0} 条结果${target}`;
  }
  if (kind === 'file') {
    return `${name} 完成：${metadata.resultCount ?? 0} 条结果，${metadata.resultChars ?? 0} 字符`;
  }
  if (kind === 'mcp') {
    return `${name} 完成：${metadata.serverName}.${metadata.toolName}，${metadata.resultChars ?? 0} 字符`;
  }
  return `${name} 完成：${metadata.resultChars ?? 0} 字符`;
}

function buildRecoveryHint(category: string): string {
  if (category === 'permission') return '权限拒绝。不要声称已经执行该操作；可以说明需要用户授权，或改用只读工具获取信息。';
  if (category === 'timeout') return '工具超时。可以尝试更窄的查询、更少结果或基于已有信息回答并说明限制。';
  if (category === 'auth') return '认证失败。不要重试泄露密钥；请提示用户检查对应 API key 或服务配置。';
  if (category === 'validation') return '参数无效。请根据工具 schema 修正参数后再试一次；不要重复发送同样的错误参数。';
  if (category === 'network') return '网络失败。可以稍后重试，或换用其它可用来源；回答时说明外部请求失败。';
  return '工具调用失败。请基于已有上下文继续；如果信息不足，要明确说明工具未成功执行。';
}

function safeParseJsonObject(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getUrlDomain(input: string): string | undefined {
  try {
    return new URL(input).hostname;
  } catch {
    return undefined;
  }
}

function categorizeError(message: string): string {
  if (/permission|权限|未获授权|denied|拒绝/i.test(message)) return 'permission';
  if (/timeout|超时/i.test(message)) return 'timeout';
  if (/api key|401|403|unauthorized|forbidden/i.test(message)) return 'auth';
  if (/invalid|无效|JSON|schema/i.test(message)) return 'validation';
  if (/network|fetch|ECONN|ENOTFOUND|连接/i.test(message)) return 'network';
  return 'unknown';
}

function isMcpRecord(record: ToolCallRecord): record is McpToolCallRecord {
  return 'serverName' in record && 'toolName' in record;
}

function isFileRecord(record: ToolCallRecord): record is FileToolCallRecord {
  return 'resultChars' in record && 'durationMs' in record && !('serverName' in record) && !('searchedAt' in record);
}
