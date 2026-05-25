import type { ChatMessage, ChatToolDefinition, McpToolCallRecord, TextModelKind, ToolCallRecord, WebToolCallRecord } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';
import type { ToolRunner } from '../tools/tool.js';

export type QueryEngineResult = {
  text: string;
  webToolCalls: WebToolCallRecord[];
  mcpToolCalls: McpToolCallRecord[];
};

type QueryEngineOptions = {
  maxToolRounds: number;
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

  async run(modelKind: TextModelKind, messages: ChatMessage[]): Promise<QueryEngineResult> {
    const model = this.models.get(modelKind);
    const loopMessages = messages.map(message => ({ ...message }));
    await Promise.all(this.tools.map(tool => tool.refresh?.() ?? Promise.resolve()));
    const toolDefinitions = this.toolDefinitions();
    const webToolCalls: WebToolCallRecord[] = [];
    const mcpToolCalls: McpToolCallRecord[] = [];

    if (toolDefinitions.length === 0) {
      return {
        text: await model.chat({ messages: loopMessages }),
        webToolCalls,
        mcpToolCalls
      };
    }

    for (let round = 0; round < this.options.maxToolRounds; round += 1) {
      const response = await model.chatWithTools({
        messages: loopMessages,
        tools: toolDefinitions,
        toolChoice: 'auto'
      });

      if (response.toolCalls.length === 0) {
        return { text: response.content, webToolCalls, mcpToolCalls };
      }

      loopMessages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
        ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {})
      });

      for (const toolCall of response.toolCalls) {
        const runner = this.findRunner(toolCall.function.name);
        this.logger.info('tool.start', {
          name: toolCall.function.name,
          argumentChars: toolCall.function.arguments.length,
          round
        });

        if (!runner) {
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: `未知工具：${toolCall.function.name}` })
          });
          this.logger.warn('tool.unknown', { name: toolCall.function.name, round });
          continue;
        }

        try {
          const result = await runner.execute(toolCall);
          if (result.record) {
            if (isMcpRecord(result.record)) mcpToolCalls.push(result.record);
            else webToolCalls.push(result.record);
          }
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.content
          });
          this.logger.info('tool.success', {
            name: toolCall.function.name,
            round
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          loopMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: message })
          });
          this.logger.warn('tool.error', {
            name: toolCall.function.name,
            error: message,
            round
          });
        }
      }
    }

    this.logger.warn('tool.max_rounds_reached', {
      maxToolRounds: this.options.maxToolRounds,
      toolCallCount: webToolCalls.length + mcpToolCalls.length
    });
    const finalResponse = await model.chatWithTools({
      messages: [
        ...loopMessages,
        {
          role: 'user',
          content: '工具调用轮次已达到上限。请基于已有工具结果直接给出最终回答；如果信息不足，要明确说明。'
        }
      ],
      toolChoice: 'none'
    });
    return { text: finalResponse.content, webToolCalls, mcpToolCalls };
  }

  private findRunner(name: string): ToolRunner<ToolCallRecord> | undefined {
    return this.tools.find(tool => tool.canExecute(name));
  }
}

function isMcpRecord(record: ToolCallRecord): record is McpToolCallRecord {
  return 'serverName' in record && 'toolName' in record;
}
