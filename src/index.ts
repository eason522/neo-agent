#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { initConfigFile, loadConfig } from './config.js';
import { setConfigValue, showConfig } from './configCommands.js';
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
  parseHeaderPairs,
  removeConfiguredMcpServer,
  testConfiguredMcpServers,
  updateMcpToolPermission
} from './mcp/mcpConfigCommands.js';
import { createAbortError, isAbortError } from './utils/abort.js';
import { SkillManager } from './skills/skillManager.js';
import type { Skill, SkillScope } from './types.js';
import { buildSkillInstallPlans, exportSkillPackage, installSkillPlan, validateSkillSources, validateSkillSource, type SkillValidationResult } from './skills/skillPackage.js';
import type { DreamReport, DreamReportSummary } from './dream/dreamService.js';
import { formatUsageSummary, UsageTracker } from './usage/usageTracker.js';
import { formatMarketplaceEntries, MarketplaceService } from './marketplace/marketplace.js';
import { formatSelfCheckReport, runInstallSelfCheck } from './release/selfCheck.js';

const program = new Command();

program
  .name('neo-agent')
  .description('个人终端 AI agent')
  .version('0.1.0')
  .option('--resume [session]', '启动对话时从最近或指定 transcript 恢复上下文')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [command]', '显示命令帮助');

program
  .command('config:init')
  .description('创建 ~/.neo-agent/config.json')
  .action(async () => {
    const filePath = await initConfigFile();
    console.log(filePath);
  });

const configCommand = program
  .command('config')
  .description('查看和修改 neo-agent 配置');

configCommand
  .command('show')
  .description('显示配置，默认脱敏输出')
  .option('--source <merged|user|project>', '配置来源，默认 merged', 'merged')
  .option('--show-secrets', '显示未脱敏配置，请谨慎使用')
  .action(async (options: { source: string; showSecrets?: boolean }) => {
    const source = parseConfigSource(options.source);
    const result = await showConfig({
      source,
      redacted: !options.showSecrets
    });
    if (result.path) console.error(chalk.gray(`${result.source}: ${result.path}`));
    else console.error(chalk.gray('source=merged'));
    console.log(JSON.stringify(result.config, null, 2));
  });

configCommand
  .command('set')
  .description('设置用户或项目配置，例如 neo config set web.maxToolRounds 8')
  .argument('<keyPath>', '点号分隔的配置路径')
  .argument('<value>', '配置值，支持 true/false/数字/JSON 数组或对象/字符串')
  .option('--scope <user|project>', '写入位置，默认 user', 'user')
  .action(async (keyPath: string, value: string, options: { scope: string }) => {
    const scope = parseConfigScope(options.scope);
    const result = await setConfigValue({ keyPath, rawValue: value, scope });
    console.log(chalk.green(`已更新配置：${result.keyPath}`));
    console.log(chalk.gray(`scope=${result.scope}`));
    console.log(chalk.gray(result.path));
  });

program
  .command('ask')
  .description('单次提问并输出答案')
  .argument('<prompt...>')
  .option('--no-web', '本次提问不自动联网搜索')
  .option('--stream', '流式输出模型文本')
  .action(async (promptParts: string[], options: { web?: boolean; stream?: boolean }) => {
    const config = await loadConfig();
    if (options.web === false) config.web.autoSearch = false;
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    const controller = new AbortController();
    const onSigint = (): void => controller.abort(createAbortError());
    process.once('SIGINT', onSigint);
    try {
      const { text, attachments } = extractImageAttachments(promptParts.join(' '));
      let streamed = false;
      const response = await agent.ask(text, attachments, {
        signal: controller.signal,
        onContentDelta: options.stream ? delta => {
          streamed = true;
          process.stdout.write(delta);
        } : undefined
      });
      if (streamed) process.stdout.write('\n');
      else console.log(response.text);
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
      const title = session.title ? `  ${session.title}` : '';
      console.log(`${session.updatedAt}  ${session.sessionId}  ${session.sizeBytes}B${title}`);
      console.log(chalk.gray(session.path));
    }
  });

