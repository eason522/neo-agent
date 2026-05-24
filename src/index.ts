#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { initConfigFile, loadConfig } from './config.js';
import { NeoAgent } from './neoAgent.js';
import { extractImageAttachments } from './input/attachments.js';
import { startRepl } from './terminal/repl.js';
import { Logger } from './logging/logger.js';
import { TranscriptService, tailFile } from './transcript/transcriptService.js';
import { formatDoctorReport, runDoctor } from './doctor/doctor.js';

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
    await agent.initialize({ scheduledDreams: false });
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
  .command('transcripts')
  .description('查看最近的对话 transcript')
  .option('-n, --limit <limit>', '显示会话数量', '10')
  .option('-t, --tail <sessionIdOrPath>', '查看某个会话文件的末尾')
  .option('-l, --lines <lines>', 'tail 显示行数', '80')
  .action(async (options: { limit: string; tail?: string; lines: string }) => {
    const config = await loadConfig();
    const transcripts = new TranscriptService(config);
    const lines = Number.parseInt(options.lines, 10);
    if (options.tail) {
      const sessions = await transcripts.listSessions(200);
      const target = sessions.find(session => session.sessionId === options.tail || session.path === options.tail);
      const filePath = target?.path ?? options.tail;
      console.log(chalk.gray(filePath));
      console.log(await tailFile(filePath, Number.isFinite(lines) ? lines : 80) || chalk.gray('没有找到 transcript 内容'));
      return;
    }

    const limit = Number.parseInt(options.limit, 10);
    const sessions = await transcripts.listSessions(Number.isFinite(limit) ? limit : 10);
    if (sessions.length === 0) {
      console.log(chalk.gray('没有找到 transcript'));
      return;
    }
    for (const session of sessions) {
      console.log(`${session.updatedAt}  ${session.sessionId}  ${session.sizeBytes}B`);
      console.log(chalk.gray(session.path));
    }
  });

program
  .command('doctor')
  .description('诊断 neo-agent 安装、配置和运行环境')
  .action(async () => {
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    process.exitCode = report.status === 'fail' ? 1 : 0;
  });

program
  .command('dream')
  .description('整理记忆和 transcript，提炼长期记忆与灵感')
  .option('--dry-run', '只生成报告，不写入记忆')
  .option('--force', '忽略定时门控，立即执行')
  .option('-s, --sessions <count>', '最多读取的近期会话数量')
  .action(async (options: { dryRun?: boolean; force?: boolean; sessions?: string }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const maxSessions = Number.parseInt(options.sessions ?? '', 10);
      const result = await agent.dreams.run({
        dryRun: options.dryRun ?? false,
        force: options.force ?? true,
        maxSessions: Number.isFinite(maxSessions) ? maxSessions : undefined
      });
      if (result.status === 'skipped') {
        console.log(chalk.gray(`dream 跳过：${result.reason}`));
        return;
      }
      console.log(chalk.green(options.dryRun ? 'dream dry-run 完成' : 'dream 完成'));
      console.log(`摘要：${result.summary}`);
      console.log(`读取会话：${result.reviewedSessions}，读取记忆：${result.reviewedMemories}`);
      console.log(`新增/更新建议：${result.upserts.length}，归档建议：${result.archives.length}，灵感：${result.insights.length}`);
      if (result.reportPath) console.log(chalk.gray(result.reportPath));
    } finally {
      await agent.close();
    }
  });

program
  .command('chat')
  .description('启动终端对话')
  .action(async () => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize();
    await startRepl(agent);
  });

program
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
