#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assertIncludes(result.stdout, 'usage');
  assertIncludes(result.stdout, 'capabilities');
  assertIncludes(result.stdout, 'assess');
  assertIncludes(result.stdout, 'web');
  assertIncludes(result.stdout, 'mcp');
  assertIncludes(result.stdout, 'skill');
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
  assertIncludes(config, '"compactEnabled"');
  assertIncludes(config, '"compactThresholdRatio"');
  assertIncludes(config, '"compactKeepRecentChars"');
  assertIncludes(config, '"compactMaxSummaryChars"');
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
  assertIncludes(config, '"selectPaths"');
  assertIncludes(config, '"excludePaths"');
  assertIncludes(config, '"selectDomains"');
  assertIncludes(config, '"excludeDomains"');
  assertIncludes(config, '"permissions"');
  assertIncludes(config, '"toolSearchThreshold"');
  assertIncludes(config, '"mode": "readOnly"');
  assertIncludes(config, '"requestTimeoutMs"');
  assertIncludes(config, '"maxRetries"');
  assertIncludes(config, '"retryBaseDelayMs"');
  assertIncludes(config, '"usage"');
  assertIncludes(config, '"prices"');
});

test('图片附件解析会校验本地文件并推断 mime', async () => {
  const { extractImageAttachments } = await import(pathToFileURL(path.join(root, 'dist', 'input', 'attachments.js')));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-attachments-'));
  const jpegPath = path.join(projectDir, 'photo.png');
  const fakeImagePath = path.join(projectDir, 'fake.png');
  const hugeImagePath = path.join(projectDir, 'huge.png');

  await writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]));
  await writeFile(fakeImagePath, 'not an image', 'utf8');
  await writeFile(hugeImagePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4 * 1024 * 1024)
  ]));

  const previousCwd = process.cwd();
  process.chdir(projectDir);
  try {
    const local = extractImageAttachments('请看 @photo.png 并说明');
    if (local.attachments.length !== 1) throw new Error('应解析出一个本地图片附件');
    if (local.attachments[0].mimeType !== 'image/jpeg') throw new Error(`应根据文件头推断 jpeg，实际 ${local.attachments[0].mimeType}`);
    assertIncludes(local.text, '请看');

    const remote = extractImageAttachments('读取 @https://example.com/a.webp?token=secret');
    if (remote.attachments[0].mimeType !== 'image/webp') throw new Error(`URL mime 推断错误：${remote.attachments[0].mimeType}`);

    assertThrows(() => extractImageAttachments('坏图 @fake.png'), '文件不是支持的图片格式');
    assertThrows(() => extractImageAttachments('缺图 @missing.png'), '图片文件不存在');
    assertThrows(() => extractImageAttachments('大图 @huge.png'), '图片文件过大');
  } finally {
    process.chdir(previousCwd);
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('config show/set 支持脱敏、scope 和 schema 校验', async () => {
  await run(['config:init']);
  const setKey = await run(['config', 'set', 'models.main.apiKey', 'test-secret-123456']);
  assertIncludes(setKey.stdout, '已更新配置：models.main.apiKey');
  assertIncludes(setKey.stdout, 'scope=user');

  const redacted = await run(['config', 'show']);
  assertIncludes(redacted.stdout, '"apiKey": "test…3456"');
  if (redacted.stdout.includes('test-secret-123456')) throw new Error('config show 默认不应泄露完整 apiKey');

  const raw = await run(['config', 'show', '--show-secrets']);
  assertIncludes(raw.stdout, 'test-secret-123456');

  const projectDir = path.join(tempHome, 'config-project');
  await mkdir(projectDir, { recursive: true });
  const setProject = await run(['config', 'set', 'web.maxToolRounds', '9', '--scope', 'project'], { cwd: projectDir });
  assertIncludes(setProject.stdout, 'scope=project');
  const projectConfig = await readFile(path.join(projectDir, 'neo-agent.config.json'), 'utf8');
  assertIncludes(projectConfig, '"maxToolRounds": 9');

  const invalid = await run(['config', 'set', 'web.maxToolRounds', '0', '--scope', 'project'], { cwd: projectDir, expectCode: 1 });
  assertIncludes(invalid.stderr, 'Invalid neo-agent config');
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

test('模型客户端会对 5xx 重试并记录 usage', async () => {
  const { OpenAICompatibleClient } = await import(pathToFileURL(path.join(root, 'dist', 'models', 'openaiCompatibleClient.js')).href);
  const originalFetch = globalThis.fetch;
  const events = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('temporary failure', { status: 500, statusText: 'Server Error' });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: 'retry ok' }
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 3,
        total_tokens: 14
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const logger = {
      debug() {},
      diagnostic(name, event, metadata) { events.push({ level: name, name: event, metadata }); },
      info(name, metadata) { events.push({ level: 'info', name, metadata }); },
      warn(name, metadata) { events.push({ level: 'warn', name, metadata }); },
      error(name, error, metadata) { events.push({ level: 'error', name, error, metadata }); }
    };
    const client = new OpenAICompatibleClient({
      model: 'test-model',
      apiKey: 'test-key',
      apiBase: 'https://example.com/v1',
      temperature: 0,
      maxTokens: 128,
      requestTimeoutMs: 1000,
      maxRetries: 1,
      retryBaseDelayMs: 1
    }, logger);
    const result = await client.chatWithTools({ messages: [{ role: 'user', content: 'hi' }] });
    assertIncludes(result.content, 'retry ok');
    if (calls !== 2) throw new Error(`应该重试一次：${calls}`);
    if (result.usage?.totalTokens !== 14) throw new Error(`应该解析 usage：${JSON.stringify(result.usage)}`);
    if (!events.some(event => event.name === 'model.request.retry')) throw new Error(`应该记录重试日志：${JSON.stringify(events)}`);
    const retry = events.find(event => event.name === 'model.request.retry');
    if (retry?.metadata?.errorCode !== 'HTTP_500' || retry.metadata.maxAttempts !== 2) throw new Error(`重试日志应该记录结构化错误码：${JSON.stringify(retry)}`);
    const success = events.find(event => event.name === 'model.request.success');
    if (success?.metadata?.totalTokens !== 14) throw new Error(`成功日志应该记录 token usage：${JSON.stringify(success)}`);
    if (success?.metadata?.retryCount !== 1) throw new Error(`成功日志应该记录 retryCount：${JSON.stringify(success)}`);
    if (!events.some(event => event.name === 'model.request.metrics' && event.metadata?.retryCount === 1)) {
      throw new Error(`应该记录 No-PII 诊断指标：${JSON.stringify(events)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('模型客户端支持流式文本和 tool call delta', async () => {
  const { OpenAICompatibleClient } = await import(pathToFileURL(path.join(root, 'dist', 'models', 'openaiCompatibleClient.js')).href);
  const originalFetch = globalThis.fetch;
  const deltas = [];
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const encoder = new TextEncoder();
    const chunks = [
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'Web', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Search', arguments: '"neo"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const client = new OpenAICompatibleClient({
      model: 'test-model',
      apiKey: 'test-key',
      apiBase: 'https://example.com/v1',
      temperature: 0,
      maxTokens: 128,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1
    }, { debug() {}, info() {}, warn() {}, error() {} });
    const result = await client.chatWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      stream: { onContentDelta: delta => deltas.push(delta) }
    });
    if (requestBody.stream !== true) throw new Error(`stream 请求体缺少 stream=true：${JSON.stringify(requestBody)}`);
    assertIncludes(deltas.join(''), 'hello world');
    assertIncludes(result.content, 'hello world');
    if (result.toolCalls[0]?.function.name !== 'WebSearch') throw new Error(`streaming tool name 拼接失败：${JSON.stringify(result.toolCalls)}`);
    assertIncludes(result.toolCalls[0].function.arguments, '"neo"');
    if (result.usage?.totalTokens !== 5) throw new Error(`stream usage 解析失败：${JSON.stringify(result.usage)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsageTracker 会落盘 token 并按配置估算成本', async () => {
  const { UsageTracker, formatUsageSummary } = await import(pathToFileURL(path.join(root, 'dist', 'usage', 'usageTracker.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const usageHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-usage-'));
  const config = defaultConfig();
  config.homeDir = usageHome;
  config.usage.file = 'usage/model-usage.jsonl';
  config.usage.prices = {
    'priced-model': { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' }
  };
  const usage = new UsageTracker(config);
  usage.record({
    modelKind: 'main',
    model: 'priced-model',
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    durationMs: 20,
    attempt: 1,
    retryCount: 0
  });
  usage.record({
    modelKind: 'small',
    model: 'unpriced-model',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15
  });
  await usage.flush();
  const summary = await usage.summarize();
  if (summary.calls !== 2 || summary.totalTokens !== 1515) throw new Error(`usage 汇总错误：${JSON.stringify(summary)}`);
  const priced = summary.models.find(model => model.model === 'priced-model');
  if (!priced || priced.estimatedCost <= 0 || priced.unpricedCalls !== 0) throw new Error(`priced model 成本错误：${JSON.stringify(priced)}`);
  const report = formatUsageSummary(summary);
  assertIncludes(report, 'priced-model');
  assertIncludes(report, 'unpriced-model');
  assertIncludes(report, '未配置单价');
  await rm(usageHome, { recursive: true, force: true });
});

test('模型客户端不会重试 4xx 参数错误', async () => {
  const { OpenAICompatibleClient } = await import(pathToFileURL(path.join(root, 'dist', 'models', 'openaiCompatibleClient.js')).href);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('bad request', { status: 400, statusText: 'Bad Request' });
  };
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = new OpenAICompatibleClient({
      model: 'test-model',
      apiKey: 'test-key',
      apiBase: 'https://example.com/v1',
      temperature: 0,
      maxTokens: 128,
      requestTimeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 1
    }, logger);
    await assertRejects(() => client.chatWithTools({ messages: [{ role: 'user', content: 'hi' }] }), '400');
    if (calls !== 1) throw new Error(`4xx 不应该重试：${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('联网 URL 策略阻止私有地址并支持域名规则', async () => {
  const { buildSearchDomainPolicy, evaluateHostnamePermission, normalizeAndValidateWebUrl } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'urlPolicy.js')).href);
  const policy = {
    allowedDomains: ['example.com'],
    blockedDomains: ['blocked.example.com'],
    blockPrivateAddresses: true
  };
  const webDecision = evaluateHostnamePermission('docs.example.com', policy, 'test');
  if (webDecision.behavior !== 'allow' || webDecision.domain !== 'web') throw new Error(`Web 权限判定应允许 docs.example.com：${JSON.stringify(webDecision)}`);
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

test('统一权限核心覆盖文件、MCP 和 Web 判定', async () => {
  const {
    evaluateFileWritePermission,
    evaluateMcpPermission,
    evaluateWebHostnamePermission,
    matchPermissionRule
  } = await import(pathToFileURL(path.join(root, 'dist', 'permissions', 'permissions.js')).href);

  const workspace = evaluateFileWritePermission({
    toolName: 'Write',
    path: 'workspace/a.txt',
    operation: 'create',
    permissionRequired: false,
    interactive: false
  });
  if (workspace.behavior !== 'allow' || workspace.code !== 'workspace_allowed') throw new Error(`workspace 写入应允许：${JSON.stringify(workspace)}`);

  const nonInteractive = evaluateFileWritePermission({
    toolName: 'Write',
    path: 'src/a.ts',
    operation: 'overwrite',
    permissionRequired: true,
    interactive: false
  });
  if (nonInteractive.behavior !== 'deny' || nonInteractive.code !== 'needs_interactive_permission') {
    throw new Error(`非交互写入应拒绝：${JSON.stringify(nonInteractive)}`);
  }

  const mcpDenied = evaluateMcpPermission({
    fullName: 'mcp__github__delete_repo',
    qualifiedName: 'github.delete_repo',
    readOnlyHint: true,
    destructiveHint: true,
    mode: 'allowAll',
    allowedTools: [],
    deniedTools: ['mcp__github__delete_*']
  });
  if (mcpDenied.behavior !== 'deny' || mcpDenied.code !== 'explicit_denied') throw new Error(`MCP deny rule 应优先：${JSON.stringify(mcpDenied)}`);

  const webBlocked = evaluateWebHostnamePermission({
    hostname: '127.0.0.1',
    operation: 'test',
    blockedByPrivateAddress: true,
    blockedByDomainRule: false,
    constrainedByAllowedDomains: false,
    allowedByDomainRule: false
  });
  if (webBlocked.behavior !== 'deny' || webBlocked.code !== 'private_address_blocked') throw new Error(`Web 私有地址应拒绝：${JSON.stringify(webBlocked)}`);

  const matched = matchPermissionRule(['mcp__github__create_issue', 'github.create_issue'], ['github.create_*']);
  if (matched !== 'github.create_*') throw new Error(`通配权限规则匹配失败：${matched}`);
});

test('TavilyClient 支持缓存、来源去重、失败分类和冲突提示', async () => {
  const { TavilyClient, TavilyRequestError } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'tavilyClient.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const config = defaultConfig();
  config.web.apiKey = 'test-key';
  config.web.apiBase = 'https://api.tavily.test';
  config.web.timeoutMs = 1000;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.query?.includes('rate limit')) {
      return new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' });
    }
    if (Array.isArray(body.urls)) {
      return new Response(JSON.stringify({
        results: [
          { url: 'https://docs.example.com/a#top', raw_content: 'page a' },
          { url: 'https://docs.example.com/a', raw_content: 'page a duplicate' }
        ],
        failed_results: [
          { url: 'https://docs.example.com/private', error: '403 forbidden' }
        ],
        response_time: 0.2
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      answer: '2024 年访问，2025 年另有报道，2026 年需要核实。',
      results: [
        { title: 'A', url: 'https://news.example.com/a#section', content: '2024-05-16 访问' },
        { title: 'A duplicate', url: 'https://news.example.com/a', content: 'duplicate' },
        { title: 'B', url: 'https://news.example.com/b', content: '2025-09-03 新闻' },
        { title: 'C', url: 'https://news.example.com/c', content: '2026-05-25 更新' }
      ],
      response_time: 0.1
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new TavilyClient(config);
    const first = await client.search('neo web cache conflict');
    if (first.results.length !== 3) throw new Error(`搜索结果应按 URL 去重：${JSON.stringify(first.results)}`);
    if (!first.warnings?.some(warning => warning.includes('多个日期'))) throw new Error(`搜索应提示日期冲突：${JSON.stringify(first.warnings)}`);
    const second = await client.search('neo web cache conflict');
    if (!second.cacheHit) throw new Error(`第二次相同搜索应命中缓存：${JSON.stringify(second)}`);
    if (calls !== 1) throw new Error(`缓存命中后不应重复请求 Tavily：${calls}`);

    const extract = await client.extract(['https://docs.example.com/a#top', 'https://docs.example.com/a']);
    if (extract.results.length !== 1) throw new Error(`extract URL 应去重：${JSON.stringify(extract.results)}`);
    if (extract.failedResults[0]?.category !== 'auth') throw new Error(`extract 失败应分类为 auth：${JSON.stringify(extract.failedResults)}`);
    if (!extract.warnings?.length) throw new Error(`部分读取失败应给出提示：${JSON.stringify(extract)}`);

    await assertRejects(async () => {
      try {
        await client.search('rate limit');
      } catch (error) {
        if (!(error instanceof TavilyRequestError) || error.category !== 'rate_limit') {
          throw new Error(`429 应分类为 rate_limit：${String(error)}`);
        }
        throw error;
      }
    }, 'rate_limit');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TavilyClient 会遵守 robots.txt 拒绝规则', async () => {
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const { TavilyClient } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'tavilyClient.js')).href);
  const config = defaultConfig();
  config.web.apiKey = 'test-key';
  config.web.apiBase = 'https://api.tavily.test';
  config.web.timeoutMs = 1000;
  const originalFetch = globalThis.fetch;
  let tavilyCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://blocked.example.com/robots.txt') {
      return new Response('User-agent: *\nDisallow: /private\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    tavilyCalls += init?.body ? 1 : 0;
    return new Response(JSON.stringify({ results: [], failed_results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new TavilyClient(config);
    await assertRejects(() => client.extract(['https://blocked.example.com/private/page']), 'robots.txt');
    if (tavilyCalls !== 0) throw new Error(`robots 拒绝后不应请求 Tavily API：${tavilyCalls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TavilyClient 会按下载正文预算截断 extract 内容', async () => {
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const { TavilyClient } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'tavilyClient.js')).href);
  const config = defaultConfig();
  config.web.apiKey = 'test-key';
  config.web.apiBase = 'https://api.tavily.test';
  config.web.timeoutMs = 1000;
  config.web.maxDownloadChars = 40;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (init?.body) {
      return new Response(JSON.stringify({
        results: [{ url: 'https://budget.example.com/long', raw_content: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' }],
        failed_results: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };
  try {
    const client = new TavilyClient(config);
    const response = await client.extract(['https://budget.example.com/long']);
    if (response.results[0]?.content.length > 40 || !response.results[0]?.content.includes('[已截断]')) {
      throw new Error(`extract 内容应受 maxDownloadChars 预算保护：${JSON.stringify(response.results)}`);
    }
    if (!response.warnings?.some(warning => warning.includes('web.maxDownloadChars=40'))) {
      throw new Error(`extract 截断应写入 warning：${JSON.stringify(response.warnings)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Logger 脱敏覆盖密钥、URL query、MCP 参数和错误栈', async () => {
  const { Logger, errorCodeFor, redact, serializeError } = await import(pathToFileURL(path.join(root, 'dist', 'logging', 'logger.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const logHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-log-redaction-'));
  const fakeSk = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');
  const fakeTp = ['tp', 'abcdefghijklmnopqrstuvwxyz'].join('-');
  const fakeTavily = ['tvly', 'dev', 'abcdefghijklmnopqrstuvwxyz'].join('-');
  const rawArguments = JSON.stringify({
    title: 'issue-secret-title',
    body: 'issue-secret-body'
  });

  const redacted = redact({
    raw: [
      fakeSk,
      fakeTp,
      fakeTavily,
      'Bearer abc.def.ghi',
      'https://docs.example.com/path?token=url-secret&x=1#frag',
      'data:image/png;base64,QUJDREVGRw=='
    ].join(' '),
    apiKey: 'field-secret-api-key',
    mcp: {
      arguments: rawArguments,
      params: {
        issue: 'params-secret-issue',
        labels: ['bug']
      }
    }
  });
  const payload = JSON.stringify(redacted);
  for (const leaked of [
    'abcdefghijklmnopqrstuvwxyz',
    'abc.def.ghi',
    'token=url-secret',
    'field-secret-api-key',
    'issue-secret-title',
    'issue-secret-body',
    'params-secret-issue',
    'QUJDREVGRw=='
  ]) {
    if (payload.includes(leaked)) throw new Error(`Logger redact 泄露敏感内容：${leaked} in ${payload}`);
  }
  assertIncludes(payload, 'https://docs.example.com/path?[REDACTED]#frag');
  assertIncludes(payload, 'sk-[REDACTED]');
  assertIncludes(payload, 'tp-[REDACTED]');
  assertIncludes(payload, 'tvly-[REDACTED]');
  assertIncludes(payload, 'Bearer [REDACTED]');
  assertIncludes(payload, 'data:image/[REDACTED];base64,[REDACTED]');
  if (redacted.mcp.arguments.redacted !== true) throw new Error(`MCP arguments 应被摘要化：${payload}`);
  if (redacted.mcp.arguments.chars !== rawArguments.length) throw new Error(`MCP arguments chars 错误：${payload}`);
  assertIncludes(redacted.mcp.arguments.keys.join(','), 'body');
  assertIncludes(redacted.mcp.arguments.keys.join(','), 'title');
  if (redacted.mcp.params.redacted !== true) throw new Error(`MCP params 应被摘要化：${payload}`);
  assertIncludes(redacted.mcp.params.keys.join(','), 'issue');
  assertIncludes(redacted.mcp.params.keys.join(','), 'labels');

  const serializedError = serializeError(new Error(`failed https://api.example.com/a?api_key=error-secret ${fakeSk}`));
  const serializedPayload = JSON.stringify(serializedError);
  if (serializedPayload.includes('api_key=error-secret') || serializedPayload.includes('abcdefghijklmnopqrstuvwxyz')) {
    throw new Error(`serializeError 泄露敏感内容：${serializedPayload}`);
  }
  const statusError = new Error('server failed');
  statusError.status = 503;
  if (errorCodeFor(statusError, 'model.request') !== 'HTTP_503') throw new Error(`errorCodeFor 应识别 HTTP status：${errorCodeFor(statusError, 'model.request')}`);

  const config = defaultConfig();
  config.homeDir = logHome;
  config.logging.file = 'logs/redaction.log';
  config.logging.level = 'info';
  config.logging.console = false;
  const logger = new Logger(config);
  if (logger.isDebugEnabled()) throw new Error('默认 info 级别不应开启 debug');
  const wasDebug = logger.enableDebug();
  if (wasDebug || !logger.isDebugEnabled()) throw new Error('enableDebug 应在运行期打开 debug 级别');
  logger.info('redaction.test', {
    url: 'https://logs.example.com/a?token=log-secret',
    arguments: rawArguments,
    apiKey: 'field-secret-api-key'
  });
  logger.debug('redaction.debug', { visible: true });
  logger.error('redaction.error', new Error('boom Bearer abc.def.ghi'), {
    params: {
      content: 'log-param-secret'
    }
  });
  logger.diagnostic('info', 'diagnostic.no_pii', {
    prompt: 'diagnostic prompt secret',
    filePath: '/tmp/diagnostic-secret-path',
    durationMs: 42,
    retryCount: 1,
    nested: { query: 'diagnostic query secret', ok: true }
  });
  await logger.flush();
  const tail = await logger.tail(10);
  for (const leaked of ['token=log-secret', 'issue-secret-title', 'field-secret-api-key', 'abc.def.ghi', 'log-param-secret', 'diagnostic prompt secret', 'diagnostic-secret-path', 'diagnostic query secret']) {
    if (tail.includes(leaked)) throw new Error(`日志文件泄露敏感内容：${leaked} in ${tail}`);
  }
  assertIncludes(tail, 'redaction.test');
  assertIncludes(tail, 'redaction.debug');
  assertIncludes(tail, '"privacy":"redacted"');
  assertIncludes(tail, '"privacy":"diagnostic"');
  assertIncludes(tail, '"errorCode":"REDACTION_ERROR"');
  assertIncludes(tail, '[REDACTED_NO_PII]');
  assertIncludes(tail, '[REDACTED]');
  await rm(logHome, { recursive: true, force: true });
});

test('LocalMemory 搜索排序优先强相关并过滤归档记忆', async () => {
  const { LocalMemory } = await import(pathToFileURL(path.join(root, 'dist', 'memory', 'localMemory.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const memoryHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-memory-ranking-'));
  const config = defaultConfig();
  config.homeDir = memoryHome;
  config.memory.maxHits = 5;
  const now = Date.now();
  const isoDaysAgo = days => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const record = (id, content, options = {}) => ({
    id,
    uri: `viking://user/memories/2026-05-25/${id}`,
    category: options.category ?? 'preference',
    content,
    tags: options.tags ?? [],
    origin: options.origin ?? 'manual',
    pinned: options.pinned ?? false,
    status: options.status ?? 'active',
    createdAt: options.createdAt ?? isoDaysAgo(options.daysAgo ?? 0),
    updatedAt: options.updatedAt ?? isoDaysAgo(options.daysAgo ?? 0),
    metadata: options.metadata
  });
  await mkdir(path.join(memoryHome, 'memory'), { recursive: true });
  await writeFile(path.join(memoryHome, 'memory', 'memories.json'), JSON.stringify({
    version: 2,
    records: [
      record('weak-pinned', 'neo 相关偏好：回答要简洁。', { pinned: true, tags: ['neo'] }),
      record('exact-web-context', 'neo 在回答时需要根据上下文判断是否联网搜索，不要答非所问。', {
        category: 'workflow',
        tags: ['联网搜索', '上下文'],
        daysAgo: 20
      }),
      record('tag-only', 'Tavily 工具配置记录。', {
        category: 'project_fact',
        tags: ['联网搜索', '上下文']
      }),
      record('workflow-style', '我喜欢简洁直接的回答，但处理开发任务时要说明关键取舍。', {
        category: 'workflow',
        tags: ['回答风格']
      }),
      record('archived-exact', '归档：neo 上下文 联网搜索。', {
        status: 'archived',
        tags: ['联网搜索', '上下文']
      })
    ]
  }, null, 2));

  const memory = new LocalMemory(config);
  const webHits = await memory.search('neo 联网搜索 上下文', 5);
  if (webHits[0]?.id !== 'exact-web-context') {
    throw new Error(`强相关记忆应该排第一：${JSON.stringify(webHits.map(hit => ({ id: hit.id, score: hit.score })))}`);
  }
  if (webHits.some(hit => hit.id === 'archived-exact')) throw new Error(`归档记忆不应出现在搜索结果：${JSON.stringify(webHits)}`);
  const weakIndex = webHits.findIndex(hit => hit.id === 'weak-pinned');
  const exactIndex = webHits.findIndex(hit => hit.id === 'exact-web-context');
  if (weakIndex >= 0 && weakIndex < exactIndex) throw new Error(`弱相关置顶记忆不应压过强相关记忆：${JSON.stringify(webHits)}`);

  const workflowHits = await memory.search('简洁回答 workflow', 5);
  if (workflowHits[0]?.id !== 'workflow-style') {
    throw new Error(`分类和内容共同命中的 workflow 记忆应该排第一：${JSON.stringify(workflowHits.map(hit => ({ id: hit.id, score: hit.score })))}`);
  }

  await rm(memoryHome, { recursive: true, force: true });
});

test('DreamService 支持锁、报告回放、人工采纳和记忆复查', async () => {
  const { DreamService } = await import(pathToFileURL(path.join(root, 'dist', 'dream', 'dreamService.js')).href);
  const { MemoryService } = await import(pathToFileURL(path.join(root, 'dist', 'memory', 'memoryService.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const dreamHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-dream-'));
  const config = defaultConfig();
  config.homeDir = dreamHome;
  config.memory.backend = 'local';
  config.dreaming.maxMemories = 20;
  config.dreaming.maxSessions = 2;
  const memory = new MemoryService(config);
  await memory.remember('重复记忆：neo 喜欢简洁直接的中文回答。', { category: 'preference', tags: ['style'] });
  await memory.remember('重复记忆：neo 喜欢简洁直接的中文回答。', { category: 'preference', tags: ['style'] });
  const weak = await memory.remember('短', { category: 'workflow' });
  await memory.update(weak.id, { content: '短', pinned: false });

  let modelCalls = 0;
  const models = {
    get: () => ({
      chat: async () => {
        modelCalls += 1;
        return JSON.stringify({
          summary: '发现一条可长期复用的工作流。',
          upserts: [{
            category: 'workflow',
            content: '处理用户反馈时，先复盘 CC-Source 对应实现，再做 neo-agent 适配。',
            tags: ['debug', 'cc-source'],
            pinned: false,
            reason: '这是用户反复强调的开发原则。'
          }],
          archives: [{ id: weak.id, reason: '内容过短，缺少可复用上下文。' }],
          insights: ['dreaming 可以把重复反馈沉淀为开发检查清单。']
        });
      }
    })
  };
  const dreams = new DreamService(config, models, memory);
  const dryRun = await dreams.run({ dryRun: true, force: true });
  if (dryRun.status !== 'completed') throw new Error(`dream dry-run 应完成：${JSON.stringify(dryRun)}`);
  if (!dryRun.reportPath) throw new Error('dream dry-run 应写入报告。');
  if (modelCalls !== 1) throw new Error(`dry-run 应调用一次模型：${modelCalls}`);
  const reports = await dreams.listReports(5);
  if (reports.length !== 1 || reports[0].appliedAt) throw new Error(`报告列表异常：${JSON.stringify(reports)}`);
  const shown = await dreams.showReport(reports[0].id);
  assertIncludes(shown.report.plan.upserts[0].content, 'CC-Source');

  const applied = await dreams.applyReport(reports[0].id);
  if (applied.status !== 'completed') throw new Error(`dream apply 应完成：${JSON.stringify(applied)}`);
  const hits = await memory.search('CC-Source 用户反馈');
  assertIncludes(hits.map(hit => hit.content).join('\n'), '处理用户反馈');
  const archived = await memory.local.find(weak.id);
  if (archived?.status !== 'archived') throw new Error(`apply 应归档报告里的记忆：${JSON.stringify(archived)}`);
  const appliedAgain = await dreams.applyReport(reports[0].id);
  if (appliedAgain.status !== 'skipped' || !appliedAgain.reason.includes('已经采纳')) {
    throw new Error(`同一 dream 报告不应重复采纳：${JSON.stringify(appliedAgain)}`);
  }

  const review = await dreams.reviewMemories(20);
  if (!review.issues.some(issue => issue.type === 'duplicate')) {
    throw new Error(`记忆复查应该发现重复记忆：${JSON.stringify(review)}`);
  }

  await mkdir(path.join(dreamHome, 'dream'), { recursive: true });
  await writeFile(path.join(dreamHome, 'dream', 'dream.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const locked = await dreams.run({ dryRun: true, force: true });
  if (locked.status !== 'skipped' || !locked.reason.includes('正在运行')) throw new Error(`dream 锁应阻止并发：${JSON.stringify(locked)}`);
  await rm(dreamHome, { recursive: true, force: true });
});

test('工具日志摘要不会记录完整查询和 MCP 参数', async () => {
  const { summarizeToolArguments, summarizeToolError, summarizeToolResult } = await import(pathToFileURL(path.join(root, 'dist', 'tools', 'toolLog.js')).href);
  const args = summarizeToolArguments({
    id: 'call_1',
    type: 'function',
    function: {
      name: 'WebSearch',
      arguments: JSON.stringify({ query: '这是一个不应该进入日志的完整搜索词', url: 'https://docs.example.com/a?token=secret' })
    }
  });
  if (JSON.stringify(args).includes('完整搜索词')) throw new Error(`工具参数日志泄露了完整查询：${JSON.stringify(args)}`);
  if (JSON.stringify(args).includes('token=secret')) throw new Error(`工具参数日志泄露了 URL query：${JSON.stringify(args)}`);
  assertIncludes(JSON.stringify(args), 'docs.example.com');
  assertIncludes(JSON.stringify(args), 'queryChars');

  const result = summarizeToolResult({
    name: 'WebFetch',
    url: 'https://docs.example.com/private?token=secret',
    searchedAt: '2026-05-25T00:00:00.000Z',
    resultCount: 1,
    failedCount: 0
  }, 'very long result body');
  if (JSON.stringify(result).includes('token=secret')) throw new Error(`工具结果日志泄露了 URL query：${JSON.stringify(result)}`);
  assertIncludes(JSON.stringify(result), 'docs.example.com');

  const error = summarizeToolError(new Error('MCP 工具未获授权：mcp__github__create_issue'));
  assertIncludes(JSON.stringify(error), 'permission');
});

test('Web/File 工具参数错误不会回显原始参数', async () => {
  const { WebToolRunner } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'webTools.js')).href);
  const { FileToolRunner, READ_TOOL_NAME } = await import(pathToFileURL(path.join(root, 'dist', 'files', 'fileTools.js')).href);
  const secretArgs = '{"query":"不应该回显的完整参数 token=secret"';
  const webRunner = new WebToolRunner({
    web: {
      autoSearch: true,
      toolLoopEnabled: true,
      apiKey: 'test',
      maxResults: 1,
      maxContextChars: 1000,
      searchDepth: 'basic',
      extractDepth: 'basic',
      allowedDomains: [],
      blockedDomains: [],
      blockPrivateAddresses: true
    }
  }, {});
  await assertRejects(() => webRunner.execute({
    id: 'bad_web',
    type: 'function',
    function: { name: 'WebSearch', arguments: secretArgs }
  }), '参数长度');
  await assertRejects(() => webRunner.execute({
    id: 'bad_web',
    type: 'function',
    function: { name: 'WebSearch', arguments: secretArgs }
  }), '工具参数不是有效 JSON');
  try {
    await webRunner.execute({
      id: 'bad_web',
      type: 'function',
      function: { name: 'WebSearch', arguments: secretArgs }
    });
  } catch (error) {
    if (String(error).includes('token=secret')) throw new Error(`Web 参数错误泄露原始参数：${String(error)}`);
  }

  const fileRunner = new FileToolRunner(root);
  await assertRejects(() => fileRunner.execute({
    id: 'bad_file',
    type: 'function',
    function: { name: READ_TOOL_NAME, arguments: secretArgs }
  }), '参数长度');
  try {
    await fileRunner.execute({
      id: 'bad_file',
      type: 'function',
      function: { name: READ_TOOL_NAME, arguments: secretArgs }
    });
  } catch (error) {
    if (String(error).includes('token=secret')) throw new Error(`File 参数错误泄露原始参数：${String(error)}`);
  }
});

test('ConversationHistory 超过阈值时生成自动 compact 摘要并保留近期消息', async () => {
  const { ConversationHistory } = await import(pathToFileURL(path.join(root, 'dist', 'conversation', 'history.js')).href);
  const history = new ConversationHistory(900, 500, {
    enabled: true,
    thresholdRatio: 0.5,
    keepRecentChars: 280,
    maxSummaryChars: 320
  });
  await history.append(
    '第一轮用户问题：请记住项目必须严格参考 CC-Source。'.repeat(4),
    '第一轮助手回答：已写入开发原则，并会优先参考 CC-Source。'.repeat(4)
  );
  const compact = await history.append(
    '第二轮用户问题：继续推进自动 compact。'.repeat(4),
    '第二轮助手回答：开始实现 ConversationHistory 自动压缩。'.repeat(4),
    {
      chat: async ({ messages }) => {
        assertIncludes(messages.at(-1)?.content ?? '', '第一轮用户问题');
        return '<analysis>内部分析不应保留</analysis><summary>已压缩：项目开发必须严格参考 CC-Source，并保持中文沟通。</summary>';
      }
    }
  );
  if (!compact.compacted) throw new Error(`应该触发自动 compact：${JSON.stringify(compact)}`);
  if (compact.source !== 'model') throw new Error(`应该使用模型摘要：${JSON.stringify(compact)}`);

  const messages = history.recentMessages();
  assertIncludes(messages[0].content, '自动压缩的历史摘要');
  assertIncludes(messages[0].content, '严格参考 CC-Source');
  if (messages[0].content.includes('<analysis>')) throw new Error(`compact 摘要不应保留 analysis：${messages[0].content}`);
});

test('TranscriptService 支持标题、compact boundary、resume snapshot 和 tool pairing 校验', async () => {
  const { TranscriptService } = await import(pathToFileURL(path.join(root, 'dist', 'transcript', 'transcriptService.js')).href);
  const { defaultConfig } = await import(pathToFileURL(path.join(root, 'dist', 'config.js')).href);
  const transcriptHome = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-transcript-'));
  const config = defaultConfig();
  config.homeDir = transcriptHome;
  const transcripts = new TranscriptService(config);
  await transcripts.start();
  await transcripts.append('user', '这是会话标题：严格参考 CC-Source。');
  await transcripts.append('assistant', '第一段回答', {
    toolPairs: [{
      round: 0,
      toolCallId: 'call_missing',
      toolName: 'DemoTool',
      hasResult: false,
      resultChars: 0
    }]
  });
  await transcripts.append('compact', '自动压缩会话上下文', {
    summary: '旧摘要：用户要求严格参考 CC-Source。',
    compactId: 'compact_test'
  });
  await transcripts.append('user', 'compact 后继续开发。');
  await transcripts.append('assistant', '继续推进。', {
    toolPairs: [{
      round: 1,
      toolCallId: 'call_persisted',
      toolName: 'LargeTool',
      hasResult: true,
      resultChars: 320,
      persistedPath: '/tmp/full-tool-result.txt',
      originalResultChars: 5000
    }]
  });
  await transcripts.flush();

  const sessions = await transcripts.listSessions(5);
  const session = sessions.find(item => item.sessionId === transcripts.sessionId);
  if (!session?.title?.includes('会话标题')) throw new Error(`应从首个用户消息推断标题：${JSON.stringify(sessions)}`);
  const snapshot = await transcripts.loadConversationSnapshot(transcripts.sessionId);
  if (!snapshot) throw new Error('应能恢复 transcript snapshot。');
  assertIncludes(snapshot.compactSummary ?? '', '旧摘要');
  if (snapshot.messages.length !== 2 || !snapshot.messages[0].content.includes('compact 后继续开发')) {
    throw new Error(`resume 应只恢复 compact boundary 后的消息：${JSON.stringify(snapshot.messages)}`);
  }
  assertIncludes(snapshot.messages[1].content, '历史工具结果引用');
  assertIncludes(snapshot.messages[1].content, '/tmp/full-tool-result.txt');
  if (!snapshot.warnings.some(warning => warning.includes('未配对 tool result'))) {
    throw new Error(`应提示未配对 tool result：${JSON.stringify(snapshot.warnings)}`);
  }
  const current = new TranscriptService(config);
  await current.start();
  const latest = await current.loadConversationSnapshot('latest');
  if (latest?.sessionId !== transcripts.sessionId) {
    throw new Error(`latest resume 应跳过当前 session，恢复上一个会话：${JSON.stringify(latest)}`);
  }
  await rm(transcriptHome, { recursive: true, force: true });
});

test('QueryEngine 会产出工具状态事件并把失败恢复提示回灌给模型', async () => {
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  const events = [];
  let modelCalls = 0;
  let recovered = false;
  const model = {
    chatWithTools: async options => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ThrowTool', arguments: JSON.stringify({ query: '不应显示在工具事件摘要里的完整查询' }) }
          }]
        };
      }
      const last = options.messages.at(-1);
      if (last?.role !== 'tool') throw new Error(`第二轮模型调用前应该收到 tool 结果：${JSON.stringify(last)}`);
      assertIncludes(last.content, 'recoveryHint');
      assertIncludes(last.content, '工具超时');
      recovered = true;
      return { content: '已根据工具失败结果继续回答', toolCalls: [] };
    },
    chat: async () => 'unused'
  };
  const runner = {
    definitions: () => [{
      type: 'function',
      function: {
        name: 'ThrowTool',
        description: 'Throw for test',
        parameters: { type: 'object', properties: {} }
      }
    }],
    canExecute: name => name === 'ThrowTool',
    execute: async () => {
      throw new Error('timeout while calling external service');
    }
  };
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, {
    maxToolRounds: 2,
    onToolEvent: event => events.push(event)
  });
  const result = await engine.run('main', [{ role: 'user', content: '触发工具失败' }]);
  assertIncludes(result.text, '工具失败');
  if (!recovered) throw new Error('模型没有收到结构化失败恢复提示。');
  assertIncludes(events.map(event => event.phase).join(','), 'start,error');
  assertIncludes(result.toolEvents.map(event => event.phase).join(','), 'start,error');
  if (events.some(event => event.summary.includes('完整查询'))) {
    throw new Error(`工具 UI 摘要泄露完整查询：${JSON.stringify(events)}`);
  }
});

test('QueryEngine 支持请求级取消并停止后续工具执行', async () => {
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  const controller = new AbortController();
  let modelCalls = 0;
  let toolExecuted = false;
  const model = {
    chatWithTools: async () => {
      modelCalls += 1;
      controller.abort();
      return {
        content: '',
        toolCalls: [{
          id: 'call_abort',
          type: 'function',
          function: { name: 'AbortTool', arguments: '{}' }
        }]
      };
    },
    chat: async () => {
      throw new Error('取消测试不应该进入普通 chat');
    }
  };
  const runner = {
    definitions: () => [{
      type: 'function',
      function: {
        name: 'AbortTool',
        description: 'Should not run after abort',
        parameters: { type: 'object', properties: {} }
      }
    }],
    canExecute: name => name === 'AbortTool',
    execute: async () => {
      toolExecuted = true;
      return { content: 'unexpected' };
    }
  };
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, { maxToolRounds: 2 });
  await assertRejects(() => engine.run('main', [{ role: 'user', content: '取消当前请求' }], { signal: controller.signal }), '用户已取消当前请求');
  if (modelCalls !== 1) throw new Error(`取消前应只调用一次模型，实际：${modelCalls}`);
  if (toolExecuted) throw new Error('请求取消后不应该继续执行工具。');
});

test('QueryEngine 按工具安全策略并发执行并保持 tool result 配对顺序', async () => {
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  let active = 0;
  let maxActive = 0;
  let modelCalls = 0;
  const model = {
    chatWithTools: async options => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: ['SafeA', 'SafeB', 'SerialC'].map((name, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: { name, arguments: '{}' }
          }))
        };
      }
      const toolMessages = options.messages.filter(message => message.role === 'tool');
      const paired = toolMessages.map(message => `${message.tool_call_id}:${message.content}`).join('|');
      assertIncludes(paired, 'call_0:SafeA done');
      assertIncludes(paired, 'call_1:SafeB done');
      assertIncludes(paired, 'call_2:SerialC done');
      if (!paired.startsWith('call_0:SafeA done|call_1:SafeB done|call_2:SerialC done')) {
        throw new Error(`tool result 顺序应与 tool_calls 一致：${paired}`);
      }
      return { content: '工具完成', toolCalls: [] };
    },
    chat: async () => 'unused'
  };
  const runner = {
    definitions: () => ['SafeA', 'SafeB', 'SerialC'].map(name => ({
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } }
    })),
    canExecute: name => ['SafeA', 'SafeB', 'SerialC'].includes(name),
    executionMode: name => name.startsWith('Safe') ? 'parallel' : 'serial',
    execute: async call => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(call.function.name.startsWith('Safe') ? 30 : 1);
      active -= 1;
      return { content: `${call.function.name} done` };
    }
  };
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, { maxToolRounds: 2, toolTimeoutMs: 1000 });
  const result = await engine.run('main', [{ role: 'user', content: '并发工具测试' }]);
  assertIncludes(result.text, '工具完成');
  if (maxActive < 2) throw new Error(`Safe 工具应该并发执行，maxActive=${maxActive}`);
  if (result.toolPairs.length !== 3) throw new Error(`应该记录三个 tool result 配对：${JSON.stringify(result.toolPairs)}`);
  if (!result.toolPairs.every(pair => pair.hasResult)) throw new Error(`所有工具都应该有配对结果：${JSON.stringify(result.toolPairs)}`);
});

