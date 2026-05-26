import type { ChatMessage, ChatToolCall, ChatToolDefinition, ExecutionToolCallRecord, FileToolCallRecord, McpToolCallRecord, SkillToolCallRecord, TextModelKind, ToolCallRecord, ToolPairRecord, ToolProgressEvent, WebToolCallRecord } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';
import { errorCodeFor } from '../logging/logger.js';
import type { ToolExecutionResult, ToolRunner } from '../tools/tool.js';
import type { HookBus } from '../hooks/hookBus.js';
import { createAbortError, throwIfAborted } from '../utils/abort.js';
import {
  buildSkippedToolResult,
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
import { applyToolHistoryBudget, applyToolResultBudget, type ToolResultBudgetOptions, type ToolResultBudgetOutcome } from '../tools/toolResultBudget.js';

export type QueryEngineResult = {
  text: string;
  webToolCalls: WebToolCallRecord[];
  mcpToolCalls: McpToolCallRecord[];
  fileToolCalls: FileToolCallRecord[];
  executionToolCalls: ExecutionToolCallRecord[];
  skillToolCalls: SkillToolCallRecord[];
  toolEvents: ToolProgressEvent[];
  toolPairs: ToolPairRecord[];
};

type QueryEngineOptions = {
  maxToolRounds: number;
  toolTimeoutMs?: number;
  toolResultBudget?: ToolResultBudgetOptions;
  onToolEvent?: (event: ToolProgressEvent) => void;
  onContentDelta?: (delta: string) => void;
  hooks?: HookBus;
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
    const executionToolCalls: ExecutionToolCallRecord[] = [];
    const skillToolCalls: SkillToolCallRecord[] = [];
    const toolEvents: ToolProgressEvent[] = [];
    const toolPairs: ToolPairRecord[] = [];
    const initialToolDefinitions = this.toolDefinitions();
    let truncatedToolArgumentRounds = 0;

    if (initialToolDefinitions.length === 0) {
      return {
        text: await model.chat({ messages: loopMessages, signal: runOptions.signal, stream: this.streamHandlers() }),
        webToolCalls,
        mcpToolCalls,
        fileToolCalls,
        executionToolCalls,
        skillToolCalls,
        toolEvents,
        toolPairs
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
        signal: runOptions.signal,
        stream: this.streamHandlers()
      });
      throwIfAborted(runOptions.signal);

      if (response.finishReason === 'length' && response.toolCalls.length > 0 && hasIncompleteToolArguments(response.toolCalls)) {
        truncatedToolArgumentRounds += 1;
        this.logger.warn('tool.arguments_truncated', {
          round,
          toolCallCount: response.toolCalls.length,
          consecutiveCount: truncatedToolArgumentRounds
        });
        loopMessages.push({
          role: 'assistant',
          content: response.content || '[模型输出因长度限制被截断，包含不完整工具调用参数。]'
        });
        loopMessages.push({
          role: 'user',
          content: buildTruncatedToolArgumentsRecoveryPrompt(truncatedToolArgumentRounds)
        });
        continue;
      }
      truncatedToolArgumentRounds = 0;

      if (response.toolCalls.length === 0) {
        return { text: response.content, webToolCalls, mcpToolCalls, fileToolCalls, executionToolCalls, skillToolCalls, toolEvents, toolPairs };
      }

      const toolCalls = normalizeToolCallIds(response.toolCalls);
      loopMessages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
        ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {})
      });

      const roundResult = await this.executeToolRound(toolCalls, round, runOptions.signal, {
        webToolCalls,
        mcpToolCalls,
        fileToolCalls,
        executionToolCalls,
        skillToolCalls,
        toolEvents,
        toolPairs
      });
      loopMessages.push(...roundResult.messages);
      await this.applyHistoryToolResultBudget(loopMessages, toolPairs, round);
      if (roundResult.terminal) {
        return this.finalizeAfterTerminalTool(modelKind, loopMessages, {
          webToolCalls,
          mcpToolCalls,
          fileToolCalls,
          executionToolCalls,
          skillToolCalls,
          toolEvents,
          toolPairs,
          signal: runOptions.signal
        });
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
          content: buildMaxRoundsFinalPrompt(messages, fileToolCalls, executionToolCalls)
        }
      ],
      toolChoice: 'none',
      signal: runOptions.signal,
      stream: this.streamHandlers()
    });
    throwIfAborted(runOptions.signal);
    if (shouldSuppressLongCodeFallback(messages, fileToolCalls, executionToolCalls, finalResponse)) {
      return {
        text: '未完成：工具调用轮次已达到上限，且目标文件没有成功写入 workspace。为避免输出被截断的不完整代码，neo 已停止刷屏兜底。请重新发起任务，或要求我用 Append 分块写入目标文件。',
        webToolCalls,
        mcpToolCalls,
        fileToolCalls,
        executionToolCalls,
        skillToolCalls,
        toolEvents,
        toolPairs
      };
    }
    return { text: finalResponse.content, webToolCalls, mcpToolCalls, fileToolCalls, executionToolCalls, skillToolCalls, toolEvents, toolPairs };
  }

  private findRunner(name: string): ToolRunner<ToolCallRecord> | undefined {
    return this.tools.find(tool => tool.canExecute(name));
  }

  private async executeToolRound(
    toolCalls: ChatToolCall[],
    round: number,
    signal: AbortSignal | undefined,
    state: Omit<QueryEngineResult, 'text'>
  ): Promise<{ messages: ChatMessage[]; terminal: boolean }> {
    const tasks = toolCalls.map(toolCall => {
      const runner = this.findRunner(toolCall.function.name);
      const mode = runner?.executionMode?.(toolCall.function.name) ?? 'serial';
      return { toolCall, runner, mode };
    });
    const outputs = new Map<string, ToolRoundOutput>();
    const exclusiveIndex = tasks.findIndex(task => task.runner && task.mode === 'exclusive');

    for (const task of tasks) {
      this.emitToolStart(task.toolCall, round, state.toolEvents);
    }

    if (exclusiveIndex >= 0) {
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        if (index === exclusiveIndex) {
          const result = await this.executeSingleTool(task.toolCall, task.runner, round, signal, state);
          outputs.set(task.toolCall.id, result);
          continue;
        }
        const reason = `同一轮存在独占工具 ${tasks[exclusiveIndex].toolCall.function.name}，为避免并发写入或状态竞争，已跳过 ${task.toolCall.function.name}。`;
        outputs.set(task.toolCall.id, this.skipTool(task.toolCall, reason, round, state.toolEvents));
      }
      return orderedRoundOutput(toolCalls, outputs, state.toolPairs, round);
    }

    const parallelTasks = tasks.filter(task => task.runner && task.mode === 'parallel');
    await Promise.all(parallelTasks.map(async task => {
      const result = await this.executeSingleTool(task.toolCall, task.runner, round, signal, state);
      outputs.set(task.toolCall.id, result);
    }));

    for (const task of tasks.filter(item => !item.runner || item.mode !== 'parallel')) {
      const result = await this.executeSingleTool(task.toolCall, task.runner, round, signal, state);
      outputs.set(task.toolCall.id, result);
    }

    return orderedRoundOutput(toolCalls, outputs, state.toolPairs, round);
  }

  private emitToolStart(toolCall: ChatToolCall, round: number, toolEvents: ToolProgressEvent[]): void {
    const startEvent = createToolStartEvent(toolCall, round);
    emitToolEvent(startEvent, toolEvents, this.options.onToolEvent);
    this.logger.info('tool.start', {
      ...summarizeToolArguments(toolCall),
      round
    });
  }

  private async executeSingleTool(
    toolCall: ChatToolCall,
    runner: ToolRunner<ToolCallRecord> | undefined,
    round: number,
    signal: AbortSignal | undefined,
    state: Omit<QueryEngineResult, 'text'>
  ): Promise<ToolRoundOutput> {
    throwIfAborted(signal);
    if (!runner) {
      const unknownEvent = createUnknownToolEvent(toolCall.function.name, round);
      emitToolEvent(unknownEvent, state.toolEvents, this.options.onToolEvent);
      this.logger.warn('tool.unknown', { name: toolCall.function.name, round });
      return {
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: buildUnknownToolResult(toolCall.function.name, round)
        },
        terminal: false
      };
    }

    try {
      const result = await this.runToolWithLifecycle(runner, toolCall, round, signal);
      throwIfAborted(signal);
      recordToolResult(result.record, state);
      const budgeted = await applyToolResultBudget({
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        content: result.content,
        options: this.options.toolResultBudget
      });
      if (budgeted.persisted) {
        this.logger.info('tool.result_persisted', {
          name: toolCall.function.name,
          toolCallId: toolCall.id,
          originalChars: budgeted.persisted.originalChars,
          previewChars: budgeted.persisted.previewChars,
          path: budgeted.persisted.displayPath,
          round
        });
      }
      this.options.hooks?.emit('PostToolUse', toolCall.function.name, {
        round,
        terminal: Boolean(result.terminal),
        resultChars: budgeted.content.length,
        originalResultChars: budgeted.persisted?.originalChars
      });
      const successEvent = createToolSuccessEvent(toolCall.function.name, result.record, budgeted.content, round);
      emitToolEvent(successEvent, state.toolEvents, this.options.onToolEvent);
      this.logger.info('tool.success', {
        name: toolCall.function.name,
        ...summarizeToolResult(result.record, budgeted.content),
        round
      });
      return {
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: budgeted.content
        },
        terminal: Boolean(result.terminal),
        persisted: budgeted.persisted
      };
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      const errorEvent = createToolErrorEvent(toolCall.function.name, error, round);
      emitToolEvent(errorEvent, state.toolEvents, this.options.onToolEvent);
      this.logger.warn('tool.error', {
        name: toolCall.function.name,
        ...summarizeToolError(error),
        errorCode: errorCodeFor(error, `tool.${toolCall.function.name}`),
        round
      });
      return {
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: buildToolErrorResult(toolCall.function.name, error, round)
        },
        terminal: false
      };
    }
  }

  private async runToolWithLifecycle(
    runner: ToolRunner<ToolCallRecord>,
    toolCall: ChatToolCall,
    round: number,
    parentSignal: AbortSignal | undefined
  ): Promise<ToolExecutionResult<ToolCallRecord>> {
    const timeoutMs = this.options.toolTimeoutMs ?? 120_000;
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal?.reason ?? createAbortError());
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    let timedOut = false;
    let settledByRace = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`工具超时：${toolCall.function.name} 超过 ${timeoutMs}ms`));
    }, timeoutMs);

    const execution = Promise.resolve().then(() => runner.execute(toolCall, { signal: controller.signal }));
    execution.then(
      result => {
        if (!settledByRace) return;
        this.logger.warn('tool.orphan_result', {
          name: toolCall.function.name,
          toolCallId: toolCall.id,
          round,
          resultChars: result.content.length,
          reason: timedOut ? 'timeout' : 'aborted'
        });
      },
      error => {
        if (!settledByRace) return;
        this.logger.warn('tool.orphan_result', {
          name: toolCall.function.name,
          toolCallId: toolCall.id,
          round,
          reason: timedOut ? 'timeout' : 'aborted',
          errorCode: errorCodeFor(error, `tool.${toolCall.function.name}.orphan`),
          ...summarizeToolError(error)
        });
      }
    );

    try {
      return await Promise.race([
        execution,
        new Promise<ToolExecutionResult<ToolCallRecord>>((_, reject) => {
          const onAbort = (): void => {
            reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('工具已取消'));
          };
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } finally {
      settledByRace = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  private skipTool(toolCall: ChatToolCall, reason: string, round: number, toolEvents: ToolProgressEvent[]): ToolRoundOutput {
    const error = new Error(reason);
    const errorEvent = createToolErrorEvent(toolCall.function.name, error, round);
    emitToolEvent(errorEvent, toolEvents, this.options.onToolEvent);
    this.logger.warn('tool.skipped', {
      name: toolCall.function.name,
      round,
      reason
    });
    return {
      message: {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: buildSkippedToolResult(toolCall.function.name, reason, round)
      },
      terminal: false
    };
  }

  private async finalizeAfterTerminalTool(
    modelKind: TextModelKind,
    messages: ChatMessage[],
    state: Omit<QueryEngineResult, 'text'> & { signal?: AbortSignal }
  ): Promise<QueryEngineResult> {
    const model = this.models.get(modelKind);
    const finalResponse = await model.chatWithTools({
      messages: [
        ...messages,
        {
          role: 'user',
          content: '上一个工具结果已经完成了用户请求中的外部操作。请不要继续调用工具，直接基于工具结果给出最终回答；如果有 warning 或未完成项，要明确列出。'
        }
      ],
      toolChoice: 'none',
      signal: state.signal,
      stream: this.streamHandlers()
    });
    throwIfAborted(state.signal);
    return {
      text: finalResponse.content,
      webToolCalls: state.webToolCalls,
      mcpToolCalls: state.mcpToolCalls,
      fileToolCalls: state.fileToolCalls,
      executionToolCalls: state.executionToolCalls,
      skillToolCalls: state.skillToolCalls,
      toolEvents: state.toolEvents,
      toolPairs: state.toolPairs
    };
  }

  private streamHandlers(): { onContentDelta?: (delta: string) => void } | undefined {
    return this.options.onContentDelta ? { onContentDelta: this.options.onContentDelta } : undefined;
  }

  private async applyHistoryToolResultBudget(messages: ChatMessage[], toolPairs: ToolPairRecord[], round: number): Promise<void> {
    const replacements = await applyToolHistoryBudget({
      messages,
      options: this.options.toolResultBudget,
      toolNameForCallId: toolCallId => toolPairs.find(pair => pair.toolCallId === toolCallId)?.toolName
    });
    for (const replacement of replacements) {
      const pair = toolPairs.find(item => item.toolCallId === replacement.toolCallId);
      if (pair) {
        pair.resultChars = replacement.nextChars;
        pair.persistedPath = replacement.persisted.displayPath;
        pair.originalResultChars = replacement.persisted.originalChars;
      }
      this.logger.info('tool.history_result_persisted', {
        name: replacement.toolName,
        toolCallId: replacement.toolCallId,
        originalChars: replacement.previousChars,
        referenceChars: replacement.nextChars,
        path: replacement.persisted.displayPath,
        round
      });
    }
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

function normalizeToolCallIds(toolCalls: ChatToolCall[]): ChatToolCall[] {
  const seen = new Set<string>();
  return toolCalls.map((toolCall, index) => {
    const baseId = toolCall.id || `tool_call_${index}`;
    const id = seen.has(baseId) ? `${baseId}_${index}` : baseId;
    seen.add(id);
    if (id === toolCall.id) return toolCall;
    return { ...toolCall, id };
  });
}

function hasIncompleteToolArguments(toolCalls: ChatToolCall[]): boolean {
  return toolCalls.some(toolCall => {
    try {
      const parsed = JSON.parse(toolCall.function.arguments || '{}');
      return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
    } catch {
      return true;
    }
  });
}

function buildTruncatedToolArgumentsRecoveryPrompt(consecutiveCount: number): string {
  const base = [
    '上一次工具调用参数被模型输出长度截断，neo 没有执行坏工具调用。',
    '如果你要写长文件、HTML/CSS/JS、落地页或完整单文件应用，请改用 Append 分块写入 workspace 文件：第一块调用 Append，mode=create；后续块调用 Append，mode=append。',
    '不要按 section 切成很多小块；普通单文件落地页应尽量 1-3 次工具调用写完。每块 content 尽量大，但必须保证本次工具参数是完整合法 JSON。',
    '不要再次用 Write 传会被截断的超长 content，也不要在最终回答里刷出整段长代码。'
  ];
  if (consecutiveCount >= 2) {
    base.push('你已经连续触发工具参数截断。下一步必须用 Append 写一个完整合法的大块，或明确说明无法完成；不要继续生成会被截断的 Write 参数，也不要退化成很多极小块。');
  }
  return base.join(' ');
}

function buildMaxRoundsFinalPrompt(
  originalMessages: ChatMessage[],
  fileToolCalls: FileToolCallRecord[],
  executionToolCalls: ExecutionToolCallRecord[]
): string {
  if (isLikelyLongFileGenerationRequest(originalMessages) && !hasSuccessfulFileWriteSurface(fileToolCalls, executionToolCalls)) {
    return [
      '工具调用轮次已达到上限，且用户请求看起来是生成长文件/HTML/CSS/JS/落地页/完整单文件，但没有成功写入目标文件。',
      '不要输出完整代码兜底，不要输出长代码块。',
      '请用简短中文明确说明未完成、原因是工具参数被截断或轮次耗尽，并建议重新使用 Append 分块写入 workspace 文件。'
    ].join(' ');
  }
  return '工具调用轮次已达到上限。请基于已有工具结果直接给出最终回答；如果信息不足，要明确说明。不要输出可能被截断的长代码兜底。';
}

function shouldSuppressLongCodeFallback(
  originalMessages: ChatMessage[],
  fileToolCalls: FileToolCallRecord[],
  executionToolCalls: ExecutionToolCallRecord[],
  response: { content: string; finishReason?: string | null }
): boolean {
  if (!isLikelyLongFileGenerationRequest(originalMessages)) return false;
  if (hasSuccessfulFileWriteSurface(fileToolCalls, executionToolCalls)) return false;
  if (response.finishReason === 'length') return true;
  return response.content.length > 6000 && /```|<html|<!DOCTYPE|<style|<script/i.test(response.content);
}

function isLikelyLongFileGenerationRequest(messages: ChatMessage[]): boolean {
  const userText = messages
    .filter(message => message.role === 'user')
    .map(message => message.content)
    .join('\n');
  return /(html|css|javascript|js|landing page|single[- ]file|write (a )?file|create (a )?file|生成.*(文件|网页|页面)|写入.*文件|落地页|单文件|完整.*(HTML|代码|页面))/i.test(userText);
}

function hasSuccessfulFileWriteSurface(
  fileToolCalls: FileToolCallRecord[],
  executionToolCalls: ExecutionToolCallRecord[]
): boolean {
  if (fileToolCalls.some(call => ['write', 'append', 'edit', 'copy', 'move'].includes(call.operation ?? ''))) return true;
  return executionToolCalls.some(call => call.exitCode === 0);
}

function orderedRoundOutput(
  toolCalls: ChatToolCall[],
  outputs: Map<string, ToolRoundOutput>,
  toolPairs: ToolPairRecord[],
  round: number
): { messages: ChatMessage[]; terminal: boolean } {
  const messages: ChatMessage[] = [];
  let terminal = false;
  for (const toolCall of toolCalls) {
    const output = outputs.get(toolCall.id);
    if (!output) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: buildSkippedToolResult(toolCall.function.name, '工具执行器没有返回结果，已生成占位 tool result，避免 orphan tool_use。', 0)
      });
      toolPairs.push({
        round,
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        hasResult: false,
        resultChars: 0
      });
      continue;
    }
    messages.push(output.message);
    toolPairs.push({
      round,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      hasResult: true,
      resultChars: output.message.content.length,
      persistedPath: output.persisted?.displayPath,
      originalResultChars: output.persisted?.originalChars
    });
    terminal = terminal || output.terminal;
  }
  return { messages, terminal };
}

type ToolRoundOutput = {
  message: ChatMessage;
  terminal: boolean;
  persisted?: ToolResultBudgetOutcome['persisted'];
};

function recordToolResult(record: ToolCallRecord | undefined, state: Omit<QueryEngineResult, 'text'>): void {
  if (!record) return;
  if (isMcpRecord(record)) state.mcpToolCalls.push(record);
  else if (isFileRecord(record)) state.fileToolCalls.push(record);
  else if (isExecutionRecord(record)) state.executionToolCalls.push(record);
  else if (isSkillRecord(record)) state.skillToolCalls.push(record);
  else state.webToolCalls.push(record);
}

function isMcpRecord(record: ToolCallRecord): record is McpToolCallRecord {
  return 'serverName' in record && 'toolName' in record;
}

function isFileRecord(record: ToolCallRecord): record is FileToolCallRecord {
  return 'resultChars' in record && 'durationMs' in record && !('serverName' in record) && !('searchedAt' in record) && !('skillName' in record);
}

function isExecutionRecord(record: ToolCallRecord): record is ExecutionToolCallRecord {
  return 'exitCode' in record && 'stdoutChars' in record && 'stderrChars' in record;
}

function isSkillRecord(record: ToolCallRecord): record is SkillToolCallRecord {
  return 'skillName' in record && 'scope' in record;
}
