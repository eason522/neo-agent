import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { NeoAgent } from '../neoAgent.js';
import { extractImageAttachments } from '../input/attachments.js';
import type { MemoryCategory, MemoryRecord, SkillImprovementSuggestion, SkillSuggestion, ToolProgressEvent } from '../types.js';
import { formatWebCrawl, formatWebExtract, formatWebMap, formatWebSearch } from '../web/tavilyClient.js';
import { createAbortError, isAbortError } from '../utils/abort.js';
import { formatUsageSummary } from '../usage/usageTracker.js';
import type { TranscriptSessionSummary } from '../transcript/transcriptService.js';

type ReplState = {
  debugEnabled: boolean;
  terminal: TerminalMultilineSupport;
  lastTurn?: {
    inputChars: number;
    modelKind: string;
    durationMs: number;
    toolEvents: ToolProgressEvent[];
    webToolCalls: number;
    mcpToolCalls: number;
    fileToolCalls: number;
    skillToolCalls: number;
  };
};

type TerminalMultilineSupport = {
  name: string;
  recommended: string[];
  fallback: string[];
  note: string;
  ctrlEnterLikelyDistinct: boolean;
};

type AskQuestion = (prompt: string, signal: AbortSignal) => Promise<string>;

const enableKittyKeyboard = '\x1b[>1u';
const disableKittyKeyboard = '\x1b[<u';
const enableModifyOtherKeys = '\x1b[>4;2m';
const disableModifyOtherKeys = '\x1b[>4m';
const enableBracketedPaste = '\x1b[?2004h';
const disableBracketedPaste = '\x1b[?2004l';
const largePasteThreshold = 800;
const largePasteMaxVisibleLines = 2;

export async function startRepl(agent: NeoAgent): Promise<void> {
  const isInteractiveSession = Boolean(input.isTTY);
  if (isInteractiveSession) {
    await startInteractiveRepl(agent);
    return;
  }
  const isInteractive = false;
  const historyFile = path.join(agent.config.homeDir, 'repl_history');
  const rl = readline.createInterface({
    input,
    output,
    prompt: chalk.gray('neo> '),
    historySize: 200,
    removeHistoryDuplicates: true
  });
  installPersistentHistory(rl, await loadReplHistory(historyFile));
  const terminalSupport = detectTerminalMultilineSupport();
  const state: ReplState = {
    debugEnabled: process.env.NEO_AGENT_REPL_DEBUG === '1',
    terminal: terminalSupport
  };
  let activeController: AbortController | undefined;
  agent.setMcpPermissionAsker(isInteractive ? async request => {
    const answer = activeController
      ? await rl.question(formatMcpPermissionPrompt(request), { signal: activeController.signal })
      : await rl.question(formatMcpPermissionPrompt(request));
    return parseMcpPermissionAnswer(answer);
  } : undefined);
  agent.setToolEventHandler(isInteractive ? event => {
    output.write(`${formatToolProgressEvent(event)}\n`);
  } : undefined);
  printBanner(terminalSupport);
  const handleSigint = (): void => {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(createAbortError());
      output.write(`\n${chalk.yellow('正在取消当前请求...')}\n`);
      return;
    }
    rl.close();
  };
  rl.on('SIGINT', handleSigint);

  try {
    if (isInteractive) rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        if (isInteractive) rl.prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') break;
      await saveReplHistory(historyFile, line);
      if (await handleCommand(agent, line, state, false)) {
        if (isInteractive) rl.prompt();
        continue;
      }

      await runAgentTurn(agent, line, isInteractive, undefined, state, controller => {
        activeController = controller;
      });
      activeController = undefined;
      if (isInteractive) rl.prompt();
    }
  } finally {
    rl.off('SIGINT', handleSigint);
    agent.setToolEventHandler(undefined);
    rl.close();
    await agent.close();
  }
}

async function startInteractiveRepl(agent: NeoAgent): Promise<void> {
  const historyFile = path.join(agent.config.homeDir, 'repl_history');
  const terminalSupport = detectTerminalMultilineSupport();
  const state: ReplState = {
    debugEnabled: process.env.NEO_AGENT_REPL_DEBUG === '1',
    terminal: terminalSupport
  };
  const history = await loadReplHistory(historyFile);
  let activeController: AbortController | undefined;
  let closed = false;
  const rawModeWasEnabled = Boolean(input.isTTY && input.isRaw);

  const askQuestion: AskQuestion = async (prompt, signal) => readInteractiveInput({
    prompt,
    signal,
    history: []
  });

  agent.setMcpPermissionAsker(async request => {
    const answer = await askQuestion(formatMcpPermissionPrompt(request), activeController?.signal ?? new AbortController().signal);
    return parseMcpPermissionAnswer(answer);
  });
  agent.setToolEventHandler(event => {
    output.write(`${formatToolProgressEvent(event)}\n`);
  });
  const handleGlobalData = (chunk: Buffer | string): void => {
    if (!activeController || activeController.signal.aborted) return;
    if (chunk.toString().includes('\x03')) {
      activeController.abort(createAbortError());
      output.write(`\n${chalk.yellow('正在取消当前请求...')}\n`);
    }
  };
  input.on('data', handleGlobalData);

  input.setRawMode(true);
  output.write(enableBracketedPaste);
  output.write(enableKittyKeyboard);
  output.write(enableModifyOtherKeys);
  printBanner(terminalSupport);

  try {
    while (!closed) {
      const line = await readInteractiveInput({
        prompt: chalk.gray('neo> '),
        history
      });
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '/exit' || trimmed === '/quit') break;
      await saveReplHistory(historyFile, line);
      history.push(line);
      if (history.length > 200) history.splice(0, history.length - 200);
      if (await handleCommand(agent, trimmed, state, true)) continue;

      await runAgentTurn(agent, line, true, askQuestion, state, controller => {
        activeController = controller;
      });
      activeController = undefined;
    }
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    closed = true;
    agent.setToolEventHandler(undefined);
    agent.setMcpPermissionAsker(undefined);
    input.off('data', handleGlobalData);
    output.write(disableModifyOtherKeys);
    output.write(disableKittyKeyboard);
    output.write(disableBracketedPaste);
    input.setRawMode(rawModeWasEnabled);
    input.pause();
    input.unref?.();
    await agent.close();
  }
}