program
  .command('usage')
  .description('查看模型 token 和成本统计')
  .option('-d, --days <days>', '只统计最近 N 天')
  .option('--json', '输出 JSON')
  .action(async (options: { days?: string; json?: boolean }) => {
    const config = await loadConfig();
    const usage = new UsageTracker(config);
    const days = Number.parseInt(options.days ?? '', 10);
    const summary = await usage.summarize({ days: Number.isFinite(days) ? days : undefined });
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(formatUsageSummary(summary));
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
  .command('self-check')
  .description('运行发布/安装自检')
  .action(async () => {
    const report = await runInstallSelfCheck(await loadConfig());
    console.log(formatSelfCheckReport(report));
    process.exitCode = report.status === 'fail' ? 1 : 0;
  });

program
  .command('capabilities')
  .alias('caps')
  .description('显示 neo 当前运行时能力快照')
  .option('--json', '输出 JSON')
  .action(async (options: { json?: boolean }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const snapshot = await agent.capabilitySnapshot();
      console.log(options.json ? JSON.stringify(snapshot, null, 2) : await agent.formatCapabilities());
    } finally {
      await agent.close();
    }
  });

program
  .command('assess')
  .description('评估一个任务在当前运行时能力下是否可完成')
  .argument('<task...>', '需要评估的任务')
  .option('--json', '输出 JSON')
  .action(async (taskParts: string[], options: { json?: boolean }) => {
    const task = taskParts.join(' ').trim();
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const assessment = await agent.assessTask(task);
      console.log(options.json ? JSON.stringify(assessment, null, 2) : await agent.formatTaskAssessment(task));
      process.exitCode = assessment.feasibility === 'blocked' ? 2 : 0;
    } finally {
      await agent.close();
    }
  });

program
  .command('hooks')
  .description('查看 hook 预留状态；当前只记录内部事件，不执行外部 hook')
  .action(async () => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      console.log('hooks: PostToolUse, PermissionRequest, Stop, Notification');
      console.log('status: reserved-only, external execution disabled');
      const events = agent.hooks.listRecent();
      if (events.length === 0) console.log(chalk.gray('当前进程暂无 hook 事件。'));
      for (const event of events) console.log(`${event.ts} ${event.event} ${event.name}`);
    } finally {
      await agent.close();
    }
  });

const dreamCommand = program
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

dreamCommand
  .command('list')
  .description('列出 dream 报告')
  .option('-n, --limit <count>', '报告数量', '10')
  .action(async (options: { limit: string }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const limit = Number.parseInt(options.limit, 10);
      const reports = await agent.dreams.listReports(Number.isFinite(limit) ? limit : 10);
      if (reports.length === 0) {
        console.log(chalk.gray('没有找到 dream 报告。'));
        return;
      }
      for (const report of reports) {
        const status = report.appliedAt ? `已采纳 ${report.appliedAt}` : (report.dryRun ? '待采纳' : '已执行');
        console.log(`${report.ts}  ${report.id}  ${status}`);
        console.log(`摘要：${report.summary}`);
        console.log(chalk.gray(`${report.path} upserts=${report.upserts} archives=${report.archives} insights=${report.insights}`));
      }
    } finally {
      await agent.close();
    }
  });

dreamCommand
  .command('show')
  .description('回放 dream 报告')
  .argument('[report]', '报告路径、id 或文件名；不填为最新报告')
  .action(async (reportSelector?: string) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const result = await agent.dreams.showReport(reportSelector);
      if (!result) {
        console.log(chalk.yellow('没有找到 dream 报告。'));
        process.exitCode = 1;
        return;
      }
      console.log(formatDreamReport(result));
    } finally {
      await agent.close();
    }
  });

dreamCommand
  .command('apply')
  .description('人工采纳 dry-run dream 报告，把建议写入记忆')
  .argument('[report]', '报告路径、id 或文件名；不填为最新报告')
  .action(async (reportSelector?: string) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const result = await agent.dreams.applyReport(reportSelector);
      if (result.status === 'skipped') {
        console.log(chalk.yellow(`dream 采纳跳过：${result.reason}`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green('dream 报告已采纳'));
      console.log(`摘要：${result.summary}`);
      console.log(`写入记忆：${result.upserts.length}，归档记忆：${result.archives.length}`);
      if (result.reportPath) console.log(chalk.gray(result.reportPath));
    } finally {
      await agent.close();
    }
  });