test('QueryEngine 超时后取消工具并忽略迟到 orphan result', async () => {
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  const warns = [];
  let modelCalls = 0;
  let signalSeen = false;
  const model = {
    chatWithTools: async options => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'slow_call',
            type: 'function',
            function: { name: 'SlowTool', arguments: '{}' }
          }]
        };
      }
      const last = options.messages.at(-1);
      if (last?.role !== 'tool') throw new Error('超时后仍应给模型回灌结构化 tool result。');
      assertIncludes(last.content, '工具超时');
      return { content: '已处理超时', toolCalls: [] };
    },
    chat: async () => 'unused'
  };
  const runner = {
    definitions: () => [{
      type: 'function',
      function: { name: 'SlowTool', description: 'Slow', parameters: { type: 'object', properties: {} } }
    }],
    canExecute: name => name === 'SlowTool',
    executionMode: () => 'parallel',
    execute: async (_call, options) => {
      await delay(40);
      signalSeen = Boolean(options.signal?.aborted);
      return { content: 'late result' };
    }
  };
  const logger = { info() {}, debug() {}, error() {}, warn(event, fields) { warns.push({ event, fields }); } };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, { maxToolRounds: 2, toolTimeoutMs: 5 });
  const result = await engine.run('main', [{ role: 'user', content: '超时工具测试' }]);
  assertIncludes(result.text, '超时');
  await delay(60);
  if (!signalSeen) throw new Error('超时后应该向工具传递 aborted signal。');
  if (!warns.some(item => item.event === 'tool.orphan_result')) {
    throw new Error(`迟到工具结果应该被记录为 orphan result：${JSON.stringify(warns)}`);
  }
});

