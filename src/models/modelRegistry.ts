import type { AppConfig, ModelKind } from '../types.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';
import type { Logger } from '../logging/logger.js';

export class ModelRegistry {
  readonly main: OpenAICompatibleClient;
  readonly small: OpenAICompatibleClient;
  readonly vision: OpenAICompatibleClient;

  constructor(readonly config: AppConfig, logger?: Logger) {
    this.main = new OpenAICompatibleClient(config.models.main, logger);
    this.small = new OpenAICompatibleClient(config.models.small, logger);
    this.vision = new OpenAICompatibleClient(config.models.vision, logger);
  }

  get(kind: ModelKind): OpenAICompatibleClient {
    if (kind === 'main') return this.main;
    if (kind === 'small') return this.small;
    return this.vision;
  }
}
