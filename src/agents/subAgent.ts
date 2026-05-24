import type { ChatMessage } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';

export class SubAgentRunner {
  constructor(private readonly models: ModelRegistry, private readonly logger?: Logger) {}

  async run(task: string, context = ''): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are a focused sub-agent spawned by neo-agent.',
          'Solve only the delegated task. Be concise, cite assumptions, and return reusable findings.',
          context ? `Context:\n${context}` : ''
        ].filter(Boolean).join('\n\n')
      },
      {
        role: 'user',
        content: task
      }
    ];

    const start = Date.now();
    this.logger?.info('subagent.run.start', { taskChars: task.length, contextChars: context.length });
    try {
      const output = await this.models.small.chat({ messages });
      this.logger?.info('subagent.run.success', { durationMs: Date.now() - start, outputChars: output.length });
      return output;
    } catch (error) {
      this.logger?.error('subagent.run.error', error, { durationMs: Date.now() - start });
      throw error;
    }
  }
}