test('QueryEngine 会把超大工具结果落盘并回灌预览', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-tool-results-'));
  try {
    const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
    const infos = [];
    const fullOutput = `${'alpha\n'.repeat(400)}TAIL_SHOULD_BE_IN_FILE_ONLY\n`;
    let modelCalls = 0;
    let persistedPath = '';
    const model = {
      chatWithTools: async options => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'large_call',
              type: 'function',
              function: { name: 'LargeTool', arguments: '{}' }
            }]
          };
        }
        const toolMessage = options.messages.at(-1);
        if (toolMessage?.role !== 'tool') throw new Error('第二轮应该收到 tool result。');
        assertIncludes(toolMessage.content, '<neo_tool_result_persisted>');
        assertIncludes(toolMessage.content, 'Full output saved to:');
        if (toolMessage.content.includes('TAIL_SHOULD_BE_IN_FILE_ONLY')) {
          throw new Error('超大结果尾部不应进入模型上下文预览。');
        }
        const match = toolMessage.content.match(/Full output saved to: (.+)/);
        persistedPath = match?.[1]?.trim() ?? '';
        return { content: '已读取预览', toolCalls: [] };
      },
      chat: async () => 'unused'
    };
    const runner = {
      definitions: () => [{
        type: 'function',
        function: { name: 'LargeTool', description: 'Large', parameters: { type: 'object', properties: {} } }
      }],
      canExecute: name => name === 'LargeTool',
      executionMode: () => 'serial',
      execute: async () => ({ content: fullOutput })
    };
    const logger = { info(event, fields) { infos.push({ event, fields }); }, debug() {}, error() {}, warn() {} };
    const engine = new QueryEngine({ get: () => model }, [runner], logger, {
      maxToolRounds: 2,
      toolResultBudget: {
        enabled: true,
        dir: outputDir,
        maxInlineChars: 800,
        previewChars: 200
      }
    });
    const result = await engine.run('main', [{ role: 'user', content: '大结果测试' }]);
    assertIncludes(result.text, '预览');
    if (!persistedPath) throw new Error('应该返回持久化文件路径。');
    assertIncludes(await readFile(persistedPath, 'utf8'), 'TAIL_SHOULD_BE_IN_FILE_ONLY');
    if (!result.toolPairs[0]?.persistedPath) throw new Error(`toolPairs 应记录 persistedPath：${JSON.stringify(result.toolPairs)}`);
    if (result.toolPairs[0]?.originalResultChars !== fullOutput.length) throw new Error(`toolPairs 应记录原始长度：${JSON.stringify(result.toolPairs)}`);
    if (!infos.some(item => item.event === 'tool.result_persisted')) {
      throw new Error(`应该记录 tool.result_persisted 日志：${JSON.stringify(infos)}`);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('QueryEngine 会按历史消息级预算落盘累计工具结果', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-tool-history-'));
  try {
    const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
    const infos = [];
    let modelCalls = 0;
    const model = {
      chatWithTools: async options => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: ['A', 'B', 'C'].map(name => ({
              id: `call_${name}`,
              type: 'function',
              function: { name: `Medium${name}`, arguments: '{}' }
            }))
          };
        }
        const toolMessages = options.messages.filter(message => message.role === 'tool');
        if (toolMessages.length !== 3) throw new Error(`第二轮应保留三个 tool result 配对：${JSON.stringify(toolMessages)}`);
        if (!toolMessages.some(message => message.content.includes('<neo_tool_result_persisted>'))) {
          throw new Error(`累计工具结果超预算时应替换为持久化引用：${JSON.stringify(toolMessages)}`);
        }
        if (toolMessages.some(message => message.content.includes('TAIL_MEDIUM_RESULT'))) {
          throw new Error(`累计预算替换后不应把完整尾部继续塞进上下文：${JSON.stringify(toolMessages)}`);
        }
        return { content: '历史预算已应用', toolCalls: [] };
      },
      chat: async () => 'unused'
    };
    const runner = {
      definitions: () => ['A', 'B', 'C'].map(name => ({
        type: 'function',
        function: { name: `Medium${name}`, description: 'Medium', parameters: { type: 'object', properties: {} } }
      })),
      canExecute: name => name.startsWith('Medium'),
      executionMode: () => 'parallel',
      execute: async call => ({ content: `${call.function.name}\n${'body\n'.repeat(80)}TAIL_MEDIUM_RESULT\n` })
    };
    const logger = { info(event, fields) { infos.push({ event, fields }); }, debug() {}, error() {}, warn() {} };
    const engine = new QueryEngine({ get: () => model }, [runner], logger, {
      maxToolRounds: 2,
      toolResultBudget: {
        enabled: true,
        dir: outputDir,
        maxInlineChars: 900,
        previewChars: 200
      }
    });
    const result = await engine.run('main', [{ role: 'user', content: '累计工具结果预算测试' }]);
    assertIncludes(result.text, '历史预算');
    if (!infos.some(item => item.event === 'tool.history_result_persisted')) {
      throw new Error(`应该记录历史工具结果落盘日志：${JSON.stringify(infos)}`);
    }
    const persistedPairs = result.toolPairs.filter(pair => pair.persistedPath);
    if (persistedPairs.length === 0) throw new Error(`toolPairs 应记录历史预算持久化路径：${JSON.stringify(result.toolPairs)}`);
    for (const pair of persistedPairs) {
      assertIncludes(await readFile(pair.persistedPath, 'utf8'), 'TAIL_MEDIUM_RESULT');
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('项目文件工具只能读取项目内文件并支持 Glob/Grep', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-files-'));
  const extraReadDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-extra-read-'));
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const answer = 42;\nconsole.log(answer);\n', 'utf8');
  await writeFile(path.join(projectDir, 'README.md'), '# Demo\nanswer lives in src/app.ts\n', 'utf8');
  await writeFile(path.join(projectDir, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 97, 110, 115, 119, 101, 114, 0, 3]));
  await writeFile(path.join(extraReadDir, 'notes.txt'), 'external scope note\n', 'utf8');
  try {
    const { FileToolRunner, GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } = await import(pathToFileURL(path.join(root, 'dist', 'files', 'fileTools.js')).href);
    const runner = new FileToolRunner(projectDir, undefined, undefined, { additionalReadDirs: [extraReadDir] });
    await runner.refresh();
    const names = runner.definitions().map(tool => tool.function.name).join(',');
    assertIncludes(names, READ_TOOL_NAME);
    assertIncludes(names, GLOB_TOOL_NAME);
    assertIncludes(names, GREP_TOOL_NAME);

    const read = await runner.execute({
      id: 'read_1',
      type: 'function',
      function: { name: READ_TOOL_NAME, arguments: JSON.stringify({ file_path: 'src/app.ts', limit: 1 }) }
    });
    assertIncludes(read.content, 'export const answer');
    assertIncludes(read.record.name, READ_TOOL_NAME);

    const glob = await runner.execute({
      id: 'glob_1',
      type: 'function',
      function: { name: GLOB_TOOL_NAME, arguments: JSON.stringify({ pattern: 'src/*.ts' }) }
    });
    assertIncludes(glob.content, 'src/app.ts');

    const grep = await runner.execute({
      id: 'grep_1',
      type: 'function',
      function: { name: GREP_TOOL_NAME, arguments: JSON.stringify({ pattern: 'answer', output_mode: 'content' }) }
    });
    assertIncludes(grep.content, 'src/app.ts');
    assertIncludes(grep.content, 'src/app.ts:1:export const answer');
    assertIncludes(grep.content, 'answer');
    if (grep.content.includes('binary.bin')) throw new Error(`Grep 不应返回二进制文件匹配：${grep.content}`);

    const dashPattern = await runner.execute({
      id: 'grep_2',
      type: 'function',
      function: { name: GREP_TOOL_NAME, arguments: JSON.stringify({ pattern: '- 42', output_mode: 'content' }) }
    });
    assertIncludes(dashPattern.content, 'No matches found');

    await assertRejects(() => runner.execute({
      id: 'read_2',
      type: 'function',
      function: { name: READ_TOOL_NAME, arguments: JSON.stringify({ file_path: '/etc/passwd' }) }
    }), '当前项目目录');

    const externalRead = await runner.execute({
      id: 'read_extra',
      type: 'function',
      function: { name: READ_TOOL_NAME, arguments: JSON.stringify({ file_path: path.join(extraReadDir, 'notes.txt') }) }
    });
    assertIncludes(externalRead.content, 'external scope note');

    const externalGrep = await runner.execute({
      id: 'grep_extra',
      type: 'function',
      function: { name: GREP_TOOL_NAME, arguments: JSON.stringify({ path: extraReadDir, pattern: 'scope', output_mode: 'content' }) }
    });
    assertIncludes(externalGrep.content, 'notes.txt');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(extraReadDir, { recursive: true, force: true });
  }
});

