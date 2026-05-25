import type { ChatMessage } from '../types.js';

export type ConversationCompactOptions = {
  enabled: boolean;
  thresholdRatio: number;
  keepRecentChars: number;
  maxSummaryChars: number;
};

export type ConversationCompactModel = {
  chat: (options: { messages: ChatMessage[]; temperature?: number; maxTokens?: number }) => Promise<string>;
};

export type ConversationCompactResult = {
  compacted: boolean;
  source?: 'model' | 'fallback';
  beforeChars: number;
  afterChars: number;
  summarizedMessages: number;
  keptMessages: number;
  summaryChars: number;
  summary?: string;
  reason?: string;
};

export class ConversationHistory {
  private readonly messages: ChatMessage[] = [];
  private compactSummary: string | undefined;

  constructor(
    private readonly maxHistoryChars: number,
    private readonly maxMessageChars: number,
    private readonly compactOptions: ConversationCompactOptions
  ) {}

  async append(
    userInput: string,
    assistantText: string,
    compactModel?: ConversationCompactModel
  ): Promise<ConversationCompactResult> {
    this.messages.push(
      { role: 'user', content: trimMessage(userInput, this.maxMessageChars) },
      { role: 'assistant', content: trimMessage(assistantText, this.maxMessageChars) }
    );
    return this.compactIfNeeded(compactModel);
  }

  recentMessages(): ChatMessage[] {
    this.trimToBudget();
    return this.withCompactSummary(this.messages);
  }

  hydrate(messages: ChatMessage[], compactSummary?: string): void {
    this.messages.splice(0, this.messages.length, ...messages.map(message => ({
      ...message,
      content: trimMessage(message.content, this.maxMessageChars)
    })));
    this.compactSummary = compactSummary ? trimMessage(compactSummary, this.compactOptions.maxSummaryChars) : undefined;
    this.trimToBudget();
  }

  recentMessagesForPlanning(maxChars: number): ChatMessage[] {
    this.trimToBudget();
    const source = this.withCompactSummary(this.messages);
    const selected: ChatMessage[] = [];
    let usedChars = 0;
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const message = source[index];
      if (!message) continue;
      const remaining = maxChars - usedChars;
      if (remaining <= 0) break;
      const content = trimMessage(message.content, remaining);
      selected.unshift({ ...message, content });
      usedChars += content.length;
    }
    return selected;
  }

  lastUserInput(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.role === 'user') return message.content;
    }
    return undefined;
  }

  stats(): { messageCount: number; charCount: number; maxHistoryChars: number } {
    return {
      messageCount: this.messages.length,
      charCount: this.totalChars(),
      maxHistoryChars: this.maxHistoryChars
    };
  }

  private async compactIfNeeded(compactModel?: ConversationCompactModel): Promise<ConversationCompactResult> {
    const beforeChars = this.totalChars();
    if (!this.compactOptions.enabled) {
      this.trimToBudget();
      return {
        compacted: false,
        beforeChars,
        afterChars: this.totalChars(),
        summarizedMessages: 0,
        keptMessages: this.messages.length,
      summaryChars: this.compactSummary?.length ?? 0,
      summary: this.compactSummary,
      reason: 'auto_compact_disabled'
      };
    }

    const threshold = Math.floor(this.maxHistoryChars * this.compactOptions.thresholdRatio);
    if (beforeChars <= threshold || this.messages.length <= 2) {
      return {
        compacted: false,
        beforeChars,
        afterChars: beforeChars,
        summarizedMessages: 0,
        keptMessages: this.messages.length,
        summaryChars: this.compactSummary?.length ?? 0,
        summary: this.compactSummary,
        reason: 'below_threshold'
      };
    }

    const { older, recent } = splitForCompact(this.messages, Math.min(this.compactOptions.keepRecentChars, Math.floor(this.maxHistoryChars * 0.7)));
    if (older.length === 0) {
      this.trimToBudget();
      return {
        compacted: false,
        beforeChars,
        afterChars: this.totalChars(),
        summarizedMessages: 0,
        keptMessages: this.messages.length,
        summaryChars: this.compactSummary?.length ?? 0,
        summary: this.compactSummary,
        reason: 'no_summarizable_prefix'
      };
    }

    const { summary, source } = await this.summarizeOlderMessages(older, compactModel);
    this.compactSummary = trimMessage(summary, this.compactOptions.maxSummaryChars);
    this.messages.splice(0, this.messages.length, ...recent);
    this.trimToBudget();
    return {
      compacted: true,
      source,
      beforeChars,
      afterChars: this.totalChars(),
      summarizedMessages: older.length,
      keptMessages: this.messages.length,
      summaryChars: this.compactSummary.length,
      summary: this.compactSummary
    };
  }

  private async summarizeOlderMessages(
    older: ChatMessage[],
    compactModel?: ConversationCompactModel
  ): Promise<{ summary: string; source: 'model' | 'fallback' }> {
    if (!compactModel) {
      return {
        summary: buildFallbackSummary(this.compactSummary, older, this.compactOptions.maxSummaryChars),
        source: 'fallback'
      };
    }

    try {
      const response = await compactModel.chat({
        temperature: 0.1,
        maxTokens: Math.max(512, Math.ceil(this.compactOptions.maxSummaryChars / 3)),
        messages: [
          {
            role: 'system',
            content: [
              '你是 neo-agent 的自动上下文压缩器。',
              '只输出中文纯文本摘要，不要调用工具，不要回答用户问题。',
              '摘要用于后续继续对话，必须保留用户明确要求、关键事实、技术决策、文件路径、错误和修复、未完成事项。',
              '如果旧摘要存在，要把新旧内容合并去重。不要编造没有出现过的信息。'
            ].join('\n')
          },
          {
            role: 'user',
            content: buildCompactPrompt(this.compactSummary, older)
          }
        ]
      });
      const normalized = normalizeModelSummary(response);
      return {
        summary: normalized || buildFallbackSummary(this.compactSummary, older, this.compactOptions.maxSummaryChars),
        source: normalized ? 'model' : 'fallback'
      };
    } catch {
      return {
        summary: buildFallbackSummary(this.compactSummary, older, this.compactOptions.maxSummaryChars),
        source: 'fallback'
      };
    }
  }

  private trimToBudget(): void {
    while (this.messages.length > 2 && this.totalChars() > this.maxHistoryChars) {
      this.messages.splice(0, 2);
    }
  }

  private totalChars(): number {
    return totalChars(this.messages) + (this.compactSummary?.length ?? 0);
  }

  private withCompactSummary(messages: ChatMessage[]): ChatMessage[] {
    const output = messages.map(message => ({ ...message }));
    if (!this.compactSummary) return output;
    return [
      {
        role: 'user',
        content: [
          '[自动压缩的历史摘要]',
          '下面是较早对话的摘要，用于延续上下文；它不是用户的新请求。',
          this.compactSummary
        ].join('\n')
      },
      ...output
    ];
  }
}

