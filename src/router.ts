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

    const shouldUseMain = this.config.routing.forceMainKeywords.some(keyword => input.includes(keyword)) || isLongFileGenerationTask(input);
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

function isLongFileGenerationTask(input: string): boolean {
  return /(html|css|javascript|js|landing page|single[- ]file|write (a )?file|create (a )?file|生成.*(文件|网页|页面)|写入.*文件|落地页|单文件|完整.*(HTML|代码|页面))/i.test(input);
}