test('项目文件 Write/Edit 必须确认权限并限制在项目内', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-file-write-'));
  const extraWriteDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-extra-write-'));
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'app.ts'), 'const value = 1;\n', 'utf8');
  try {
    const { FileToolRunner, WRITE_TOOL_NAME, EDIT_TOOL_NAME } = await import(pathToFileURL(path.join(root, 'dist', 'files', 'fileTools.js')).href);
    const hookEvents = [];
    const hooks = { emit: (event, name, metadata) => hookEvents.push({ event, name, metadata }) };
    const runner = new FileToolRunner(projectDir, undefined, hooks, { workspaceDir: 'workspace', additionalWriteDirs: [extraWriteDir] });
    await runner.refresh();
    const names = runner.definitions().map(tool => tool.function.name).join(',');
    assertIncludes(names, WRITE_TOOL_NAME);
    assertIncludes(names, EDIT_TOOL_NAME);

    const workspaceWrite = await runner.execute({
      id: 'write_workspace',
      type: 'function',
      function: { name: WRITE_TOOL_NAME, arguments: JSON.stringify({ file_path: 'workspace/free.txt', content: 'workspace can write without confirmation\n' }) }
    });
    assertIncludes(workspaceWrite.content, 'created workspace/free.txt');
    assertIncludes(await readFile(path.join(projectDir, 'workspace', 'free.txt'), 'utf8'), 'without confirmation');
    if (!hookEvents.some(event => event.event === 'PermissionRequest' && event.metadata?.permissionRequired === false)) {
      throw new Error(`workspace 写入应标记为无需权限确认：${JSON.stringify(hookEvents)}`);
    }

    await assertRejects(() => runner.execute({
      id: 'write_denied',
      type: 'function',
      function: { name: WRITE_TOOL_NAME, arguments: JSON.stringify({ file_path: 'src/new.ts', content: 'export const x = 1;\n' }) }
    }), '交互式权限确认');
    if (!hookEvents.some(event => event.event === 'PermissionRequest' && event.name === WRITE_TOOL_NAME)) {
      throw new Error(`Write 应发出 PermissionRequest hook 事件：${JSON.stringify(hookEvents)}`);
    }

    runner.setPermissionAsker(async request => {
      if (request.toolName === WRITE_TOOL_NAME && !request.path.includes('external.ts')) assertIncludes(request.path, 'src/new.ts');
      if (request.toolName === WRITE_TOOL_NAME && request.path.includes('external.ts')) assertIncludes(request.path, extraWriteDir);
      if (request.toolName === EDIT_TOOL_NAME) assertIncludes(request.path, 'src/app.ts');
      return 'allow';
    });
    const write = await runner.execute({
      id: 'write_allowed',
      type: 'function',
      function: { name: WRITE_TOOL_NAME, arguments: JSON.stringify({ file_path: 'src/new.ts', content: 'export const x = 1;\n' }) }
    });
    assertIncludes(write.content, 'created src/new.ts');
    assertIncludes(await readFile(path.join(projectDir, 'src', 'new.ts'), 'utf8'), 'export const x');

    const externalWrite = await runner.execute({
      id: 'write_extra_allowed',
      type: 'function',
      function: { name: WRITE_TOOL_NAME, arguments: JSON.stringify({ file_path: path.join(extraWriteDir, 'external.ts'), content: 'export const external = true;\n' }) }
    });
    assertIncludes(externalWrite.content, 'external.ts');
    assertIncludes(await readFile(path.join(extraWriteDir, 'external.ts'), 'utf8'), 'external = true');

    const edit = await runner.execute({
      id: 'edit_allowed',
      type: 'function',
      function: { name: EDIT_TOOL_NAME, arguments: JSON.stringify({ file_path: 'src/app.ts', old_string: 'value = 1', new_string: 'value = 2' }) }
    });
    assertIncludes(edit.content, 'edited src/app.ts');
    assertIncludes(await readFile(path.join(projectDir, 'src', 'app.ts'), 'utf8'), 'value = 2');

    const workspaceEdit = await runner.execute({
      id: 'edit_workspace',
      type: 'function',
      function: { name: EDIT_TOOL_NAME, arguments: JSON.stringify({ file_path: 'workspace/free.txt', old_string: 'without confirmation', new_string: 'with full access' }) }
    });
    assertIncludes(workspaceEdit.content, 'edited workspace/free.txt');
    assertIncludes(await readFile(path.join(projectDir, 'workspace', 'free.txt'), 'utf8'), 'with full access');

    await assertRejects(() => runner.execute({
      id: 'write_outside',
      type: 'function',
      function: { name: WRITE_TOOL_NAME, arguments: JSON.stringify({ file_path: '../outside.ts', content: 'bad' }) }
    }), '当前项目目录');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(extraWriteDir, { recursive: true, force: true });
  }
});

