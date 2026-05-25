import type { ChatToolCall, McpToolCallRecord, ToolCallRecord, WebToolCallRecord } from '../types.js';

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
