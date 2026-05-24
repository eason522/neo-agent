import path from 'node:path';
import type { AppConfig, ChatMessage, MemoryCategory, MemoryRecord, TextModelKind } from '../types.js';
import type { Logger } from '../logging/logger.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import { TranscriptService, tailFile, type TranscriptSessionSummary } from '../transcript/transcriptService.js';
import { readJsonFile, stableId, writeJsonFile } from '../utils/fs.js';

type DreamState = {
  lastDreamedAt?: string;
  lastReportPath?: string;
};

type DreamUpsert = {
  category: MemoryCategory;
  content: string;
  tags?: string[];
  pinned?: boolean;
  reason?: string;
};

type DreamArchive = {
  id: string;
  reason?: string;
};

type DreamPlan = {
  summary: string;
  upserts: DreamUpsert[];
  archives: DreamArchive[];
  insights: string[];
};

export type DreamRunOptions = {
  dryRun?: boolean;
  force?: boolean;
  maxSessions?: number;
  modelKind?: TextModelKind;
};

export type DreamRunResult = {
  status: 'skipped' | 'completed';
  reason?: string;
  dryRun: boolean;
  reportPath?: string;
  summary?: string;
  upserts: DreamUpsert[];
  archives: DreamArchive[];
  insights: string[];
  reviewedSessions: number;
  reviewedMemories: number;
};

export class DreamService {
  private readonly statePath: string;
  private readonly reportsDir: string;

  constructor(
    private readonly config: AppConfig,
    private readonly models: ModelRegistry,
    private readonly memory: MemoryService,
    private readonly logger?: Logger
  ) {
    this.statePath = path.join(config.homeDir, 'dream', 'state.json');
    this.reportsDir = path.join(config.homeDir, 'dream', 'reports');
  }

  async maybeRunScheduled(): Promise<DreamRunResult> {
    if (!this.config.dreaming.enabled) {
      return skipped('dreaming 未启用');
    }

    const state = await this.readState();
    const lastDreamedAt = state.lastDreamedAt ? Date.parse(state.lastDreamedAt) : 0;
    const hoursSince = (Date.now() - lastDreamedAt) / 3_600_000;
    if (lastDreamedAt > 0 && hoursSince < this.config.dreaming.minHours) {
      return skipped(`距离上次 dreaming 只有 ${hoursSince.toFixed(1)} 小时`);
    }

    const sessions = await this.recentSessionsSince(lastDreamedAt);
    if (sessions.length < this.config.dreaming.minSessions) {
      return skipped(`新会话数量 ${sessions.length}，未达到 ${this.config.dreaming.minSessions}`);
    }

    return this.run({
      dryRun: false,
      force: true,
      maxSessions: this.config.dreaming.maxSessions,
      modelKind: this.config.dreaming.modelKind
    });
  }

  async run(options: DreamRunOptions = {}): Promise<DreamRunResult> {
    const dryRun = options.dryRun ?? false;
    const state = await this.readState();
    const lastDreamedAt = state.lastDreamedAt ? Date.parse(state.lastDreamedAt) : 0;
    const sessions = options.force
      ? await this.recentSessions(options.maxSessions ?? this.config.dreaming.maxSessions)
      : await this.recentSessionsSince(lastDreamedAt);
    const selectedSessions = sessions.slice(0, options.maxSessions ?? this.config.dreaming.maxSessions);
    const memories = await this.memory.list(this.config.dreaming.maxMemories);

    if (selectedSessions.length === 0 && memories.length === 0) {
      return skipped('没有可整理的 transcript 或记忆');
    }

    const transcriptContext = await this.readTranscriptContext(selectedSessions);
    const prompt = buildDreamPrompt({
      memories,
      transcriptContext,
      dryRun,
      lastDreamedAt: state.lastDreamedAt
    });
    const modelKind = options.modelKind ?? this.config.dreaming.modelKind;
    this.logger?.info('dream.run.start', {
      dryRun,
      modelKind,
      memories: memories.length,
      sessions: selectedSessions.length
    });

    const raw = await this.models.get(modelKind).chat({
      messages: [
        { role: 'system', content: '你是 neo-agent 的 dreaming 子系统，只输出严格 JSON，不要输出解释性前后缀。' },
        { role: 'user', content: prompt }
      ] satisfies ChatMessage[],
      temperature: 0.4,
      maxTokens: 2400
    });
    const plan = parseDreamPlan(raw);

    if (!dryRun) {
      for (const item of plan.upserts) {
        await this.memory.remember(item.content, {
          category: item.category,
          tags: ['dream', ...(item.tags ?? [])],
          pinned: item.pinned ?? false,
          origin: 'agent',
          metadata: { reason: item.reason }
        });
      }
      for (const item of plan.archives) {
        await this.memory.forget(item.id);
      }
    }

    const reportPath = await this.writeReport({
      id: stableId('dream'),
      ts: new Date().toISOString(),
      dryRun,
      modelKind,
      reviewedSessions: selectedSessions,
      reviewedMemories: memories.length,
      plan,
      raw
    });

    if (!dryRun) {
      await this.writeState({
        lastDreamedAt: new Date().toISOString(),
        lastReportPath: reportPath
      });
    }

    this.logger?.info('dream.run.success', {
      dryRun,
      reportPath,
      upserts: plan.upserts.length,
      archives: plan.archives.length,
      insights: plan.insights.length
    });

    return {
      status: 'completed',
      dryRun,
      reportPath,
      summary: plan.summary,
      upserts: plan.upserts,
      archives: plan.archives,
      insights: plan.insights,
      reviewedSessions: selectedSessions.length,
      reviewedMemories: memories.length
    };
  }

