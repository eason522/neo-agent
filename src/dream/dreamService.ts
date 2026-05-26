import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ChatMessage, MemoryCategory, MemoryRecord, MemoryTier, TextModelKind } from '../types.js';
import type { Logger } from '../logging/logger.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import { TranscriptService, tailFile, type TranscriptSessionSummary } from '../transcript/transcriptService.js';
import { readJsonFile, stableId, writeJsonFile } from '../utils/fs.js';

type DreamState = {
  lastDreamedAt?: string;
  lastDeepDreamedAt?: string;
  lastNapAt?: string;
  lastReportPath?: string;
  baselineCompleted?: boolean;
  memoryWatermark?: string;
  sessionWatermark?: string;
};

type DreamLock = {
  pid: number;
  startedAt: string;
};

type DreamUpsert = {
  category: MemoryCategory;
  tier?: MemoryTier;
  content: string;
  tags?: string[];
  pinned?: boolean;
  expiresAt?: string;
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
  soulUpdates: string[];
};

export type DreamMode = 'deep' | 'nap';

export type DreamReport = {
  id: string;
  mode: DreamMode;
  ts: string;
  dryRun: boolean;
  modelKind: TextModelKind;
  baseline: boolean;
  reviewedSessions: TranscriptSessionSummary[];
  reviewedMemories: number;
  plan: DreamPlan;
  raw: string;
  soulUpdated?: boolean;
  appliedAt?: string;
  appliedCounts?: {
    upserts: number;
    archives: number;
  };
};

export type DreamRunOptions = {
  mode?: DreamMode;
  dryRun?: boolean;
  force?: boolean;
  maxSessions?: number;
  modelKind?: TextModelKind;
  lookbackHours?: number;
};

export type DreamRunResult = {
  status: 'skipped' | 'completed';
  reason?: string;
  mode?: DreamMode;
  dryRun: boolean;
  reportPath?: string;
  summary?: string;
  upserts: DreamUpsert[];
  archives: DreamArchive[];
  insights: string[];
  reviewedSessions: number;
  reviewedMemories: number;
};

export type DreamReportSummary = {
  id: string;
  mode: DreamMode;
  path: string;
  ts: string;
  dryRun: boolean;
  summary: string;
  upserts: number;
  archives: number;
  insights: number;
  appliedAt?: string;
};

export type DreamMemoryReviewIssue = {
  type: 'duplicate' | 'stale' | 'low_value';
  severity: 'info' | 'warn';
  memoryIds: string[];
  message: string;
};

export type DreamMemoryReview = {
  checkedMemories: number;
  issues: DreamMemoryReviewIssue[];
};

