import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ModelUsageRecord, ModelUsageRecordInput } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { ensureDir, stableId } from '../utils/fs.js';

export type UsageModelSummary = {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  currency?: string;
  pricedCalls: number;
  unpricedCalls: number;
};

export type UsageDailySummary = {
  day: string;
  calls: number;
  totalTokens: number;
  estimatedCost: number;
};

export type UsageSummary = {
  filePath: string;
  since?: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  models: UsageModelSummary[];
  days: UsageDailySummary[];
};

export class UsageTracker {
  readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig, private readonly logger?: Logger) {
    this.filePath = path.isAbsolute(config.usage.file)
      ? config.usage.file
      : path.join(config.homeDir, config.usage.file);
  }

  record(input: ModelUsageRecordInput): void {
    if (!this.config.usage.enabled) return;
    const price = this.config.usage.prices[input.model];
    const estimatedCost = price
      ? ((input.promptTokens ?? 0) / 1_000_000) * price.inputPerMillion + ((input.completionTokens ?? 0) / 1_000_000) * price.outputPerMillion
      : undefined;
    const record: ModelUsageRecord = {
      id: stableId('usage'),
      ts: new Date().toISOString(),
      ...input,
      estimatedCost,
      currency: price?.currency,
      pricingConfigured: Boolean(price)
    };
    const line = `${JSON.stringify(record)}\n`;
    this.logger?.debug('usage.record', {
      modelKind: record.modelKind,
      model: record.model,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      retryCount: record.retryCount ?? 0,
      pricingConfigured: record.pricingConfigured
    });
    this.pendingWrite = this.pendingWrite.then(async () => {
      await ensureDir(path.dirname(this.filePath));
      await appendFile(this.filePath, line, 'utf8');
    }).catch(error => {
      this.logger?.error('usage.write.error', error, { filePath: this.filePath });
    });
  }

  async flush(): Promise<void> {
    await this.pendingWrite.catch(() => undefined);
  }

  async summarize(options: { days?: number } = {}): Promise<UsageSummary> {
    await this.flush();
    const since = options.days && options.days > 0
      ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    const records = (await this.readRecords()).filter(record => !since || record.ts >= since);
    const byModel = new Map<string, UsageModelSummary>();
    const byDay = new Map<string, UsageDailySummary>();
    let calls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let estimatedCost = 0;

    for (const record of records) {
      calls += 1;
      const prompt = record.promptTokens ?? 0;
      const completion = record.completionTokens ?? 0;
      const total = record.totalTokens ?? prompt + completion;
      const cost = record.estimatedCost ?? 0;
      promptTokens += prompt;
      completionTokens += completion;
      totalTokens += total;
      estimatedCost += cost;

      const modelSummary = byModel.get(record.model) ?? {
        model: record.model,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        currency: record.currency,
        pricedCalls: 0,
        unpricedCalls: 0
      };
      modelSummary.calls += 1;
      modelSummary.promptTokens += prompt;
      modelSummary.completionTokens += completion;
      modelSummary.totalTokens += total;
      modelSummary.estimatedCost += cost;
      modelSummary.currency = modelSummary.currency ?? record.currency;
      if (record.pricingConfigured) modelSummary.pricedCalls += 1;
      else modelSummary.unpricedCalls += 1;
      byModel.set(record.model, modelSummary);

      const day = record.ts.slice(0, 10);
      const daySummary = byDay.get(day) ?? { day, calls: 0, totalTokens: 0, estimatedCost: 0 };
      daySummary.calls += 1;
      daySummary.totalTokens += total;
      daySummary.estimatedCost += cost;
      byDay.set(day, daySummary);
    }

    return {
      filePath: this.filePath,
      since,
      calls,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      models: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
      days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day))
    };
  }

  private async readRecords(): Promise<ModelUsageRecord[]> {
    try {
      const fileStat = await stat(this.filePath);
      const maxRead = Math.min(fileStat.size, 8 * 1024 * 1024);
      const raw = await readFile(this.filePath, 'utf8');
      return raw
        .slice(Math.max(0, raw.length - maxRead))
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map(line => safeParseUsageRecord(line))
        .filter((record): record is ModelUsageRecord => Boolean(record));
    } catch {
      return [];
    }
  }
}

export function formatUsageSummary(summary: UsageSummary): string {
  const lines = [
    'neo usage',
    `文件：${summary.filePath}`,
    summary.since ? `范围：${summary.since} 至现在` : '范围：全部记录',
    `总调用：${summary.calls}`,
    `总 token：${summary.totalTokens}（输入 ${summary.promptTokens}，输出 ${summary.completionTokens}）`,
    `估算成本：${formatCost(summary.estimatedCost, summary.models.find(model => model.currency)?.currency)}`
  ];
  if (summary.models.length === 0) {
    lines.push('暂无 usage 记录。');
    return lines.join('\n');
  }
  lines.push('', '按模型：');
  for (const model of summary.models) {
    const cost = model.unpricedCalls > 0
      ? '未配置单价'
      : formatCost(model.estimatedCost, model.currency);
    lines.push(`- ${model.model}: 调用 ${model.calls}，token ${model.totalTokens}（输入 ${model.promptTokens}，输出 ${model.completionTokens}），成本 ${cost}`);
  }
  if (summary.days.length > 0) {
    lines.push('', '按日期：');
    for (const day of summary.days.slice(0, 14)) {
      lines.push(`- ${day.day}: 调用 ${day.calls}，token ${day.totalTokens}，成本 ${formatCost(day.estimatedCost, summary.models.find(model => model.currency)?.currency)}`);
    }
  }
  return lines.join('\n');
}

function safeParseUsageRecord(line: string): ModelUsageRecord | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<ModelUsageRecord>;
    if (!parsed || typeof parsed.ts !== 'string' || typeof parsed.model !== 'string') return undefined;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : stableId('usage'),
      ts: parsed.ts,
      modelKind: parsed.modelKind ?? 'main',
      model: parsed.model,
      promptTokens: numberOrUndefined(parsed.promptTokens),
      completionTokens: numberOrUndefined(parsed.completionTokens),
      totalTokens: numberOrUndefined(parsed.totalTokens),
      estimatedCost: numberOrUndefined(parsed.estimatedCost),
      currency: typeof parsed.currency === 'string' ? parsed.currency : undefined,
      pricingConfigured: parsed.pricingConfigured === true,
      durationMs: numberOrUndefined(parsed.durationMs),
      attempt: numberOrUndefined(parsed.attempt)
    };
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatCost(value: number, currency = 'USD'): string {
  return `${value.toFixed(6)} ${currency}`;
}
