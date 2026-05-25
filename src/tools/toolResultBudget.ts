import { writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  await writeFile(filePath, input.content, 'utf8');

  const preview = previewAtBoundary(input.content, options.previewChars);
  const displayPath = displayPathForTool(filePath);
  const message = [
    '<neo_tool_result_persisted>',
    `Tool result too large (${input.content.length} chars). Full output saved to: ${displayPath}`,
    'Use the Read tool on this path if you need details beyond the preview.',
    '',
    `Preview (first ${preview.length} chars):`,
    preview,
    input.content.length > preview.length ? '...' : '',
    '</neo_tool_result_persisted>'
  ].filter(line => line !== '').join('\n');

  return {
    content: message,
    persisted: {
      filePath,
      displayPath,
      originalChars: input.content.length,
      previewChars: preview.length
    }
  };
}

function normalizeEmptyToolResult(toolName: string, content: string): string {
  return content.length > 0 ? content : `(${toolName} completed with no output)`;
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