export class DreamService {
  private readonly statePath: string;
  private readonly reportsDir: string;
  private readonly lockPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly models: ModelRegistry,
    private readonly memory: MemoryService,
    private readonly logger?: Logger
  ) {
    this.statePath = path.join(config.homeDir, 'dream', 'state.json');
    this.reportsDir = path.join(config.homeDir, 'dream', 'reports');
    this.lockPath = path.join(config.homeDir, 'dream', 'dream.lock');
  }

  async maybeRunScheduled(): Promise<DreamRunResult> {
    if (!this.config.dreaming.enabled) {
      return skipped('dreaming 未启用');
    }

    const state = await this.readState();
    const lastDreamedAt = state.lastDeepDreamedAt ? Date.parse(state.lastDeepDreamedAt) : state.lastDreamedAt ? Date.parse(state.lastDreamedAt) : 0;
    const hoursSince = (Date.now() - lastDreamedAt) / 3_600_000;
    if (lastDreamedAt > 0 && hoursSince < this.config.dreaming.minHours) {
      return skipped(`距离上次 dreaming 只有 ${hoursSince.toFixed(1)} 小时`);
    }

    const sessions = await this.recentSessionsSince(lastDreamedAt);
    if (sessions.length < this.config.dreaming.minSessions) {
      return skipped(`新会话数量 ${sessions.length}，未达到 ${this.config.dreaming.minSessions}`);
    }

    return this.run({
      mode: 'deep',
      dryRun: false,
      force: true,
      maxSessions: this.config.dreaming.maxSessions,
      modelKind: this.config.dreaming.modelKind
    });
  }

  async run(options: DreamRunOptions = {}): Promise<DreamRunResult> {
    const lock = await this.acquireLock();
    if (!lock.acquired) return skipped(lock.reason);
    try {
      return await this.runLocked(options);
    } finally {
      await lock.release();
    }
  }

  async listReports(limit = 10): Promise<DreamReportSummary[]> {
    const root = this.reportsDir;
    const summaries: DreamReportSummary[] = [];
    try {
      const files = await transcriptsListFiles(root);
      for (const filePath of files) {
        const report = await this.readReportFile(filePath);
        if (!report) continue;
        summaries.push({
          id: report.id,
          mode: report.mode,
          path: filePath,
          ts: report.ts,
          dryRun: report.dryRun,
          summary: report.plan.summary,
          upserts: report.plan.upserts.length,
          archives: report.plan.archives.length,
          insights: report.plan.insights.length,
          appliedAt: report.appliedAt
        });
      }
    } catch {
      return [];
    }
    return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  }

  async showReport(selector?: string): Promise<DreamReportSummary & { report: DreamReport } | undefined> {
    const resolved = await this.resolveReportPath(selector);
    if (!resolved) return undefined;
    const report = await this.readReportFile(resolved);
    if (!report) return undefined;
    return {
      id: report.id,
      mode: report.mode,
      path: resolved,
      ts: report.ts,
      dryRun: report.dryRun,
      summary: report.plan.summary,
      upserts: report.plan.upserts.length,
      archives: report.plan.archives.length,
      insights: report.plan.insights.length,
      appliedAt: report.appliedAt,
      report
    };
  }

  async applyReport(selector?: string): Promise<DreamRunResult> {
    const lock = await this.acquireLock();
    if (!lock.acquired) return skipped(lock.reason);
    try {
      const resolved = await this.resolveReportPath(selector);
      if (!resolved) return skipped('没有找到 dream 报告');
      const report = await this.readReportFile(resolved);
      if (!report) return skipped('dream 报告无法读取或格式不正确');
      if (report.appliedAt) return skipped(`dream 报告已经采纳：${report.appliedAt}`);

      for (const item of report.plan.upserts) {
        await this.memory.remember(item.content, {
          category: item.category,
          tier: item.tier ?? (report.mode === 'nap' ? 'short_term' : 'long_term'),
          tags: ['dream', ...(item.tags ?? [])],
          pinned: item.pinned ?? false,
          expiresAt: item.expiresAt ?? defaultExpiresAt(report.mode, this.config),
          origin: 'agent',
          metadata: { reason: item.reason, reportId: report.id }
        });
      }
      for (const item of report.plan.archives) {
        await this.memory.forget(item.id);
      }
      const soulUpdated = report.mode === 'deep' && report.plan.soulUpdates.length > 0
        ? await this.applySoulUpdates(report.plan.soulUpdates, report.id)
        : false;
      const appliedAt = new Date().toISOString();
      const appliedReport: DreamReport = {
        ...report,
        soulUpdated,
        appliedAt,
        appliedCounts: {
          upserts: report.plan.upserts.length,
          archives: report.plan.archives.length
        }
      };
      await writeJsonFile(resolved, appliedReport);
      await this.writeState({
        ...(await this.readState()),
        lastDreamedAt: appliedAt,
        ...(report.mode === 'deep' ? { lastDeepDreamedAt: appliedAt, baselineCompleted: true } : { lastNapAt: appliedAt }),
        lastReportPath: resolved
      });
      return {
        status: 'completed',
        mode: report.mode,
        dryRun: false,
        reportPath: resolved,
        summary: report.plan.summary,
        upserts: report.plan.upserts,
        archives: report.plan.archives,
        insights: report.plan.insights,
        reviewedSessions: report.reviewedSessions.length,
        reviewedMemories: report.reviewedMemories
      };
    } finally {
      await lock.release();
    }
  }

  async reviewMemories(limit = this.config.dreaming.maxMemories): Promise<DreamMemoryReview> {
    const memories = await this.memory.list(limit);
    const issues: DreamMemoryReviewIssue[] = [];
    const byContent = new Map<string, MemoryRecord[]>();
    for (const memory of memories) {
      const key = compactMemoryText(memory.content);
      const list = byContent.get(key) ?? [];
      list.push(memory);
      byContent.set(key, list);

      if (!memory.pinned && memory.content.length < 12) {
        issues.push({
          type: 'low_value',
          severity: 'warn',
          memoryIds: [memory.id],
          message: '记忆内容过短，可能缺少可复用上下文。'
        });
      }
      const updatedAt = Date.parse(memory.updatedAt);
      if (!memory.pinned && Number.isFinite(updatedAt) && Date.now() - updatedAt > 1000 * 60 * 60 * 24 * 180) {
        issues.push({
          type: 'stale',
          severity: 'info',
          memoryIds: [memory.id],
          message: '记忆超过 180 天未更新，建议复查是否仍然有效。'
        });
      }
    }
    for (const duplicates of byContent.values()) {
      if (duplicates.length < 2) continue;
      issues.push({
        type: 'duplicate',
        severity: 'warn',
        memoryIds: duplicates.map(memory => memory.id),
        message: '发现内容高度相同的重复记忆，建议合并或归档旧版本。'
      });
    }
    return {
      checkedMemories: memories.length,
      issues
    };
  }

  private async runLocked(options: DreamRunOptions = {}): Promise<DreamRunResult> {
    const dryRun = options.dryRun ?? false;
    const mode = options.mode ?? 'deep';
    const state = await this.readState();
    const lastDreamedAt = mode === 'nap'
      ? state.lastNapAt ? Date.parse(state.lastNapAt) : 0
      : state.lastDeepDreamedAt ? Date.parse(state.lastDeepDreamedAt) : state.lastDreamedAt ? Date.parse(state.lastDreamedAt) : 0;
    const sessions = mode === 'nap'
      ? await this.recentSessionsWithin(options.lookbackHours ?? this.config.dreaming.napLookbackHours, options.maxSessions ?? this.config.dreaming.maxSessions)
      : options.force
      ? await this.recentSessions(options.maxSessions ?? this.config.dreaming.maxSessions)
      : await this.recentSessionsSince(lastDreamedAt);
    const selectedSessions = sessions.slice(0, options.maxSessions ?? this.config.dreaming.maxSessions);
    const memories = await this.memory.list(this.config.dreaming.maxMemories);

    if (selectedSessions.length === 0 && memories.length === 0) {
      return skipped('没有可整理的 transcript 或记忆');
    }

    const transcriptContext = await this.readTranscriptContext(selectedSessions);
    const prompt = buildDreamPrompt({
      mode,
      memories,
      transcriptContext,
      dryRun,
      baseline: mode === 'deep' && !state.baselineCompleted,
      lastDreamedAt: mode === 'nap' ? state.lastNapAt : state.lastDeepDreamedAt ?? state.lastDreamedAt
    });
    const modelKind = options.modelKind ?? this.config.dreaming.modelKind;
    this.logger?.info('dream.run.start', {
      dryRun,
      mode,
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
          tier: item.tier ?? (mode === 'nap' ? 'short_term' : 'long_term'),
          tags: ['dream', ...(item.tags ?? [])],
          pinned: item.pinned ?? false,
          expiresAt: item.expiresAt ?? defaultExpiresAt(mode, this.config),
          origin: 'agent',
          metadata: { reason: item.reason }
        });
      }
      for (const item of plan.archives) {
        await this.memory.forget(item.id);
      }
      if (mode === 'deep' && plan.soulUpdates.length > 0) {
        await this.applySoulUpdates(plan.soulUpdates, 'direct-run');
      }
    }

    const now = new Date().toISOString();
    const reportPath = await this.writeReport({
      id: stableId('dream'),
      mode,
      ts: now,
      dryRun,
      modelKind,
      baseline: mode === 'deep' && !state.baselineCompleted,
      reviewedSessions: selectedSessions,
      reviewedMemories: memories.length,
      plan,
      raw
    });

    if (!dryRun) {
      await this.writeState({
        ...state,
        lastDreamedAt: now,
        ...(mode === 'deep' ? { lastDeepDreamedAt: now, baselineCompleted: true } : { lastNapAt: now }),
        lastReportPath: reportPath,
        memoryWatermark: memories[0]?.updatedAt ?? state.memoryWatermark,
        sessionWatermark: selectedSessions[0]?.updatedAt ?? state.sessionWatermark
      });
    }

    this.logger?.info('dream.run.success', {
      dryRun,
      mode,
      reportPath,
      upserts: plan.upserts.length,
      archives: plan.archives.length,
      insights: plan.insights.length
    });

    return {
      status: 'completed',
      mode,
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

  private async recentSessionsWithin(hours: number, limit: number): Promise<TranscriptSessionSummary[]> {
    const cutoff = Date.now() - hours * 3_600_000;
    const transcripts = new TranscriptService(this.config, this.logger);
    const sessions = await transcripts.listSessions(Math.max(limit * 4, 8));
    return sessions.filter(session => Date.parse(session.updatedAt) >= cutoff).slice(0, limit);
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

  private async resolveReportPath(selector?: string): Promise<string | undefined> {
    if (selector) {
      const direct = path.resolve(selector);
      if (await fileExists(direct)) return direct;
      const reports = await this.listReports(100);
      const matched = reports.find(report => report.id === selector || path.basename(report.path) === selector || path.basename(report.path, '.json') === selector);
      return matched?.path;
    }
    return (await this.listReports(1))[0]?.path;
  }

  private async readReportFile(filePath: string): Promise<DreamReport | undefined> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DreamReport>;
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.ts !== 'string' || !parsed.plan) return undefined;
      return {
        id: parsed.id,
        mode: parsed.mode === 'nap' ? 'nap' : 'deep',
        ts: parsed.ts,
        dryRun: parsed.dryRun === true,
        modelKind: parsed.modelKind === 'small' ? 'small' : 'main',
        baseline: parsed.baseline === true,
        reviewedSessions: Array.isArray(parsed.reviewedSessions) ? parsed.reviewedSessions : [],
        reviewedMemories: typeof parsed.reviewedMemories === 'number' ? parsed.reviewedMemories : 0,
        plan: parseDreamPlan(JSON.stringify(parsed.plan)),
        raw: typeof parsed.raw === 'string' ? parsed.raw : '',
        soulUpdated: parsed.soulUpdated === true,
        appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : undefined,
        appliedCounts: parsed.appliedCounts
      };
    } catch {
      return undefined;
    }
  }

  private async acquireLock(): Promise<{ acquired: true; release: () => Promise<void> } | { acquired: false; reason: string; release: () => Promise<void> }> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const existing = await readDreamLock(this.lockPath);
    if (existing) {
      const ageMs = Date.now() - Date.parse(existing.startedAt);
      if (Number.isFinite(ageMs) && ageMs < 1000 * 60 * 60 && isProcessRunning(existing.pid)) {
        return {
          acquired: false,
          reason: `另一个 dreaming 正在运行：pid=${existing.pid}`,
          release: async () => undefined
        };
      }
      await unlink(this.lockPath).catch(() => undefined);
    }
    const lock: DreamLock = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      await writeFile(this.lockPath, JSON.stringify(lock), { flag: 'wx' });
    } catch {
      return {
        acquired: false,
        reason: '另一个 dreaming 刚刚获得锁',
        release: async () => undefined
      };
    }
    return {
      acquired: true,
      release: async () => {
        const current = await readDreamLock(this.lockPath);
        if (current?.pid === process.pid) await unlink(this.lockPath).catch(() => undefined);
      }
    };
  }

  private async applySoulUpdates(updates: string[], reportId: string): Promise<boolean> {
    const cleaned = updates.map(item => item.trim()).filter(Boolean);
    if (cleaned.length === 0) return false;
    const soulPath = path.join(process.cwd(), 'SOUL.md');
    const existing = await readFile(soulPath, 'utf8').catch(() => '');
    const block = buildSoulDreamBlock(cleaned, reportId);
    const next = replaceSoulDreamBlock(existing || '# neo 的灵魂\n', block);
    if (next === existing) return false;
    await writeFile(soulPath, next, 'utf8');
    return true;
  }
}

