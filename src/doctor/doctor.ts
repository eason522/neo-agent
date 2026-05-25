import { access, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../types.js';
import { loadConfig } from '../config.js';
import { pathExists } from '../utils/fs.js';
import { loadSoul } from '../prompts/soul.js';

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
    checks.push(checkModelConfig('主模型', config.models.main.apiKey, config.models.main.apiBase, config.models.main.model));
    checks.push(checkModelConfig('小模型', config.models.small.apiKey, config.models.small.apiBase, config.models.small.model));
    checks.push(checkModelConfig('视觉模型', config.models.vision.apiKey, config.models.vision.apiBase, config.models.vision.model));
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
    const response = await fetch(config.memory.openVikingUrl, { signal: AbortSignal.timeout(1500) });
    return {
      status: response.ok ? 'pass' : 'warn',
      name: 'OpenViking',
      message: response.ok ? 'OpenViking 服务可访问。' : 'OpenViking 地址有响应，但状态不是 2xx。',
      detail: `${config.memory.openVikingUrl} -> ${response.status}`
    };
  } catch {
    return {
      status: 'warn',
      name: 'OpenViking',
      message: 'OpenViking 服务当前不可访问，将回退到本地记忆。',
      detail: config.memory.openVikingUrl,
      fix: '如果需要 OpenViking 检索，请启动 OpenViking 服务，或把 NEO_AGENT_MEMORY_BACKEND 设置为 local。'
    };
  }
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
    detail: `apiBase=${config.web.apiBase}, apiKey=${maskSecret(config.web.apiKey)}, maxResults=${config.web.maxResults}, toolLoop=${config.web.toolLoopEnabled ? `enabled:${config.web.maxToolRounds}` : 'disabled'}, planner=${config.web.plannerEnabled ? config.web.plannerModelKind : 'disabled'}, allowedDomains=${config.web.allowedDomains.length}, blockedDomains=${config.web.blockedDomains.length}, blockPrivate=${config.web.blockPrivateAddresses}`
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
