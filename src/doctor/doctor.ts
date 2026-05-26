import { access, readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../types.js';
import { loadConfig } from '../config.js';
import { pathExists } from '../utils/fs.js';
import { loadSoul } from '../prompts/soul.js';
import { getOpenVikingLocalServiceSetupHint } from '../memory/openVikingMemory.js';

const execFileAsync = promisify(execFile);

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export type DoctorCheck = {
  status: DoctorStatus;
  name: string;
  message: string;
  detail?: string;
  fix?: string;
};

export type DoctorReport = {
  status: DoctorStatus;
  checks: DoctorCheck[];
};

export async function runDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig | undefined;

  checks.push(await checkNodeVersion());
  checks.push(await checkNpm());
  checks.push(await checkNeoCommand());
  checks.push(await checkGit(cwd));

  try {
    config = await loadConfig(cwd);
    checks.push({
      status: 'pass',
      name: '配置加载',
      message: '配置文件可以正常加载。',
      detail: `homeDir=${config.homeDir}`
    });
  } catch (error) {
    checks.push({
      status: 'fail',
      name: '配置加载',
      message: '配置文件加载失败。',
      detail: error instanceof Error ? error.message : String(error),
      fix: '运行 `neo config:init` 重新生成默认配置，或修正 ~/.neo-agent/config.json / neo-agent.config.json。'
    });
  }

  if (config) {
    checks.push(await checkWritableDir(config.homeDir, '数据目录'));
    checks.push(await checkPackageVersion(cwd));
    checks.push(await checkRipgrep());
    checks.push(checkModelConfig('主模型', config.models.main.apiKey, config.models.main.apiBase, config.models.main.model));
    checks.push(checkModelConfig('小模型', config.models.small.apiKey, config.models.small.apiBase, config.models.small.model));
    checks.push(checkModelConfig('视觉模型', config.models.vision.apiKey, config.models.vision.apiBase, config.models.vision.model));
    checks.push(checkContextBudget(config));
    checks.push(await checkWorkspace(config, cwd));
    checks.push(await checkFileScopes(config, cwd));
    checks.push(await checkToolResults(config, cwd));
    checks.push(await checkSkillRoots(config, cwd));
    checks.push(...await checkConfigFilePermissions(config, cwd));
    checks.push(await checkLogPath(config));
    checks.push(await checkTranscriptPath(config));
    checks.push(await checkSoul(cwd));
    checks.push(await checkOpenViking(config));
    checks.push(checkWebConfig(config));
    checks.push(...checkMcpConfig(config));
  }

  checks.push(await checkBuildOutput(cwd));

  return {
    status: summarizeStatus(checks),
    checks
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    'neo doctor 诊断结果',
    `总体状态：${statusLabel(report.status)}`,
    ''
  ];

  for (const check of report.checks) {
    lines.push(`${statusIcon(check.status)} ${check.name}：${check.message}`);
    if (check.detail) lines.push(`  详情：${check.detail}`);
    if (check.fix) lines.push(`  建议：${check.fix}`);
  }

  return lines.join('\n');
}

async function checkNodeVersion(): Promise<DoctorCheck> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return {
      status: 'pass',
      name: 'Node.js',
      message: `版本满足要求：${process.version}`
    };
  }
  return {
    status: 'fail',
    name: 'Node.js',
    message: `版本过低：${process.version}`,
    fix: '升级到 Node.js 20 或更高版本。'
  };
}

async function checkNpm(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('npm', ['--version'], { timeout: 2000 });
    return {
      status: 'pass',
      name: 'npm',
      message: `npm 可用：${stdout.trim()}`
    };
  } catch {
    return {
      status: 'warn',
      name: 'npm',
      message: '没有检测到 npm。',
      fix: '如果需要本地开发、安装依赖或重新 link `neo`，请安装 npm。'
    };
  }
}