test('Tavily crawler 过滤参数会合并配置和命令输入', async () => {
  const { buildCrawlerFilters } = await import(pathToFileURL(path.join(root, 'dist', 'web', 'tavilyClient.js')).href);
  const filters = buildCrawlerFilters({
    selectPaths: ['/docs/.*'],
    excludePaths: ['/admin/.*'],
    selectDomains: ['^docs\\.example\\.com$'],
    excludeDomains: ['^private\\.example\\.com$'],
    allowedDomains: ['example.com'],
    blockedDomains: ['blocked.example.com']
  }, {
    selectPaths: ['/api/.*'],
    excludePaths: ['/draft/.*'],
    selectDomains: ['^ignored\\.com$'],
    excludeDomains: ['^old\\.example\\.com$']
  });
  assertIncludes(filters.selectPaths.join(','), '/docs/.*');
  assertIncludes(filters.selectPaths.join(','), '/api/.*');
  assertIncludes(filters.excludePaths.join(','), '/admin/.*');
  assertIncludes(filters.excludePaths.join(','), '/draft/.*');
  assertIncludes(filters.selectDomains.join(','), 'example\\.com');
  if (filters.selectDomains.join(',').includes('ignored')) {
    throw new Error(`配置 allowedDomains 存在时，不应采纳外部 selectDomains：${JSON.stringify(filters)}`);
  }
  assertIncludes(filters.excludeDomains.join(','), 'blocked\\.example\\.com');
  assertIncludes(filters.excludeDomains.join(','), '^old\\.example\\.com$');
  assertThrows(() => buildCrawlerFilters({
    selectPaths: ['/['],
    excludePaths: [],
    selectDomains: [],
    excludeDomains: [],
    allowedDomains: [],
    blockedDomains: []
  }), '无效正则');
});

test('MCP 工具命名沿用 CC-Source 风格', async () => {
  const { buildMcpToolName } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpManager.js')).href);
  const name = buildMcpToolName('github server', 'create issue');
  assertIncludes(name, 'mcp__github_server__create_issue');
});

test('MCP resource runner 能列出和读取只读资源', async () => {
  const { LIST_MCP_RESOURCES_TOOL_NAME, McpResourceRunner, READ_MCP_RESOURCE_TOOL_NAME } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpResourceRunner.js')).href);
  const runner = new McpResourceRunner({
    connectedServerNames: () => ['demo'],
    listResources: async server => [{
      serverName: server ?? 'demo',
      uri: 'file://demo/readme.md',
      name: 'readme',
      mimeType: 'text/markdown'
    }],
    readResource: async () => [{
      uri: 'file://demo/readme.md',
      mimeType: 'text/markdown',
      text: 'hello resource'
    }]
  });
  await runner.refresh();
  const names = runner.definitions().map(tool => tool.function.name).join(',');
  assertIncludes(names, LIST_MCP_RESOURCES_TOOL_NAME);
  assertIncludes(names, READ_MCP_RESOURCE_TOOL_NAME);

  const list = await runner.execute({
    id: 'call_list',
    type: 'function',
    function: { name: LIST_MCP_RESOURCES_TOOL_NAME, arguments: JSON.stringify({ server: 'demo' }) }
  });
  assertIncludes(list.content, 'file://demo/readme.md');
  assertIncludes(list.record.toolName, 'resources/list');

  const read = await runner.execute({
    id: 'call_read',
    type: 'function',
    function: { name: READ_MCP_RESOURCE_TOOL_NAME, arguments: JSON.stringify({ server: 'demo', uri: 'file://demo/readme.md' }) }
  });
  assertIncludes(read.content, 'hello resource');
  assertIncludes(read.record.toolName, 'resources/read');
});