dreamCommand
  .command('review')
  .description('复查本地记忆，提示重复、过期或低价值记录')
  .option('-n, --limit <count>', '最多检查的记忆数量')
  .action(async (options: { limit?: string }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const limit = Number.parseInt(options.limit ?? '', 10);
      const review = await agent.dreams.reviewMemories(Number.isFinite(limit) ? limit : undefined);
      console.log(`已复查记忆：${review.checkedMemories}`);
      if (review.issues.length === 0) {
        console.log(chalk.green('没有发现明显问题。'));
        return;
      }
      for (const issue of review.issues) {
        const color = issue.severity === 'warn' ? chalk.yellow : chalk.gray;
        console.log(color(`${issue.type}: ${issue.message}`));
        console.log(chalk.gray(issue.memoryIds.join(', ')));
      }
    } finally {
      await agent.close();
    }
  });

const skillCommand = program
  .command('skill')
  .description('管理 skill 生命周期');

const marketplaceCommand = program
  .command('marketplace')
  .description('轻量 skill/plugin marketplace 规划入口');

marketplaceCommand
  .command('init')
  .description('创建本地 marketplace 索引文件')
  .option('--force', '覆盖已有索引')
  .action(async (options: { force?: boolean }) => {
    const service = new MarketplaceService(await loadConfig());
    const result = await service.init(options.force ?? false);
    console.log(result.created ? chalk.green('已创建 marketplace 索引') : chalk.gray('marketplace 索引已存在'));
    console.log(chalk.gray(result.path));
  });

marketplaceCommand
  .command('list')
  .description('列出本地 marketplace skill 条目')
  .action(async () => {
    const service = new MarketplaceService(await loadConfig());
    console.log(chalk.gray(service.indexPath));
    console.log(formatMarketplaceEntries(await service.list()));
  });

marketplaceCommand
  .command('show')
  .description('查看 marketplace 条目')
  .argument('<name>')
  .action(async (name: string) => {
    const service = new MarketplaceService(await loadConfig());
    const entry = await service.show(name);
    if (!entry) {
      console.log(chalk.yellow(`没有找到 marketplace 条目：${name}`));
      process.exitCode = 1;
      return;
    }
    console.log(formatMarketplaceEntries([entry]));
  });

marketplaceCommand
  .command('install')
  .description('从本地 marketplace 条目安装 skill；plugin source 会复用 skillsPath/skillsPaths 导入')
  .argument('<name>')
  .option('--scope <user|project>', '安装位置，默认 user', 'user')
  .option('--overwrite', '覆盖已有 skill')
  .action(async (name: string, options: { scope: string; overwrite?: boolean }) => {
    const config = await loadConfig();
    const scope = parseSkillScope(options.scope) ?? 'user';
    const service = new MarketplaceService(config);
    const result = await service.installSkill(name, { scope, overwrite: options.overwrite });
    console.log(chalk.green(`marketplace 安装完成：${name}`));
    console.log(chalk.gray(`source=${result.source} scope=${scope}`));
    console.log(`installed=${result.installed.join(', ') || '(无)'}`);
    if (result.skipped.length > 0) console.log(chalk.yellow(`skipped=${result.skipped.join(', ')}`));
  });

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
    const skipped = [];
    for (const plan of plans) {
      const existing = !options.overwrite ? await manager.getSkill(plan.name, scope) : undefined;
      if (existing) {
        skipped.push(existing);
        continue;
      }
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
    for (const skill of skipped) {
      console.log(chalk.yellow(`已跳过已存在 skill：${skill.name}`));
      console.log(chalk.gray(`scope=${scope}`));
      console.log(chalk.gray(skill.filePath));
    }
    if (results.length > 1) console.log(chalk.green(`${action}：共 ${results.length} 个 skill`));
    if (skipped.length > 0) console.log(chalk.yellow(`已跳过：共 ${skipped.length} 个已存在 skill`));
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

const agentCommand = program
  .command('agent')
  .description('管理可恢复 sub-agent 任务');

agentCommand
  .command('run')
  .description('启动一个 sub-agent 任务')
  .argument('<task...>')
  .option('--background', '后台运行，稍后用 neo agent show 查看')
  .action(async (taskParts: string[], options: { background?: boolean }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const task = taskParts.join(' ');
      const record = await agent.subAgent.startTask(task, { background: options.background ?? false });
      console.log(chalk.green(`sub-agent task ${record.id} ${options.background ? '已后台启动' : '已完成'}`));
      const latest = await agent.subAgent.getTask(record.id) ?? record;
      console.log(formatSubAgentTask(latest, !options.background));
    } finally {
      await agent.close();
    }
  });

