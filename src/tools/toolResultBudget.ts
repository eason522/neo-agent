import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import { ensureDir, sanitizeName, stableId } from '../utils/fs.js';

export type ToolResultBudgetOptions = {
  enabled: boolean;
  dir: string;
  maxInlineChars: number;
  previewChars: number;
};

export type ToolResultBudgetOutcome = {
  content: string;
  persisted?: {
    filePath: string;
    displayPath: string;
    originalChars: number;
    previewChars: number;
  };
};

export type ToolHistoryBudgetReplacement = {
  toolCallId: string;
  toolName: string;
  previousChars: number;
  nextChars: number;
  persisted: NonNullable<ToolResultBudgetOutcome['persisted']>;
};

export async function applyToolResultBudget(input: {
  toolName: string;
  toolCallId: string;
  content: string;
  options?: ToolResultBudgetOptions;
}): Promise<ToolResultBudgetOutcome> {
  const options = input.options;
  if (!options?.enabled || input.content.length <= options.maxInlineChars) {
    return { content: normalizeEmptyToolResult(input.toolName, input.content) };
  }

  return persistToolResultReference({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    content: input.content,
    options
  });
}

export async function applyToolHistoryBudget(input: {
  messages: ChatMessage[];
  options?: ToolResultBudgetOptions;
  toolNameForCallId?: (toolCallId: string) => string | undefined;
}): Promise<ToolHistoryBudgetReplacement[]> {
  const options = input.options;
  if (!options?.enabled) return [];
  const toolMessages = input.messages.filter(message =>
    message.role === 'tool' &&
    message.tool_call_id &&
    message.content.length > 0 &&
    !isPersistedToolResultReference(message.content)
  );
  let totalToolResultChars = toolMessages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalToolResultChars <= options.maxInlineChars) return [];

  const replacements: ToolHistoryBudgetReplacement[] = [];
  for (const message of toolMessages) {
    if (totalToolResultChars <= options.maxInlineChars) break;
    const previousChars = message.content.length;
    const toolCallId = message.tool_call_id!;
    const toolName = input.toolNameForCallId?.(toolCallId) ?? 'ToolResult';
    const budgeted = await persistToolResultReference({
      toolName,
      toolCallId,
      content: message.content,
      options,
      previewChars: 0,
      reason: '历史工具结果累计超过预算。'
    });
    if (!budgeted.persisted) continue;
    message.content = budgeted.content;
    totalToolResultChars = totalToolResultChars - previousChars + budgeted.content.length;
    replacements.push({
      toolCallId,
      toolName,
      previousChars,
      nextChars: budgeted.content.length,
      persisted: budgeted.persisted
    });
  }

  return replacements;
}

export async function persistToolResultReference(input: {
  toolName: string;
  toolCallId: string;
  content: string;
  options: ToolResultBudgetOptions;
  previewChars?: number;
  reason?: string;
}): Promise<ToolResultBudgetOutcome> {
  const content = normalizeEmptyToolResult(input.toolName, input.content);
  const options = input.options;
  const root = path.isAbsolute(options.dir) ? options.dir : path.resolve(process.cwd(), options.dir);
  const dayDir = path.join(root, new Date().toISOString().slice(0, 10));
  await ensureDir(dayDir);
  const fileName = [
    Date.now().toString(36),
    sanitizeName(input.toolName),
    sanitizeName(input.toolCallId),
    stableId('result').slice('result_'.length)
  ].filter(Boolean).join('-') + '.txt';
  const filePath = path.join(dayDir, fileName);
  await writeFile(filePath, content, 'utf8');

  const previewLimit = input.previewChars ?? options.previewChars;
  const preview = previewLimit > 0 ? previewAtBoundary(content, previewLimit) : '';
  const displayPath = displayPathForTool(filePath);
  const message = [
    '<neo_tool_result_persisted>',
    `Tool result moved out of context (${content.length} chars). Full output saved to: ${displayPath}`,
    input.reason,
    preview
      ? 'Use the Read tool on this path if you need details beyond the preview.'
      : 'Use the Read tool on this path if you need the full result.',
    preview ? '' : '',
    preview ? `Preview (first ${preview.length} chars):` : '',
    preview,
    preview && content.length > preview.length ? '...' : '',
    '</neo_tool_result_persisted>'
  ].filter(line => line !== '').join('\n');

  return {
    content: message,
    persisted: {
      filePath,
      displayPath,
      originalChars: content.length,
      previewChars: preview.length
    }
  };
}

function normalizeEmptyToolResult(toolName: string, content: string): string {
  return content.length > 0 ? content : `(${toolName} completed with no output)`;
}

function isPersistedToolResultReference(content: string): boolean {
  return content.includes('<neo_tool_result_persisted>');
}

function previewAtBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const slice = content.slice(0, Math.max(1, maxChars));
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline > Math.floor(maxChars * 0.6)) return slice.slice(0, lastNewline).trimEnd();
  return slice.trimEnd();
}

function displayPathForTool(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return filePath;
}