async function transcriptsListFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function readDreamLock(filePath: string): Promise<DreamLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<DreamLock>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function compactMemoryText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, '').replace(/[，。,.!?！？、；;：:]/g, '').trim();
}

function buildDreamPrompt(input: {
  mode: DreamMode;
  memories: MemoryRecord[];
  transcriptContext: string;
  dryRun: boolean;
  baseline: boolean;
  lastDreamedAt?: string;
}): string {
  const isNap = input.mode === 'nap';
  return [
    isNap ? '# Nap: 短期记忆粗整理' : '# Deep Dream: 长期记忆深度整理和灵感提炼',
    '',
    isNap
      ? '你正在执行 neo 的浅睡眠 nap：目标是粗略整理最近 1-2 天上下文，形成短期记忆，帮助后续连续推进。'
      : '你正在执行 neo 的 deep dreaming：目标不是复述会话，而是把散落、重复、过期、相互矛盾的记忆整理成未来真正有用的长期上下文。',
    '',
    '参考规则：',
    isNap ? '- nap 只写 short_term 短期记忆，不修改 SOUL.md，不归档长期记忆。' : '- deep dreaming 写 long_term 长期记忆，可以归档过期或被替代的记忆。',
    '- 不要保存 API key、token、密码、隐私数据。',
    '- 不保存代码结构、文件路径、git 历史、一次性任务流水账；这些应该从当前项目读取。',
    isNap ? '- 重点提炼最近任务、临时卡点、近期情绪/生活事件和待观察事项。' : '- 合并重复记忆，归档明显过期或被更新事实替代的记忆。',
    isNap ? '- 如果内容可能长期有价值，只放入 insights，等待 deep dreaming 再判断是否晋升。' : '- 分析近期用户一直关注的事情、一直没想通的问题、反复卡住的项目、重要生活事件、特别高兴或难过的事情。',
    isNap ? '' : '- 可以对有趣、有价值、有意义的内容做更自由的联想、整合和关联探索，产出可能带来意外启发的 insights。',
    isNap ? '' : '- 如发现值得加深 neo 和用户长期默契的内容，可写入 soulUpdates；只写简短稳定认知，不写隐私细节。',
    '- 把相对日期转换成绝对日期。',
    '- 灵感可以大胆一点，但必须标明它为什么可能有用；不确定的灵感放进 insights，不要伪装成事实。',
    '',
    `mode=${input.mode}`,
    `dryRun=${input.dryRun}`,
    `baseline=${input.baseline}`,
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
    '    { "category": "preference|project_fact|workflow|session_summary", "tier": "long_term|short_term", "content": "要写入的新记忆", "tags": ["dream"], "pinned": false, "expiresAt": "可选 ISO 时间", "reason": "为什么值得保存" }',
    '  ],',
    '  "archives": [',
    '    { "id": "要归档的现有记忆 id", "reason": "为什么归档" }',
    '  ],',
    '  "insights": ["可能有价值但还不应直接写成事实的灵感"],',
    '  "soulUpdates": ["仅 deep dreaming 可用：值得写入 SOUL.md 受控区块的长期默契认知"]',
    '}'
  ].filter(Boolean).join('\n');
}

