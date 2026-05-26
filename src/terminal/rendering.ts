export const replSummaryMaxChars = 220;
export const replErrorMaxChars = 1200;
export const replInlineAssistantMaxChars = 140;

export type PermissionPromptAction = {
  key: string;
  label: string;
};

export type PermissionPromptField = {
  label: string;
  value: string | number | undefined;
};

export type PermissionPromptInput = {
  title: string;
  subtitle?: string;
  fields: PermissionPromptField[];
  actions: PermissionPromptAction[];
  question?: string;
  footer?: string[];
};

export function formatAssistantResponseBlock(label: string, text: string): string {
  const body = text.trim();
  if (!body) return `${label} (空响应)\n`;
  if (!body.includes('\n') && body.length <= replInlineAssistantMaxChars) {
    return `${label} ${body}\n`;
  }
  return `${label}\n${indentMultiline(body)}\n`;
}

export function formatEventSummary(input: string, maxChars = replSummaryMaxChars): string {
  return truncateSingleLine(input, maxChars);
}

export function formatDebugEventLine(kind: string, message: string): string {
  return `  - ${kind} ${formatEventSummary(message)}`;
}

export function formatErrorBlock(label: string, message: string, logPath?: string): string {
  const truncated = truncateMultiline(message, replErrorMaxChars);
  const lines = [`${label} ${truncated}`];
  if (message.length > replErrorMaxChars) {
    lines.push('  [错误信息已截断，完整内容见日志或 transcript]');
  }
  if (logPath) lines.push(`  log: ${logPath}`);
  return `${lines.join('\n')}\n\n`;
}

export function formatPermissionPrompt(input: PermissionPromptInput): string {
  const lines = [
    '',
    input.title,
    input.subtitle ? `  ${input.subtitle}` : '',
    ...input.fields
      .filter(field => field.value !== undefined && String(field.value).trim() !== '')
      .map(field => `  ${field.label}: ${formatEventSummary(String(field.value))}`),
    input.question ? `  ${input.question}` : '  是否允许执行？',
    ...input.actions.map(action => `  ${action.key.padEnd(2, ' ')} ${action.label}`),
    ...(input.footer ?? []).map(line => `  ${line}`),
    '> '
  ];
  return lines.filter(Boolean).join('\n');
}

export function indentMultiline(input: string, indent = '  '): string {
  return input
    .split(/\r?\n/)
    .map(line => `${indent}${line}`)
    .join('\n');
}

function truncateSingleLine(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 18)).trimEnd()} ... [truncated]`;
}

function truncateMultiline(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 18)).trimEnd()}\n... [truncated]`;
}
