import type { ChatToolCall, ChatToolDefinition } from '../types.js';

export type ToolExecutionOptions = {
  signal?: AbortSignal;
};

export type ToolExecutionResult<TRecord = unknown> = {
  content: string;
  record?: TRecord;
};

export type ToolRunner<TRecord = unknown> = {
  refresh?(): Promise<void>;
  definitions(): ChatToolDefinition[];
  canExecute(name: string): boolean;
  execute(call: ChatToolCall, options?: ToolExecutionOptions): Promise<ToolExecutionResult<TRecord>>;
};
