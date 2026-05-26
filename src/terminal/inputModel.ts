const largePasteThreshold = 800;
const largePasteMaxVisibleLines = 2;

export function looksLikePlainTextPaste(value: string): boolean {
  if (value.includes('\x1b')) return false;
  if (!/[\r\n]/.test(value)) return false;
  return value.length > 12 || (value.match(/\r\n|\r|\n/g)?.length ?? 0) > 1;
}

export function normalizePastedText(value: string): string {
  const normalized = stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('\t', '    ');
  return normalized.replace(/\n$/, '');
}

export function shouldFoldPastedText(value: string): boolean {
  if (value.length > largePasteThreshold) return true;
  return getPastedTextLineBreakCount(value) > largePasteMaxVisibleLines;
}

export function createPastedContentPlaceholder(
  value: string,
  pasteId: number,
  currentInput: string,
  pastedContents: Map<string, string>
): string {
  const base = `[Pasted Content ${value.length} chars]`;
  if (!currentInput.includes(base) && !pastedContents.has(base)) return base;
  return `[Pasted Content #${pasteId} ${value.length} chars]`;
}

export function expandPastedContentPlaceholders(value: string, pastedContents: Map<string, string>): string {
  if (pastedContents.size === 0) return value;
  const pattern = new RegExp([...pastedContents.keys()].map(escapeRegExp).join('|'), 'g');
  return value.replace(pattern, placeholder => pastedContents.get(placeholder) ?? placeholder);
}

export function shouldPersistHistory(line: string): boolean {
  return !/(api[-_ ]?key|sk-[A-Za-z0-9]{12,}|tp-[A-Za-z0-9]{12,}|tvly-[A-Za-z0-9_-]{12,})/i.test(line);
}

function getPastedTextLineBreakCount(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
