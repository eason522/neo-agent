import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, ToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolExecutionResult, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import type { CapabilitySnapshot } from './capabilities.js';

export const TASK_ASSESSMENT_TOOL_NAME = 'TaskAssessment';

export type TaskFeasibility = 'complete' | 'partial' | 'blocked';
export type TaskAssessmentConfidence = 'high' | 'medium' | 'low';

export type RequiredCapability = {
  id: string;
  label: string;
  reason: string;
};

export type MissingCapability = {
  id: string;
  label: string;
  impact: string;
  workaround?: string;
};

export type TaskAssessmentResult = {
  task: string;
  feasibility: TaskFeasibility;
  confidence: TaskAssessmentConfidence;
  requiredCapabilities: RequiredCapability[];
  availableCapabilities: string[];
  missingCapabilities: MissingCapability[];
  constraints: string[];
  recommendedStrategy: string[];
  shouldProceed: boolean;
  needsUserInput: boolean;
  userInputNeeded: string[];
  snapshotGeneratedAt: string;
};

const inputSchema = z.object({
  task: z.string().min(1),
  include_capabilities: z.boolean().optional()
});

type CapabilityRule = {
  id: string;
  label: string;
  patterns: RegExp[];
  reason: string;
};

const capabilityRules: CapabilityRule[] = [
  {
    id: 'file_read',
    label: '读取/检索项目文件',
    patterns: [
      /读(取)?|查看|检查|分析|总结|搜索|检索|定位|浏览|打开/,
      /\b(read|inspect|analy[sz]e|summari[sz]e|search|grep|find|review)\b/i,
      /\b(readme|package\.json|tsconfig|src\/|文件|代码|仓库|项目)\b/i
    ],
    reason: '任务需要读取或检索本地项目内容。'
  },
  {
    id: 'file_write',
    label: '写入/修改项目文件',
    patterns: [
      /改|修改|修复|实现|新增|创建|写入|删除|重构|接入|补齐|更新|落地/,
      /\b(write|edit|modify|fix|implement|create|delete|refactor|update|add)\b/i
    ],
    reason: '任务需要创建或修改本地项目文件。'
  },
  {
    id: 'web_search',
    label: '联网查询公开信息',
    patterns: [
      /联网|搜索网页|查(一下|资料|文档|新闻|价格|版本|最新|官网)|今天|现在|当前|实时|最新/,
      /\b(web|search|browse|fetch|latest|current|today|news|price|version|docs?)\b/i,
      /https?:\/\//i
    ],
    reason: '任务可能依赖公开网页或时效性信息。'
  },
  {
    id: 'shell',
    label: '执行终端命令',
    patterns: [
      /运行|执行|测试|构建|编译|安装依赖|启动服务|跑(一下)?|命令行|终端/,
      /\b(run|execute|test|build|compile|install|start|serve|npm|pnpm|yarn|node|python|git|shell|terminal|command)\b/i
    ],
    reason: '任务要求在本机执行命令、测试、构建或服务。'
  },
  {
    id: 'external_api',
    label: '调用外部 API / 已连接服务',
    patterns: [
      /调用.*api|外部 api|发到|发送到|发布|部署|创建 issue|提 pr|数据库|slack|notion|jira|github/,
      /\b(api|deploy|publish|database|db|slack|notion|jira|github|pull request|issue)\b/i
    ],
    reason: '任务可能需要通过 MCP 或外部服务完成动作。'
  },
  {
    id: 'sub_agent',
    label: '启动 sub-agent 并行处理',
    patterns: [
      /sub-?agent|子任务|后台|并行|分工|委托/,
      /\b(subagent|sub-agent|background|parallel|delegate)\b/i
    ],
    reason: '任务提到后台、并行或委托给子 agent。'
  },
  {
    id: 'hooks',
    label: '执行外部 hook',
    patterns: [
      /hook|钩子|回调|自动触发/,
      /\b(hook|callback|trigger)\b/i
    ],
    reason: '任务提到 hook 或自动触发动作。'
  },
  {
    id: 'image_generation',
    label: '生成或编辑图片',
    patterns: [
      /生成图片|画图|出图|编辑图片|改图|海报|插画/,
      /\b(generate|edit).*\b(image|picture|poster|illustration)\b/i
    ],
    reason: '任务需要图片生成或图片编辑能力。'
  },
  {
    id: 'vision',
    label: '理解图片附件',
    patterns: [
      /看图|截图|图片里|图中|识别图片|附件图片/,
      /\b(screenshot|image attachment|look at this image|vision)\b/i
    ],
    reason: '任务需要模型理解用户提供的图片附件。'
  },
  {
    id: 'skill',
    label: '加载或使用 skill',
    patterns: [
      /skill|技能|工作流|沉淀/,
      /\b(skill|workflow)\b/i
    ],
    reason: '任务涉及 skill 或可复用工作流。'
  }
];