  private async recentSessions(limit: number): Promise<TranscriptSessionSummary[]> {
    const transcripts = new TranscriptService(this.config, this.logger);
    return transcripts.listSessions(limit);
  }

  private async recentSessionsSince(sinceMs: number): Promise<TranscriptSessionSummary[]> {
    const transcripts = new TranscriptService(this.config, this.logger);
    const sessions = await transcripts.listSessions(Math.max(this.config.dreaming.maxSessions * 4, this.config.dreaming.minSessions * 2));
    return sessions.filter(session => Date.parse(session.updatedAt) > sinceMs);
  }

  private async readTranscriptContext(sessions: TranscriptSessionSummary[]): Promise<string> {
    const chunks: string[] = [];
    for (const session of sessions) {
      const tail = await tailFile(session.path, this.config.dreaming.transcriptTailLines);
      if (!tail) continue;
      chunks.push(`## ${session.sessionId}\nupdatedAt=${session.updatedAt}\npath=${session.path}\n${tail}`);
    }
    return chunks.join('\n\n');
  }

  private async readState(): Promise<DreamState> {
    return readJsonFile<DreamState>(this.statePath, {});
  }

  private async writeState(state: DreamState): Promise<void> {
    await writeJsonFile(this.statePath, state);
  }

  private async writeReport(report: unknown): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(this.reportsDir, `${ts}.json`);
    await writeJsonFile(filePath, report);
    return filePath;
  }
}

function buildDreamPrompt(input: {
  memories: MemoryRecord[];
  transcriptContext: string;
  dryRun: boolean;
  lastDreamedAt?: string;
}): string {
  return [
    '# Dream: 记忆整理和灵感提炼',
    '',
    '你正在执行 neo 的 dreaming：一次冷静的反思整理。目标不是复述会话，而是把散落、重复、过期、相互矛盾的记忆整理成未来真正有用的长期上下文。',
    '',
    '参考规则：',
    '- 只保留长期有价值的信息；不要保存 API key、token、密码、隐私数据。',
    '- 不保存代码结构、文件路径、git 历史、一次性任务流水账；这些应该从当前项目读取。',
    '- 合并重复记忆，归档明显过期或被更新事实替代的记忆。',
    '- 把相对日期转换成绝对日期。',
    '- 灵感可以大胆一点，但必须标明它为什么可能有用；不确定的灵感放进 insights，不要伪装成事实。',
    '',
    `dryRun=${input.dryRun}`,
    `lastDreamedAt=${input.lastDreamedAt ?? 'never'}`,
    '',
    '## 当前记忆',
    input.memories.length > 0 ? JSON.stringify(input.memories, null, 2) : '[]',
    '',
    '## 近期 transcript 片段',
    input.transcriptContext || '没有 transcript 片段。',
    '',
    '## 输出格式',
    '只输出 JSON，结构必须完全符合：',
    '{',
    '  "summary": "一句话总结本次整理",',
    '  "upserts": [',
    '    { "category": "preference|project_fact|workflow|session_summary", "content": "要写入的新记忆", "tags": ["dream"], "pinned": false, "reason": "为什么值得长期保存" }',
    '  ],',
    '  "archives": [',
    '    { "id": "要归档的现有记忆 id", "reason": "为什么归档" }',
    '  ],',
    '  "insights": ["可能有价值但还不应直接写成事实的灵感"]',
    '}'
  ].join('\n');
}

function parseDreamPlan(raw: string): DreamPlan {
  const parsed = parseJsonObject(raw);
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'dreaming 完成，但模型没有给出摘要。',
    upserts: Array.isArray(parsed.upserts) ? parsed.upserts.map(normalizeUpsert).filter(isDreamUpsert) : [],
    archives: Array.isArray(parsed.archives) ? parsed.archives.map(normalizeArchive).filter(isDreamArchive) : [],
    insights: Array.isArray(parsed.insights) ? parsed.insights.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function normalizeUpsert(raw: unknown): DreamUpsert | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.content !== 'string' || !value.content.trim()) return undefined;
  return {
    category: normalizeCategory(value.category),
    content: value.content.trim(),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    pinned: value.pinned === true,
    reason: typeof value.reason === 'string' ? value.reason : undefined
  };
}

function normalizeArchive(raw: unknown): DreamArchive | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id.trim()) return undefined;
  return {
    id: value.id.trim(),
    reason: typeof value.reason === 'string' ? value.reason : undefined
  };
}

function isDreamUpsert(item: DreamUpsert | undefined): item is DreamUpsert {
  return item !== undefined;
}

function isDreamArchive(item: DreamArchive | undefined): item is DreamArchive {
  return item !== undefined;
}

function normalizeCategory(value: unknown): MemoryCategory {
  if (value === 'project_fact' || value === 'workflow' || value === 'session_summary' || value === 'preference') return value;
  return 'session_summary';
}

function skipped(reason: string): DreamRunResult {
  return {
    status: 'skipped',
    reason,
    dryRun: false,
    upserts: [],
    archives: [],
    insights: [],
    reviewedSessions: 0,
    reviewedMemories: 0
  };
}
