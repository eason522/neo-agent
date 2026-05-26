import type { ChatCompletionResult, ChatMessage, ChatStreamHandlers, ChatToolCall, ChatToolDefinition, ModelConfig, ModelKind, ModelUsage, ModelUsageRecordInput } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { errorCodeFor } from '../logging/logger.js';
import { isAbortError } from '../utils/abort.js';

type ChatOptions = {
  messages: ChatMessage[] | unknown[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  stream?: ChatStreamHandlers;
};

type ChatWithToolsOptions = ChatOptions & {
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none';
};

export type ModelUsageSink = {
  modelKind: ModelKind;
  record: (event: ModelUsageRecordInput) => void;
};

export class OpenAICompatibleClient {
  constructor(private readonly config: ModelConfig, private readonly logger?: Logger, private readonly usageSink?: ModelUsageSink) {}

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
    const maxAttempts = this.config.maxRetries + 1;
    this.logger?.debug('model.request.start', {
      model: this.config.model,
      apiBase: this.config.apiBase,
      messageCount: options.messages.length,
      toolCount: tools.length,
      toolChoice: tools.length > 0 ? options.toolChoice ?? 'auto' : 'none',
      temperature: options.temperature ?? this.config.temperature,
      maxTokens: options.maxTokens ?? this.config.maxTokens
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = options.stream
          ? await this.fetchStreamingChatCompletion(url, options, tools)
          : await this.fetchBufferedChatCompletion(url, options, tools);
        const content = result.content;
        const reasoningContent = result.reasoningContent;
        const toolCalls = result.toolCalls;
        const usage = result.usage;
        if (!content && toolCalls.length === 0) throw new Error(`Model ${this.config.model} returned an empty response.`);
        this.logger?.info('model.request.success', {
          model: this.config.model,
          durationMs: Date.now() - start,
          outputChars: content.length,
          reasoningChars: reasoningContent?.length ?? 0,
          toolCallCount: toolCalls.length,
          finishReason: result.finishReason,
          attempt,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          retryCount: attempt - 1
        });
        this.usageSink?.record({
          modelKind: this.usageSink.modelKind,
          model: this.config.model,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          durationMs: Date.now() - start,
          attempt,
          retryCount: attempt - 1
        });
        this.logger?.diagnostic?.('info', 'model.request.metrics', {
          model: this.config.model,
          modelKind: this.usageSink?.modelKind,
          durationMs: Date.now() - start,
          totalTokens: usage?.totalTokens,
          retryCount: attempt - 1,
          toolCallCount: toolCalls.length
        });
        return {
          content,
          reasoningContent,
          toolCalls,
          finishReason: result.finishReason,
          usage
        };
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
          this.logger?.info('model.request.cancelled', {
            model: this.config.model,
            durationMs: Date.now() - start,
            attempt
          });
          throw error;
        }

        if (attempt < maxAttempts && isRetryableModelError(error)) {
          const delayMs = retryDelayMs(this.config.retryBaseDelayMs, attempt);
          this.logger?.warn('model.request.retry', {
            model: this.config.model,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            delayMs,
            errorCategory: categorizeModelError(error),
            errorCode: errorCodeFor(error, 'model.request.retry')
          });
          await sleep(delayMs, options.signal);
          continue;
        }

        this.logger?.error('model.request.error', error, {
          model: this.config.model,
          durationMs: Date.now() - start,
          attempt,
          retryCount: Math.max(0, attempt - 1),
          errorCategory: categorizeModelError(error)
        });
        throw error;
      }
    }
    throw new Error(`Model ${this.config.model} request failed after ${maxAttempts} attempts.`);
  }

  private async fetchBufferedChatCompletion(url: URL, options: ChatWithToolsOptions, tools: ChatToolDefinition[]): Promise<ChatCompletionResult> {
    const response = await this.fetchChatCompletion(url, options, tools, false);
    const payload = await response.json() as ChatCompletionPayload;
    const choice = payload.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      reasoningContent: choice?.message?.reasoning_content ?? undefined,
      toolCalls: normalizeToolCalls(choice?.message?.tool_calls ?? []),
      finishReason: choice?.finish_reason,
      usage: normalizeUsage(payload.usage)
    };
  }

  private async fetchStreamingChatCompletion(url: URL, options: ChatWithToolsOptions, tools: ChatToolDefinition[]): Promise<ChatCompletionResult> {
    const response = await this.fetchChatCompletion(url, options, tools, true);
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallParts = new Map<number, {
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>();
    let finishReason: string | null | undefined;
    let usage: ModelUsage | undefined;

    for await (const payload of readOpenAISse(response, options.signal)) {
      if (payload.usage) usage = normalizeUsage(payload.usage);
      const choice = payload.choices?.[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        contentParts.push(delta.content);
        options.stream?.onContentDelta?.(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        reasoningParts.push(delta.reasoning_content);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? toolCallParts.size;
        const existing = toolCallParts.get(index) ?? { function: { name: '', arguments: '' } };
        if (call.id) existing.id = call.id;
        if (call.type) existing.type = call.type;
        existing.function = {
          name: `${existing.function?.name ?? ''}${call.function?.name ?? ''}`,
          arguments: `${existing.function?.arguments ?? ''}${call.function?.arguments ?? ''}`
        };
        toolCallParts.set(index, existing);
      }
    }

    return {
      content: contentParts.join(''),
      reasoningContent: reasoningParts.join('') || undefined,
      toolCalls: normalizeToolCalls([...toolCallParts.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)),
      finishReason,
      usage
    };
  }

  private async fetchChatCompletion(url: URL, options: ChatWithToolsOptions, tools: ChatToolDefinition[], stream: boolean): Promise<Response> {
    const { signal, cleanup } = composeTimeoutSignal(options.signal, this.config.requestTimeoutMs);
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
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          ...(tools.length > 0 ? {
            tools,
            tool_choice: options.toolChoice ?? 'auto'
          } : {})
        }),
        signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ModelRequestError(
          `Model ${this.config.model} request failed: ${response.status} ${response.statusText} ${body.slice(0, 1200)}`,
          response.status
        );
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (signal.aborted) throw new ModelRequestError(`Model ${this.config.model} request timed out after ${this.config.requestTimeoutMs}ms.`, undefined, 'timeout');
      throw error;
    } finally {
      cleanup();
    }
  }
}

