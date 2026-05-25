import type { ChatCompletionResult, ChatMessage, ChatToolCall, ChatToolDefinition, ModelConfig } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { isAbortError } from '../utils/abort.js';

type ChatOptions = {
  messages: ChatMessage[] | unknown[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

type ChatWithToolsOptions = ChatOptions & {
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none';
};

export class OpenAICompatibleClient {
  constructor(private readonly config: ModelConfig, private readonly logger?: Logger) {}

  async chat(options: ChatOptions): Promise<string> {
    const result = await this.chatWithTools({ ...options, toolChoice: 'none' });
    if (!result.content) throw new Error(`Model ${this.config.model} returned an empty response.`);
    return result.content;
  }

  async chatWithTools(options: ChatWithToolsOptions): Promise<ChatCompletionResult> {
    if (!this.config.apiKey) {
      throw new Error(`Missing API key for model ${this.config.model}. Set DEEPSEEK_API_KEY or MIMO_API_KEY.`);
    }

    const url = new URL('chat/completions', ensureTrailingSlash(this.config.apiBase));
    const tools = options.tools ?? [];
    const start = Date.now();
    this.logger?.debug('model.request.start', {
      model: this.config.model,
      apiBase: this.config.apiBase,
      messageCount: options.messages.length,
      toolCount: tools.length,
      toolChoice: tools.length > 0 ? options.toolChoice ?? 'auto' : 'none',
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
          max_tokens: options.maxTokens ?? this.config.maxTokens,
          ...(tools.length > 0 ? {
            tools,
            tool_choice: options.toolChoice ?? 'auto'
          } : {})
        }),
        signal: options.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Model ${this.config.model} request failed: ${response.status} ${response.statusText} ${body.slice(0, 1200)}`);
      }

      const payload = await response.json() as {
        choices?: Array<{
          finish_reason?: string | null;
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              id?: string;
              type?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }>;
          };
        }>;
      };
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? '';
      const reasoningContent = choice?.message?.reasoning_content ?? undefined;
      const toolCalls = normalizeToolCalls(choice?.message?.tool_calls ?? []);
      if (!content && toolCalls.length === 0) throw new Error(`Model ${this.config.model} returned an empty response.`);
      this.logger?.info('model.request.success', {
        model: this.config.model,
        durationMs: Date.now() - start,
        outputChars: content.length,
        reasoningChars: reasoningContent?.length ?? 0,
        toolCallCount: toolCalls.length,
        finishReason: choice?.finish_reason
      });
      return {
        content,
        reasoningContent,
        toolCalls,
        finishReason: choice?.finish_reason
      };
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        this.logger?.info('model.request.cancelled', {
          model: this.config.model,
          durationMs: Date.now() - start
        });
        throw error;
      }
      this.logger?.error('model.request.error', error, {
        model: this.config.model,
        durationMs: Date.now() - start
      });
      throw error;
    }
  }
}

function normalizeToolCalls(input: Array<{
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}>): ChatToolCall[] {
  return input
    .map((call, index) => ({
      id: call.id || `tool_call_${index}`,
      type: 'function' as const,
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}'
      }
    }))
    .filter(call => call.function.name.length > 0);
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}
