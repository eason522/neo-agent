import type { ChatMessage } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';

export class SubAgentRunner {
  constructor(private readonly models: ModelRegistry) {}

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

    return this.models.small.chat({ messages });
  }
}