agentCommand
  .command('list')
  .description('列出 sub-agent 任务')
  .option('-n, --limit <count>', '显示数量', '20')
  .action(async (options: { limit: string }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const limit = Number.parseInt(options.limit, 10);
      const tasks = await agent.subAgent.listTasks(Number.isFinite(limit) ? limit : 20);
      if (tasks.length === 0) console.log(chalk.gray('没有 sub-agent 任务。'));
      for (const task of tasks) console.log(formatSubAgentTask(task, false));
    } finally {
      await agent.close();
    }
  });

agentCommand
  .command('show')
  .description('查看 sub-agent 任务')
  .argument('<id>')
  .action(async (id: string) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const task = await agent.subAgent.getTask(id);
      if (!task) {
        console.log(chalk.yellow(`没有找到 sub-agent 任务：${id}`));
        process.exitCode = 1;
        return;
      }
      console.log(formatSubAgentTask(task, true));
    } finally {
      await agent.close();
    }
  });

agentCommand
  .command('stop')
  .description('停止当前进程内仍在运行的 sub-agent 任务；已退出进程的任务会标记为 cancelled')
  .argument('<id>')
  .action(async (id: string) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ scheduledDreams: false });
    try {
      const task = await agent.subAgent.stopTask(id);
      if (!task) {
        console.log(chalk.yellow(`没有找到 sub-agent 任务：${id}`));
        process.exitCode = 1;
        return;
      }
      console.log(formatSubAgentTask(task, false));
    } finally {
      await agent.close();
    }
  });