async function checkNeoCommand(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('which', ['neo'], { timeout: 2000 });
    return {
      status: 'pass',
      name: 'neo 命令',
      message: 'neo 命令已在 PATH 中。',
      detail: stdout.trim()
    };
  } catch {
    return {
      status: 'warn',
      name: 'neo 命令',
      message: 'PATH 中没有找到 neo。',
      fix: '在项目目录运行 `npm run build && npm link`。'
    };
  }
}

async function checkGit(cwd: string): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], { cwd, timeout: 3000 });
    const status = stdout.trim();
    return {
      status: status.includes('origin/main') ? 'pass' : 'warn',
      name: 'Git 仓库',
      message: '当前目录是 git 仓库。',
      detail: status || '工作区干净'
    };
  } catch {
    return {
      status: 'warn',
      name: 'Git 仓库',
      message: '当前目录不是 git 仓库，或 git 不可用。',
      fix: '如果要同步到 GitHub，请在项目目录初始化 git 并配置 remote。'
    };
  }
}

async function checkWritableDir(dir: string, name: string): Promise<DoctorCheck> {
  try {
    await access(dir, constants.F_OK);
  } catch {
    return {
      status: 'warn',
      name,
      message: '目录还不存在。',
      detail: dir,
      fix: '启动 neo 后会自动创建；如果创建失败，请检查父目录权限。'
    };
  }

  const probe = path.join(dir, `.doctor-write-${Date.now()}`);
  try {
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    return {
      status: 'pass',
      name,
      message: '目录存在且可写。',
      detail: dir
    };
  } catch {
    return {
      status: 'fail',
      name,
      message: '目录不可写。',
      detail: dir,
      fix: '修正目录权限，或通过 NEO_AGENT_HOME 指向可写目录。'
    };
  }
}

