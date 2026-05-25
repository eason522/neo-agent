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
import { formatWebCrawl, formatWebExtract, formatWebMap, formatWebSearch, TavilyClient } from './web/tavilyClient.js';
import {
  addConfiguredMcpServer,
  formatMcpServerEntry,
  listConfiguredMcpServers,
  parseEnvPairs,
  removeConfiguredMcpServer,
  testConfiguredMcpServers
} from './mcp/mcpConfigCommands.js';
import { createAbortError, isAbortError } from './utils/abort.js';

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
  .option('--no-web', '本次提问不自动联网搜索')
  .action(async (promptParts: string[], options: { web?: boolean }) => {
    const config = await loadConfig();
    if (options.web === false) config.web.autoSearch = false;
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    const { text, attachments } = extractImageAttachments(promptParts.join(' '));
    const controller = new AbortController();
    const onSigint = (): void => controller.abort(createAbortError());
    process.once('SIGINT', onSigint);
    try {
      const response = await agent.ask(text, attachments, { signal: controller.signal });
      console.log(response.text);
      console.error(chalk.gray(`model=${response.modelKind}`));
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        console.error(chalk.yellow('已取消当前请求。'));
        process.exitCode = 130;
      } else {
        throw error;
      }
    } finally {
      process.off('SIGINT', onSigint);
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

const webCommand = program
  .command('web')
  .description('联网搜索和网页读取');

webCommand
  .command('search')
  .description('使用 Tavily 搜索互联网')
  .argument('<query...>')
  .option('-n, --max-results <count>', '结果数量')
  .option('-d, --depth <basic|advanced>', '搜索深度')
  .action(async (queryParts: string[], options: { maxResults?: string; depth?: 'basic' | 'advanced' }) => {
    const config = await loadConfig();
    const logger = new Logger(config);
    const client = new TavilyClient(config, logger);
    const maxResults = Number.parseInt(options.maxResults ?? '', 10);
    try {
      const response = await client.search(queryParts.join(' '), {
        maxResults: Number.isFinite(maxResults) ? maxResults : undefined,
        depth: options.depth
      });
      console.log(formatWebSearch(response));
    } finally {
      await logger.flush();
    }
  });

const mcpCommand = program
  .command('mcp')
  .description('管理 MCP server 配置');

mcpCommand
  .command('list')
  .description('列出已配置的 MCP server')
  .option('--json', '输出 JSON')
  .action(async (options: { json?: boolean }) => {
    const { filePath, entries } = await listConfiguredMcpServers();
    if (options.json) {
      console.log(JSON.stringify({ filePath, servers: entries }, null, 2));
      return;
    }
    console.log(chalk.gray(filePath));
    if (entries.length === 0) {
      console.log(chalk.gray('没有配置 MCP server。使用 `neo mcp add <name> <command> [args...]` 添加。'));
      return;
    }
    for (const entry of entries) console.log(formatMcpServerEntry(entry));
  });

mcpCommand
  .command('add')
  .description('添加 stdio MCP server')
  .argument('<name>', 'server 名称')
  .argument('<command>', '启动命令')
  .argument('[args...]', '启动参数')
  .allowUnknownOption(true)
  .option('-e, --env <pair>', '环境变量 KEY=VALUE，可重复', collectOption, [])
  .option('--disabled', '添加后先禁用')
  .action(async (name: string, command: string, args: string[], options: { env: string[]; disabled?: boolean }) => {
    const result = await addConfiguredMcpServer({
      name,
      command,
      args,
      env: parseEnvPairs(options.env),
      disabled: options.disabled
    });
    console.log(chalk.green(`已添加 MCP server：${name}`));
    console.log(chalk.gray(result.filePath));
    console.log(formatMcpServerEntry({ name, server: result.server }));
  });

mcpCommand
  .command('remove')
  .description('删除 MCP server 配置')
  .argument('<name>', 'server 名称')
  .action(async (name: string) => {
    const result = await removeConfiguredMcpServer(name);
    if (!result.removed) {
      console.log(chalk.yellow(`没有找到 MCP server：${name}`));
      return;
    }
    console.log(chalk.green(`已删除 MCP server：${name}`));
    console.log(chalk.gray(result.filePath));
  });

mcpCommand
  .command('test')
  .description('测试已配置 MCP server 连接')
  .argument('[name]', 'server 名称；不填则测试所有启用的 server')
  .action(async (name?: string) => {
    const results = await testConfiguredMcpServers(name);
    if (results.length === 0) {
      console.log(chalk.gray('没有启用的 MCP server。'));
      return;
    }
    for (const result of results) {
      if (result.status === 'connected') {
        console.log(`${chalk.green('✓')} ${result.name} connected, tools=${result.toolCount ?? 0}`);
      } else {
        console.log(`${chalk.red('x')} ${result.name} failed: ${result.error}`);
      }
    }
    if (results.some(result => result.status === 'failed')) process.exitCode = 1;
  });

webCommand
  .command('extract')
  .description('使用 Tavily 提取网页正文')
  .argument('<url...>')
  .option('-d, --depth <basic|advanced>', '提取深度')
  .option('--max-chars <count>', '每个网页最多输出字符数', '5000')
  .action(async (urls: string[], options: { depth?: 'basic' | 'advanced'; maxChars: string }) => {
    const config = await loadConfig();
    const logger = new Logger(config);
    const client = new TavilyClient(config, logger);
    const maxChars = Number.parseInt(options.maxChars, 10);
    try {
      const response = await client.extract(urls, { depth: options.depth });
      console.log(formatWebExtract(response, Number.isFinite(maxChars) ? maxChars : 5000));
    } finally {
      await logger.flush();
    }
  });

webCommand
  .command('map')
  .description('使用 Tavily 发现站点 URL')
  .argument('<url>')
  .option('-i, --instructions <text>', '自然语言筛选指令')
  .option('--limit <count>', '最多返回 URL 数量')
  .option('--depth <count>', '最大深度，1-5')
  .option('--select-paths <patterns>', '只包含匹配这些路径正则的 URL，逗号分隔')
  .option('--exclude-paths <patterns>', '排除匹配这些路径正则的 URL，逗号分隔')
  .option('--select-domains <patterns>', '只包含匹配这些域名正则的 URL，逗号分隔')
  .option('--exclude-domains <patterns>', '排除匹配这些域名正则的 URL，逗号分隔')
  .action(async (url: string, options: { instructions?: string; limit?: string; depth?: string; selectPaths?: string; excludePaths?: string; selectDomains?: string; excludeDomains?: string }) => {
    const config = await loadConfig();
    const logger = new Logger(config);
    const client = new TavilyClient(config, logger);
    try {
      const response = await client.map(url, {
        instructions: options.instructions,
        limit: parseOptionalInt(options.limit),
        maxDepth: parseOptionalInt(options.depth),
        selectPaths: parseListOption(options.selectPaths),
        excludePaths: parseListOption(options.excludePaths),
        selectDomains: parseListOption(options.selectDomains),
        excludeDomains: parseListOption(options.excludeDomains)
      });
      console.log(formatWebMap(response));
    } finally {
      await logger.flush();
    }
  });

webCommand
  .command('crawl')
  .description('使用 Tavily 有限深度爬取站点正文')
  .argument('<url>')
  .option('-i, --instructions <text>', '自然语言筛选指令')
  .option('--limit <count>', '最多处理页面数')
  .option('--depth <count>', '最大深度，1-5')
  .option('--max-chars <count>', '每个页面最多输出字符数', '1200')
  .option('--select-paths <patterns>', '只爬取匹配这些路径正则的 URL，逗号分隔')
  .option('--exclude-paths <patterns>', '排除匹配这些路径正则的 URL，逗号分隔')
  .option('--select-domains <patterns>', '只爬取匹配这些域名正则的 URL，逗号分隔')
  .option('--exclude-domains <patterns>', '排除匹配这些域名正则的 URL，逗号分隔')
  .action(async (url: string, options: { instructions?: string; limit?: string; depth?: string; maxChars: string; selectPaths?: string; excludePaths?: string; selectDomains?: string; excludeDomains?: string }) => {
    const config = await loadConfig();
    const logger = new Logger(config);
    const client = new TavilyClient(config, logger);
    const maxChars = Number.parseInt(options.maxChars, 10);
    try {
      const response = await client.crawl(url, {
        instructions: options.instructions,
        limit: parseOptionalInt(options.limit),
        maxDepth: parseOptionalInt(options.depth),
        selectPaths: parseListOption(options.selectPaths),
        excludePaths: parseListOption(options.excludePaths),
        selectDomains: parseListOption(options.selectDomains),
        excludeDomains: parseListOption(options.excludeDomains)
      });
      console.log(formatWebCrawl(response, Number.isFinite(maxChars) ? maxChars : 1200));
    } finally {
      await logger.flush();
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

function parseOptionalInt(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseListOption(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const items = input.split(',').map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