test('ToolSearch 会延迟加载 MCP 工具', async () => {
  const { McpToolRunner } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpToolRunner.js')).href);
  const { TOOL_SEARCH_TOOL_NAME, ToolSearchRunner } = await import(pathToFileURL(path.join(root, 'dist', 'tools', 'toolSearchRunner.js')).href);
  const mcp = {
    listToolDetails: async () => [
      { serverName: 'github', toolName: 'list_issues', fullName: 'mcp__github__list_issues', description: 'List GitHub issues', inputSchema: { type: 'object', properties: {} }, readOnlyHint: true },
      { serverName: 'github', toolName: 'create_issue', fullName: 'mcp__github__create_issue', description: 'Create GitHub issue', inputSchema: { type: 'object', properties: {} }, readOnlyHint: false },
      { serverName: 'slack', toolName: 'send_message', fullName: 'mcp__slack__send_message', description: 'Send Slack message', inputSchema: { type: 'object', properties: {} }, readOnlyHint: false }
    ],
    callTool: async () => ({ ok: true })
  };
  const runner = new McpToolRunner(mcp, { mode: 'readOnly', allowedTools: [], deniedTools: [] }, 1);
  const search = new ToolSearchRunner(runner);
  await runner.refresh();
  if (runner.definitions().length !== 0) throw new Error('超过阈值时 MCP 工具应该先延迟加载。');
  assertIncludes(search.definitions().map(tool => tool.function.name).join(','), TOOL_SEARCH_TOOL_NAME);
  const result = await search.execute({
    id: 'tool_search',
    type: 'function',
    function: { name: TOOL_SEARCH_TOOL_NAME, arguments: JSON.stringify({ query: 'github list', max_results: 2 }) }
  });
  assertIncludes(result.content, 'mcp__github__list_issues');
  assertIncludes(runner.definitions().map(tool => tool.function.name).join(','), 'mcp__github__list_issues');
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

test('MCP 高风险工具支持一次性和持久化授权', async () => {
  const { McpToolRunner } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpToolRunner.js')).href);
  const calls = [];
  const persisted = [];
  const mcp = {
    listToolDetails: async () => [{
      serverName: 'github',
      toolName: 'create_issue',
      fullName: 'mcp__github__create_issue',
      description: 'Create GitHub issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      readOnlyHint: false,
      destructiveHint: false
    }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    }
  };
  const permissions = { mode: 'readOnly', allowedTools: [], deniedTools: [] };
  const runner = new McpToolRunner(mcp, permissions, 20, undefined, async (tool, behavior) => {
    persisted.push({ tool, behavior });
  });
  await runner.refresh();
  const call = {
    id: 'mcp_write',
    type: 'function',
    function: { name: 'mcp__github__create_issue', arguments: JSON.stringify({ title: 'bug', body: 'detail' }) }
  };

  await assertRejects(() => runner.execute(call), 'MCP 工具未获授权');

  let promptRequest;
  runner.setPermissionAsker(async request => {
    promptRequest = request;
    return 'allow_once';
  });
  const result = await runner.execute(call);
  assertIncludes(result.content, '"ok": true');
  assertIncludes(promptRequest.fullName, 'mcp__github__create_issue');
  assertIncludes(promptRequest.argumentKeys.join(','), 'body,title');
  if (calls.length !== 1) throw new Error(`一次性允许后应该执行一次工具，实际：${calls.length}`);

  runner.setPermissionAsker(async () => 'deny');
  await assertRejects(() => runner.execute(call), '用户拒绝执行 MCP 工具');
  if (calls.length !== 1) throw new Error(`拒绝后不应该继续调用外部工具，实际：${calls.length}`);

  runner.setPermissionAsker(async () => 'allow_always');
  await runner.execute(call);
  if (!permissions.allowedTools.includes('mcp__github__create_issue')) throw new Error(`始终允许应写入内存权限：${JSON.stringify(permissions)}`);
  if (persisted.at(-1)?.behavior !== 'allow') throw new Error(`始终允许应触发持久化：${JSON.stringify(persisted)}`);
  runner.setPermissionAsker(undefined);
  await runner.execute(call);
  if (calls.length !== 3) throw new Error(`持久允许后不应再次询问，实际调用：${calls.length}`);

  permissions.allowedTools.length = 0;
  runner.setPermissionAsker(async () => 'deny_always');
  await assertRejects(() => runner.execute(call), '用户拒绝执行 MCP 工具');
  if (!permissions.deniedTools.includes('mcp__github__create_issue')) throw new Error(`始终拒绝应写入内存权限：${JSON.stringify(permissions)}`);
  if (persisted.at(-1)?.behavior !== 'deny') throw new Error(`始终拒绝应触发持久化：${JSON.stringify(persisted)}`);
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
  assertIncludes(result.stdout, '上下文预算');
  assertIncludes(result.stdout, 'Workspace');
  assertIncludes(result.stdout, 'Tool results');
  assertIncludes(result.stdout, 'Skills');
  assertIncludes(result.stdout, '配置文件权限');
  assertIncludes(result.stdout, 'ripgrep');
});

test('self-check 会检查版本、CHANGELOG 和安装环境', async () => {
  const result = await run(['self-check']);
  assertIncludes(result.stdout, 'neo-agent 0.1.0 self-check');
  assertIncludes(result.stdout, 'node:');
  assertIncludes(result.stdout, 'changelog: CHANGELOG.md version 0.1.0');
});

test('capabilities 命令会输出运行时能力快照', async () => {
  const result = await run(['capabilities']);
  assertIncludes(result.stdout, 'neo capabilities @');
  assertIncludes(result.stdout, 'runtime tools:');
  assertIncludes(result.stdout, 'Capabilities');
  assertIncludes(result.stdout, 'TaskAssessment');
  assertIncludes(result.stdout, 'Read');
  assertIncludes(result.stdout, 'Write');
  assertIncludes(result.stdout, 'skills:');

  const json = await run(['capabilities', '--json']);
  const parsed = JSON.parse(json.stdout);
  if (!parsed.runtimeTools.some(tool => tool.name === 'Capabilities')) throw new Error(`应暴露 Capabilities 工具：${json.stdout}`);
  if (!parsed.runtimeTools.some(tool => tool.name === 'TaskAssessment')) throw new Error(`应暴露 TaskAssessment 工具：${json.stdout}`);
  if (!parsed.files.tools.includes('Write')) throw new Error(`能力快照应包含 Write：${json.stdout}`);
  if (parsed.files.workspaceDir !== 'workspace') throw new Error(`能力快照应包含默认 workspace：${json.stdout}`);
  if (parsed.files.writeConfirmationAvailable !== false) throw new Error(`非交互 CLI 不应具备写入确认回调：${json.stdout}`);
});

test('assess 命令会基于能力快照评估任务可行性', async () => {
  const readable = await run(['assess', '阅读 README 并总结']);
  assertIncludes(readable.stdout, 'neo task assessment @');
  assertIncludes(readable.stdout, 'feasibility: complete');
  assertIncludes(readable.stdout, 'file_read');

  const partial = await run(['assess', '运行 npm test 并修复失败']);
  assertIncludes(partial.stdout, 'feasibility: partial');
  assertIncludes(partial.stdout, 'shell');
  assertIncludes(partial.stdout, 'file_write');
  assertIncludes(partial.stdout, '需要用户执行测试/构建/命令');

  const json = await run(['assess', '--json', '阅读 README 并总结']);
  const parsed = JSON.parse(json.stdout);
  if (parsed.feasibility !== 'complete') throw new Error(`阅读任务应可完成：${json.stdout}`);
  if (!parsed.requiredCapabilities.some(capability => capability.id === 'file_read')) throw new Error(`应识别文件读取能力：${json.stdout}`);
});

test('MCP 配置命令能添加、列出和删除 server', async () => {
  const add = await run(['mcp', 'add', '--env', 'TOKEN=secret', 'demo', '--', 'node', 'server.js', '--flag']);
  assertIncludes(add.stdout, '已添加 MCP server：demo');
  assertIncludes(add.stdout, 'env=1');

  const list = await run(['mcp', 'list']);
  assertIncludes(list.stdout, 'demo: stdio node server.js --flag env=1');

  const json = await run(['mcp', 'list', '--json']);
  assertIncludes(json.stdout, '"name": "demo"');
  assertIncludes(json.stdout, '"TOKEN": "secret"');
  assertIncludes(json.stdout, '"scope": "user"');

  const projectDir = path.join(tempHome, 'mcp-project');
  await mkdir(projectDir, { recursive: true });
  const addProject = await run(['mcp', 'add', '--scope', 'project', 'local-demo', '--', 'node', 'local-server.js'], { cwd: projectDir });
  assertIncludes(addProject.stdout, '.mcp.json');
  assertIncludes(addProject.stdout, 'scope=project');
  const projectMcp = await readFile(path.join(projectDir, '.mcp.json'), 'utf8');
  assertIncludes(projectMcp, '"mcpServers"');
  assertIncludes(projectMcp, '"local-demo"');
  const projectList = await run(['mcp', 'list', '--scope', 'project'], { cwd: projectDir });
  assertIncludes(projectList.stdout, 'local-demo: stdio node local-server.js scope=project');
  const mergedConfig = await run(['config', 'show', '--source', 'merged'], { cwd: projectDir });
  assertIncludes(mergedConfig.stdout, '"local-demo"');

  const addHttp = await run(['mcp', 'add', '--type', 'http', '--header', 'X-Test=1', '--oauth-token-env', 'MCP_TOKEN', 'remote', 'https://mcp.example.com/mcp']);
  assertIncludes(addHttp.stdout, 'remote: http https://mcp.example.com/mcp headers=1 oauth=MCP_TOKEN');
  const allow = await run(['mcp', 'permission', 'allow', 'mcp__github__create_issue']);
  assertIncludes(allow.stdout, '已持久允许 MCP 工具：mcp__github__create_issue');
  const deny = await run(['mcp', 'permission', 'deny', 'mcp__github__delete_*']);
  assertIncludes(deny.stdout, '已持久拒绝 MCP 工具：mcp__github__delete_*');
  const config = await run(['config', 'show', '--source', 'user', '--show-secrets']);
  assertIncludes(config.stdout, '"allowedTools": [');
  assertIncludes(config.stdout, 'mcp__github__create_issue');
  assertIncludes(config.stdout, '"type": "http"');
  assertIncludes(config.stdout, '"accessTokenEnv": "MCP_TOKEN"');

  const remove = await run(['mcp', 'remove', 'demo']);
  assertIncludes(remove.stdout, '已删除 MCP server：demo');
  const removeProject = await run(['mcp', 'remove', 'local-demo', '--scope', 'project'], { cwd: projectDir });
  assertIncludes(removeProject.stdout, '已删除 MCP server：local-demo');
  await run(['mcp', 'remove', 'remote']);
  await run(['mcp', 'permission', 'remove', 'mcp__github__create_issue']);
  await run(['mcp', 'permission', 'remove', 'mcp__github__delete_*']);

  const empty = await run(['mcp', 'list']);
  assertIncludes(empty.stdout, '没有配置 MCP server');
});

test('skill 生命周期命令能创建、查看、编辑路径和删除 skill', async () => {
  const create = await run(['skill', 'create', '--trigger', 'demo', 'demo-skill', 'Demo skill description']);
  assertIncludes(create.stdout, '已创建 skill：demo-skill');
  assertIncludes(create.stdout, 'SKILL.md');

  const list = await run(['skill', 'list']);
  assertIncludes(list.stdout, 'demo-skill');
  assertIncludes(list.stdout, 'Demo skill description');
  assertIncludes(list.stdout, '触发词=demo');

  const show = await run(['skill', 'show', 'demo-skill']);
  assertIncludes(show.stdout, '# demo-skill');
  assertIncludes(show.stdout, 'Description: Demo skill description');
  assertIncludes(show.stdout, 'Triggers: demo');

  const edit = await run(['skill', 'edit', 'demo-skill']);
  assertIncludes(edit.stdout, 'SKILL.md');
  assertIncludes(edit.stdout, '已输出 skill 文件路径');

  const remove = await run(['skill', 'delete', 'demo-skill']);
  assertIncludes(remove.stdout, '已删除 skill：demo-skill');

  const missing = await run(['skill', 'show', 'demo-skill'], { expectCode: 1 });
  assertIncludes(missing.stdout, '没有找到 skill：demo-skill');
});

test('skill install/validate/export 支持 md 和 zip，并拒绝 zip-slip', async () => {
  const skillMd = path.join(tempHome, 'writer.md');
  const skillZip = path.join(tempHome, 'writer.zip');
  await writeFile(skillMd, [
    '---',
    'name: writer-helper',
    'description: Help write concise Chinese project updates',
    'triggers: writing, summary',
    '---',
    '',
    '# writer-helper',
    '',
    '## Workflow',
    '1. Keep the answer concise.',
    ''
  ].join('\n'), 'utf8');

  const preview = await run(['skill', 'install', skillMd, '--dry-run']);
  assertIncludes(preview.stdout, 'skill 安装预览通过：writer-helper');
  assertIncludes(preview.stdout, 'skill 校验通过');

  const install = await run(['skill', 'install', skillMd]);
  assertIncludes(install.stdout, '已安装 skill：writer-helper');
  assertIncludes(install.stdout, 'scope=user');

  const validate = await run(['skill', 'validate', 'writer-helper']);
  assertIncludes(validate.stdout, 'skill 校验通过');
  assertIncludes(validate.stdout, 'writer-helper');

  const exported = await run(['skill', 'export', 'writer-helper', '--output', skillZip]);
  assertIncludes(exported.stdout, '已导出 skill：writer-helper');
  assertIncludes(exported.stdout, 'writer.zip');

  const remove = await run(['skill', 'delete', 'writer-helper']);
  assertIncludes(remove.stdout, '已删除 skill：writer-helper');

  const installZip = await run(['skill', 'install', skillZip]);
  assertIncludes(installZip.stdout, '已安装 skill：writer-helper');

  const show = await run(['skill', 'show', 'writer-helper']);
  assertIncludes(show.stdout, 'Help write concise Chinese project updates');

  const projectRoot = path.join(tempHome, 'project-scope');
  await mkdir(projectRoot, { recursive: true });
  const renamed = await run(['skill', 'install', skillMd, '--name', 'project-writer', '--scope', 'project'], { cwd: projectRoot });
  assertIncludes(renamed.stdout, '已安装 skill：project-writer');
  assertIncludes(renamed.stdout, 'scope=project');
  const showRenamed = await run(['skill', 'show', 'project-writer', '--scope', 'project'], { cwd: projectRoot });
  assertIncludes(showRenamed.stdout, 'Help write concise Chinese project updates');

  const { zipSync, strToU8 } = await import('fflate');
  const multiZip = path.join(tempHome, 'multi-skills.zip');
  await writeFile(multiZip, Buffer.from(zipSync({
    'skills-main/alpha/SKILL.md': strToU8('---\nname: alpha-skill\ndescription: Alpha skill\ntriggers: alpha\n---\n\n# alpha-skill\n'),
    'skills-main/alpha/examples/': new Uint8Array(),
    'skills-main/alpha/examples/a.md': strToU8('alpha resource'),
    'skills-main/beta/SKILL.md': strToU8('---\nname: beta-skill\ndescription: Beta skill\ntriggers: beta\n---\n\n# beta-skill\n')
  })));
  const multiProject = path.join(tempHome, 'multi-project');
  await mkdir(multiProject, { recursive: true });
  const installMultiZip = await run(['skill', 'install', multiZip, '--scope', 'project'], { cwd: multiProject });
  assertIncludes(installMultiZip.stdout, '已安装 skill：alpha-skill');
  assertIncludes(installMultiZip.stdout, '已安装 skill：beta-skill');
  assertIncludes(installMultiZip.stdout, '共 2 个 skill');
  const reinstallMultiZip = await run(['skill', 'install', multiZip, '--scope', 'project'], { cwd: multiProject });
  assertIncludes(reinstallMultiZip.stdout, '已跳过已存在 skill：alpha-skill');
  assertIncludes(reinstallMultiZip.stdout, '已跳过已存在 skill：beta-skill');
  assertIncludes(reinstallMultiZip.stdout, '已跳过：共 2 个已存在 skill');

  const { buildSkillInstallPlan } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillPackage.js')).href);
  const evilZip = zipSync({
    '../evil/SKILL.md': strToU8('# evil\n\nDescription: bad\n')
  });
  await writeFile(path.join(tempHome, 'evil.zip'), Buffer.from(evilZip));
  await assertRejects(() => buildSkillInstallPlan({ source: path.join(tempHome, 'evil.zip') }), '不安全');
});

test('marketplace 本地索引能安装 skill', async () => {
  const skillMd = path.join(tempHome, 'market-skill.md');
  await writeFile(skillMd, [
    '---',
    'name: market-helper',
    'description: Marketplace helper skill',
    'triggers: market',
    '---',
    '',
    '# market-helper',
    'Use this from marketplace.',
    ''
  ].join('\n'), 'utf8');

  const init = await run(['marketplace', 'init']);
  assertIncludes(init.stdout, 'marketplace');
  const indexPath = path.join(tempHome, 'marketplace', 'skills.json');
  await writeFile(indexPath, `${JSON.stringify({
    version: 1,
    skills: [{
      name: 'market-helper',
      description: 'Marketplace helper skill',
      source: skillMd,
      tags: ['test']
    }]
  }, null, 2)}\n`, 'utf8');

  const list = await run(['marketplace', 'list']);
  assertIncludes(list.stdout, 'market-helper');
  assertIncludes(list.stdout, '#test');

  const install = await run(['marketplace', 'install', 'market-helper', '--scope', 'project'], { cwd: tempHome });
  assertIncludes(install.stdout, 'marketplace 安装完成：market-helper');
  assertIncludes(install.stdout, 'installed=market-helper');
  const installed = await readFile(path.join(tempHome, '.neo-agent', 'skills', 'market-helper', 'SKILL.md'), 'utf8');
  assertIncludes(installed, 'Marketplace helper skill');
});

test('SubAgentRunner 会持久化任务状态并支持停止', async () => {
  const { SubAgentRunner } = await import(pathToFileURL(path.join(root, 'dist', 'agents', 'subAgent.js')).href);
  const subHome = path.join(tempHome, 'subagent-home');
  const models = {
    config: { models: { small: { model: 'small-test' } } },
    small: {
      chat: async ({ messages, signal }) => {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        assertIncludes(messages.at(-1).content, 'demo task');
        return 'sub-agent result';
      }
    }
  };
  const runner = new SubAgentRunner(models, { info() {}, error() {} }, { homeDir: subHome });
  const record = await runner.startTask('demo task', { background: false });
  const completed = await runner.getTask(record.id);
  if (completed?.status !== 'completed') throw new Error(`sub-agent 应完成并落盘：${JSON.stringify(completed)}`);
  assertIncludes(completed.output, 'sub-agent result');
  const list = await runner.listTasks();
  if (!list.some(task => task.id === record.id)) throw new Error(`sub-agent list 应包含任务：${JSON.stringify(list)}`);

  const slowModels = {
    config: { models: { small: { model: 'small-test' } } },
    small: { chat: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('late'), 5000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      }, { once: true });
    }) }
  };
  const slowRunner = new SubAgentRunner(slowModels, { info() {}, error() {} }, { homeDir: subHome });
  const bg = await slowRunner.startTask('slow task', { background: true });
  const stopped = await slowRunner.stopTask(bg.id);
  if (stopped?.status !== 'cancelled') throw new Error(`stop 应标记任务 cancelled：${JSON.stringify(stopped)}`);
});