async function checkPackageVersion(cwd: string): Promise<DoctorCheck> {
  const packagePath = path.join(cwd, 'package.json');
  try {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: string; version?: string };
    const version = packageJson.version ?? 'unknown';
    const changelog = await pathExists(path.join(cwd, 'CHANGELOG.md'));
    return {
      status: changelog ? 'pass' : 'warn',
      name: '版本信息',
      message: `当前包版本：${packageJson.name ?? 'neo-agent'}@${version}`,
      detail: `package=${packagePath}, changelog=${changelog ? 'present' : 'missing'}`,
      fix: changelog ? undefined : '补充 CHANGELOG.md，便于发布和回滚时追踪版本差异。'
    };
  } catch (error) {
    return {
      status: 'warn',
      name: '版本信息',
      message: '无法读取 package.json。',
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkRipgrep(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('rg', ['--version'], { timeout: 2000 });
    return {
      status: 'pass',
      name: 'ripgrep',
      message: `rg 可用：${stdout.split('\n')[0]?.trim() ?? 'unknown'}`
    };
  } catch {
    return {
      status: 'warn',
      name: 'ripgrep',
      message: '没有检测到 rg。',
      fix: '安装 ripgrep；Grep/代码搜索会优先依赖 rg，缺失时会降低检索能力。'
    };
  }
}

function checkContextBudget(config: AppConfig): DoctorCheck {
  const thresholdChars = Math.floor(config.conversation.maxHistoryChars * config.conversation.compactThresholdRatio);
  const detail = [
    `maxHistoryChars=${config.conversation.maxHistoryChars}`,
    `maxMessageChars=${config.conversation.maxMessageChars}`,
    `compact=${config.conversation.compactEnabled ? `enabled@${config.conversation.compactThresholdRatio}` : 'disabled'}`,
    `compactKeepRecentChars=${config.conversation.compactKeepRecentChars}`,
    `compactMaxSummaryChars=${config.conversation.compactMaxSummaryChars}`
  ].join(', ');

  if (!config.conversation.compactEnabled) {
    return {
      status: 'warn',
      name: '上下文预算',
      message: '自动压缩已关闭，长会话更容易超过上下文预算。',
      detail,
      fix: '保持 conversation.compactEnabled=true，或缩小 maxHistoryChars。'
    };
  }
  if (config.conversation.maxMessageChars >= config.conversation.maxHistoryChars) {
    return {
      status: 'warn',
      name: '上下文预算',
      message: '单条消息预算接近或超过历史总预算。',
      detail,
      fix: '让 maxMessageChars 明显小于 maxHistoryChars，避免单条工具结果挤占完整历史。'
    };
  }
  if (config.conversation.compactKeepRecentChars >= thresholdChars) {
    return {
      status: 'warn',
      name: '上下文预算',
      message: '压缩保留窗口不小于触发阈值，压缩后可能难以降载。',
      detail,
      fix: '降低 compactKeepRecentChars，或提高 maxHistoryChars。'
    };
  }
  return {
    status: 'pass',
    name: '上下文预算',
    message: '历史、单条消息和压缩预算配置合理。',
    detail
  };
}

async function checkWorkspace(config: AppConfig, cwd: string): Promise<DoctorCheck> {
  const dir = resolveProjectPath(cwd, config.workspace.dir);
  const result = await checkWritableDir(dir, 'Workspace');
  return {
    ...result,
    detail: [result.detail, `configured=${config.workspace.dir}`].filter(Boolean).join(', ')
  };
}

async function checkFileScopes(config: AppConfig, cwd: string): Promise<DoctorCheck> {
  const readResults = await Promise.all(config.files.additionalReadDirs.map(dir => checkPathAccess(resolveProjectPath(cwd, dir), constants.R_OK)));
  const writeResults = await Promise.all(config.files.additionalWriteDirs.map(dir => checkPathAccess(resolveProjectPath(cwd, dir), constants.W_OK)));
  const readBad = readResults.filter(result => !result.ok);
  const writeBad = writeResults.filter(result => !result.ok);
  const detail = [
    `readDirs=${config.files.additionalReadDirs.length}`,
    `writeDirs=${config.files.additionalWriteDirs.length}`,
    readBad.length ? `readUnavailable=${readBad.map(result => result.path).join('|')}` : undefined,
    writeBad.length ? `writeUnavailable=${writeBad.map(result => result.path).join('|')}` : undefined
  ].filter(Boolean).join(', ');

  if (writeBad.length > 0) {
    return {
      status: 'fail',
      name: '文件权限范围',
      message: '部分额外写入目录不可写。',
      detail,
      fix: '修正目录权限，或从 files.additionalWriteDirs 移除不可写路径。'
    };
  }
  if (readBad.length > 0) {
    return {
      status: 'warn',
      name: '文件权限范围',
      message: '部分额外读取目录不可读。',
      detail,
      fix: '修正目录权限，或从 files.additionalReadDirs 移除不可读路径。'
    };
  }
  return {
    status: 'pass',
    name: '文件权限范围',
    message: '额外读写目录配置可用。',
    detail
  };
}

async function checkToolResults(config: AppConfig, cwd: string): Promise<DoctorCheck> {
  const dir = resolveProjectPath(cwd, config.toolResults.dir);
  const detail = [
    `enabled=${config.toolResults.enabled}`,
    `dir=${dir}`,
    `maxInlineChars=${config.toolResults.maxInlineChars}`,
    `previewChars=${config.toolResults.previewChars}`
  ].join(', ');
  if (!config.toolResults.enabled) {
    return {
      status: 'warn',
      name: 'Tool results',
      message: '工具结果落盘预算已关闭，超大工具输出会直接进入上下文。',
      detail,
      fix: '保持 toolResults.enabled=true，并为 maxInlineChars 设置明确上限。'
    };
  }
  if (config.toolResults.previewChars >= config.toolResults.maxInlineChars) {
    return {
      status: 'warn',
      name: 'Tool results',
      message: '预览字符数不小于内联预算，落盘后仍可能占用过多上下文。',
      detail,
      fix: '让 previewChars 明显小于 maxInlineChars。'
    };
  }
  const result = await checkWritableDir(dir, 'Tool results 目录');
  return {
    ...result,
    detail
  };
}

async function checkSkillRoots(config: AppConfig, cwd: string): Promise<DoctorCheck> {
  const userRoot = path.join(config.homeDir, 'skills');
  const projectRoot = path.join(cwd, '.neo-agent', 'skills');
  const [user, project] = await Promise.all([countSkills(userRoot), countSkills(projectRoot)]);
  const errors = [user.error, project.error].filter(Boolean);
  return {
    status: errors.length > 0 ? 'warn' : 'pass',
    name: 'Skills',
    message: errors.length > 0 ? '部分 skill 根目录无法扫描。' : 'skill 根目录可以扫描。',
    detail: [
      `user=${userRoot}:${user.exists ? user.count : 'missing'}`,
      `project=${projectRoot}:${project.exists ? project.count : 'missing'}`,
      `autoCreate=${config.skills.autoCreate ? `enabled@${config.skills.autoCreateThreshold}` : 'disabled'}`,
      errors.length ? `errors=${errors.join('|')}` : undefined
    ].filter(Boolean).join(', '),
    fix: errors.length > 0 ? '检查对应目录权限，或删除损坏的 skill 目录。' : undefined
  };
}

async function checkConfigFilePermissions(config: AppConfig, cwd: string): Promise<DoctorCheck[]> {
  const paths = [
    path.join(config.homeDir, 'config.json'),
    path.join(cwd, 'neo-agent.config.json'),
    path.join(cwd, '.mcp.json')
  ];
  const present: string[] = [];
  const broadSecrets: string[] = [];
  const unreadable: string[] = [];

  for (const filePath of paths) {
    if (!(await pathExists(filePath))) continue;
    present.push(filePath);
    try {
      const [fileStat, content] = await Promise.all([stat(filePath), readFile(filePath, 'utf8')]);
      const containsSecret = /apiKey|accessToken|_KEY|token/i.test(content);
      if (containsSecret && process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
        broadSecrets.push(`${filePath}:${(fileStat.mode & 0o777).toString(8)}`);
      }
    } catch (error) {
      unreadable.push(`${filePath}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (unreadable.length > 0) {
    return [{
      status: 'warn',
      name: '配置文件权限',
      message: '部分配置文件无法读取权限或内容。',
      detail: unreadable.join(', ')
    }];
  }
  if (broadSecrets.length > 0) {
    return [{
      status: 'warn',
      name: '配置文件权限',
      message: '包含密钥字段的配置文件可被同组或其他用户读取。',
      detail: broadSecrets.join(', '),
      fix: '在类 Unix 系统上执行 `chmod 600 <config-file>`。'
    }];
  }
  return [{
    status: 'pass',
    name: '配置文件权限',
    message: '已检查配置文件权限。',
    detail: present.length > 0 ? present.join(', ') : '没有发现本地配置文件'
  }];
}

function checkModelConfig(name: string, apiKey: string | undefined, apiBase: string, model: string): DoctorCheck {
  if (!apiKey) {
    return {
      status: 'fail',
      name,
      message: '缺少 API key。',
      detail: `model=${model}, apiBase=${apiBase}`,
      fix: name === '视觉模型' ? '设置 MIMO_API_KEY，或写入 ~/.neo-agent/config.json。' : '设置 DEEPSEEK_API_KEY，或写入 ~/.neo-agent/config.json。'
    };
  }
  if (!/^https?:\/\//.test(apiBase)) {
    return {
      status: 'fail',
      name,
      message: 'apiBase 不是有效 URL。',
      detail: `model=${model}, apiBase=${apiBase}`,
      fix: '把 apiBase 改成 http:// 或 https:// 开头的地址。'
    };
  }
  return {
    status: 'pass',
    name,
    message: '模型配置存在。',
    detail: `model=${model}, apiBase=${apiBase}, apiKey=${maskSecret(apiKey)}`
  };
}

async function checkLogPath(config: AppConfig): Promise<DoctorCheck> {
  const filePath = path.isAbsolute(config.logging.file) ? config.logging.file : path.join(config.homeDir, config.logging.file);
  const result = await checkWritableDir(path.dirname(filePath), '日志目录');
  return {
    ...result,
    detail: [
      result.detail,
      `file=${filePath}`,
      `maxBytes=${config.logging.maxBytes}`,
      `retentionDays=${config.logging.retentionDays}`,
      `maxFiles=${config.logging.maxFiles}`
    ].filter(Boolean).join(', ')
  };
}

async function checkTranscriptPath(config: AppConfig): Promise<DoctorCheck> {
  if (!config.transcripts.enabled) {
    return {
      status: 'warn',
      name: 'Transcript',
      message: 'Transcript 持久化已关闭。',
      fix: '如需会话回顾，设置 NEO_AGENT_TRANSCRIPTS_ENABLED=1。'
    };
  }
  const dir = path.isAbsolute(config.transcripts.dir) ? config.transcripts.dir : path.join(config.homeDir, config.transcripts.dir);
  return checkWritableDir(dir, 'Transcript 目录');
}

async function checkSoul(cwd: string): Promise<DoctorCheck> {
  const soul = await loadSoul(cwd);
  if (!soul.trim()) {
    return {
      status: 'warn',
      name: 'SOUL.md',
      message: '没有加载到 SOUL.md。',
      fix: '确认项目根目录存在 SOUL.md，或重新安装包含 SOUL.md 的构建产物。'
    };
  }
  return {
    status: soul.includes('你叫 neo') ? 'pass' : 'warn',
    name: 'SOUL.md',
    message: 'SOUL.md 可以加载。',
    detail: `字符数=${soul.length}`
  };
}

async function checkOpenViking(config: AppConfig): Promise<DoctorCheck> {
  if (config.memory.backend === 'local') {
    return {
      status: 'pass',
      name: 'OpenViking',
      message: '当前使用 local 记忆后端，不需要 OpenViking。'
    };
  }

  try {
    const healthUrl = new URL('/health', config.memory.openVikingUrl);
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    const mcpResponse = response.ok ? await probeOpenVikingMcp(config.memory.openVikingUrl).catch(() => undefined) : undefined;
    if (response.ok && mcpResponse?.ok) {
      return {
        status: 'pass',
        name: 'OpenViking',
        message: 'OpenViking 本地服务和 /mcp 可访问。',
        detail: `${healthUrl.toString()} -> ${response.status}, /mcp health -> ok`
      };
    }
    return {
      status: 'warn',
      name: 'OpenViking',
      message: response.ok ? 'OpenViking /health 可访问，但 /mcp health 不可用。' : 'OpenViking /health 有响应，但状态不是 2xx。',
      detail: `${healthUrl.toString()} -> ${response.status}${mcpResponse ? `, /mcp -> ${mcpResponse.status}` : ''}`,
      fix: response.ok ? '确认 openviking-server 版本包含同进程 /mcp 端点，并按官方文档检查 openviking-server doctor。' : getOpenVikingLocalServiceSetupHint(config.memory.openVikingUrl)
    };
  } catch {
    return {
      status: 'warn',
      name: 'OpenViking',
      message: 'OpenViking 本地服务当前不可访问，将回退到本地记忆。',
      detail: config.memory.openVikingUrl,
      fix: getOpenVikingLocalServiceSetupHint(config.memory.openVikingUrl)
    };
  }
}

async function probeOpenVikingMcp(url: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(new URL('/mcp', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'neo-doctor',
      method: 'tools/call',
      params: { name: 'health', arguments: {} }
    }),
    signal: AbortSignal.timeout(1500)
  });
  if (!response.ok) return { ok: false, status: response.status };
  const payload = await response.json() as { error?: unknown };
  return { ok: !payload.error, status: response.status };
}

function checkWebConfig(config: AppConfig): DoctorCheck {
  if (!config.web.apiKey) {
    return {
      status: 'warn',
      name: '联网搜索',
      message: '未配置 Tavily API key，web search/extract 暂不可用。',
      detail: `provider=${config.web.provider}, apiBase=${config.web.apiBase}`,
      fix: '设置 TAVILY_API_KEY，或写入 ~/.neo-agent/config.json 的 web.apiKey。'
    };
  }
  if (!/^https?:\/\//.test(config.web.apiBase)) {
    return {
      status: 'fail',
      name: '联网搜索',
      message: 'Tavily apiBase 不是有效 URL。',
      detail: config.web.apiBase,
      fix: '把 web.apiBase 改成 http:// 或 https:// 开头的地址。'
    };
  }
  return {
    status: 'pass',
    name: '联网搜索',
    message: 'Tavily 配置存在。',
    detail: `apiBase=${config.web.apiBase}, apiKey=${maskSecret(config.web.apiKey)}, maxResults=${config.web.maxResults}, toolLoop=${config.web.toolLoopEnabled ? `enabled:${config.web.maxToolRounds}` : 'disabled'}, planner=${config.web.plannerEnabled ? config.web.plannerModelKind : 'disabled'}, allowedDomains=${config.web.allowedDomains.length}, blockedDomains=${config.web.blockedDomains.length}, selectPaths=${config.web.selectPaths.length}, excludePaths=${config.web.excludePaths.length}, blockPrivate=${config.web.blockPrivateAddresses}`
  };
}

function checkMcpConfig(config: AppConfig): DoctorCheck[] {
  const entries = Object.entries(config.mcp.servers);
  const permissionDetail = formatMcpPermissionDetail(config);
  if (entries.length === 0) {
    return [{
      status: 'pass',
      name: 'MCP',
      message: '没有配置 MCP server。',
      detail: permissionDetail
    }];
  }

  return entries.map(([name, server]) => {
    if (server.disabled) {
      return {
        status: 'warn',
        name: `MCP：${name}`,
        message: '该 MCP server 已禁用。',
        detail: permissionDetail
      };
    }
    if (!server.command) {
      return {
        status: 'fail',
        name: `MCP：${name}`,
        message: '缺少 command。',
        fix: '在配置中为该 MCP server 填写 command。'
      };
    }
    return {
      status: 'pass',
      name: `MCP：${name}`,
      message: '配置格式看起来正常。',
      detail: `${[server.command, ...(server.args ?? [])].join(' ')}; ${permissionDetail}`
    };
  });
}

function formatMcpPermissionDetail(config: AppConfig): string {
  return [
    `permissionMode=${config.mcp.permissions.mode}`,
    `allowedTools=${config.mcp.permissions.allowedTools.length}`,
    `deniedTools=${config.mcp.permissions.deniedTools.length}`
  ].join(', ');
}

async function checkBuildOutput(cwd: string): Promise<DoctorCheck> {
  const distIndex = path.join(cwd, 'dist', 'index.js');
  if (await pathExists(distIndex)) {
    const fileStat = await stat(distIndex);
    return {
      status: 'pass',
      name: '构建产物',
      message: 'dist/index.js 存在。',
      detail: `mtime=${fileStat.mtime.toISOString()}`
    };
  }
  return {
    status: 'warn',
    name: '构建产物',
    message: '没有找到 dist/index.js。',
    fix: '运行 `npm run build`。'
  };
}

function summarizeStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail';
  if (checks.some(check => check.status === 'warn')) return 'warn';
  return 'pass';
}

function statusIcon(status: DoctorStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '!';
  return 'x';
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return '通过';
  if (status === 'warn') return '有警告';
  return '失败';
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '[已隐藏]';
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

function resolveProjectPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

async function checkPathAccess(filePath: string, mode: number): Promise<{ ok: boolean; path: string }> {
  try {
    await access(filePath, mode);
    return { ok: true, path: filePath };
  } catch {
    return { ok: false, path: filePath };
  }
}

async function countSkills(root: string): Promise<{ exists: boolean; count: number; error?: string }> {
  if (!(await pathExists(root))) return { exists: false, count: 0 };
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await pathExists(path.join(root, entry.name, 'SKILL.md'))) count += 1;
    }
    return { exists: true, count };
  } catch (error) {
    return {
      exists: true,
      count: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
