#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
  assertIncludes(result.stdout, 'transcripts');
});

test('初始化配置', async () => {
  const result = await run(['config:init']);
  assertIncludes(result.stdout, path.join(tempHome, 'config.json'));
  const config = await readFile(path.join(tempHome, 'config.json'), 'utf8');
  assertIncludes(config, 'deepseek-v4-pro');
  assertIncludes(config, 'mimo-v2.5');
  assertIncludes(config, '"dreaming"');
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
