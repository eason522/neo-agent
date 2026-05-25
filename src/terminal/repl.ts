import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { NeoAgent } from '../neoAgent.js';
import { extractImageAttachments } from '../input/attachments.js';
import type { MemoryCategory, MemoryRecord, SkillImprovementSuggestion, SkillSuggestion, ToolProgressEvent } from '../types.js';
import { formatWebCrawl, formatWebExtract, formatWebMap, formatWebSearch } from '../web/tavilyClient.js';
import { createAbortError, isAbortError } from '../utils/abort.js';

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

export async function startRepl(agent: NeoAgent): Promise<void> {
  const isInteractive = Boolean(input.isTTY);
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
  let multilineBuffer: string[] | undefined;
  let activeController: AbortController | undefined;
  const continueMultilineFromShortcut = (): void => {
    const mutableRl = rl as ReturnType<typeof readline.createInterface> & {
      line?: string;
      write?: (data: string | null, key?: { ctrl?: boolean; name?: string }) => void;
    };
    const currentLine = String(mutableRl.line ?? '').trimEnd();
    if (!multilineBuffer) {
      multilineBuffer = [];
      rl.setPrompt(chalk.gray('neo… '));
    }
    multilineBuffer.push(currentLine);
    mutableRl.write?.(null, { ctrl: true, name: 'u' });
    output.write('\n');
    if (isInteractive) rl.prompt();
  };
  const handleKeypress = (sequence: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): void => {
    if (!isMultilineShortcut(sequence, key)) return;
    continueMultilineFromShortcut();
  };
  if (isInteractive && input.isTTY) {
    emitKeypressEvents(input);
    input.on('keypress', handleKeypress);
  }
  agent.setMcpPermissionAsker(isInteractive ? async request => {
    const answer = activeController
      ? await rl.question(formatMcpPermissionPrompt(request), { signal: activeController.signal })
      : await rl.question(formatMcpPermissionPrompt(request));
    return /^(y|yes|允许|同意)$/i.test(answer.trim()) ? 'allow_once' : 'deny';
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
      const rawLine = raw.trimEnd();
      const line = rawLine.trim();
      if (multilineBuffer) {
        if (line === '/cancel') {
          multilineBuffer = undefined;
          rl.setPrompt(chalk.gray('neo> '));
          output.write(chalk.gray('已取消多行输入。\n'));
          if (isInteractive) rl.prompt();
          continue;
        }
        if (line === '.' || line === '/end') {
          const combined = multilineBuffer.join('\n').trim();
          multilineBuffer = undefined;
          rl.setPrompt(chalk.gray('neo> '));
          if (!combined) {
            if (isInteractive) rl.prompt();
            continue;
          }
          await saveReplHistory(historyFile, combined);
          await runAgentTurn(agent, combined, isInteractive, rl, state, controller => {
            activeController = controller;
          });
          activeController = undefined;
          if (isInteractive) rl.prompt();
          continue;
        }
        multilineBuffer.push(rawLine);
        if (isInteractive) rl.prompt();
        continue;
      }
      if (!line) {
        if (isInteractive) rl.prompt();
        continue;
      }
      if (line === '/multi') {
        multilineBuffer = [];
        rl.setPrompt(chalk.gray('neo… '));
        output.write(chalk.gray('进入多行输入：单独输入 . 或 /end 提交，/cancel 取消。\n'));
        if (isInteractive) rl.prompt();
        continue;
      }
      if (rawLine.endsWith('\\')) {
        multilineBuffer = [rawLine.slice(0, -1)];
        rl.setPrompt(chalk.gray('neo… '));
        if (isInteractive) rl.prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') break;
      await saveReplHistory(historyFile, line);
      if (await handleCommand(agent, line, state)) {
        if (isInteractive) rl.prompt();
        continue;
      }

      await runAgentTurn(agent, line, isInteractive, rl, state, controller => {
        activeController = controller;
      });
      activeController = undefined;
      if (isInteractive) rl.prompt();
    }
  } finally {
    rl.off('SIGINT', handleSigint);
    input.off('keypress', handleKeypress);
    agent.setToolEventHandler(undefined);
    rl.close();
    await agent.close();
  }
}

async function runAgentTurn(
  agent: NeoAgent,
  line: string,
  isInteractive: boolean,
  rl: ReturnType<typeof readline.createInterface>,
  state: ReplState,
  setActiveController: (controller: AbortController | undefined) => void
): Promise<void> {
  const { text, attachments } = extractImageAttachments(line);
  output.write(chalk.gray('thinking...\n'));
  const startedAt = Date.now();
  const turnController = new AbortController();
  setActiveController(turnController);
  try {
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
    if (isInteractive && response.skillSuggestion && !turnController.signal.aborted) {
      await confirmSkillSuggestion(agent, rl, response.skillSuggestion, turnController.signal);
    }
    if (isInteractive && response.skillImprovementSuggestion && !turnController.signal.aborted) {
      await confirmSkillImprovement(agent, rl, response.skillImprovementSuggestion, turnController.signal);
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

function isMultilineShortcut(sequence: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): boolean {
  const name = key.name ?? '';
  if ((name === 'return' || name === 'enter') && (key.ctrl || key.meta)) return true;
  if (name === 'j' && key.ctrl) return true;
  return [
    '\u001b[13;5u',
    '\u001b[13;6u',
    '\u001b[13;3u',
    '\u001b[13;7u'
  ].includes(sequence);
}

function detectTerminalMultilineSupport(env: NodeJS.ProcessEnv = process.env): TerminalMultilineSupport {
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  const isTmux = Boolean(env.TMUX);

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
    return buildTerminalSupport('Windows Terminal', ['Ctrl+J', 'Ctrl+Enter'], isTmux, 'Windows Terminal 的 Ctrl+Enter 支持取决于输入协议和配置；Ctrl+J 通常更稳。');
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
  return buildTerminalSupport('未知终端', ['Ctrl+J', 'Alt+Enter'], false, '当前无法可靠识别终端类型；如果快捷键无效，请使用 /multi。');
}

function buildTerminalSupport(
  name: string,
  recommended: string[],
  isTmux: boolean,
  note?: string
): TerminalMultilineSupport {
  const fallback = ['/multi', '行尾 \\'];
  const tmuxNote = isTmux ? '检测到 tmux，组合键可能受 tmux extended-keys 配置影响。' : '';
  return {
    name: isTmux && name !== 'tmux' ? `${name} + tmux` : name,
    recommended,
    fallback,
    note: [note, tmuxNote, `稳定兜底：${fallback.join('、')}。`].filter(Boolean).join(' '),
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
    `耗时=${turn.durationMs}ms`
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

async function confirmSkillSuggestion(
  agent: NeoAgent,
  rl: ReturnType<typeof readline.createInterface>,
  suggestion: SkillSuggestion,
  signal: AbortSignal
): Promise<void> {
  output.write([
    chalk.yellow('neo 发现这个任务可能值得沉淀为 skill：'),
    `${chalk.cyan(suggestion.name)} - ${suggestion.description}`,
    chalk.gray(`触发词：${suggestion.triggers.join(', ') || '(空)'}`),
    chalk.gray(suggestion.reason)
  ].join('\n') + '\n');
  const answer = await rl.question('创建这个 skill 吗？[y/N] ', { signal });
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
  rl: ReturnType<typeof readline.createInterface>,
  suggestion: SkillImprovementSuggestion,
  signal: AbortSignal
): Promise<void> {
  output.write([
    chalk.yellow(`neo 发现 skill ${suggestion.skillName} 可能需要更新：`),
    ...suggestion.updates.map(update => `- ${update.section}: ${update.change}`),
    chalk.gray(suggestion.reason)
  ].join('\n') + '\n');
  const answer = await rl.question('把这些改进追加到 SKILL.md 吗？[y/N] ', { signal });
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

async function handleCommand(agent: NeoAgent, line: string, state: ReplState): Promise<boolean> {
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
          console.log(`${session.updatedAt}  ${session.sessionId}  ${session.sizeBytes}B`);
          console.log(chalk.gray(session.path));
        }
      }
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
  console.log(chalk.bold('neo-agent'));
  console.log(chalk.gray(`输入 /help 查看命令。${formatMultilineSupport(support)}\n`));
}

function printHelp(support: TerminalMultilineSupport): void {
  console.log([
    '/help                 查看命令',
    '/exit                 退出',
    '/status               查看当前 REPL 状态',
    '/debug [on|off|last]  开关轻量 debug 视图',
    `/multi                多行输入，. 或 /end 提交；当前推荐 ${support.recommended.join(' / ')}，兜底 ${support.fallback.join(' / ')}`,
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
    '/agent <任务>         把聚焦任务交给小模型 sub-agent',
    '/dream [--dry-run]    整理记忆并提炼灵感',
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
    '允许本次执行吗？输入 y/yes/允许 允许，其他输入拒绝：'
  ].filter(Boolean).join('\n');
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
