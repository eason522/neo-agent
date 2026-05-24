import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { NeoAgent } from '../neoAgent.js';
import { extractImageAttachments } from '../input/attachments.js';
import type { MemoryCategory, MemoryRecord } from '../types.js';
import { formatWebCrawl, formatWebExtract, formatWebMap, formatWebSearch } from '../web/tavilyClient.js';

export async function startRepl(agent: NeoAgent): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: chalk.gray('neo> ') });
  const isInteractive = Boolean(input.isTTY);
  printBanner();

  try {
    if (isInteractive) rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        if (isInteractive) rl.prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') break;
      if (await handleCommand(agent, line)) {
        if (isInteractive) rl.prompt();
        continue;
      }

      const { text, attachments } = extractImageAttachments(line);
      output.write(chalk.gray('thinking...\n'));
      try {
        const response = await agent.ask(text, attachments);
        output.write(`${chalk.cyan(`neo:${response.modelKind}`)} ${response.text.trim()}\n\n`);
      } catch (error) {
        output.write(`${chalk.red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
      }
      if (isInteractive) rl.prompt();
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

async function handleCommand(agent: NeoAgent, line: string): Promise<boolean> {
  if (!line.startsWith('/')) return false;
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command) {
    case '/help':
      await agent.transcripts.append('command', line, { command });
      printHelp();
      return true;
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
      for (const skill of skills) console.log(`${chalk.cyan(skill.name)} - ${skill.description}`);
      return true;
    }
    case '/skill': {
      await agent.transcripts.append('command', line, { command, argsChars: arg.length });
      const [subCommand, ...skillRest] = rest;
      if (subCommand !== 'create' || skillRest.length === 0) {
        console.log('用法：/skill create <名称> :: <描述>');
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

function printBanner(): void {
  console.log(chalk.bold('neo-agent'));
  console.log(chalk.gray('输入 /help 查看命令。图片输入可使用 @image:/path/to/file.png 或 @/path/file.png。\n'));
}

function printHelp(): void {
  console.log([
    '/help                 查看命令',
    '/exit                 退出',
    '/remember <内容>      保存一条用户记忆，支持 --type/--tag/--pin',
    '/memory [查询词]      查看或搜索记忆，支持 --type',
    '/memory-update <id|uri> <新内容>',
    '/memory-delete <id|uri>',
    '/memory-pin <id|uri>',
    '/memory-export [数量]',
    '/skills               查看已加载的 skill',
    '/skill create <名称> :: <描述>',
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
