#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const node = process.execPath;
const cli = path.join(root, 'dist', 'index.js');
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-smoke-'));

const tests = [];

test('显示版本号', async () => {
  const result = await run(['--version']);
  assertIncludes(result.stdout, '0.1.0');
});

test('显示帮助', async () => {
  const result = await run(['--help']);
  assertIncludes(result.stdout, '个人终端 AI agent');
  assertIncludes(result.stdout, 'doctor');
  assertIncludes(result.stdout, 'dream');
  assertIncludes(result.stdout, 'web');
  assertIncludes(result.stdout, 'transcripts');
});

test('初始化配置', async () => {
  const result = await run(['config:init']);
  assertIncludes(result.stdout, path.join(tempHome, 'config.json'));
  const config = await readFile(path.join(tempHome, 'config.json'), 'utf8');
  assertIncludes(config, 'deepseek-v4-pro');
  assertIncludes(config, 'mimo-v2.5');
  assertIncludes(config, '"dreaming"');
  assertIncludes(config, '"conversation"');
  assertIncludes(config, '"web"');
  assertIncludes(config, 'https://api.tavily.com');
  assertIncludes(config, '"maxDepth"');
  assertIncludes(config, '"autoSearch"');
  assertIncludes(config, '"toolLoopEnabled"');
  assertIncludes(config, '"maxToolRounds"');
  assertIncludes(config, '"plannerEnabled"');
  assertIncludes(config, '"plannerModelKind"');
  assertIncludes(config, '"allowedDomains"');
  assertIncludes(config, '"blockedDomains"');
  assertIncludes(config, '"blockPrivateAddresses"');
  assertIncludes(config, '"permissions"');
  assertIncludes(config, '"mode": "readOnly"');
});

test('联网工具定义符合 tool loop 入口', async () => {
  const { createWebToolDefinitions } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'webTools.js')).href);
  const tools = createWebToolDefinitions();
  const names = tools.map(tool => tool.function.name).join(',');
  assertIncludes(names, 'WebSearch');
  assertIncludes(names, 'WebFetch');
  for (const tool of tools) {
    if (tool.type !== 'function') throw new Error(`联网工具必须是 function 类型：${JSON.stringify(tool)}`);
    if (!tool.function.parameters?.properties) throw new Error(`联网工具缺少 JSON schema：${tool.function.name}`);
  }
});

test('联网 URL 策略阻止私有地址并支持域名规则', async () => {
  const { buildSearchDomainPolicy, normalizeAndValidateWebUrl } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'urlPolicy.js')).href);
  const policy = {
    allowedDomains: ['example.com'],
    blockedDomains: ['blocked.example.com'],
    blockPrivateAddresses: true
  };
  const safeUrl = normalizeAndValidateWebUrl('http://docs.example.com/path', policy, 'test');
  assertIncludes(safeUrl, 'https://docs.example.com/path');
  assertThrows(() => normalizeAndValidateWebUrl('http://127.0.0.1:8080', policy, 'test'), '内网');
  assertThrows(() => normalizeAndValidateWebUrl('https://blocked.example.com', policy, 'test'), 'blockedDomains');
  assertThrows(() => normalizeAndValidateWebUrl('https://other.com', policy, 'test'), 'allowedDomains');

  const domainPolicy = buildSearchDomainPolicy(policy, ['docs.example.com'], ['news.example.com']);
  assertIncludes(domainPolicy.allowedDomains.join(','), 'docs.example.com');
  assertIncludes(domainPolicy.blockedDomains.join(','), 'blocked.example.com');
  assertIncludes(domainPolicy.blockedDomains.join(','), 'news.example.com');
});

test('MCP 工具命名沿用 CC-Source 风格', async () => {
  const { buildMcpToolName } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpManager.js')).href);
  const name = buildMcpToolName('github server', 'create issue');
  assertIncludes(name, 'mcp__github_server__create_issue');
});

