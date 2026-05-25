#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import path from 'node:path';
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
import { SkillManager } from './skills/skillManager.js';
import type { Skill, SkillScope } from './types.js';
import { buildSkillInstallPlans, exportSkillPackage, installSkillPlan, validateSkillSources, validateSkillSource, type SkillValidationResult } from './skills/skillPackage.js';

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
      if (response.skillSuggestion) {
        console.error(chalk.yellow(`skill 建议：${response.skillSuggestion.name}，${response.skillSuggestion.reason}`));
        console.error(chalk.gray('单次 ask 不会自动创建 skill；如需沉淀，请在 REPL 中确认，或使用 `neo skill create`。'));
      }
      if (response.skillImprovementSuggestion) {
        console.error(chalk.yellow(`skill 改进建议：${response.skillImprovementSuggestion.skillName}，${response.skillImprovementSuggestion.reason}`));
        console.error(chalk.gray('单次 ask 不会自动修改 skill；如需更新，请在 REPL 中确认。'));
      }
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

const skillCommand = program
  .command('skill')
  .description('管理 skill 生命周期');

skillCommand
  .command('list')
  .description('列出已加载的 skill')
  .option('--scope <user|project>', '只显示某个 scope')
  .option('--json', '输出 JSON')
  .action(async (options: { scope?: string; json?: boolean }) => {
    const config = await loadConfig();
    const scope = parseSkillScope(options.scope);
    const skills = (await new SkillManager(config).loadSkills()).filter(skill => !scope || skill.scope === scope);
    if (options.json) {
      console.log(JSON.stringify(skills.map(toSkillSummary), null, 2));
      return;
    }
    printSkillList(skills);
  });

skillCommand
  .command('show')
  .description('查看 skill 内容')
  .argument('<name>', 'skill 名称')
  .option('--scope <user|project>', '指定 scope')
  .option('--json', '输出 JSON')
  .action(async (name: string, options: { scope?: string; json?: boolean }) => {
    const config = await loadConfig();
    const skill = await new SkillManager(config).getSkill(name, parseSkillScope(options.scope));
    if (!skill) {
      console.log(chalk.yellow(`没有找到 skill：${name}`));
      process.exitCode = 1;
      return;
    }
    if (options.json) console.log(JSON.stringify(toSkillSummary(skill), null, 2));
    else printSkillDetail(skill);
  });

skillCommand
  .command('create')
  .description('创建 skill')
  .argument('<name>', 'skill 名称')
  .argument('[description...]', '描述')
  .option('--scope <user|project>', '安装位置，默认 user', 'user')
  .option('-t, --trigger <trigger>', '触发词，可重复', collectOption, [])
  .action(async (name: string, descriptionParts: string[], options: { scope: string; trigger: string[] }) => {
    const config = await loadConfig();
    const scope = parseSkillScope(options.scope) ?? 'user';
    const description = descriptionParts.join(' ').trim() || 'Manual skill';
    const triggers = options.trigger.length > 0 ? options.trigger : name.split(/[-_\s]+/).filter(Boolean);
    const skill = await new SkillManager(config).createSkill(name, description, triggers, [
      'Confirm the task matches this skill.',
      'Apply the remembered workflow and adapt only where the current request differs.'
    ], { scope });
    console.log(chalk.green(`已创建 skill：${skill.name}`));
    console.log(chalk.gray(`scope=${skill.scope}`));
    console.log(chalk.gray(`${skill.path}/SKILL.md`));
  });

skillCommand
  .command('install')
  .description('从 .md、目录、.zip 或 URL 安装 skill')
  .argument('<source>', 'skill 来源路径或 URL')
  .option('--name <name>', '覆盖 skill 名称')
  .option('--scope <user|project>', '安装位置，默认 user', 'user')
  .option('--overwrite', '覆盖已有 skill')
  .option('--dry-run', '只预览，不写入')
  .action(async (source: string, options: { name?: string; scope: string; overwrite?: boolean; dryRun?: boolean }) => {
    const config = await loadConfig();
    const manager = new SkillManager(config);
    const scope = parseSkillScope(options.scope) ?? 'user';
    const plans = await buildSkillInstallPlans({ source, name: options.name });
    for (const plan of plans) printSkillValidation(plan.validation);
    const results = [];
    for (const plan of plans) {
      results.push(await installSkillPlan({
        plan,
        targetRoot: manager.skillRoot(scope),
        overwrite: options.overwrite,
        dryRun: options.dryRun
      }));
    }
    const action = options.dryRun ? 'skill 安装预览通过' : '已安装 skill';
    for (const result of results) {
      console.log(chalk.green(`${action}：${result.name}`));
      console.log(chalk.gray(`scope=${scope} source=${result.sourceType}`));
      console.log(chalk.gray(result.skillFilePath));
    }
    if (results.length > 1) console.log(chalk.green(`${action}：共 ${results.length} 个 skill`));
  });

skillCommand
  .command('validate')
  .description('校验 skill 来源或已安装 skill')
  .argument('<sourceOrName>', 'skill 路径、URL 或已安装 skill 名称')
  .option('--name <name>', '校验时使用的名称提示')
  .option('--scope <user|project>', '按已安装 skill 查找时指定 scope')
  .action(async (sourceOrName: string, options: { name?: string; scope?: string }) => {
    const config = await loadConfig();
    const manager = new SkillManager(config);
    const installed = await manager.getSkill(sourceOrName, parseSkillScope(options.scope));
    const validations = installed
      ? [await validateSkillSource(installed.filePath, options.name ?? installed.name)]
      : await validateSkillSources(sourceOrName, options.name);
    for (const validation of validations) printSkillValidation(validation);
    if (validations.some(validation => !validation.valid)) process.exitCode = 1;
  });