test('skill 自动沉淀只生成建议，确认后才写入', async () => {
  const { SkillManager } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillManager.js')).href);
  const suggestionHome = path.join(tempHome, 'skill-suggestion-home');
  const suggestionProject = path.join(tempHome, 'skill-suggestion-project');
  await mkdir(suggestionProject, { recursive: true });
  const manager = new SkillManager({ homeDir: suggestionHome, skills: { autoCreate: true, autoCreateThreshold: 2 } }, suggestionProject);
  const input = '请帮我整理这个开发流程，以后每次都按这个流程复盘和总结';
  const first = await manager.maybeSuggestSkill(input, '第一次回答摘要');
  if (first) throw new Error(`第一次不应该达到阈值：${JSON.stringify(first)}`);
  const second = await manager.maybeSuggestSkill(input, '第二次回答摘要');
  if (!second) throw new Error('第二次应该生成 skill 建议');
  assertIncludes(second.reason, '相似任务');
  const beforeCreate = await manager.loadSkills();
  if (beforeCreate.length !== 0) throw new Error(`生成建议不应该自动写入 skill：${JSON.stringify(beforeCreate)}`);
  const created = await manager.createSuggestedSkill(second);
  assertIncludes(created.name, second.name);
  const afterCreate = await manager.loadSkills();
  if (afterCreate.length !== 1) throw new Error(`确认后应该写入一个 skill：${JSON.stringify(afterCreate)}`);

  const oneOffInstall = '@skills-main.zip 安装这个包里的skill';
  await manager.maybeSuggestSkill(oneOffInstall, '已安装 17 个 skill');
  const installSuggestion = await manager.maybeSuggestSkill(oneOffInstall, '这些 skill 已经安装完成');
  if (installSuggestion) throw new Error(`一次性安装包操作不应该触发 skill 沉淀建议：${JSON.stringify(installSuggestion)}`);
});

test('skill 改进建议只生成建议，确认后才追加到 SKILL.md', async () => {
  const { SkillManager } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillManager.js')).href);
  const improvementHome = path.join(tempHome, 'skill-improvement-home');
  const improvementProject = path.join(tempHome, 'skill-improvement-project');
  await mkdir(improvementProject, { recursive: true });
  const manager = new SkillManager({ homeDir: improvementHome, skills: { autoCreate: true, autoCreateThreshold: 2 } }, improvementProject);
  const skill = await manager.createSkill('review-flow', 'Review code changes', ['review', 'code'], [
    'Read the diff.',
    'List risks first.'
  ]);
  const suggestion = await manager.maybeSuggestSkillImprovement(
    '以后每次 review 也要先检查有没有遗漏测试，不要只看实现代码',
    '已完成 review，并提醒测试风险。',
    [{ name: 'Skill', skillName: skill.name, scope: skill.scope, bodyChars: skill.body.length, resultChars: skill.body.length, durationMs: 1 }]
  );
  if (!suggestion) throw new Error('应该生成 skill 改进建议');
  assertIncludes(suggestion.updates[0].change, '遗漏测试');
  const before = await readFile(skill.filePath, 'utf8');
  if (before.includes('User-confirmed improvements')) throw new Error('生成建议时不应该自动写入 skill');
  const updated = await manager.applySkillImprovementSuggestion(suggestion);
  const after = await readFile(updated.filePath, 'utf8');
  assertIncludes(after, 'User-confirmed improvements');
  assertIncludes(after, '遗漏测试');
});

test('skill install 支持 CC-Source plugin manifest 的 skillsPath/skillsPaths', async () => {
  const pluginRoot = path.join(tempHome, 'demo-plugin');
  await mkdir(path.join(pluginRoot, 'skills', 'default-skill'), { recursive: true });
  await mkdir(path.join(pluginRoot, 'extra-skills', 'extra-skill'), { recursive: true });
  await mkdir(path.join(pluginRoot, 'single-skill'), { recursive: true });
  await writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    skillsPath: './single-skill',
    skillsPaths: ['./extra-skills']
  }, null, 2), 'utf8');
  await writeFile(path.join(pluginRoot, 'skills', 'default-skill', 'SKILL.md'), [
    '---',
    'description: Default plugin skill',
    'triggers: default',
    '---',
    '# default-skill',
    ''
  ].join('\n'), 'utf8');
  await writeFile(path.join(pluginRoot, 'extra-skills', 'extra-skill', 'SKILL.md'), [
    '---',
    'description: Extra plugin skill',
    'triggers: extra',
    '---',
    '# extra-skill',
    ''
  ].join('\n'), 'utf8');
  await writeFile(path.join(pluginRoot, 'single-skill', 'SKILL.md'), [
    '---',
    'description: Single plugin skill',
    'triggers: single',
    '---',
    '# single-skill',
    ''
  ].join('\n'), 'utf8');

  const preview = await run(['skill', 'install', pluginRoot, '--dry-run']);
  assertIncludes(preview.stdout, 'skill 安装预览通过：demo-plugin-default-skill');
  assertIncludes(preview.stdout, 'skill 安装预览通过：demo-plugin-extra-skill');
  assertIncludes(preview.stdout, 'skill 安装预览通过：demo-plugin-single-skill');
  assertIncludes(preview.stdout, '共 3 个 skill');

  const install = await run(['skill', 'install', pluginRoot]);
  assertIncludes(install.stdout, '已安装 skill：demo-plugin-default-skill');
  assertIncludes(install.stdout, 'source=plugin');

  const list = await run(['skill', 'list']);
  assertIncludes(list.stdout, 'demo-plugin-default-skill');
  assertIncludes(list.stdout, 'demo-plugin-extra-skill');
  assertIncludes(list.stdout, 'demo-plugin-single-skill');

  const validate = await run(['skill', 'validate', path.join(pluginRoot, 'plugin.json')]);
  assertIncludes(validate.stdout, 'demo-plugin-default-skill');
  assertIncludes(validate.stdout, 'demo-plugin-extra-skill');
  assertIncludes(validate.stdout, 'demo-plugin-single-skill');
});