function trimMessage(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 36)).trimEnd()}\n[该消息因上下文预算被截断]`;
}

function totalChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function splitForCompact(messages: ChatMessage[], keepRecentChars: number): { older: ChatMessage[]; recent: ChatMessage[] } {
  let usedChars = 0;
  let start = messages.length;
  while (start > 0) {
    const pairStart = Math.max(0, start - 2);
    const pair = messages.slice(pairStart, start);
    const pairChars = totalChars(pair);
    if (usedChars > 0 && usedChars + pairChars > keepRecentChars) break;
    usedChars += pairChars;
    start = pairStart;
  }
  return {
    older: messages.slice(0, start),
    recent: messages.slice(start)
  };
}

function buildCompactPrompt(existingSummary: string | undefined, older: ChatMessage[]): string {
  const lines = older.map((message, index) => {
    const label = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : message.role;
    return `## ${index + 1}. ${label}\n${message.content}`;
  }).join('\n\n');
  return [
    existingSummary ? `# 旧摘要\n${existingSummary}` : '',
    '# 需要压缩的较早对话',
    lines,
    '# 输出要求',
    '请输出一份可继续工作的中文摘要，控制在必要信息范围内。保留：用户要求、约束、长期偏好、技术决策、文件路径、命令、错误与修复、仍待做的事项。'
  ].filter(Boolean).join('\n\n');
}

function normalizeModelSummary(input: string): string {
  return input
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<\/?summary>/gi, '')
    .trim();
}

function buildFallbackSummary(existingSummary: string | undefined, older: ChatMessage[], maxChars: number): string {
  const items = older.map((message, index) => {
    const content = trimMessage(message.content, 1200);
    return `${index + 1}. ${message.role}: ${content}`;
  });
  return trimMessage([
    existingSummary ? `旧摘要：\n${existingSummary}` : '',
    '自动压缩摘要：模型摘要不可用，以下是较早对话的抽取式记录。',
    ...items
  ].filter(Boolean).join('\n\n'), maxChars);
}