mcpCommand
  .command('list')
  .description('列出已配置的 MCP server')
  .option('--scope <user|project|all>', '配置来源，默认 all', 'all')
  .option('--json', '输出 JSON')
  .action(async (options: { scope: string; json?: boolean }) => {
    const scope = parseMcpConfigScope(options.scope);
    const { filePath, entries } = await listConfiguredMcpServers({ scope });
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
  .description('添加 MCP server，支持 stdio/http/sse')
  .argument('<name>', 'server 名称')
  .argument('[target]', 'stdio 启动命令，或 http/sse URL')
  .argument('[args...]', '启动参数')
  .allowUnknownOption(true)
  .option('--type <stdio|http|sse>', 'server 类型', 'stdio')
  .option('-e, --env <pair>', '环境变量 KEY=VALUE，可重复', collectOption, [])
  .option('-H, --header <pair>', 'HTTP/SSE header KEY=VALUE，可重复', collectOption, [])
  .option('--oauth-token-env <name>', '从环境变量读取 OAuth Bearer token')
  .option('--disabled', '添加后先禁用')
  .option('--scope <user|project>', '写入位置，默认 user', 'user')
  .action(async (name: string, target: string | undefined, args: string[], options: { type: string; env: string[]; header: string[]; oauthTokenEnv?: string; disabled?: boolean; scope: string }) => {
    const type = parseMcpServerType(options.type);
    const scope = parseMcpConfigScope(options.scope) ?? 'user';
    const result = await addConfiguredMcpServer({
      name,
      scope,
      type,
      command: type === 'stdio' ? target : undefined,
      args: type === 'stdio' ? args : [],
      url: type === 'stdio' ? undefined : target,
      env: parseEnvPairs(options.env),
      headers: parseHeaderPairs(options.header),
      oauthTokenEnv: options.oauthTokenEnv,
      disabled: options.disabled
    });
    console.log(chalk.green(`已添加 MCP server：${name}`));
    console.log(chalk.gray(result.filePath));
    console.log(formatMcpServerEntry({ name, server: result.server, scope }));
  });

mcpCommand
  .command('remove')
  .description('删除 MCP server 配置')
  .argument('<name>', 'server 名称')
  .option('--scope <user|project>', '删除位置，默认 user', 'user')
  .action(async (name: string, options: { scope: string }) => {
    const scope = parseMcpConfigScope(options.scope) ?? 'user';
    const result = await removeConfiguredMcpServer(name, { scope });
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

mcpCommand
  .command('permission')
  .description('持久化 MCP 工具权限规则')
  .argument('<allow|deny|remove>', '权限动作')
  .argument('<tool>', '工具名，例如 mcp__github__create_issue、github.create_issue 或 mcp__github__*')
  .action(async (action: string, tool: string) => {
    if (action !== 'allow' && action !== 'deny' && action !== 'remove') throw new Error('权限动作只能是 allow、deny 或 remove。');
    const result = await updateMcpToolPermission({
      tool,
      behavior: action === 'deny' ? 'deny' : 'allow',
      remove: action === 'remove'
    });
    const verb = action === 'remove' ? '已移除 MCP 权限规则' : action === 'allow' ? '已持久允许 MCP 工具' : '已持久拒绝 MCP 工具';
    console.log(chalk.green(`${verb}：${tool}`));
    console.log(chalk.gray(result.filePath));
    console.log(chalk.gray(`allowed=${result.allowedTools.length} denied=${result.deniedTools.length}`));
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
  .option('--resume [session]', '从最近或指定 transcript 恢复上下文')
  .action(async (options: { resume?: string | boolean }) => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ resumeSessionId: normalizeResumeOption(options.resume ?? program.opts<{ resume?: string | boolean }>().resume) });
    await startRepl(agent);
  });

program
  .action(async () => {
    const config = await loadConfig();
    const agent = new NeoAgent(config);
    await agent.initialize({ resumeSessionId: normalizeResumeOption(program.opts<{ resume?: string | boolean }>().resume) });
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

function normalizeResumeOption(input: string | boolean | undefined): string | undefined {
  if (input === true) return 'latest';
  if (typeof input === 'string' && input.trim()) return input.trim();
  return undefined;
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

function formatSubAgentTask(task: {
  id: string;
  status: string;
  mode: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  transcriptPath: string;
  toolIsolation: string;
  output?: string;
  error?: string;
}, includeOutput: boolean): string {
  return [
    `${chalk.cyan(task.id)}  ${task.status}  ${task.mode}`,
    `任务：${task.task}`,
    chalk.gray(`model=${task.model} isolation=${task.toolIsolation} created=${task.createdAt} updated=${task.updatedAt}`),
    chalk.gray(task.transcriptPath),
    includeOutput && task.output ? `\n${task.output.trimEnd()}` : '',
    includeOutput && task.error ? chalk.red(`\n${task.error}`) : ''
  ].filter(Boolean).join('\n');
}

function formatDreamReport(input: DreamReportSummary & { report: DreamReport }): string {
  const lines = [
    `${chalk.cyan(input.id)}  ${input.ts}`,
    chalk.gray(input.path),
    `状态：${input.appliedAt ? `已采纳 ${input.appliedAt}` : (input.dryRun ? '待采纳' : '已执行')}`,
    `摘要：${input.summary}`,
    '',
    '新增/更新建议：'
  ];
  if (input.report.plan.upserts.length === 0) lines.push(chalk.gray('(无)'));
  for (const item of input.report.plan.upserts) {
    lines.push(`- [${item.category}] ${item.content}`);
    if (item.reason) lines.push(chalk.gray(`  原因：${item.reason}`));
  }
  lines.push('', '归档建议：');
  if (input.report.plan.archives.length === 0) lines.push(chalk.gray('(无)'));
  for (const item of input.report.plan.archives) {
    lines.push(`- ${item.id}`);
    if (item.reason) lines.push(chalk.gray(`  原因：${item.reason}`));
  }
  lines.push('', '灵感：');
  if (input.report.plan.insights.length === 0) lines.push(chalk.gray('(无)'));
  for (const item of input.report.plan.insights) lines.push(`- ${item}`);
  return lines.join('\n');
}

function parseSkillScope(input: string | undefined): SkillScope | undefined {
  if (!input) return undefined;
  if (input === 'user' || input === 'project') return input;
  throw new Error(`无效 scope：${input}，只能是 user 或 project。`);
}

function parseConfigScope(input: string): 'user' | 'project' {
  if (input === 'user' || input === 'project') return input;
  throw new Error(`无效 scope：${input}，只能是 user 或 project。`);
}

function parseConfigSource(input: string): 'merged' | 'user' | 'project' {
  if (input === 'merged' || input === 'user' || input === 'project') return input;
  throw new Error(`无效 source：${input}，只能是 merged、user 或 project。`);
}

function parseMcpServerType(input: string): 'stdio' | 'http' | 'sse' {
  if (input === 'stdio' || input === 'http' || input === 'sse') return input;
  throw new Error(`无效 MCP server 类型：${input}，只能是 stdio、http 或 sse。`);
}

function parseMcpConfigScope(input: string | undefined): 'user' | 'project' | undefined {
  if (!input || input === 'all') return undefined;
  if (input === 'user' || input === 'project') return input;
  throw new Error(`无效 MCP scope：${input}，只能是 user、project 或 all。`);
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