type ChatCompletionPayload = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

async function* readOpenAISse(response: Response, signal?: AbortSignal): AsyncGenerator<ChatCompletionPayload> {
  if (!response.body) throw new Error('Model streaming response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex: number;
      while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(buffer[separatorIndex] === '\r' ? separatorIndex + 4 : separatorIndex + 2);
        const dataLines = frame
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim());
        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          yield JSON.parse(data) as ChatCompletionPayload;
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      for (const line of tail.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        yield JSON.parse(data) as ChatCompletionPayload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class ModelRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly category?: 'timeout' | 'network') {
    super(message);
    this.name = 'ModelRequestError';
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

function normalizeUsage(input: ChatCompletionPayload['usage']): ModelUsage | undefined {
  if (!input) return undefined;
  return {
    promptTokens: input.prompt_tokens,
    completionTokens: input.completion_tokens,
    totalTokens: input.total_tokens
  };
}

function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelRequestError) {
    if (error.category === 'timeout' || error.category === 'network') return true;
    return error.status === 429 || Boolean(error.status && error.status >= 500);
  }
  if (error instanceof TypeError) return true;
  return false;
}

function categorizeModelError(error: unknown): string {
  if (error instanceof ModelRequestError) {
    if (error.category) return error.category;
    if (error.status === 429) return 'rate_limit';
    if (error.status && error.status >= 500) return 'server';
    if (error.status && error.status >= 400) return 'client';
  }
  if (error instanceof TypeError) return 'network';
  return 'unknown';
}

function retryDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.min(10_000, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function composeTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('model request timeout')), timeoutMs);
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    }
  };
}