test('MCP 权限默认只允许只读工具', async () => {
  const { evaluateMcpToolPermission } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpToolRunner.js')).href);
  const permissions = { mode: 'readOnly', allowedTools: [], deniedTools: [] };
  const readOnly = evaluateMcpToolPermission({
    fullName: 'mcp__github__list_issues',
    serverName: 'github',
    toolName: 'list_issues',
    readOnlyHint: true,
    destructiveHint: false
  }, permissions);
  if (!readOnly.allowed) throw new Error(`只读 MCP 工具应该默认允许：${JSON.stringify(readOnly)}`);

  const write = evaluateMcpToolPermission({
    fullName: 'mcp__github__create_issue',
    serverName: 'github',
    toolName: 'create_issue',
    readOnlyHint: false,
    destructiveHint: false
  }, permissions);
  if (write.allowed) throw new Error(`非只读 MCP 工具不应该默认允许：${JSON.stringify(write)}`);

  const explicit = evaluateMcpToolPermission({
    fullName: 'mcp__github__create_issue',
    serverName: 'github',
    toolName: 'create_issue',
    readOnlyHint: false,
    destructiveHint: false
  }, { mode: 'readOnly', allowedTools: ['mcp__github__create_issue'], deniedTools: [] });
  if (!explicit.allowed) throw new Error(`显式允许的 MCP 工具应该能执行：${JSON.stringify(explicit)}`);

  const denied = evaluateMcpToolPermission({
    fullName: 'mcp__github__delete_repo',
    serverName: 'github',
    toolName: 'delete_repo',
    readOnlyHint: true,
    destructiveHint: true
  }, { mode: 'allowAll', allowedTools: [], deniedTools: ['mcp__github__delete_*'] });
  if (denied.allowed) throw new Error(`deniedTools 应该优先于 allowAll：${JSON.stringify(denied)}`);
});

test('自动联网规划能识别时效问题和追问', async () => {
  const { planWebUse } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'webPlanner.js')).href);
  const visitPlan = planWebUse('普京何时来我国访问呢？结束访问了吗？', true);
  if (!visitPlan.shouldUseWeb) {
    throw new Error(`政治人物访问问题应该触发联网。实际：${JSON.stringify(visitPlan)}`);
  }
  const followUpPlan = planWebUse('你可以联网搜索一下吧', true, '普京何时来我国访问呢？结束访问了吗？');
  assertIncludes(followUpPlan.query ?? '', '普京');
  assertIncludes(followUpPlan.reason, '上一轮问题');
});

test('doctor 缺 key 时失败并给出建议', async () => {
  const result = await run(['doctor'], { expectCode: 1 });
  assertIncludes(result.stdout, 'neo doctor 诊断结果');
  assertIncludes(result.stdout, '缺少 API key');
  assertIncludes(result.stdout, '设置 DEEPSEEK_API_KEY');
});

test('REPL 常用命令不触发模型也能运行', async () => {
  const result = await run([], {
    input: [
      '/help',
      '/remember --type workflow --tag cli --pin 我喜欢简洁直接的回答',
      '/memory --type workflow 简洁',
      '/memory-export 5',
      '/logs 5',
      '/transcript 20',
      '/transcripts 5',
      '/exit',
      ''
    ].join('\n')
  });
  assertIncludes(result.stdout, '/help                 查看命令');
  assertIncludes(result.stdout, '已记住');
  assertIncludes(result.stdout, '置顶 workflow');
  assertIncludes(result.stdout, '我喜欢简洁直接的回答');
  assertIncludes(result.stdout, '"category": "workflow"');
  assertIncludes(result.stdout, 'transcripts');
});

test('transcripts 命令能列出会话', async () => {
  const result = await run(['transcripts', '--limit', '5']);
  assertIncludes(result.stdout, 'session_');
});

try {
  for (const item of tests) {
    await item.fn();
    console.log(`✓ ${item.name}`);
  }
  console.log(`\n全部 smoke tests 通过。临时目录：${tempHome}`);
} catch (error) {
  console.error(`\nsmoke test 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.exitCode !== 1) {
    await rm(tempHome, { recursive: true, force: true });
  }
}

function test(name, fn) {
  tests.push({ name, fn });
}

async function run(args, options = {}) {
  const env = {
    ...process.env,
    NEO_AGENT_HOME: tempHome,
    DEEPSEEK_API_KEY: '',
    MIMO_API_KEY: '',
    TAVILY_API_KEY: '',
    NEO_AGENT_LOG_MAX_BYTES: '2048',
    NEO_AGENT_LOG_MAX_FILES: '3',
    NEO_AGENT_LOG_RETENTION_DAYS: '14'
  };

  const result = await new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`命令超时：node ${cli} ${args.join(' ')}`));
    }, options.timeout ?? 10000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });

  if (typeof options.expectCode === 'number') {
    if (result.code !== options.expectCode) {
      throw new Error(`期望退出码 ${options.expectCode}，实际为 ${result.code}。\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }
    return result;
  }
  if (result.code !== 0) {
    throw new Error(`命令退出码 ${result.code}。\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function assertIncludes(haystack, needle) {
  if (!haystack.includes(needle)) {
    throw new Error(`输出中没有找到 ${JSON.stringify(needle)}。\n实际输出：\n${haystack}`);
  }
}

function assertThrows(fn, expectedMessage) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertIncludes(message, expectedMessage);
    return;
  }
  throw new Error(`期望抛出包含 ${JSON.stringify(expectedMessage)} 的错误，但函数正常返回。`);
}
