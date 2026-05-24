import type { ChatMessage, ModelConfig } from '../types.js';
import type { Logger } from '../logging/logger.js';

type ChatOptions = {
  messages: ChatMessage[] | unknown[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export class OpenAICompatibleClient {
  constructor(private readonly config: ModelConfig, private readonly logger?: Logger) {}

  async chat(options: ChatOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`Missing API key for model ${this.config.model}. Set DEEPSEEK_API_KEY or MIMO_API_KEY.`);
    }

    const url = new URL('chat/completions', ensureTrailingSlash(this.config.apiBase));
    const start = Date.now();
    this.logger?.debug('model.request.start', {
      model: this.config.model,
      apiBase: this.config.apiBase,
      messageCount: options.messages.length,
      temperature: options.temperature ?? this.config.temperature,
      maxTokens: options.maxTokens ?? this.config.maxTokens
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: options.messages,
          temperature: options.temperature ?? this.config.temperature,
          max_tokens: options.maxTokens ?? this.config.maxTokens
        }),
        signal: options.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Model ${this.config.model} request failed: ${response.status} ${response.statusText} ${body.slice(0, 1200)}`);
      }

      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Model ${this.config.model} returned an empty response.`);
      this.logger?.info('model.request.success', {
        model: this.config.model,
        durationMs: Date.now() - start,
        outputChars: content.length
      });
      return content;
    } catch (error) {
      this.logger?.error('model.request.error', error, {
        model: this.config.model,
        durationMs: Date.now() - start
      });
      throw error;
    }
  }
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}
