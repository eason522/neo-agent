export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
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
    searchDepth: WebSearchDepth;
    extractDepth: WebExtractDepth;
    maxResults: number;
    maxDepth: number;
    maxBreadth: number;
    maxPages: number;
    allowExternal: boolean;
    timeoutMs: number;
  };
  skills: {
    autoCreate: boolean;
    autoCreateThreshold: number;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
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
  memories: MemoryHit[];
  skills: Skill[];
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
