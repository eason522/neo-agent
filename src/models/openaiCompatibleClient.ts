import type { ChatMessage, ModelConfig } from '../types.js';

type ChatOptions = {
  messages: ChatMessage[] | unknown[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export class OpenAICompatibleClient {
  constructor(private readonly config: ModelConfig) {}

  async chat(options: ChatOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`Missing API key for model ${this.config.model}. Set DEEPSEEK_API_KEY or MIMO_API_KEY.`);
    }

    const url = new URL('chat/completions', ensureTrailingSlash(this.config.apiBase));
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
      throw new Error(`Model ${this.config.model} request failed: ${response.status} ${response.statusText} ${body}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Model ${this.config.model} returned an empty response.`);
    return content;
  }
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}