export class TaskAssessmentToolRunner implements ToolRunner<ToolCallRecord> {
  constructor(private readonly snapshotProvider: () => Promise<CapabilitySnapshot>) {}

  definitions(): ChatToolDefinition[] {
    return [{
      type: 'function',
      function: {
        name: TASK_ASSESSMENT_TOOL_NAME,
        description: [
          '基于 neo 当前运行时能力快照评估用户任务是否可完成。',
          '返回 complete/partial/blocked、所需能力、缺失能力、约束、推荐策略和需要用户补充的信息。',
          '当用户给出复杂任务、询问能否完成、或任务可能依赖 shell/MCP/Web/文件写入等能力时，应先调用此工具再规划。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['task'],
          properties: {
            task: {
              type: 'string',
              description: '需要评估的用户任务原文。'
            },
            include_capabilities: {
              type: 'boolean',
              description: '是否在结果中包含可用能力摘要。默认 true。'
            }
          }
        }
      }
    }];
  }

  canExecute(name: string): boolean {
    return name === TASK_ASSESSMENT_TOOL_NAME;
  }

  executionMode(): 'parallel' {
    return 'parallel';
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult<ToolCallRecord>> {
    throwIfAborted(options.signal);
    const input = inputSchema.parse(parseJsonObject(call.function.arguments));
    const assessment = assessTaskAgainstCapabilities(input.task, await this.snapshotProvider());
    return {
      content: JSON.stringify(input.include_capabilities === false ? compactAssessment(assessment) : assessment, null, 2)
    };
  }
}

export function assessTaskAgainstCapabilities(task: string, snapshot: CapabilitySnapshot): TaskAssessmentResult {
  const required = inferRequiredCapabilities(task);
  const missing: MissingCapability[] = [];
  const available: string[] = [];
  const constraints = [...snapshot.limitations];

  for (const capability of required) {
    const availability = capabilityAvailability(capability.id, snapshot);
    if (availability.available) available.push(capability.id);
    else missing.push({
      id: capability.id,
      label: capability.label,
      impact: availability.impact,
      workaround: availability.workaround
    });
    if (availability.constraint) constraints.push(availability.constraint);
  }

  const feasibility = decideFeasibility(required, missing);
  const userInputNeeded = buildUserInputNeeded(required, missing, snapshot);
  return {
    task,
    feasibility,
    confidence: inferConfidence(task, required),
    requiredCapabilities: required,
    availableCapabilities: available,
    missingCapabilities: missing,
    constraints: [...new Set(constraints)],
    recommendedStrategy: buildRecommendedStrategy(feasibility, required, missing, snapshot),
    shouldProceed: feasibility !== 'blocked',
    needsUserInput: userInputNeeded.length > 0,
    userInputNeeded,
    snapshotGeneratedAt: snapshot.generatedAt
  };
}

export function formatTaskAssessment(result: TaskAssessmentResult): string {
  const lines = [
    `neo task assessment @ ${result.snapshotGeneratedAt}`,
    `task: ${result.task}`,
    `feasibility: ${result.feasibility} confidence=${result.confidence}`,
    `shouldProceed: ${result.shouldProceed ? 'yes' : 'no'}`,
    `required: ${result.requiredCapabilities.map(item => `${item.id}(${item.label})`).join(', ') || '(none)'}`,
    `available: ${result.availableCapabilities.join(', ') || '(none)'}`,
    result.missingCapabilities.length > 0
      ? `missing:\n${result.missingCapabilities.map(item => `- ${item.id}: ${item.impact}${item.workaround ? ` workaround=${item.workaround}` : ''}`).join('\n')}`
      : 'missing: (none)',
    result.userInputNeeded.length > 0
      ? `user input needed:\n${result.userInputNeeded.map(item => `- ${item}`).join('\n')}`
      : '',
    result.recommendedStrategy.length > 0
      ? `strategy:\n${result.recommendedStrategy.map(item => `- ${item}`).join('\n')}`
      : '',
    result.constraints.length > 0
      ? `constraints:\n${result.constraints.map(item => `- ${item}`).join('\n')}`
      : ''
  ];
  return lines.filter(Boolean).join('\n');
}

export function getTaskAssessmentPrompt(): string {
  return [
    '# Task Assessment',
    '- 当用户给出需要规划或执行的复杂任务，尤其涉及文件写入、测试/构建、终端命令、联网、MCP/API、图片、hook、sub-agent，先调用 TaskAssessment 评估可行性。',
    '- 如果 TaskAssessment 返回 partial 或 blocked，先向用户说明缺失能力和可行替代路径，再继续能完成的部分。',
    '- 不要把 TaskAssessment 当成最终答案；它是规划前的运行时约束检查。'
  ].join('\n');
}

function inferRequiredCapabilities(task: string): RequiredCapability[] {
  const matched = capabilityRules.filter(rule => rule.patterns.some(pattern => pattern.test(task)));
  if (matched.length === 0) {
    return [{
      id: 'reasoning',
      label: '文本推理与回答',
      reason: '任务没有明显要求外部工具，默认可通过模型推理回答。'
    }];
  }
  const inferred = matched.map(rule => ({
    id: rule.id,
    label: rule.label,
    reason: rule.reason
  }));
  if (inferred.some(item => item.id === 'file_write') && !inferred.some(item => item.id === 'file_read')) {
    const fileRead = capabilityRules.find(rule => rule.id === 'file_read');
    if (fileRead) inferred.unshift({
      id: fileRead.id,
      label: fileRead.label,
      reason: '修改文件前需要先读取相关项目内容。'
    });
  }
  return dedupeCapabilities(inferred);
}

function capabilityAvailability(id: string, snapshot: CapabilitySnapshot): { available: boolean; impact: string; workaround?: string; constraint?: string } {
  if (id === 'reasoning') return { available: true, impact: '' };
  if (id === 'file_read') {
    return snapshot.files.canRead
      ? { available: true, impact: '' }
      : { available: false, impact: '当前没有 Read/Glob/Grep 文件读取工具。', workaround: '请用户粘贴相关文件内容。' };
  }
  if (id === 'file_write') {
    if (!snapshot.files.canWrite) return { available: false, impact: '当前没有 Write/Edit 文件写入工具。', workaround: '输出补丁或修改建议，由用户手动应用。' };
    if (!snapshot.files.writeConfirmationAvailable) {
      return {
        available: true,
        impact: '',
        constraint: `当前入口没有写入确认回调；可直接写入 workspace (${snapshot.files.workspaceDir})，写入项目其它位置需要改在 REPL 中确认。`
      };
    }
    return { available: true, impact: '', constraint: `workspace (${snapshot.files.workspaceDir}) 内写入无需额外确认；写入项目其它位置或额外授权目录需要确认。` };
  }
  if (id === 'web_search') {
    return snapshot.web.enabled
      ? { available: true, impact: '' }
      : { available: false, impact: '当前 WebSearch/WebFetch 未启用或缺少 API key。', workaround: '请用户提供资料链接/内容，或配置 Web API key 后重试。' };
  }
  if (id === 'shell') {
    if (snapshot.execution.tools.length === 0) {
      return { available: false, impact: '当前 neo 没有 Bash/Python 执行工具。', workaround: '输出需要用户执行的命令，或由用户提供命令输出后继续分析。' };
    }
    if (!snapshot.execution.confirmationAvailable) {
      return {
        available: false,
        impact: 'Bash/Python 工具可用，但当前入口没有执行确认回调；只能自动执行只读低风险 Bash，高风险 Bash 和 Python 会被拒绝。',
        workaround: '在交互式 REPL/TUI 中执行需要确认的命令，或让用户手动运行命令并回传输出。'
      };
    }
    return { available: true, impact: '', constraint: `Bash/Python 在 workspace (${snapshot.execution.cwd}) 内执行；只读 Bash 自动允许，高风险 Bash 和 Python 需要确认。` };
  }
  if (id === 'external_api') {
    return snapshot.mcp.visibleTools.length > 0
      ? { available: true, impact: '', constraint: `只能调用已连接且可见的 MCP 工具：${snapshot.mcp.visibleTools.slice(0, 12).join(', ')}${snapshot.mcp.visibleTools.length > 12 ? '...' : ''}` }
      : { available: false, impact: '当前没有已连接 MCP 工具或外部 API 工具。', workaround: '配置对应 MCP server，或让用户在外部系统中完成动作。' };
  }
  if (id === 'sub_agent') {
    return snapshot.subAgents.available
      ? { available: true, impact: '', constraint: `sub-agent 工具隔离模式：${snapshot.subAgents.toolIsolation}。` }
      : { available: false, impact: '当前没有 sub-agent 能力。' };
  }
  if (id === 'hooks') {
    return snapshot.hooks.externalExecutionEnabled
      ? { available: true, impact: '' }
      : { available: false, impact: 'Hooks 当前只记录内部事件，不执行外部 hook。', workaround: '先实现 hook 执行器或改用手动命令。' };
  }
  if (id === 'image_generation') {
    return { available: false, impact: '当前 neo 没有图片生成/编辑工具。', workaround: '输出图片 prompt、设计说明或接入图片生成工具。' };
  }
  if (id === 'vision') return { available: true, impact: '', constraint: '图片理解依赖用户提供有效图片附件。' };
  if (id === 'skill') {
    return snapshot.skills.callable > 0
      ? { available: true, impact: '' }
      : { available: false, impact: '当前没有可调用 skill。', workaround: '先创建或安装相关 skill。' };
  }
  return { available: false, impact: `未知能力：${id}` };
}

function decideFeasibility(required: RequiredCapability[], missing: MissingCapability[]): TaskFeasibility {
  if (missing.length === 0) return 'complete';
  if (missing.length === required.length) return 'blocked';
  return 'partial';
}

function inferConfidence(task: string, required: RequiredCapability[]): TaskAssessmentConfidence {
  if (required.length === 1 && required[0]?.id === 'reasoning') return 'medium';
  if (task.length < 8) return 'low';
  return 'high';
}

function buildUserInputNeeded(required: RequiredCapability[], missing: MissingCapability[], snapshot: CapabilitySnapshot): string[] {
  const needs: string[] = [];
  if (missing.some(item => item.id === 'shell')) needs.push('需要用户执行测试/构建/命令并把输出贴回来，或接受不运行命令的静态分析结果。');
  if (required.some(item => item.id === 'shell') && snapshot.execution.tools.length > 0 && !snapshot.execution.confirmationAvailable) needs.push('高风险 Bash 和 Python 需要交互确认；当前入口没有确认回调时只能自动执行只读 Bash。');
  if (missing.some(item => item.id === 'web_search')) needs.push('需要用户提供相关网页、文档内容，或配置 Web API key。');
  if (missing.some(item => item.id === 'external_api')) needs.push('需要用户配置对应 MCP server/API 工具，或手动完成外部系统动作。');
  if (missing.some(item => item.id === 'file_write') && snapshot.files.canWrite) needs.push(`如果必须写入 workspace (${snapshot.files.workspaceDir}) 之外的位置，需要进入支持交互确认的 REPL，或允许 neo 只输出补丁。`);
  if (required.some(item => item.id === 'vision')) needs.push('需要用户附加可读取的图片文件。');
  return needs;
}

function buildRecommendedStrategy(feasibility: TaskFeasibility, required: RequiredCapability[], missing: MissingCapability[], snapshot: CapabilitySnapshot): string[] {
  if (feasibility === 'complete') {
    return [
      '直接按任务执行；执行前仍应按需读取相关文件或调用对应工具确认事实。',
      required.some(item => item.id === 'file_write') ? `涉及写入时优先落在 workspace (${snapshot.files.workspaceDir})；若要改项目其它位置，先说明将修改的文件并等待写入确认。` : ''
    ].filter(Boolean);
  }
  const strategy = ['先完成当前能力可覆盖的部分，并明确标注未验证或需用户配合的部分。'];
  if (missing.some(item => item.id === 'shell')) strategy.push('不能本地运行命令时，提供命令清单和预期输出检查点，让用户回传结果。');
  if (missing.some(item => item.id === 'file_write') && snapshot.files.canWrite) strategy.push(`当前入口不能确认 workspace (${snapshot.files.workspaceDir}) 之外的写入时，优先输出补丁或让用户切到 REPL。`);
  if (missing.some(item => item.id === 'web_search')) strategy.push('缺少联网时，只使用本地上下文；涉及时效性信息必须声明未联网。');
  if (missing.some(item => item.id === 'external_api')) strategy.push('外部系统动作改为生成请求内容、配置建议或操作步骤。');
  if (feasibility === 'blocked') strategy.push('在用户补齐缺失能力或输入前，不应声称已经完成任务。');
  return strategy;
}

function dedupeCapabilities(items: RequiredCapability[]): RequiredCapability[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compactAssessment(result: TaskAssessmentResult): Partial<TaskAssessmentResult> {
  return {
    task: result.task,
    feasibility: result.feasibility,
    confidence: result.confidence,
    requiredCapabilities: result.requiredCapabilities,
    missingCapabilities: result.missingCapabilities,
    recommendedStrategy: result.recommendedStrategy,
    shouldProceed: result.shouldProceed,
    needsUserInput: result.needsUserInput,
    userInputNeeded: result.userInputNeeded,
    snapshotGeneratedAt: result.snapshotGeneratedAt
  };
}

function parseJsonObject(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JSON object')) throw error;
    throw new Error(`TaskAssessment 参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}
