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

test('项目文件工具只能读取项目内文件并支持 Glob/Grep', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'neo-agent-files-'));
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const answer = 42;\nconsole.log(answer);\n', 'utf8');
  await writeFile(path.join(projectDir, 'README.md'), '# Demo\nanswer lives in src/app.ts\n', 'utf8');
  try {
    const { FileToolRunner, GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } = await import(pathToFileURL(path.join(root, 'dist', 'files', 'fileTools.js')).href);
    const runner = new FileToolRunner(projectDir);
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
    assertIncludes(grep.content, 'answer');

    await assertRejects(() => runner.execute({
      id: 'read_2',
      type: 'function',
      function: { name: READ_TOOL_NAME, arguments: JSON.stringify({ file_path: '/etc/passwd' }) }
    }), '当前项目目录');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
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

test('MCP 高风险工具在 REPL 可走一次性授权', async () => {
  const { McpToolRunner } = await import(pathToFileURL(path.join(root, 'dist', 'mcp', 'mcpToolRunner.js')).href);
  const calls = [];
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
  const runner = new McpToolRunner(mcp, { mode: 'readOnly', allowedTools: [], deniedTools: [] }, 20);
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

test('MCP 配置命令能添加、列出和删除 server', async () => {
  const add = await run(['mcp', 'add', '--env', 'TOKEN=secret', 'demo', '--', 'node', 'server.js', '--flag']);
  assertIncludes(add.stdout, '已添加 MCP server：demo');
  assertIncludes(add.stdout, 'env=1');

  const list = await run(['mcp', 'list']);
  assertIncludes(list.stdout, 'demo: node server.js --flag env=1');

  const json = await run(['mcp', 'list', '--json']);
  assertIncludes(json.stdout, '"name": "demo"');
  assertIncludes(json.stdout, '"TOKEN": "secret"');

  const remove = await run(['mcp', 'remove', 'demo']);
  assertIncludes(remove.stdout, '已删除 MCP server：demo');

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
  const { buildSkillInstallPlan } = await import(pathToFileURL(path.join(root, 'dist', 'skills', 'skillPackage.js')).href);
  const evilZip = zipSync({
    '../evil/SKILL.md': strToU8('# evil\n\nDescription: bad\n')
  });
  await writeFile(path.join(tempHome, 'evil.zip'), Buffer.from(evilZip));
  await assertRejects(() => buildSkillInstallPlan({ source: path.join(tempHome, 'evil.zip') }), '不安全');
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
      assertIncludes(last.content, 'Always answer in two short lines.');
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
  const skillFile = path.join(projectRoot, '.neo-agent', 'skills', 'answer-style', 'SKILL.md');
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

test('REPL 常用命令不触发模型也能运行', async () => {
  const result = await run([], {
    input: [
      '/help',
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
      '/exit',
      ''
    ].join('\n')
  });
  assertIncludes(result.stdout, '/help                 查看命令');
  assertIncludes(result.stdout, '已记住');
  assertIncludes(result.stdout, '置顶 workflow');
  assertIncludes(result.stdout, '我喜欢简洁直接的回答');
  assertIncludes(result.stdout, '"category": "workflow"');
  assertIncludes(result.stdout, 'REPL skill description');
  assertIncludes(result.stdout, '已删除 skill');
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
