import type { ChatToolCall, ChatToolDefinition } from '../types.js';

export type ToolExecutionOptions = {
  signal?: AbortSignal;
};

export type ToolExecutionMode = 'parallel' | 'serial' | 'exclusive';

export type ToolExecutionResult<TRecord = unknown> = {
  content: string;
  record?: TRecord;
  terminal?: boolean;
};

export type ToolRunner<TRecord = unknown> = {
  refresh?(): Promise<void>;
  definitions(): ChatToolDefinition[];
  canExecute(name: string): boolean;
  executionMode?(name: string): ToolExecutionMode;
  execute(call: ChatToolCall, options?: ToolExecutionOptions): Promise<ToolExecutionResult<TRecord>>;
};
