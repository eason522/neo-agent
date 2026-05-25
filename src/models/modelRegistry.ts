import type { AppConfig, ModelKind } from '../types.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';
import type { Logger } from '../logging/logger.js';
import type { UsageTracker } from '../usage/usageTracker.js';

export class ModelRegistry {
  readonly main: OpenAICompatibleClient;
  readonly small: OpenAICompatibleClient;
  readonly vision: OpenAICompatibleClient;

  constructor(readonly config: AppConfig, logger?: Logger, usage?: UsageTracker) {
    this.main = new OpenAICompatibleClient(config.models.main, logger, usage ? { modelKind: 'main', record: event => usage.record(event) } : undefined);
    this.small = new OpenAICompatibleClient(config.models.small, logger, usage ? { modelKind: 'small', record: event => usage.record(event) } : undefined);
    this.vision = new OpenAICompatibleClient(config.models.vision, logger, usage ? { modelKind: 'vision', record: event => usage.record(event) } : undefined);
  }

  get(kind: ModelKind): OpenAICompatibleClient {
    if (kind === 'main') return this.main;
    if (kind === 'small') return this.small;
    return this.vision;
  }
}
