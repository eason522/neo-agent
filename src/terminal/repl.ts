import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { NeoAgent } from '../neoAgent.js';
import { extractImageAttachments } from '../input/attachments.js';

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
      const records = arg ? await agent.memory.search(arg) : await agent.memory.list(12);
      if (records.length === 0) console.log(chalk.gray('没有找到记忆'));
      for (const item of records) console.log(`${chalk.gray(item.uri)}\n${item.content}\n`);
      return true;
    }
    case '/remember': {
      await agent.transcripts.append('command', line, { command, contentChars: arg.length });
      if (!arg) console.log('用法：/remember <内容>');
      else {
        const record = await agent.memory.remember(arg, ['manual'], 'user');
        console.log(`${chalk.green('已记住')} ${record.uri}`);
      }
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
    '/remember <内容>      保存一条用户记忆',
    '/memory [查询词]      查看或搜索记忆',
    '/skills               查看已加载的 skill',
    '/skill create <名称> :: <描述>',
    '/mcp                  查看已连接的 MCP 工具',
    '/logs [行数]          查看最近的 JSONL 日志',
    '/transcript [行数]    查看当前会话 transcript',
    '/transcripts [数量]   查看最近会话 transcript 列表',
    '/agent <任务>         把聚焦任务交给小模型 sub-agent',
    '@/path/image.png      在普通提示词中附加图片'
  ].join('\n'));
}
