import type { AgentResponse, AppConfig, Attachment, ChatMessage } from './types.js';
import { ModelRegistry } from './models/modelRegistry.js';
import { ModelRouter } from './router.js';
import { VisionAnalyzer } from './vision/visionAnalyzer.js';
import { MemoryService } from './memory/memoryService.js';
import { SkillManager } from './skills/skillManager.js';
import { McpManager } from './mcp/mcpManager.js';
import { SubAgentRunner } from './agents/subAgent.js';
import { buildSystemPrompt } from './prompts/systemPrompt.js';

export class NeoAgent {
  readonly models: ModelRegistry;
  readonly memory: MemoryService;
  readonly skills: SkillManager;
  readonly mcp: McpManager;
  readonly subAgent: SubAgentRunner;

  private readonly router: ModelRouter;
  private readonly vision: VisionAnalyzer;

  constructor(readonly config: AppConfig) {
    this.models = new ModelRegistry(config);
    this.memory = new MemoryService(config);
    this.skills = new SkillManager(config);
    this.mcp = new McpManager(config);
    this.subAgent = new SubAgentRunner(this.models);
    this.router = new ModelRouter(config);
    this.vision = new VisionAnalyzer(this.models);
  }

  async initialize(): Promise<void> {
    await this.mcp.connectAll();
  }

  async ask(input: string, attachments: Attachment[] = []): Promise<AgentResponse> {
    const [memories, matchedSkills, mcpTools, visionContext] = await Promise.all([
      this.memory.search(input),
      this.skills.match(input),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input)
    ]);

    const decision = this.router.decide(input, attachments);
    const systemPrompt = buildSystemPrompt(memories, matchedSkills, mcpTools);
    const userContent = [
      visionContext ? `Vision context:\n${visionContext}` : '',
      `User request:\n${input}`
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const text = await this.models.get(decision.modelKind).chat({ messages });
    await this.memory.remember(`User: ${input}\nAssistant: ${text.slice(0, 1200)}`, ['session'], 'session');
    await this.skills.maybeAutoCreate(input, text).catch(() => undefined);

    return {
      text,
      modelKind: decision.modelKind,
      visionContext,
      memories,
      skills: matchedSkills
    };
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}
