#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { initConfigFile, loadConfig } from './config.js';
import { NeoAgent } from './neoAgent.js';
import { extractImageAttachments } from './input/attachments.js';
import { startRepl } from './terminal/repl.js';
import { Logger } from './logging/logger.js';

const program = new Command();

program
  .name('neo-agent')
  .description('个人终端 AI agent')
  .version('0.1.0')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [command]', '显示命令帮助');

program
  .command('config:init')
  .description('创建 ~/.neo-agent/config.json')
  .action(async () => {
    const filePath = await initConfigFile();
    console.log(filePath);
  });

program
  .command('ask')
  .description('单次提问并输出答案')
  .argument('<prompt...>')
  .action(async (promptParts: string[]) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize();
    const { text, attachments } = extractImageAttachments(promptParts.join(' '));
    try {
      const response = await agent.ask(text, attachments);
      console.log(response.text);
      console.error(chalk.gray(`model=${response.modelKind}`));
    } finally {
      await agent.close();
    }
  });

program
  .command('logs')
  .description('查看最近的 JSONL 日志')
  .option('-n, --lines <lines>', '显示行数', '80')
  .action(async (options: { lines: string }) => {
    const config = await loadConfig();
    const logger = new Logger(config);
    const lines = Number.parseInt(options.lines, 10);
    console.log(chalk.gray(logger.filePath));
    const tail = await logger.tail(Number.isFinite(lines) ? lines : 80);
    console.log(tail || chalk.gray('暂时没有日志'));
  });

program
  .command('chat', { isDefault: true })
  .description('启动终端对话')
  .action(async () => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize();
    await startRepl(agent);
  });

program.parseAsync(process.argv).catch(error => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
