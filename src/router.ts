import type { AppConfig, Attachment, RouterDecision } from './types.js';

export class ModelRouter {
  constructor(private readonly config: AppConfig) {}

  decide(input: string, attachments: Attachment[]): RouterDecision {
    if (attachments.length > 0) {
      return {
        modelKind: 'main',
        reason: 'image input requires vision pre-analysis and stronger downstream reasoning'
      };
    }

    const shouldUseMain = this.config.routing.forceMainKeywords.some(keyword => input.includes(keyword));
    if (shouldUseMain) {
      return {
        modelKind: 'main',
        reason: 'task contains planning, coding, or multi-step keywords'
      };
    }

    if (input.length <= this.config.routing.smallModelMaxChars) {
      return {
        modelKind: 'small',
        reason: 'short text-only task'
      };
    }

    return {
      modelKind: 'main',
      reason: 'long input benefits from the main model'
    };
  }
}
