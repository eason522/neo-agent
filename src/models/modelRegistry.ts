import type { AppConfig, ModelKind } from '../types.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';

export class ModelRegistry {
  readonly main: OpenAICompatibleClient;
  readonly small: OpenAICompatibleClient;
  readonly vision: OpenAICompatibleClient;

  constructor(readonly config: AppConfig) {
    this.main = new OpenAICompatibleClient(config.models.main);
    this.small = new OpenAICompatibleClient(config.models.small);
    this.vision = new OpenAICompatibleClient(config.models.vision);
  }

  get(kind: ModelKind): OpenAICompatibleClient {
    if (kind === 'main') return this.main;
    if (kind === 'small') return this.small;
    return this.vision;
  }
}
