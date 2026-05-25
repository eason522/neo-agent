import type { ChatMessage, ChatToolDefinition, FileToolCallRecord, McpToolCallRecord, SkillToolCallRecord, TextModelKind, ToolCallRecord, ToolProgressEvent, WebToolCallRecord } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';
import type { ToolRunner } from '../tools/tool.js';
import { createAbortError, throwIfAborted } from '../utils/abort.js';
import {
  buildToolErrorResult,
  buildUnknownToolResult,
  createMaxRoundsEvent,
  createToolErrorEvent,
  createToolStartEvent,
  createToolSuccessEvent,
  createUnknownToolEvent,
  summarizeToolArguments,
  summarizeToolError,
  summarizeToolResult
} from '../tools/toolLog.js';

export type QueryEngineResult = {
  text: string;
  webToolCalls: WebToolCallRecord[];
  mcpToolCalls: McpToolCallRecord[];
  fileToolCalls: FileToolCallRecord[];
  skillToolCalls: SkillToolCallRecord[];
  toolEvents: ToolProgressEvent[];
};

type QueryEngineOptions = {
  maxToolRounds: number;
  onToolEvent?: (event: ToolProgressEvent) => void;
};

type QueryEngineRunOptions = {
  signal?: AbortSignal;
};

export class QueryEngine {
  constructor(
    private readonly models: ModelRegistry,
    private readonly tools: ToolRunner<ToolCallRecord>[],
    private readonly logger: Logger,
    private readonly options: QueryEngineOptions
  ) {}

  toolDefinitions(): ChatToolDefinition[] {
    return this.tools.flatMap(tool => tool.definitions());
  }

  async run(modelKind: TextModelKind, messages: ChatMessage[], runOptions: QueryEngineRunOptions = {}): Promise<QueryEngineResult> {
    const model = this.models.get(modelKind);
    const loopMessages = messages.map(message => ({ ...message }));
    throwIfAborted(runOptions.signal);
    await Promise.all(this.tools.map(tool => tool.refresh?.() ?? Promise.resolve()));
    throwIfAborted(runOptions.signal);
    const webToolCalls: WebToolCallRecord[] = [];
    const mcpToolCalls: McpToolCallRecord[] = [];
    const fileToolCalls: FileToolCallRecord[] = [];
    const skillToolCalls: SkillToolCallRecord[] = [];
    const toolEvents: ToolProgressEvent[] = [];
    const initialToolDefinitions = this.toolDefinitions();

    if (initialToolDefinitions.length === 0) {
      return {
        text: await model.chat({ messages: loopMessages, signal: runOptions.signal }),
        webToolCalls,
        mcpToolCalls,
        fileToolCalls,
        skillToolCalls,
        toolEvents
      };
    }

    for (let round = 0; round < this.options.maxToolRounds; round += 1) {
      throwIfAborted(runOptions.signal);
      const toolDefinitions = this.toolDefinitions();
      if (toolDefinitions.length === 0) break;
      const response = await model.chatWithTools({
        messages: loopMessages,
        tools: toolDefinitions,
        toolChoice: 'auto',
        signal: runOptions.signal
      });
      throwIfAborted(runOptions.signal);

      if (response.toolCalls.length === 0) {
        return { text: response.content, webToolCalls, mcpToolCalls, fileToolCalls, skillToolCalls, toolEvents };
      }

      loopMessages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
        ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {})
      });

      for (const toolCall of response.toolCalls) {
        throwIfAborted(runOptions.signal);
        const runner = this.findRunner(toolCall.function.name);
        const startEvent = createToolStartEvent(toolCall, round);
        emitToolEvent(startEvent, toolEvents, this.options.onToolEvent);
        this.logger.info('tool.start', {
          ...summarizeToolArguments(toolCall),
          round
        });

        if (!runner) {
          const unknownEvent = createUnknownToolEvent(toolCall.function.name, round);
          emitToolEvent(unknownEvent, toolEvents, this.options.onToolEvent);
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: buildUnknownToolResult(toolCall.function.name, round)
          });
          this.logger.warn('tool.unknown', { name: toolCall.function.name, round });
          continue;
        }

        try {
          const result = await runner.execute(toolCall, { signal: runOptions.signal });
          throwIfAborted(runOptions.signal);
          if (result.record) {
            if (isMcpRecord(result.record)) mcpToolCalls.push(result.record);
            else if (isFileRecord(result.record)) fileToolCalls.push(result.record);
            else if (isSkillRecord(result.record)) skillToolCalls.push(result.record);
            else webToolCalls.push(result.record);
          }
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.content
          });
          const successEvent = createToolSuccessEvent(toolCall.function.name, result.record, result.content, round);
          emitToolEvent(successEvent, toolEvents, this.options.onToolEvent);
          this.logger.info('tool.success', {
            name: toolCall.function.name,
            ...summarizeToolResult(result.record, result.content),
            round
          });
        } catch (error) {
          if (runOptions.signal?.aborted) throw createAbortError();
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: buildToolErrorResult(toolCall.function.name, error, round)
          });
          const errorEvent = createToolErrorEvent(toolCall.function.name, error, round);
          emitToolEvent(errorEvent, toolEvents, this.options.onToolEvent);
          this.logger.warn('tool.error', {
            name: toolCall.function.name,
            ...summarizeToolError(error),
            round
          });
        }
      }
    }

    this.logger.warn('tool.max_rounds_reached', {
      maxToolRounds: this.options.maxToolRounds,
      toolCallCount: webToolCalls.length + mcpToolCalls.length + fileToolCalls.length + skillToolCalls.length
    });
    const maxRoundsEvent = createMaxRoundsEvent(this.options.maxToolRounds, toolEvents.filter(event => event.phase === 'start').length);
    emitToolEvent(maxRoundsEvent, toolEvents, this.options.onToolEvent);
    const finalResponse = await model.chatWithTools({
      messages: [
        ...loopMessages,
        {
          role: 'user',
          content: '工具调用轮次已达到上限。请基于已有工具结果直接给出最终回答；如果信息不足，要明确说明。'
        }
      ],
      toolChoice: 'none',
      signal: runOptions.signal
    });
    throwIfAborted(runOptions.signal);
    return { text: finalResponse.content, webToolCalls, mcpToolCalls, fileToolCalls, skillToolCalls, toolEvents };
  }

  private findRunner(name: string): ToolRunner<ToolCallRecord> | undefined {
    return this.tools.find(tool => tool.canExecute(name));
  }
}

function emitToolEvent(
  event: ToolProgressEvent,
  events: ToolProgressEvent[],
  handler: ((event: ToolProgressEvent) => void) | undefined
): void {
  events.push(event);
  handler?.(event);
}

function isMcpRecord(record: ToolCallRecord): record is McpToolCallRecord {
  return 'serverName' in record && 'toolName' in record;
}

function isFileRecord(record: ToolCallRecord): record is FileToolCallRecord {
  return 'resultChars' in record && 'durationMs' in record && !('serverName' in record) && !('searchedAt' in record) && !('skillName' in record);
}

function isSkillRecord(record: ToolCallRecord): record is SkillToolCallRecord {
  return 'skillName' in record && 'scope' in record;
}