test('Skill tool 能在 tool loop 中按需加载 SKILL.md 正文', async () => {
  const projectRoot = path.join(tempHome, 'skill-tool-project');
  await mkdir(projectRoot, { recursive: true });
  const { SkillManager } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillManager.js')).href);
  const { SkillToolRunner, getSkillToolPrompt } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillToolRunner.js')).href);
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  const manager = new SkillManager({ homeDir: tempHome, skills: { autoCreate: false, autoCreateThreshold: 3 } }, projectRoot);
  await manager.createSkill('answer-style', 'Use a concise answer style', ['answer', 'style'], [
    'Always answer in two short lines.',
    'Do not add filler.'
  ], { scope: 'project' });
  const skillFile = path.join(projectRoot, '.neo-agent', 'skills', 'answer-style', 'SKILL.md');
  await mkdir(path.join(projectRoot, '.neo-agent', 'skills', 'answer-style', 'examples'), { recursive: true });
  await writeFile(path.join(projectRoot, '.neo-agent', 'skills', 'answer-style', 'examples', 'template.md'), 'template body should not be in tool result', 'utf8');
  await writeFile(skillFile, [
    '# answer-style',
    '',
    'Description: Use a concise answer style',
    '',
    'Triggers: answer, style',
    '',
    '## Workflow',
    '1. Always answer in two short lines.',
    '2. Use ${NEO_SKILL_DIR}/examples/template.md as the local template path.',
    '3. Keep ${CLAUDE_SKILL_DIR} compatible with CC-Source imports.',
    ''
  ].join('\n'), 'utf8');

  const skillPrompt = getSkillToolPrompt(await manager.loadSkills());
  assertIncludes(skillPrompt, 'answer-style');
  assertIncludes(skillPrompt, '先调用 Skill');

  const runner = new SkillToolRunner(manager);
  const events = [];
  let calls = 0;
  const model = {
    chatWithTools: async options => {
      calls += 1;
      if (calls === 1) {
        const skillTool = options.tools.find(tool => tool.function.name === 'Skill');
        if (!skillTool) throw new Error(`应该暴露 Skill 工具：${JSON.stringify(options.tools)}`);
        return {
          content: '',
          toolCalls: [{
            id: 'call_skill',
            type: 'function',
            function: { name: 'Skill', arguments: JSON.stringify({ skill: 'answer-style', args: '当前任务' }) }
          }]
        };
      }
      const last = options.messages.at(-1);
      if (last?.role !== 'tool') throw new Error(`第二轮模型调用前应该收到 Skill 工具结果：${JSON.stringify(last)}`);
      assertIncludes(last.content, 'answer-style');
      assertIncludes(last.content, 'Base directory for this skill');
      assertIncludes(last.content, 'Always answer in two short lines.');
      assertIncludes(last.content, '/examples/template.md');
      assertIncludes(last.content, '"path": "examples/template.md"');
      assertIncludes(last.content, '不会自动执行');
      if (last.content.includes('${NEO_SKILL_DIR}') || last.content.includes('${CLAUDE_SKILL_DIR}')) {
        throw new Error(`Skill 目录变量应该已经替换：${last.content}`);
      }
      if (last.content.includes('template body should not be in tool result')) {
        throw new Error('Skill 资源清单不应该直接读取资源正文。');
      }
      return { content: '已按 skill 回答', toolCalls: [] };
    },
    chat: async () => 'unused'
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, {
    maxToolRounds: 3,
    onToolEvent: event => events.push(event)
  });
  const result = await engine.run('main', [{ role: 'user', content: 'answer this with the style skill' }]);
  assertIncludes(result.text, '已按 skill 回答');
  if (result.skillToolCalls.length !== 1) throw new Error(`应该记录一次 Skill 调用：${JSON.stringify(result.skillToolCalls)}`);
  assertIncludes(result.skillToolCalls[0].skillName, 'answer-style');
  const usedSkill = (await manager.loadSkills()).find(skill => skill.name === 'answer-style');
  if (usedSkill?.usage?.usageCount !== 1 || usedSkill.usage.successCount !== 1) {
    throw new Error(`应该记录 Skill usage：${JSON.stringify(usedSkill?.usage)}`);
  }
  const listAfterUsage = await run(['skill', 'list', '--scope', 'project'], { cwd: projectRoot });
  assertIncludes(listAfterUsage.stdout, '使用=1');
  await writeFile(skillFile, [
    '# answer-style',
    '',
    'Description: Use a sharper answer style after edit',
    '',
    'Triggers: answer, style',
    '',
    '## Workflow',
    '1. Answer in one short paragraph after reload.',
    '2. Mention only verified facts.',
    ''
  ].join('\n'), 'utf8');
  const reloadedSkill = (await manager.loadSkills()).find(skill => skill.name === 'answer-style');
  assertIncludes(reloadedSkill?.description ?? '', 'sharper answer style');
  const changeSummary = manager.lastChangeSummary();
  if (!changeSummary.changed || changeSummary.updated.length === 0) {
    throw new Error(`应该检测到 skill 文件变化：${JSON.stringify(changeSummary)}`);
  }
  if (!events.some(event => event.phase === 'success' && event.name === 'Skill')) {
    throw new Error(`应该产生 Skill 成功事件：${JSON.stringify(events)}`);
  }
});

test('InstallSkillPackage tool 能从项目 zip 批量安装 skill', async () => {
  const projectRoot = path.join(tempHome, 'skill-install-tool-project');
  await mkdir(projectRoot, { recursive: true });
  const { zipSync, strToU8 } = await import('fflate');
  await writeFile(path.join(projectRoot, 'skills-main.zip'), Buffer.from(zipSync({
    'skills-main/one/SKILL.md': strToU8('---\nname: zip-one\ndescription: Zip one skill\ntriggers: one\n---\n\n# zip-one\n'),
    'skills-main/two/SKILL.md': strToU8('---\nname: zip-two\ndescription: Zip two skill\ntriggers: two\n---\n\n# zip-two\n')
  })));
  const { SkillManager } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillManager.js')).href);
  const { SkillToolRunner } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillToolRunner.js')).href);
  const { QueryEngine } = await import(pathToFileURL(path.join(root, 'dist', 'agent', 'queryEngine.js')).href);
  const manager = new SkillManager({ homeDir: tempHome, skills: { autoCreate: false, autoCreateThreshold: 3 } }, projectRoot);
  const runner = new SkillToolRunner(manager, projectRoot);
  let calls = 0;
  const model = {
    chatWithTools: async options => {
      calls += 1;
      if (calls > 2) throw new Error(`终止型安装工具成功后不应该继续进入第 ${calls} 轮工具调用`);
      if (calls === 1) {
        const installTool = options.tools.find(tool => tool.function.name === 'InstallSkillPackage');
        if (!installTool) throw new Error(`应该暴露 InstallSkillPackage 工具：${JSON.stringify(options.tools)}`);
        if ('dry_run' in installTool.function.parameters.properties) {
          throw new Error(`对话内安装工具不应该向模型暴露 dry_run：${JSON.stringify(installTool)}`);
        }
        return {
          content: '',
          toolCalls: [{
            id: 'call_install_skill_package',
            type: 'function',
            function: { name: 'InstallSkillPackage', arguments: JSON.stringify({ source: '@skills-main.zip' }) }
          }]
        };
      }
      if (options.toolChoice !== 'none') throw new Error(`安装工具完成后应该强制最终回答，不再开放工具：${JSON.stringify(options.toolChoice)}`);
      const last = options.messages.at(-1);
      const toolResult = options.messages.findLast(message => message.role === 'tool');
      if (!toolResult) throw new Error(`第二轮模型调用前应该收到安装工具结果：${JSON.stringify(options.messages)}`);
      if (last?.role !== 'user') throw new Error(`终止型工具后应该追加最终回答提示：${JSON.stringify(last)}`);
      assertIncludes(last.content, '不要继续调用工具');
      assertIncludes(toolResult.content, '"installedCount": 2');
      assertIncludes(toolResult.content, 'zip-one');
      assertIncludes(toolResult.content, 'zip-two');
      return { content: '已安装 zip-one 和 zip-two', toolCalls: [] };
    },
    chat: async () => 'unused'
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new QueryEngine({ get: () => model }, [runner], logger, { maxToolRounds: 3 });
  const result = await engine.run('main', [{ role: 'user', content: '@skills-main.zip 安装这个包里所有skill' }]);
  assertIncludes(result.text, '已安装');
  if (result.skillToolCalls.length !== 1 || result.skillToolCalls[0].installedCount !== 2) {
    throw new Error(`应该记录一次批量安装 Skill 调用：${JSON.stringify(result.skillToolCalls)}`);
  }
  const installed = await manager.loadSkills();
  assertIncludes(installed.map(skill => skill.name).join(','), 'zip-one');
  assertIncludes(installed.map(skill => skill.name).join(','), 'zip-two');
  const repeated = await runner.execute({
    id: 'call_install_skill_package_again',
    type: 'function',
    function: { name: 'InstallSkillPackage', arguments: JSON.stringify({ source: 'skills-main.zip', dry_run: true }) }
  });
  assertIncludes(repeated.content, 'already_installed');
  assertIncludes(repeated.content, '"installedCount": 0');
  assertIncludes(repeated.content, 'zip-one');
  if (!repeated.terminal) throw new Error('重复安装已存在 skill 时也应该是终止型工具结果。');
});

test('REPL 常用命令不触发模型也能运行', async () => {
  const result = await run([], {
    input: [
      '/help',
      '/status',
      '/capabilities',
      '/assess 阅读 README 并总结',
      '/debug on',
      '/debug last',
      '/debug off',
      '/remember --type workflow --tag cli --pin 我喜欢简洁直接的回答',
      '/memory --type workflow 简洁',
      '/memory-export 5',
      '/skill create repl-skill :: REPL skill description',
      '/skill show repl-skill',
      '/skill path repl-skill',
      '/skill delete repl-skill',
      '/logs 5',
      '/transcript 20',
      '/transcripts 5',
      '/resume latest',
      '/usage',
      '/exit',
      ''
    ].join('\n')
  });
  assertIncludes(result.stdout, '/help                 查看命令');
  assertIncludes(result.stdout, '换行                 当前推荐');
  assertIncludes(result.stdout, 'neo REPL 状态');
  assertIncludes(result.stdout, 'neo capabilities @');
  assertIncludes(result.stdout, 'runtime tools:');
  assertIncludes(result.stdout, 'neo task assessment @');
  assertIncludes(result.stdout, 'feasibility: complete');
  assertIncludes(result.stdout, 'debug 已开启');
  assertIncludes(result.stdout, 'debug 暂无最近一轮对话');
  assertIncludes(result.stdout, '已记住');
  assertIncludes(result.stdout, '置顶 workflow');
  assertIncludes(result.stdout, '我喜欢简洁直接的回答');
  assertIncludes(result.stdout, '"category": "workflow"');
  assertIncludes(result.stdout, 'REPL skill description');
  assertIncludes(result.stdout, '已删除 skill');
  assertIncludes(result.stdout, 'transcripts');
  assertIncludes(result.stdout, '/resume [session]');
  assertIncludes(result.stdout, '/capabilities');
  assertIncludes(result.stdout, '/assess <任务>');
  assertIncludes(result.stdout, '/usage [天数]');
  assertIncludes(result.stdout, '/tmp/neo-agent-smoke-');
  assertIncludes(result.stdout, 'neo usage');
});

test('REPL 会根据终端环境提示多行输入方式', async () => {
  const { detectTerminalMultilineSupport } = await import(pathToFileURL(path.join(root, 'dist', 'terminal', 'repl.js')));
  const wezterm = detectTerminalMultilineSupport({
    WEZTERM_PANE: '1',
    TERM_PROGRAM: '',
    TERM: 'xterm-256color'
  });
  if (wezterm.name !== 'WezTerm') throw new Error(`应识别 WezTerm，实际 ${wezterm.name}`);
  assertIncludes(wezterm.recommended.join(' / '), 'Ctrl+Enter / Alt+Enter / Ctrl+J');

  const sshUnknown = detectTerminalMultilineSupport({
    TERM_PROGRAM: '',
    TERM: 'xterm-256color',
    SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22'
  });
  if (sshUnknown.name !== 'SSH 远程会话（本地终端未知）') throw new Error(`应识别 SSH unknown，实际 ${sshUnknown.name}`);
  assertIncludes(sshUnknown.recommended.join(' / '), 'Ctrl+Enter / Ctrl+J');
  assertIncludes(sshUnknown.note, '主动开启 Kitty keyboard protocol');

  const powerShell = detectTerminalMultilineSupport({
    TERM_PROGRAM: '',
    TERM: 'xterm-256color',
    SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22',
    NEO_AGENT_TERMINAL: 'powershell'
  });
  if (powerShell.name !== 'PowerShell over SSH') throw new Error(`应识别 PowerShell over SSH，实际 ${powerShell.name}`);
  assertIncludes(powerShell.recommended.join(' / '), 'Ctrl+Enter / Ctrl+J');
  assertIncludes(powerShell.note, 'Alt+Enter 在 PowerShell');
});

test('transcripts 命令能列出会话', async () => {
  const result = await run(['transcripts', '--limit', '5']);
  assertIncludes(result.stdout, 'session_');
});

test('usage 命令能展示模型成本统计视图', async () => {
  const usageDir = path.join(tempHome, 'usage');
  await mkdir(usageDir, { recursive: true });
  await writeFile(path.join(usageDir, 'model-usage.jsonl'), `${JSON.stringify({
    id: 'usage_test',
    ts: new Date().toISOString(),
    modelKind: 'main',
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCost: 0,
    pricingConfigured: false
  })}\n`, 'utf8');
  const result = await run(['usage']);
  assertIncludes(result.stdout, 'neo usage');
  assertIncludes(result.stdout, 'test-model');
  assertIncludes(result.stdout, '未配置单价');
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
    NEO_AGENT_LOG_RETENTION_DAYS: '14',
    ...(options.env ?? {})
  };

  const result = await new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], {
      cwd: options.cwd ?? root,
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

async function assertRejects(fn, expectedMessage) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertIncludes(message, expectedMessage);
    return;
  }
  throw new Error(`期望异步抛出包含 ${JSON.stringify(expectedMessage)} 的错误，但函数正常返回。`);
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