async function readInteractiveInput(options: {
  prompt: string;
  signal?: AbortSignal;
  history: string[];
}): Promise<string> {
  let text = '';
  let cursor = 0;
  let historyIndex = options.history.length;
  let renderedLines = 0;
  let renderedCursorRow = 0;
  let pasteBuffer: string | undefined;
  let nextPasteId = 1;
  const pastedContents = new Map<string, string>();

  const render = (): void => {
    if (renderedLines > 0) {
      const rowsBelowCursor = renderedLines - 1 - renderedCursorRow;
      if (rowsBelowCursor > 0) output.write(`\x1b[${rowsBelowCursor}B`);
      output.write('\r\x1b[2K');
      for (let index = 1; index < renderedLines; index += 1) {
        output.write('\x1b[1A\r\x1b[2K');
      }
    }
    const lines = text.split('\n');
    const rendered = lines.map((line, index) => `${promptForLine(options.prompt, index)}${line}`).join('\n');
    output.write(rendered);

    const cursorPosition = getCursorPosition(text, cursor, options.prompt);
    const endRow = getRenderedRowCount(lines, options.prompt) - 1;
    if (endRow > cursorPosition.row) output.write(`\x1b[${endRow - cursorPosition.row}A`);
    output.write('\r');
    if (cursorPosition.column > 0) output.write(`\x1b[${cursorPosition.column}C`);

    renderedLines = getRenderedRowCount(lines, options.prompt);
    renderedCursorRow = cursorPosition.row;
  };

  render();

  return await new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (value: string): void => {
      cleanup();
      output.write('\n');
      resolve(expandPastedContentPlaceholders(value, pastedContents));
    };
    const onAbort = (): void => {
      cleanup();
      reject(options.signal?.reason ?? createAbortError());
    };
    const setText = (next: string, nextCursor = next.length): void => {
      text = next;
      cursor = Math.max(0, Math.min(next.length, nextCursor));
      render();
    };
    const insert = (value: string): void => setText(`${text.slice(0, cursor)}${value}${text.slice(cursor)}`, cursor + value.length);
    const insertPaste = (value: string): void => {
      const normalized = normalizePastedText(value);
      if (!shouldFoldPastedText(normalized)) {
        insert(normalized);
        return;
      }
      const placeholder = createPastedContentPlaceholder(normalized, nextPasteId, text, pastedContents);
      nextPasteId += 1;
      pastedContents.set(placeholder, normalized);
      insert(placeholder);
    };
    const backspace = (): void => {
      if (cursor <= 0) return;
      setText(`${text.slice(0, cursor - 1)}${text.slice(cursor)}`, cursor - 1);
    };
    const deleteForward = (): void => {
      if (cursor >= text.length) return;
      setText(`${text.slice(0, cursor)}${text.slice(cursor + 1)}`, cursor);
    };
    const moveCursor = (next: number): void => {
      cursor = Math.max(0, Math.min(text.length, next));
      render();
    };
    const previousHistory = (): void => {
      if (options.history.length === 0) return;
      historyIndex = Math.max(0, historyIndex - 1);
      pastedContents.clear();
      setText(options.history[historyIndex] ?? '');
    };
    const nextHistory = (): void => {
      if (options.history.length === 0) return;
      historyIndex = Math.min(options.history.length, historyIndex + 1);
      pastedContents.clear();
      setText(historyIndex >= options.history.length ? '' : options.history[historyIndex] ?? '');
    };
    const onData = (chunk: Buffer | string): void => {
      const data = chunk.toString();
      if (pasteBuffer !== undefined) {
        const end = data.indexOf('\x1b[201~');
        if (end < 0) {
          pasteBuffer += data;
          return;
        }
        insertPaste(`${pasteBuffer}${data.slice(0, end)}`);
        pasteBuffer = undefined;
        const restAfterPaste = data.slice(end + 6);
        if (!restAfterPaste) return;
        onData(restAfterPaste);
        return;
      }
      if (looksLikePlainTextPaste(data)) {
        insertPaste(data);
        return;
      }
      for (let index = 0; index < data.length;) {
        const rest = data.slice(index);
        if (rest.startsWith('\x1b[200~')) {
          const end = rest.indexOf('\x1b[201~');
          if (end >= 0) {
            insertPaste(rest.slice(6, end));
            index += end + 6;
            continue;
          }
          pasteBuffer = rest.slice(6);
          return;
        }
        const multiline = findMultilineSequence(rest);
        if (multiline?.index === 0) {
          insert('\n');
          index += multiline.sequence.length;
          continue;
        }
        if (rest.startsWith('\x1b[A')) {
          previousHistory();
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[B')) {
          nextHistory();
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[C')) {
          moveCursor(cursor + 1);
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[D')) {
          moveCursor(cursor - 1);
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[H') || rest.startsWith('\x1b[1~')) {
          moveCursor(0);
          index += rest.startsWith('\x1b[H') ? 3 : 4;
          continue;
        }
        if (rest.startsWith('\x1b[F') || rest.startsWith('\x1b[4~')) {
          moveCursor(text.length);
          index += rest.startsWith('\x1b[F') ? 3 : 4;
          continue;
        }
        if (rest.startsWith('\x1b[3~')) {
          deleteForward();
          index += 4;
          continue;
        }
        if (rest.startsWith('\x1b')) {
          const escapeMatch = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(rest) ?? /^\x1b./.exec(rest);
          index += escapeMatch?.[0].length ?? 1;
          continue;
        }
        const char = data[index] ?? '';
        if (char === '\r') {
          finish(text);
          return;
        }
        if (char === '\n') {
          insert('\n');
          index += 1;
          continue;
        }
        if (char === '\x7f' || char === '\b') {
          backspace();
          index += 1;
          continue;
        }
        if (char === '\x01') {
          moveCursor(0);
          index += 1;
          continue;
        }
        if (char === '\x05') {
          moveCursor(text.length);
          index += 1;
          continue;
        }
        if (char === '\x02') {
          moveCursor(cursor - 1);
          index += 1;
          continue;
        }
        if (char === '\x06') {
          moveCursor(cursor + 1);
          index += 1;
          continue;
        }
        if (char === '\x03') {
          if (text) {
            pastedContents.clear();
            setText('');
            index += 1;
            continue;
          }
          cleanup();
          output.write('\n');
          reject(createAbortError());
          return;
        }
        if (char === '\x04') {
          cleanup();
          output.write('\n');
          reject(createAbortError());
          return;
        }
        if (char >= ' ' || char === '\t') {
          insert(char);
        }
        index += 1;
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    input.on('data', onData);
  });
}

function promptForLine(firstPrompt: string, lineIndex: number): string {
  return lineIndex === 0 ? firstPrompt : chalk.gray('neo… ');
}

function getCursorPosition(text: string, cursor: number, firstPrompt: string): { row: number; column: number } {
  const columns = getTerminalColumns();
  const beforeCursor = text.slice(0, cursor).split('\n');
  let row = 0;
  for (let index = 0; index < beforeCursor.length - 1; index += 1) {
    row += getRenderedRowCountForLine(`${promptForLine(firstPrompt, index)}${beforeCursor[index] ?? ''}`, columns);
  }
  const logicalLine = beforeCursor.length - 1;
  const lineBeforeCursor = beforeCursor[logicalLine] ?? '';
  const cursorWidth = displayWidth(`${promptForLine(firstPrompt, logicalLine)}${lineBeforeCursor}`);
  return {
    row: row + Math.floor(cursorWidth / columns),
    column: cursorWidth % columns
  };
}

function getRenderedRowCount(lines: string[], firstPrompt: string): number {
  const columns = getTerminalColumns();
  return lines
    .map((line, index) => getRenderedRowCountForLine(`${promptForLine(firstPrompt, index)}${line}`, columns))
    .reduce((total, rows) => total + rows, 0);
}

function getRenderedRowCountForLine(value: string, columns: number): number {
  return Math.max(1, Math.ceil(Math.max(1, displayWidth(value)) / columns));
}

function getTerminalColumns(): number {
  return Math.max(20, output.columns || Number(process.env.COLUMNS) || 80);
}

function looksLikePlainTextPaste(value: string): boolean {
  if (value.includes('\x1b')) return false;
  if (!/[\r\n]/.test(value)) return false;
  return value.length > 12 || (value.match(/\r\n|\r|\n/g)?.length ?? 0) > 1;
}

function normalizePastedText(value: string): string {
  const normalized = stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('\t', '    ');
  return normalized.replace(/\n$/, '');
}

function shouldFoldPastedText(value: string): boolean {
  if (value.length > largePasteThreshold) return true;
  return getPastedTextLineBreakCount(value) > largePasteMaxVisibleLines;
}

function getPastedTextLineBreakCount(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function createPastedContentPlaceholder(
  value: string,
  pasteId: number,
  currentInput: string,
  pastedContents: Map<string, string>
): string {
  const base = `[Pasted Content ${value.length} chars]`;
  if (!currentInput.includes(base) && !pastedContents.has(base)) return base;
  return `[Pasted Content #${pasteId} ${value.length} chars]`;
}

function expandPastedContentPlaceholders(value: string, pastedContents: Map<string, string>): string {
  if (pastedContents.size === 0) return value;
  const pattern = new RegExp([...pastedContents.keys()].map(escapeRegExp).join('|'), 'g');
  return value.replace(pattern, placeholder => pastedContents.get(placeholder) ?? placeholder);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    width += codePoint >= 0x1100 ? 2 : 1;
  }
  return width;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

async function runAgentTurn(
  agent: NeoAgent,
  line: string,
  isInteractive: boolean,
  askQuestion: AskQuestion | undefined,
  state: ReplState,
  setActiveController: (controller: AbortController | undefined) => void
): Promise<void> {
  const startedAt = Date.now();
  const turnController = new AbortController();
  setActiveController(turnController);
  try {
    const { text, attachments } = extractImageAttachments(line);
    output.write(chalk.gray('thinking...\n'));
    const response = await agent.ask(text, attachments, { signal: turnController.signal });
    const durationMs = Date.now() - startedAt;
    state.lastTurn = {
      inputChars: text.length,
      modelKind: response.modelKind,
      durationMs,
      toolEvents: response.toolEvents ?? [],
      webToolCalls: response.webToolCalls?.length ?? 0,
      mcpToolCalls: response.mcpToolCalls?.length ?? 0,
      fileToolCalls: response.fileToolCalls?.length ?? 0,
      skillToolCalls: response.skillToolCalls?.length ?? 0
    };
    output.write(`${chalk.cyan(`neo:${response.modelKind}`)} ${response.text.trim()}\n`);
    output.write(`${formatStatusLine(state.lastTurn)}\n\n`);
    if (state.debugEnabled) output.write(`${formatDebugView(agent, state)}\n`);
    if (isInteractive && askQuestion && response.skillSuggestion && !turnController.signal.aborted) {
      await confirmSkillSuggestion(agent, askQuestion, response.skillSuggestion, turnController.signal);
    }
    if (isInteractive && askQuestion && response.skillImprovementSuggestion && !turnController.signal.aborted) {
      await confirmSkillImprovement(agent, askQuestion, response.skillImprovementSuggestion, turnController.signal);
    }
  } catch (error) {
    if (isAbortError(error) || turnController.signal.aborted) {
      output.write(`${chalk.yellow('已取消当前请求。')}\n\n`);
    } else {
      output.write(`${chalk.red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
    }
  } finally {
    setActiveController(undefined);
  }
}

async function loadReplHistory(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-200);
}

function installPersistentHistory(rl: ReturnType<typeof readline.createInterface>, history: string[]): void {
  const target = rl as unknown as { history?: string[] };
  target.history = [...history].reverse();
}

async function saveReplHistory(filePath: string, line: string): Promise<void> {
  const normalized = line.trim();
  if (!normalized || !shouldPersistHistory(normalized)) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await loadReplHistory(filePath);
  const next = [...existing.filter(item => item !== normalized), normalized].slice(-200);
  await writeFile(filePath, `${next.join('\n')}\n`, 'utf8');
}

function shouldPersistHistory(line: string): boolean {
  return !/(api[-_ ]?key|sk-[A-Za-z0-9]{12,}|tp-[A-Za-z0-9]{12,}|tvly-[A-Za-z0-9_-]{12,})/i.test(line);
}

function findMultilineSequence(input: string): { index: number; sequence: string } | undefined {
  const sequences = [
    '\u001b[13;5u',
    '\u001b[13;6u',
    '\u001b[13;3u',
    '\u001b[13;7u',
    '\u001b[27;5;13~',
    '\u001b[27;6;13~',
    '\u001b[27;3;13~',
    '\u001b[27;7;13~'
  ];
  return sequences
    .map(sequence => ({ sequence, index: input.indexOf(sequence) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
}

export function detectTerminalMultilineSupport(env: NodeJS.ProcessEnv = process.env): TerminalMultilineSupport {
  const override = (env.NEO_AGENT_TERMINAL ?? env.NEO_AGENT_TERMINAL_PROFILE ?? '').toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  const isTmux = Boolean(env.TMUX);
  const isSsh = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

  if (override) return terminalSupportFromOverride(override, isTmux, isSsh);

  if (env.WEZTERM_PANE) {
    return buildTerminalSupport('WezTerm', ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  }
  if (env.KITTY_WINDOW_ID || term.includes('xterm-kitty')) {
    return buildTerminalSupport('Kitty', ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  }
  if (termProgram.includes('ghostty') || env.GHOSTTY_RESOURCES_DIR) {
    return buildTerminalSupport('Ghostty', ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  }
  if (termProgram.includes('vscode')) {
    return buildTerminalSupport('VS Code Terminal', ['Alt+Enter', 'Ctrl+J', 'Ctrl+Enter'], isTmux, 'VS Code 的快捷键可能被编辑器或终端配置拦截；若 Ctrl+Enter 无效，优先用 Alt+Enter 或 Ctrl+J。');
  }
  if (env.WT_SESSION || termProgram.includes('windows_terminal')) {
    return buildTerminalSupport('Windows Terminal', ['Ctrl+Enter', 'Ctrl+J'], isTmux, 'neo 已主动开启增强键盘协议；Alt+Enter 常被终端占用，不作为推荐换行键。');
  }
  if (termProgram.includes('iterm')) {
    return buildTerminalSupport('iTerm2', ['Alt+Enter', 'Ctrl+J', 'Ctrl+Enter'], isTmux, 'iTerm2 默认不一定把 Ctrl+Enter 单独发给程序；开启 CSI u 或键盘映射后可用。');
  }
  if (termProgram.includes('apple_terminal') || termProgram === 'apple terminal') {
    return buildTerminalSupport('Apple Terminal', ['Ctrl+J'], isTmux, 'Apple Terminal 通常不能可靠区分 Ctrl+Enter 和普通 Enter。');
  }
  if (env.VTE_VERSION || termProgram.includes('gnome') || colorTerm.includes('gnome') || term.includes('vte')) {
    return buildTerminalSupport('VTE/GNOME Terminal', ['Ctrl+J', 'Alt+Enter'], isTmux, 'VTE 系终端通常不能可靠区分 Ctrl+Enter 和普通 Enter。');
  }
  if (isTmux) {
    return buildTerminalSupport('tmux', ['Ctrl+J'], true, 'tmux 未开启 extended-keys 时通常不能传递 Ctrl+Enter；可在 tmux 配置里开启 extended-keys 后重试。');
  }
  if (isSsh) {
    return buildTerminalSupport(
      'SSH 远程会话（本地终端未知）',
      ['Ctrl+Enter', 'Ctrl+J'],
      false,
      'neo 已按 CC-Source 方式主动开启 Kitty keyboard protocol 和 xterm modifyOtherKeys；SSH 默认不会告诉 neo 本机外层终端类型，可设置 NEO_AGENT_TERMINAL=powershell、wezterm、kitty、vscode 等手动覆盖显示。'
    );
  }
  return buildTerminalSupport('未知终端', ['Ctrl+Enter', 'Ctrl+J'], false, 'neo 会尝试启用增强键盘协议；Alt+Enter 可能被终端占用，不作为默认推荐。');
}

function terminalSupportFromOverride(override: string, isTmux: boolean, isSsh: boolean): TerminalMultilineSupport {
  const suffix = isSsh ? ' over SSH' : '';
  if (override.includes('powershell') || override.includes('pwsh') || override.includes('conhost')) {
    return buildTerminalSupport(
      `PowerShell${suffix}`,
      ['Ctrl+Enter', 'Ctrl+J'],
      isTmux,
      'neo 已主动开启增强键盘协议；Alt+Enter 在 PowerShell/conhost/Windows Terminal 中常被全屏等行为占用，不作为推荐换行键。'
    );
  }
  if (override.includes('windows') || override.includes('wt')) {
    return buildTerminalSupport(`Windows Terminal${suffix}`, ['Ctrl+Enter', 'Ctrl+J'], isTmux, 'neo 已主动开启增强键盘协议；Alt+Enter 常被终端占用，不作为推荐换行键。');
  }
  if (override.includes('wezterm')) return buildTerminalSupport(`WezTerm${suffix}`, ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  if (override.includes('kitty')) return buildTerminalSupport(`Kitty${suffix}`, ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  if (override.includes('ghostty')) return buildTerminalSupport(`Ghostty${suffix}`, ['Ctrl+Enter', 'Alt+Enter', 'Ctrl+J'], isTmux);
  if (override.includes('vscode')) return buildTerminalSupport(`VS Code Terminal${suffix}`, ['Alt+Enter', 'Ctrl+J', 'Ctrl+Enter'], isTmux, 'VS Code 的快捷键可能被编辑器或终端配置拦截；若 Ctrl+Enter 无效，优先用 Alt+Enter 或 Ctrl+J。');
  if (override.includes('iterm')) return buildTerminalSupport(`iTerm2${suffix}`, ['Alt+Enter', 'Ctrl+J', 'Ctrl+Enter'], isTmux, 'iTerm2 默认不一定把 Ctrl+Enter 单独发给程序；开启 CSI u 或键盘映射后可用。');
  return buildTerminalSupport(`手动终端配置：${override}${suffix}`, ['Ctrl+Enter', 'Ctrl+J'], isTmux, '未知手动终端配置；neo 仍会尝试启用增强键盘协议。');
}

function buildTerminalSupport(
  name: string,
  recommended: string[],
  isTmux: boolean,
  note?: string
): TerminalMultilineSupport {
  const fallback = ['粘贴多行文本'];
  const tmuxNote = isTmux ? '检测到 tmux，组合键可能受 tmux extended-keys 配置影响。' : '';
  return {
    name: isTmux && name !== 'tmux' ? `${name} + tmux` : name,
    recommended,
    fallback,
    note: [note, tmuxNote, `也支持：${fallback.join('、')}。`].filter(Boolean).join(' '),
    ctrlEnterLikelyDistinct: recommended[0] === 'Ctrl+Enter' && !isTmux
  };
}

function formatMultilineSupport(support: TerminalMultilineSupport): string {
  return [
    `终端=${support.name}`,
    `推荐换行=${support.recommended.join(' / ')}`,
    `兜底=${support.fallback.join(' / ')}`,
    support.note
  ].join('；');
}

function formatStatusLine(turn: NonNullable<ReplState['lastTurn']>): string {
  const toolCount = turn.toolEvents.filter(event => event.phase === 'start').length;
  const parts = [
    `模型=${turn.modelKind}`,
    `工具=${toolCount}`,
    `耗时=${formatElapsedTime(turn.durationMs)}`
  ];
  const detail = [
    turn.webToolCalls > 0 ? `web=${turn.webToolCalls}` : '',
    turn.fileToolCalls > 0 ? `file=${turn.fileToolCalls}` : '',
    turn.mcpToolCalls > 0 ? `mcp=${turn.mcpToolCalls}` : '',
    turn.skillToolCalls > 0 ? `skill=${turn.skillToolCalls}` : ''
  ].filter(Boolean);
  if (detail.length > 0) parts.push(detail.join(','));
  return chalk.gray(`status ${parts.join(' ')}`);
}

function formatElapsedTime(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs));
  if (safeMs < 1000) return `${safeMs}ms`;

  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const milliseconds = safeMs % 1000;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  if (hours === 0 && minutes === 0 && milliseconds > 0) parts.push(`${milliseconds}ms`);

  return parts.join('');
}

function printReplStatus(agent: NeoAgent, state: ReplState): void {
  console.log([
    chalk.bold('neo REPL 状态'),
    `terminal: ${state.terminal.name}`,
    `multiline: ${state.terminal.recommended.join(' / ')}；兜底 ${state.terminal.fallback.join(' / ')}`,
    `homeDir: ${agent.config.homeDir}`,
    `log: ${agent.logger.filePath}`,
    `transcript: ${agent.transcripts.filePath}`,
    `main: ${agent.config.models.main.model}`,
    `small: ${agent.config.models.small.model}`,
    `toolRounds: ${agent.config.web.maxToolRounds}`,
    `debug: ${state.debugEnabled ? 'on' : 'off'}`,
    state.lastTurn ? formatStatusLine(state.lastTurn) : chalk.gray('status 尚无本轮对话')
  ].join('\n'));
}

function formatDebugView(agent: NeoAgent, state: ReplState): string {
  const turn = state.lastTurn;
  if (!turn) return chalk.gray('debug 暂无最近一轮对话。');
  const events = turn.toolEvents.length > 0
    ? turn.toolEvents.map(event => `- ${event.phase} round=${event.round + 1} ${event.name}: ${event.summary}`).join('\n')
    : chalk.gray('- 无工具事件');
  return [
    chalk.gray('debug'),
    chalk.gray(`inputChars=${turn.inputChars} durationMs=${turn.durationMs}`),
    chalk.gray(`log=${agent.logger.filePath}`),
    chalk.gray(`transcript=${agent.transcripts.filePath}`),
    events
  ].join('\n');
}

async function pickResumeSession(agent: NeoAgent): Promise<TranscriptSessionSummary | undefined> {
  const sessions = (await agent.transcripts.listSessions(50))
    .filter(session => session.sessionId !== agent.transcripts.sessionId);
  if (sessions.length === 0) {
    console.log(chalk.gray('没有可恢复的历史会话。'));
    await agent.transcripts.append('command', 'resume picker empty', {
      command: '/resume',
      status: 'empty'
    });
    return undefined;
  }
  return await readInteractiveSelect({
    title: '选择要恢复的会话',
    items: sessions,
    format: (session, maxWidth) => formatResumeSessionOption(session, maxWidth),
    emptyText: '没有可恢复的历史会话。'
  });
}

async function readInteractiveSelect<T>(options: {
  title: string;
  items: T[];
  format: (item: T, maxWidth: number) => string;
  emptyText: string;
}): Promise<T | undefined> {
  if (options.items.length === 0) {
    console.log(chalk.gray(options.emptyText));
    return undefined;
  }
  let selected = 0;
  let offset = 0;
  let renderedRows = 0;
  const visibleCount = Math.max(1, Math.min(options.items.length, Math.max(5, Math.min(12, (output.rows || 24) - 6))));

  const clear = (): void => {
    if (renderedRows === 0) return;
    output.write('\r\x1b[2K');
    for (let index = 1; index < renderedRows; index += 1) {
      output.write('\x1b[1A\r\x1b[2K');
    }
    renderedRows = 0;
  };
  const render = (): void => {
    clear();
    if (selected < offset) offset = selected;
    if (selected >= offset + visibleCount) offset = selected - visibleCount + 1;
    const end = Math.min(options.items.length, offset + visibleCount);
    const columns = getTerminalColumns();
    const lines = [
      chalk.bold(`${options.title}${options.items.length > visibleCount ? ` (${selected + 1}/${options.items.length})` : ''}`),
      chalk.gray('↑/↓ 选择，Enter 恢复，Esc/q 取消'),
      ...options.items.slice(offset, end).map((item, index) => {
        const absoluteIndex = offset + index;
        const isSelected = absoluteIndex === selected;
        const pointer = isSelected ? '› ' : '  ';
        const label = `${pointer}${options.format(item, Math.max(10, columns - displayWidth(pointer)))}`;
        return isSelected ? chalk.cyan(label) : label;
      })
    ];
    if (offset > 0) lines.splice(2, 0, chalk.gray('  ...'));
    if (end < options.items.length) lines.push(chalk.gray('  ...'));
    output.write(lines.join('\n'));
    renderedRows = lines.reduce((total, line) => total + getRenderedRowCountForLine(line, columns), 0);
  };

  render();
  return await new Promise<T | undefined>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      clear();
    };
    const done = (item: T | undefined): void => {
      cleanup();
      resolve(item);
    };
    const cancel = (): void => {
      cleanup();
      output.write(chalk.gray('已取消恢复。\n'));
      resolve(undefined);
    };
    const move = (delta: number): void => {
      selected = Math.max(0, Math.min(options.items.length - 1, selected + delta));
      render();
    };
    const onData = (chunk: Buffer | string): void => {
      const data = chunk.toString();
      for (let index = 0; index < data.length;) {
        const rest = data.slice(index);
        if (rest.startsWith('\x1b[A')) {
          move(-1);
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[B')) {
          move(1);
          index += 3;
          continue;
        }
        if (rest.startsWith('\x1b[5~')) {
          move(-visibleCount);
          index += 4;
          continue;
        }
        if (rest.startsWith('\x1b[6~')) {
          move(visibleCount);
          index += 4;
          continue;
        }
        const char = data[index] ?? '';
        if (char === '\r' || char === '\n') {
          done(options.items[selected]);
          return;
        }
        if (char === '\x1b' || char === 'q' || char === 'Q') {
          cancel();
          return;
        }
        if (char === '\x03' || char === '\x04') {
          cleanup();
          reject(createAbortError());
          return;
        }
        if (char === 'k') move(-1);
        else if (char === 'j') move(1);
        index += 1;
      }
    };
    input.on('data', onData);
  });
}

function formatResumeSessionOption(session: TranscriptSessionSummary, maxWidth: number): string {
  const title = session.title?.trim() || '(无标题会话)';
  const time = formatResumeTime(session.updatedAt);
  const size = session.sizeBytes > 1024 ? `${Math.round(session.sizeBytes / 1024)}KB` : `${session.sizeBytes}B`;
  const meta = `${session.sessionId} ${size}`;
  const fixedWidth = displayWidth(time) + displayWidth(meta) + 4;
  const titleWidth = Math.max(8, maxWidth - fixedWidth);
  const line = `${time}  ${truncateDisplayWidth(title, titleWidth)}  ${chalk.gray(meta)}`;
  return truncateAnsiLine(line, maxWidth);
}

function formatResumeTime(input: string): string {
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return input;
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';
  let width = 0;
  let outputText = '';
  const target = maxWidth - 1;
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (width + charWidth > target) break;
    outputText += char;
    width += charWidth;
  }
  return `${outputText.trimEnd()}…`;
}

function truncateAnsiLine(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value;
  return truncateDisplayWidth(stripAnsi(value), maxWidth);
}

async function confirmSkillSuggestion(
  agent: NeoAgent,
  askQuestion: AskQuestion,
  suggestion: SkillSuggestion,
  signal: AbortSignal
): Promise<void> {
  output.write([
    chalk.yellow('neo 发现这个任务可能值得沉淀为 skill：'),
    `${chalk.cyan(suggestion.name)} - ${suggestion.description}`,
    chalk.gray(`触发词：${suggestion.triggers.join(', ') || '(空)'}`),
    chalk.gray(suggestion.reason)
  ].join('\n') + '\n');
  const answer = await askQuestion('创建这个 skill 吗？[y/N] ', signal);
  if (!/^(y|yes|是|创建|同意)$/i.test(answer.trim())) {
    output.write(chalk.gray('已跳过创建 skill。\n'));
    await agent.transcripts.append('command', 'skill suggestion declined', {
      command: 'skill_suggestion_declined',
      name: suggestion.name,
      signature: suggestion.signature
    });
    return;
  }
  const skill = await agent.skills.createSuggestedSkill(suggestion);
  output.write(`${chalk.green('已创建 skill')} ${skill.path}\n`);
  await agent.transcripts.append('command', 'skill suggestion accepted', {
    command: 'skill_suggestion_accepted',
    name: skill.name,
    path: skill.path,
    signature: suggestion.signature
  });
}

async function confirmSkillImprovement(
  agent: NeoAgent,
  askQuestion: AskQuestion,
  suggestion: SkillImprovementSuggestion,
  signal: AbortSignal
): Promise<void> {
  output.write([
    chalk.yellow(`neo 发现 skill ${suggestion.skillName} 可能需要更新：`),
    ...suggestion.updates.map(update => `- ${update.section}: ${update.change}`),
    chalk.gray(suggestion.reason)
  ].join('\n') + '\n');
  const answer = await askQuestion('把这些改进追加到 SKILL.md 吗？[y/N] ', signal);
  if (!/^(y|yes|是|更新|追加|同意)$/i.test(answer.trim())) {
    output.write(chalk.gray('已跳过更新 skill。\n'));
    await agent.transcripts.append('command', 'skill improvement declined', {
      command: 'skill_improvement_declined',
      skillName: suggestion.skillName,
      scope: suggestion.scope,
      updateCount: suggestion.updates.length
    });
    return;
  }
  const skill = await agent.skills.applySkillImprovementSuggestion(suggestion);
  output.write(skill ? `${chalk.green('已更新 skill')} ${skill.filePath}\n` : chalk.yellow('没有找到要更新的 skill。\n'));
  await agent.transcripts.append('command', 'skill improvement accepted', {
    command: 'skill_improvement_accepted',
    skillName: suggestion.skillName,
    scope: suggestion.scope,
    filePath: skill?.filePath,
    updateCount: suggestion.updates.length
  });
}

async function handleCommand(agent: NeoAgent, line: string, state: ReplState, isInteractive: boolean): Promise<boolean> {
  if (!line.startsWith('/')) return false;
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command) {
    case '/help':
      await agent.transcripts.append('command', line, { command });
      printHelp(state.terminal);
      return true;
    case '/status':
      await agent.transcripts.append('command', line, { command });
      printReplStatus(agent, state);
      return true;
    case '/debug': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const mode = arg.trim().toLowerCase();
      if (mode === 'on') {
        state.debugEnabled = true;
        console.log(chalk.green('debug 已开启'));
      } else if (mode === 'off') {
        state.debugEnabled = false;
        console.log(chalk.gray('debug 已关闭'));
      } else if (mode === 'last') {
        console.log(formatDebugView(agent, state));
      } else {
        state.debugEnabled = !state.debugEnabled;
        console.log(state.debugEnabled ? chalk.green('debug 已开启') : chalk.gray('debug 已关闭'));
      }
      return true;
    }
    case '/memory': {
      await agent.transcripts.append('command', line, { command, queryChars: arg.length });
      const parsed = parseMemoryQuery(arg);
      const records = parsed.query ? await agent.memory.search(parsed.query) : await agent.memory.list(12, parsed.category);
      const filtered = parsed.category ? records.filter(record => record.category === parsed.category) : records;
      if (filtered.length === 0) console.log(chalk.gray('没有找到记忆'));
      for (const item of filtered) console.log(formatMemory(item));
      return true;
    }
    case '/remember': {
      await agent.transcripts.append('command', line, { command, contentChars: arg.length });
      const parsed = parseRememberArgs(arg);
      if (!parsed.content) console.log('用法：/remember [--type preference|project_fact|workflow|session_summary] [--tag 标签] [--pin] <内容>');
      else {
        const record = await agent.memory.remember(parsed.content, {
          category: parsed.category,
          tags: parsed.tags,
          pinned: parsed.pinned,
          origin: 'manual'
        });
        console.log(`${chalk.green('已记住')} ${formatMemorySummary(record)}`);
      }
      return true;
    }
    case '/memory-update': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const [idOrUri, ...contentParts] = rest;
      const content = contentParts.join(' ').trim();
      if (!idOrUri || !content) {
        console.log('用法：/memory-update <id|uri> <新内容>');
        return true;
      }
      const record = await agent.memory.update(idOrUri, { content });
      console.log(record ? `${chalk.green('已更新')} ${formatMemorySummary(record)}` : chalk.yellow('没有找到这条记忆'));
      return true;
    }
    case '/memory-delete':
    case '/forget': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      if (!arg) {
        console.log('用法：/memory-delete <id|uri>');
        return true;
      }
      const record = await agent.memory.forget(arg);
      console.log(record ? `${chalk.green('已删除')} ${formatMemorySummary(record)}` : chalk.yellow('没有找到这条记忆'));
      return true;
    }
    case '/memory-pin': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      if (!arg) {
        console.log('用法：/memory-pin <id|uri>');
        return true;
      }
      const record = await agent.memory.update(arg, { pinned: true });
      console.log(record ? `${chalk.green('已置顶')} ${formatMemorySummary(record)}` : chalk.yellow('没有找到这条记忆'));
      return true;
    }
    case '/memory-export': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const parsed = parseMemoryQuery(arg);
      const limit = Number.parseInt(parsed.query, 10);
      const records = await agent.memory.list(Number.isFinite(limit) ? limit : 100, parsed.category);
      console.log(JSON.stringify(records, null, 2));
      return true;
    }
    case '/skills': {
      await agent.transcripts.append('command', line, { command });
      const skills = await agent.skills.loadSkills();
      if (skills.length === 0) console.log(chalk.gray('没有找到 skill'));
      for (const skill of skills) console.log(formatSkillSummary(skill));
      return true;
    }
    case '/skill': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const [subCommand, ...skillRest] = rest;
      if (!subCommand || subCommand === 'list') {
        const skills = await agent.skills.loadSkills();
        if (skills.length === 0) console.log(chalk.gray('没有找到 skill'));
        for (const skill of skills) console.log(formatSkillSummary(skill));
        return true;
      }
      if ((subCommand === 'show' || subCommand === 'path' || subCommand === 'edit' || subCommand === 'delete' || subCommand === 'remove') && skillRest.length === 0) {
        console.log('用法：/skill list | show <名称> | path <名称> | edit <名称> | delete <名称> | create <名称> :: <描述>');
        return true;
      }
      if (subCommand === 'show') {
        const skill = await agent.skills.getSkill(skillRest.join(' '));
        if (!skill) console.log(chalk.yellow(`没有找到 skill：${skillRest.join(' ')}`));
        else console.log(formatSkillDetail(skill));
        return true;
      }
      if (subCommand === 'path' || subCommand === 'edit') {
        const filePath = await agent.skills.skillFilePath(skillRest.join(' '));
        if (!filePath) console.log(chalk.yellow(`没有找到 skill：${skillRest.join(' ')}`));
        else {
          console.log(chalk.gray(filePath));
          if (subCommand === 'edit') console.log(chalk.yellow('REPL 中不直接打开编辑器；请使用上面的路径，或运行 `neo skill edit <名称>`。'));
        }
        return true;
      }
      if (subCommand === 'delete' || subCommand === 'remove') {
        const deleted = await agent.skills.deleteSkill(skillRest.join(' '));
        console.log(deleted ? `${chalk.green('已删除 skill')} ${deleted.name}` : chalk.yellow(`没有找到 skill：${skillRest.join(' ')}`));
        return true;
      }
      if (subCommand !== 'create' || skillRest.length === 0) {
        console.log('用法：/skill list | show <名称> | path <名称> | edit <名称> | delete <名称> | create <名称> :: <描述>');
        return true;
      }
      const [name, description = 'Manual skill'] = skillRest.join(' ').split(/\s+::\s+/, 2);
      const skill = await agent.skills.createSkill(name, description, name.split(/\s+/), [
        'Confirm the task matches this skill.',
        'Apply the remembered workflow and adapt only where the current request differs.'
      ]);
      console.log(`${chalk.green('已创建 skill')} ${skill.path}`);
      return true;
    }
    case '/mcp': {
      await agent.transcripts.append('command', line, { command });
      const tools = await agent.mcp.listTools();
      if (tools.length === 0) console.log(chalk.gray('没有已连接的 MCP 工具'));
      else tools.forEach(tool => console.log(tool));
      return true;
    }
    case '/logs': {
      await agent.transcripts.append('command', line, { command });
      const lineCount = Number.parseInt(arg, 10);
      const tail = await agent.logger.tail(Number.isFinite(lineCount) ? lineCount : 60);
      console.log(chalk.gray(agent.logger.filePath));
      console.log(tail || chalk.gray('暂时没有日志'));
      return true;
    }
    case '/transcript': {
      await agent.transcripts.append('command', line, { command });
      const lineCount = Number.parseInt(arg, 10);
      const tail = await agent.transcripts.tail(Number.isFinite(lineCount) ? lineCount : undefined);
      console.log(chalk.gray(agent.transcripts.filePath));
      console.log(tail || chalk.gray('当前会话还没有 transcript'));
      return true;
    }
    case '/transcripts': {
      await agent.transcripts.append('command', line, { command });
      const limit = Number.parseInt(arg, 10);
      const sessions = await agent.transcripts.listSessions(Number.isFinite(limit) ? limit : 10);
      if (sessions.length === 0) {
        console.log(chalk.gray('没有找到 transcript'));
      } else {
        for (const session of sessions) {
          const title = session.title ? `  ${session.title}` : '';
          console.log(`${session.updatedAt}  ${session.sessionId}  ${session.sizeBytes}B${title}`);
          console.log(chalk.gray(session.path));
        }
      }
      return true;
    }
    case '/resume': {
      let selector = arg.trim();
      if (!selector && isInteractive) {
        const session = await pickResumeSession(agent);
        if (!session) return true;
        selector = session.sessionId;
      }
      selector ||= 'latest';
      const result = await agent.resumeSession(selector);
      if (result.status !== 'resumed' || !result.snapshot) {
        console.log(chalk.yellow(`没有找到可恢复的会话：${selector}`));
        console.log(chalk.gray('可以直接输入 /resume 打开选择器，或启动时使用 neo --resume [sessionId]。'));
        return true;
      }
      const { snapshot } = result;
      console.log(chalk.green(`已恢复会话：${snapshot.sessionId}`));
      if (snapshot.title) console.log(`标题：${snapshot.title}`);
      console.log(`恢复消息：${snapshot.messages.length}，compact 摘要：${snapshot.compactSummary?.length ?? 0} 字符`);
      if (snapshot.warnings.length > 0) {
        for (const warning of snapshot.warnings) console.log(chalk.yellow(`警告：${warning}`));
      }
      console.log(chalk.gray(snapshot.path));
      return true;
    }
    case '/usage': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const days = Number.parseInt(arg, 10);
      console.log(formatUsageSummary(await agent.usage.summarize({ days: Number.isFinite(days) ? days : undefined })));
      return true;
    }
    case '/agent': {
      await agent.transcripts.append('command', line, { command, taskChars: arg.length });
      if (!arg) console.log('用法：/agent <任务>');
      else console.log(await agent.subAgent.run(arg));
      return true;
    }
    case '/dream': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const [subCommand, ...dreamRest] = rest;
      if (subCommand === 'list') {
        const reports = await agent.dreams.listReports(10);
        if (reports.length === 0) console.log(chalk.gray('没有找到 dream 报告。'));
        for (const report of reports) {
          const status = report.appliedAt ? `已采纳 ${report.appliedAt}` : (report.dryRun ? '待采纳' : '已执行');
          console.log(`${report.ts}  ${report.id}  ${status}`);
          console.log(chalk.gray(report.path));
        }
        return true;
      }
      if (subCommand === 'show') {
        const report = await agent.dreams.showReport(dreamRest.join(' ') || undefined);
        if (!report) console.log(chalk.yellow('没有找到 dream 报告。'));
        else {
          console.log(`${chalk.cyan(report.id)}  ${report.ts}`);
          console.log(`摘要：${report.summary}`);
          console.log(`新增/更新建议：${report.upserts}，归档建议：${report.archives}，灵感：${report.insights}`);
          console.log(chalk.gray(report.path));
        }
        return true;
      }
      if (subCommand === 'apply') {
        const result = await agent.dreams.applyReport(dreamRest.join(' ') || undefined);
        if (result.status === 'skipped') console.log(chalk.yellow(`dream 采纳跳过：${result.reason}`));
        else console.log(`${chalk.green('dream 报告已采纳')} 写入 ${result.upserts.length}，归档 ${result.archives.length}`);
        return true;
      }
      if (subCommand === 'review') {
        const review = await agent.dreams.reviewMemories();
        console.log(`已复查记忆：${review.checkedMemories}`);
        if (review.issues.length === 0) console.log(chalk.green('没有发现明显问题。'));
        for (const issue of review.issues) {
          const color = issue.severity === 'warn' ? chalk.yellow : chalk.gray;
          console.log(color(`${issue.type}: ${issue.message}`));
          console.log(chalk.gray(issue.memoryIds.join(', ')));
        }
        return true;
      }
      const dryRun = rest.includes('--dry-run');
      const force = rest.includes('--force') || !rest.includes('--scheduled');
      const result = await agent.dreams.run({ dryRun, force });
      if (result.status === 'skipped') console.log(chalk.gray(`dream 跳过：${result.reason}`));
      else {
        console.log(chalk.green(dryRun ? 'dream dry-run 完成' : 'dream 完成'));
        console.log(`摘要：${result.summary}`);
        console.log(`新增/更新建议：${result.upserts.length}，归档建议：${result.archives.length}，灵感：${result.insights.length}`);
        if (result.reportPath) console.log(chalk.gray(result.reportPath));
      }
      return true;
    }
    case '/web': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const [subCommand, ...webArgs] = rest;
      if (subCommand === 'search') {
        const query = webArgs.join(' ').trim();
        if (!query) console.log('用法：/web search <查询词>');
        else console.log(formatWebSearch(await agent.web.search(query)));
        return true;
      }
      if (subCommand === 'extract') {
        const urls = webArgs.filter(Boolean);
        if (urls.length === 0) console.log('用法：/web extract <url...>');
        else console.log(formatWebExtract(await agent.web.extract(urls)));
        return true;
      }
      if (subCommand === 'map') {
        const [url, ...instructionParts] = webArgs;
        if (!url) console.log('用法：/web map <url> [筛选指令]');
        else console.log(formatWebMap(await agent.web.map(url, { instructions: instructionParts.join(' ').trim() || undefined })));
        return true;
      }
      if (subCommand === 'crawl') {
        const [url, ...instructionParts] = webArgs;
        if (!url) console.log('用法：/web crawl <url> [筛选指令]');
        else console.log(formatWebCrawl(await agent.web.crawl(url, { instructions: instructionParts.join(' ').trim() || undefined })));
        return true;
      }
      console.log('用法：/web search <查询词>、/web extract <url...>、/web map <url> 或 /web crawl <url>');
      return true;
    }
    default:
      await agent.transcripts.append('command', line, { command, known: false });
      console.log(`未知命令：${command}`);
      return true;
  }
}

function printBanner(support: TerminalMultilineSupport): void {
  void support;
  console.log(chalk.bold('neo-agent'));
  console.log(chalk.gray('输入 /help 查看命令。\n'));
}

function printHelp(support: TerminalMultilineSupport): void {
  console.log([
    '/help                 查看命令',
    '/exit                 退出',
    '/status               查看当前 REPL 状态',
    '/debug [on|off|last]  开关轻量 debug 视图',
    `换行                 当前推荐 ${support.recommended.join(' / ')}；${support.note}`,
    '/remember <内容>      保存一条用户记忆，支持 --type/--tag/--pin',
    '/memory [查询词]      查看或搜索记忆，支持 --type',
    '/memory-update <id|uri> <新内容>',
    '/memory-delete <id|uri>',
    '/memory-pin <id|uri>',
    '/memory-export [数量]',
    '/skills               查看已加载的 skill',
    '/skill list/show/path/edit/delete/create',
    '/mcp                  查看已连接的 MCP 工具',
    '/logs [行数]          查看最近的 JSONL 日志',
    '/transcript [行数]    查看当前会话 transcript',
    '/transcripts [数量]   查看最近会话 transcript 列表',
    '/resume [session]     恢复最近或指定会话上下文',
    '/usage [天数]          查看模型 token 和成本统计',
    '/agent <任务>         把聚焦任务交给小模型 sub-agent',
    '/dream [--dry-run]    整理记忆并提炼灵感；支持 list/show/apply/review',
    '/web search <查询词>  联网搜索',
    '/web extract <url>    提取网页正文',
    '/web map <url>        发现站点 URL',
    '/web crawl <url>      有限深度爬取站点正文',
    '@/path/image.png      在普通提示词中附加图片'
  ].join('\n'));
}

function formatSkillSummary(skill: { name: string; description: string; triggers: string[]; path: string; scope?: string; usage?: { usageCount: number; lastUsedAt?: string } }): string {
  const triggers = skill.triggers.length > 0 ? ` 触发词=${skill.triggers.join(',')}` : '';
  const scope = skill.scope ? ` scope=${skill.scope}` : '';
  const usage = skill.usage ? ` 使用=${skill.usage.usageCount}` : '';
  return [
    `${chalk.cyan(skill.name)} - ${skill.description}${chalk.gray(`${scope}${triggers}${usage}`)}`,
    chalk.gray(`${skill.path}/SKILL.md`)
  ].join('\n');
}

function formatSkillDetail(skill: { name: string; description: string; triggers: string[]; path: string; scope?: string; usage?: { usageCount: number; successCount: number; failureCount: number; lastUsedAt?: string }; body: string }): string {
  return [
    `${chalk.cyan(skill.name)} - ${skill.description}`,
    skill.scope ? chalk.gray(`scope=${skill.scope}`) : '',
    chalk.gray(`${skill.path}/SKILL.md`),
    skill.triggers.length > 0 ? chalk.gray(`触发词：${skill.triggers.join(', ')}`) : '',
    skill.usage ? chalk.gray(`使用：${skill.usage.usageCount} 次，成功 ${skill.usage.successCount}，失败 ${skill.usage.failureCount}，最近 ${skill.usage.lastUsedAt ?? 'never'}`) : '',
    '',
    skill.body.trimEnd()
  ].filter(line => line !== '').join('\n');
}

function formatMcpPermissionPrompt(request: {
  fullName: string;
  serverName: string;
  toolName: string;
  description?: string;
  risk: string;
  argumentKeys: string[];
  argumentChars: number;
}): string {
  const keys = request.argumentKeys.length > 0 ? request.argumentKeys.join(', ') : '无';
  return [
    '',
    chalk.yellow('MCP 工具需要权限确认'),
    `工具：${request.fullName}`,
    `来源：${request.serverName}.${request.toolName}`,
    request.description ? `说明：${request.description}` : '',
    `风险：${request.risk}`,
    `参数：${request.argumentChars} 字符；字段：${keys}`,
    '选择：y=允许本次，a=始终允许，n=拒绝本次，d=始终拒绝。'
  ].filter(Boolean).join('\n');
}

function parseMcpPermissionAnswer(answer: string): 'allow_once' | 'allow_always' | 'deny' | 'deny_always' {
  const normalized = answer.trim().toLowerCase();
  if (/^(a|always|始终允许|永久允许|总是允许)$/i.test(normalized)) return 'allow_always';
  if (/^(d|deny always|始终拒绝|永久拒绝|总是拒绝)$/i.test(normalized)) return 'deny_always';
  if (/^(y|yes|允许|同意)$/i.test(normalized)) return 'allow_once';
  return 'deny';
}

function formatToolProgressEvent(event: ToolProgressEvent): string {
  const prefix = event.phase === 'start'
    ? chalk.gray('tool>')
    : event.phase === 'success'
      ? chalk.green('tool✓')
      : event.phase === 'max_rounds'
        ? chalk.yellow('tool!')
        : chalk.red('tool!');
  const round = event.phase === 'max_rounds' ? '上限' : `round ${event.round + 1}`;
  return `${prefix} ${chalk.gray(round)} ${event.summary}`;
}

function parseRememberArgs(arg: string): { content: string; category: MemoryCategory; tags: string[]; pinned: boolean } {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const tags: string[] = [];
  let category: MemoryCategory = 'preference';
  let pinned = false;
  const content: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === '--type' || token === '--category') && tokens[index + 1]) {
      category = parseMemoryCategory(tokens[index + 1]);
      index += 1;
      continue;
    }
    if ((token === '--tag' || token === '--tags') && tokens[index + 1]) {
      tags.push(...tokens[index + 1].split(',').map(item => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (token === '--pin' || token === '--pinned') {
      pinned = true;
      continue;
    }
    content.push(token);
  }

  return { content: content.join(' ').trim(), category, tags, pinned };
}

function parseMemoryQuery(arg: string): { query: string; category?: MemoryCategory } {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const query: string[] = [];
  let category: MemoryCategory | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === '--type' || token === '--category') && tokens[index + 1]) {
      category = parseMemoryCategory(tokens[index + 1]);
      index += 1;
      continue;
    }
    query.push(token);
  }
  return { query: query.join(' ').trim(), category };
}

function parseMemoryCategory(raw: string): MemoryCategory {
  const value = raw.trim().toLowerCase();
  if (['project_fact', 'project', 'fact', '项目', '事实', '项目事实'].includes(value)) return 'project_fact';
  if (['workflow', 'flow', '工作流', '流程'].includes(value)) return 'workflow';
  if (['session_summary', 'session', 'summary', '会话', '摘要', '会话摘要'].includes(value)) return 'session_summary';
  return 'preference';
}

function formatMemory(record: MemoryRecord): string {
  return `${formatMemorySummary(record)}\n${record.content}\n`;
}

function formatMemorySummary(record: MemoryRecord): string {
  const pin = record.pinned ? '置顶 ' : '';
  const tags = record.tags.length > 0 ? ` #${record.tags.join(' #')}` : '';
  return `${pin}${record.category} ${record.id}${tags}\n${chalk.gray(record.uri)}`;
}