function parseDreamPlan(raw: string): DreamPlan {
  const parsed = parseJsonObject(raw);
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'dreaming 完成，但模型没有给出摘要。',
    upserts: Array.isArray(parsed.upserts) ? parsed.upserts.map(normalizeUpsert).filter(isDreamUpsert) : [],
    archives: Array.isArray(parsed.archives) ? parsed.archives.map(normalizeArchive).filter(isDreamArchive) : [],
    insights: Array.isArray(parsed.insights) ? parsed.insights.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [],
    soulUpdates: Array.isArray(parsed.soulUpdates) ? parsed.soulUpdates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
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
    tier: normalizeTier(value.tier),
    content: value.content.trim(),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    pinned: value.pinned === true,
    expiresAt: typeof value.expiresAt === 'string' && value.expiresAt.trim() ? value.expiresAt.trim() : undefined,
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

function normalizeTier(value: unknown): MemoryTier | undefined {
  if (value === 'long_term' || value === 'short_term') return value;
  return undefined;
}

function defaultExpiresAt(mode: DreamMode, config: AppConfig): string | undefined {
  if (mode !== 'nap') return undefined;
  return new Date(Date.now() + config.dreaming.shortTermTtlDays * 86_400_000).toISOString();
}

const soulStartMarker = '<!-- neo:dreaming:start -->';
const soulEndMarker = '<!-- neo:dreaming:end -->';

function buildSoulDreamBlock(updates: string[], reportId: string): string {
  const lines = [
    soulStartMarker,
    '',
    '## Dreaming 沉淀',
    '',
    `最近更新：${new Date().toISOString()}`,
    `来源报告：${reportId}`,
    '',
    ...updates.map(item => `- ${item}`),
    '',
    soulEndMarker
  ];
  return lines.join('\n');
}

function replaceSoulDreamBlock(existing: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(soulStartMarker)}[\\s\\S]*?${escapeRegExp(soulEndMarker)}`);
  const trimmed = existing.trimEnd();
  if (pattern.test(existing)) return existing.replace(pattern, block);
  return `${trimmed}\n\n${block}\n`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