skillCommand
  .command('export')
  .description('把已安装 skill 打包为 zip')
  .argument('<name>', 'skill 名称')
  .option('--scope <user|project>', '指定 scope')
  .option('-o, --output <path>', '输出 zip 路径')
  .action(async (name: string, options: { scope?: string; output?: string }) => {
    const config = await loadConfig();
    const skill = await new SkillManager(config).getSkill(name, parseSkillScope(options.scope));
    if (!skill) {
      console.log(chalk.yellow(`没有找到 skill：${name}`));
      process.exitCode = 1;
      return;
    }
    const outputPath = path.resolve(options.output ?? `${skill.name}.zip`);
    const result = await exportSkillPackage({ skillDir: skill.path, skillName: skill.name, outputPath });
    console.log(chalk.green(`已导出 skill：${skill.name}`));
    console.log(chalk.gray(`${result.outputPath} files=${result.fileCount} bytes=${result.bytes}`));
  });

skillCommand
  .command('edit')
  .description('用 $VISUAL 或 $EDITOR 编辑 skill')
  .argument('<name>', 'skill 名称')
  .option('--scope <user|project>', '指定 scope')
  .action(async (name: string, options: { scope?: string }) => {
    const config = await loadConfig();
    const filePath = await new SkillManager(config).skillFilePath(name, parseSkillScope(options.scope));
    if (!filePath) {
      console.log(chalk.yellow(`没有找到 skill：${name}`));
      process.exitCode = 1;
      return;
    }
    await openEditorOrPrintPath(filePath);
  });

skillCommand
  .command('delete')
  .alias('remove')
  .description('删除 skill')
  .argument('<name>', 'skill 名称')
  .option('--scope <user|project>', '指定 scope')
  .action(async (name: string, options: { scope?: string }) => {
    const config = await loadConfig();
    const deleted = await new SkillManager(config).deleteSkill(name, parseSkillScope(options.scope));
    if (!deleted) {
      console.log(chalk.yellow(`没有找到 skill：${name}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`已删除 skill：${deleted.name}`));
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

function toSkillSummary(skill: Skill): Pick<Skill, 'name' | 'path' | 'filePath' | 'scope' | 'description' | 'triggers' | 'usage'> {
  return {
    name: skill.name,
    path: skill.path,
    filePath: skill.filePath,
    scope: skill.scope,
    description: skill.description,
    triggers: skill.triggers,
    usage: skill.usage
  };
}

function printSkillList(skills: Skill[]): void {
  if (skills.length === 0) {
    console.log(chalk.gray('没有找到 skill'));
    return;
  }
  for (const skill of skills) {
    const triggers = skill.triggers.length > 0 ? ` 触发词=${skill.triggers.join(',')}` : '';
    const usage = skill.usage ? ` 使用=${skill.usage.usageCount} 最近=${skill.usage.lastUsedAt ?? 'never'}` : '';
    console.log(`${chalk.cyan(skill.name)} - ${skill.description}${chalk.gray(` scope=${skill.scope}${triggers}${usage}`)}`);
    console.log(chalk.gray(`${skill.path}/SKILL.md`));
  }
}

function printSkillDetail(skill: Skill): void {
  console.log(`${chalk.cyan(skill.name)} - ${skill.description}`);
  console.log(chalk.gray(`scope=${skill.scope}`));
  console.log(chalk.gray(`${skill.path}/SKILL.md`));
  if (skill.triggers.length > 0) console.log(chalk.gray(`触发词：${skill.triggers.join(', ')}`));
  if (skill.usage) console.log(chalk.gray(`使用：${skill.usage.usageCount} 次，成功 ${skill.usage.successCount}，失败 ${skill.usage.failureCount}，最近 ${skill.usage.lastUsedAt ?? 'never'}`));
  console.log('');
  console.log(skill.body.trimEnd());
}

function printSkillValidation(validation: SkillValidationResult): void {
  console.log(validation.valid ? chalk.green('skill 校验通过') : chalk.red('skill 校验失败'));
  console.log(`名称：${validation.name}`);
  console.log(`描述：${validation.description || '(空)'}`);
  console.log(`触发词：${validation.triggers.length > 0 ? validation.triggers.join(', ') : '(空)'}`);
  console.log(`大小：${validation.bytes} bytes`);
  for (const warning of validation.warnings) console.log(chalk.yellow(`警告：${warning}`));
  for (const error of validation.errors) console.log(chalk.red(`错误：${error}`));
}

function parseSkillScope(input: string | undefined): SkillScope | undefined {
  if (!input) return undefined;
  if (input === 'user' || input === 'project') return input;
  throw new Error(`无效 scope：${input}，只能是 user 或 project。`);
}

async function openEditorOrPrintPath(filePath: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || !process.stdin.isTTY) {
    console.log(chalk.gray(filePath));
    console.log(chalk.yellow(editor ? '当前不是交互式终端，已输出 skill 文件路径。' : '未设置 VISUAL 或 EDITOR，已输出 skill 文件路径。'));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`编辑器退出码：${code ?? 'unknown'}`));
    });
  });
}
