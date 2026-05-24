import type { ChatMessage } from '../types.js';

export class ConversationHistory {
  private readonly messages: ChatMessage[] = [];

  constructor(
    private readonly maxHistoryChars: number,
    private readonly maxMessageChars: number
  ) {}

  append(userInput: string, assistantText: string): void {
    this.messages.push(
      { role: 'user', content: trimMessage(userInput, this.maxMessageChars) },
      { role: 'assistant', content: trimMessage(assistantText, this.maxMessageChars) }
    );
    this.trimToBudget();
  }

  recentMessages(): ChatMessage[] {
    this.trimToBudget();
    return this.messages.map(message => ({ ...message }));
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
      charCount: totalChars(this.messages),
      maxHistoryChars: this.maxHistoryChars
    };
  }

  private trimToBudget(): void {
    while (this.messages.length > 2 && totalChars(this.messages) > this.maxHistoryChars) {
      this.messages.splice(0, 2);
    }
  }
}

function trimMessage(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 36)).trimEnd()}\n[该消息因上下文预算被截断]`;
}

function totalChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
