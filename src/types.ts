export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
};

export type ChatToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

export type ChatToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatCompletionResult = {
  content: string;
  reasoningContent?: string;
  toolCalls: ChatToolCall[];
  finishReason?: string | null;
};

export type ModelKind = 'main' | 'small' | 'vision';
export type TextModelKind = Exclude<ModelKind, 'vision'>;

export type ModelConfig = {
  model: string;
  apiKey?: string;
  apiBase: string;
  temperature: number;
  maxTokens: number;
};

export type MemoryBackend = 'local' | 'openviking' | 'hybrid';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type MemoryCategory = 'preference' | 'project_fact' | 'workflow' | 'session_summary';
export type MemoryOrigin = 'manual' | 'session' | 'agent' | 'imported' | 'openviking';
export type MemoryStatus = 'active' | 'archived';
export type WebSearchDepth = 'basic' | 'advanced';
export type WebExtractDepth = 'basic' | 'advanced';
export type McpPermissionMode = 'readOnly' | 'allowAll';

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
};

export type AppConfig = {
  homeDir: string;
  models: {
    main: ModelConfig;
    small: ModelConfig;
    vision: ModelConfig;
  };
  routing: {
    smallModelMaxChars: number;
    forceMainKeywords: string[];
  };
  conversation: {
    maxHistoryChars: number;
    maxMessageChars: number;
    compactEnabled: boolean;
    compactThresholdRatio: number;
    compactKeepRecentChars: number;
    compactMaxSummaryChars: number;
  };
  memory: {
    backend: MemoryBackend;
    openVikingUrl: string;
    maxHits: number;
  };
  dreaming: {
    enabled: boolean;
    minHours: number;
    minSessions: number;
    maxSessions: number;
    transcriptTailLines: number;
    maxMemories: number;
    modelKind: TextModelKind;
  };
  web: {
    provider: 'tavily';
    apiKey?: string;
    apiBase: string;
    autoSearch: boolean;
    toolLoopEnabled: boolean;
    maxToolRounds: number;
    plannerEnabled: boolean;
    plannerModelKind: TextModelKind;
    searchDepth: WebSearchDepth;
    extractDepth: WebExtractDepth;
    maxResults: number;
    maxContextChars: number;
    maxDepth: number;
    maxBreadth: number;
    maxPages: number;
    allowExternal: boolean;
    allowedDomains: string[];
    blockedDomains: string[];
    blockPrivateAddresses: boolean;
    selectPaths: string[];
    excludePaths: string[];
    selectDomains: string[];
    excludeDomains: string[];
    timeoutMs: number;
  };
  skills: {
    autoCreate: boolean;
    autoCreateThreshold: number;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
    toolSearchThreshold: number;
    permissions: {
      mode: McpPermissionMode;
      allowedTools: string[];
      deniedTools: string[];
    };
  };
  logging: {
    level: LogLevel;
    file: string;
    console: boolean;
    maxBytes: number;
    retentionDays: number;
    maxFiles: number;
  };
  transcripts: {
    enabled: boolean;
    dir: string;
    maxTailLines: number;
  };
};

export type Attachment = {
  type: 'image';
  path: string;
  mimeType: string;
};

export type RouterDecision = {
  modelKind: TextModelKind;
  reason: string;
};

export type MemoryRecord = {
  id: string;
  uri: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  origin: MemoryOrigin;
  pinned: boolean;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryHit = MemoryRecord & {
  score: number;
  source: 'local' | 'openviking';
};

export type Skill = {
  name: string;
  path: string;
  description: string;
  triggers: string[];
  body: string;
};

export type AgentResponse = {
  text: string;
  modelKind: TextModelKind;
  visionContext?: string;
  webContext?: WebContext;
  webToolCalls?: WebToolCallRecord[];
  mcpToolCalls?: McpToolCallRecord[];
  fileToolCalls?: FileToolCallRecord[];
  toolEvents?: ToolProgressEvent[];
  memories: MemoryHit[];
  skills: Skill[];
};

export type WebToolCallRecord = {
  name: 'WebSearch' | 'WebFetch';
  query?: string;
  url?: string;
  searchedAt: string;
  resultCount: number;
  failedCount?: number;
};

export type McpToolCallRecord = {
  name: string;
  serverName: string;
  toolName: string;
  resultChars: number;
  durationMs: number;
};

export type FileToolCallRecord = {
  name: 'Read' | 'Glob' | 'Grep';
  path?: string;
  pattern?: string;
  resultCount?: number;
  resultChars: number;
  durationMs: number;
};

export type ToolCallRecord = WebToolCallRecord | McpToolCallRecord | FileToolCallRecord;

export type ToolProgressEvent = {
  phase: 'start' | 'success' | 'error' | 'unknown' | 'max_rounds';
  round: number;
  name: string;
  summary: string;
  metadata: Record<string, unknown>;
};

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
};

export type WebSearchResponse = {
  query: string;
  answer?: string;
  results: WebSearchResult[];
  responseTime?: number;
};

export type WebExtractResult = {
  url: string;
  content: string;
};

export type WebExtractResponse = {
  results: WebExtractResult[];
  failedResults: Array<{ url: string; error?: string }>;
  responseTime?: number;
};

export type WebMapResponse = {
  baseUrl?: string;
  results: string[];
  responseTime?: number;
};

export type WebCrawlResult = {
  url: string;
  content: string;
};

export type WebCrawlResponse = {
  baseUrl?: string;
  results: WebCrawlResult[];
  responseTime?: number;
};

export type WebContext = {
  query?: string;
  reason: string;
  plannerSource?: 'model' | 'fallback';
  plannerAction?: 'none' | 'search' | 'extract' | 'search_and_extract';
  usesPreviousTurn?: boolean;
  searchedAt: string;
  search?: WebSearchResponse;
  extracts?: WebExtractResponse;
};
