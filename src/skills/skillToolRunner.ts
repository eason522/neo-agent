import { z } from 'zod';
import type { ChatToolCall, ChatToolDefinition, Skill, SkillToolCallRecord } from '../types.js';
import type { ToolExecutionOptions, ToolRunner } from '../tools/tool.js';
import { throwIfAborted } from '../utils/abort.js';
import { sanitizeName } from '../utils/fs.js';
import type { SkillManager } from './skillManager.js';

export const SKILL_TOOL_NAME = 'Skill';

const skillListingBudgetChars = 8000;
const maxListingDescriptionChars = 250;
const maxSkillBodyChars = 100_000;

const skillInputSchema = z.object({
  skill: z.string().min(1),
  args: z.string().optional()
});

export class SkillToolRunner implements ToolRunner<SkillToolCallRecord> {
  private skills: Skill[] = [];

  constructor(private readonly manager: SkillManager) {}

  async refresh(): Promise<void> {
    this.skills = await this.manager.loadSkills();
  }

  definitions(): ChatToolDefinition[] {
    const callableSkills = this.callableSkills();
    if (callableSkills.length === 0) return [];
    return [{
      type: 'function',
      function: {
        name: SKILL_TOOL_NAME,
        description: [
          '加载一个已安装 skill 的完整说明，让你在主对话中按该 skill 的流程完成任务。',
          '当用户任务匹配可用 skill 时，必须先调用这个工具，再基于返回的 SKILL.md 内容继续回答。',
          '这个工具只读取 skill 内容，不执行 shell、hook 或外部动作。'
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skill: {
              type: 'string',
              description: 'skill 名称，可带或不带开头的 /。例如 writer-helper。'
            },
            args: {
              type: 'string',
              description: '可选。用户给这个 skill 的额外参数或当前任务摘要。'
            }
          },
          required: ['skill']
        }
      }
    }];
  }

  canExecute(name: string): boolean {
    return name === SKILL_TOOL_NAME && this.callableSkills().length > 0;
  }

  async execute(call: ChatToolCall, options: ToolExecutionOptions = {}): Promise<{ content: string; record: SkillToolCallRecord }> {
    throwIfAborted(options.signal);
    const start = Date.now();
    const input = skillInputSchema.parse(parseJsonObject(call.function.arguments));
    const normalizedName = normalizeSkillName(input.skill);
    const skill = this.findSkill(normalizedName);
    if (!skill) throw new Error(`Unknown skill: ${normalizedName}`);
    if (skill.disableModelInvocation) throw new Error(`Skill ${normalizedName} 禁止模型自动调用。`);

    const content = truncate(JSON.stringify({
      tool: SKILL_TOOL_NAME,
      skill: {
        name: skill.name,
        scope: skill.scope,
        description: skill.description,
        whenToUse: skill.whenToUse,
        triggers: skill.triggers,
        skillDir: skill.path
      },
      args: input.args,
      body: skill.body,
      instruction: [
        '这个 skill 已经加载到当前轮次。不要再次调用 Skill 读取同一个 skill。',
        '请严格参考 body 中的流程、约束和风格完成用户任务。',
        'skill 中的 shell、hook 或命令片段不会自动执行；如需执行外部动作，必须通过已授权工具或向用户说明。'
      ].join(' ')
    }, null, 2), maxSkillBodyChars);

    return {
      content,
      record: {
        name: SKILL_TOOL_NAME,
        skillName: skill.name,
        scope: skill.scope,
        bodyChars: skill.body.length,
        resultChars: content.length,
        durationMs: Date.now() - start
      }
    };
  }

  callableSkills(): Skill[] {
    return this.skills.filter(skill => !skill.disableModelInvocation);
  }

  private findSkill(name: string): Skill | undefined {
    const safeName = sanitizeName(name);
    return this.callableSkills().find(skill => skill.name === safeName || skill.name === name);
  }
}

export function getSkillToolPrompt(skills: Skill[]): string {
  const callableSkills = skills.filter(skill => !skill.disableModelInvocation);
  if (callableSkills.length === 0) {
    return [
      '# Skill 工具',
      '- 当前没有可由模型调用的 skill。',
      '- 如果发现任务会重复出现，或用户明确要求沉淀流程，可以建议创建 skill。'
    ].join('\n');
  }

  return [
    '# Skill 工具',
    '- 可用 skill 列在下面。列表只用于发现；完整 `SKILL.md` 正文必须通过 Skill 工具按需加载。',
    '- 当用户任务匹配某个 skill 时，调用 Skill 是阻塞要求：先调用 Skill，再继续完成任务。',
    '- 不要只提到某个 skill 却不调用它；不要为内置 CLI 命令调用 Skill。',
    '- 如果当前轮次的工具结果已经返回某个 skill 的正文，直接遵循正文，不要重复调用同一个 skill。',
    '- Skill 工具只读取说明，不执行 shell、hook 或外部动作。',
    '',
    '可用 skill：',
    formatSkillsWithinBudget(callableSkills)
  ].join('\n');
}

function formatSkillsWithinBudget(skills: Skill[]): string {
  const sorted = [...skills].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lines: string[] = [];
  let used = 0;
  for (const skill of sorted) {
    const line = formatSkillListing(skill);
    const nextUsed = used + line.length + (lines.length > 0 ? 1 : 0);
    if (nextUsed > skillListingBudgetChars) {
      lines.push(`- [已省略 ${sorted.length - lines.length} 个 skill，列表超出预算]`);
      break;
    }
    lines.push(line);
    used = nextUsed;
  }
  return lines.join('\n');
}

function formatSkillListing(skill: Skill): string {
  const description = truncateInline([skill.description, skill.whenToUse].filter(Boolean).join(' - '), maxListingDescriptionChars);
  const triggers = skill.triggers.length > 0 ? ` triggers=${skill.triggers.join(',')}` : '';
  return `- ${skill.name} (${skill.scope}): ${description}${triggers}`;
}

function normalizeSkillName(input: string): string {
  return input.trim().replace(/^\/+/, '');
}

function parseJsonObject(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments || '{}');
  } catch {
    throw new Error(`Skill 工具参数不是有效 JSON，参数长度 ${rawArguments.length} 字符。`);
  }
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}

function truncateInline(input: string, maxChars: number): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
