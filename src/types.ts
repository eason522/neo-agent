export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
};

export type ModelKind = 'main' | 'small' | 'vision';

export type ModelConfig = {
  model: string;
  apiKey?: string;
  apiBase: string;
  temperature: number;
  maxTokens: number;
};

export type MemoryBackend = 'local' | 'openviking' | 'hybrid';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

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
  modelKind: Exclude<ModelKind, 'vision'>;
  reason: string;
};

export type MemoryRecord = {
  id: string;
  uri: string;
  kind: 'user' | 'agent' | 'session';
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
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
  modelKind: Exclude<ModelKind, 'vision'>;
  visionContext?: string;
  memories: MemoryHit[];
  skills: Skill[];
};
