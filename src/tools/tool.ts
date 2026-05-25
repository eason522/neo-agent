import type { ChatToolCall, ChatToolDefinition } from '../types.js';

export type ToolExecutionResult<TRecord = unknown> = {
  content: string;
  record?: TRecord;
};

export type ToolRunner<TRecord = unknown> = {
  definitions(): ChatToolDefinition[];
  canExecute(name: string): boolean;
  execute(call: ChatToolCall): Promise<ToolExecutionResult<TRecord>>;
};
