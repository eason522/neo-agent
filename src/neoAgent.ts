import type { AgentResponse, AppConfig, Attachment, ChatMessage } from './types.js';
import { ModelRegistry } from './models/modelRegistry.js';
import { ModelRouter } from './router.js';
import { VisionAnalyzer } from './vision/visionAnalyzer.js';
import { MemoryService } from './memory/memoryService.js';
import { SkillManager } from './skills/skillManager.js';
import { McpManager } from './mcp/mcpManager.js';
import { SubAgentRunner } from './agents/subAgent.js';
import { buildSystemPrompt } from './prompts/systemPrompt.js';
import { Logger } from './logging/logger.js';

export class NeoAgent {
  readonly models: ModelRegistry;
  readonly memory: MemoryService;
  readonly skills: SkillManager;
  readonly mcp: McpManager;
  readonly subAgent: SubAgentRunner;
  readonly logger: Logger;

  private readonly router: ModelRouter;
  private readonly vision: VisionAnalyzer;

  constructor(readonly config: AppConfig) {
    this.logger = new Logger(config);
    this.models = new ModelRegistry(config, this.logger);
    this.memory = new MemoryService(config, this.logger);
    this.skills = new SkillManager(config);
    this.mcp = new McpManager(config, this.logger);
    this.subAgent = new SubAgentRunner(this.models, this.logger);
    this.router = new ModelRouter(config);
    this.vision = new VisionAnalyzer(this.models);
  }

  async initialize(): Promise<void> {
    this.logger.info('agent.initialize.start', {
      homeDir: this.config.homeDir,
      logFile: this.logger.filePath,
      memoryBackend: this.config.memory.backend
    });
    await this.mcp.connectAll();
    this.logger.info('agent.initialize.success');
  }

  async ask(input: string, attachments: Attachment[] = []): Promise<AgentResponse> {
    const start = Date.now();
    this.logger.info('agent.ask.start', {
      inputChars: input.length,
      attachmentCount: attachments.length
    });
    const [memories, matchedSkills, mcpTools, visionContext] = await Promise.all([
      this.memory.search(input),
      this.skills.match(input),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input)
    ]);

    const decision = this.router.decide(input, attachments);
    this.logger.info('router.decision', {
      modelKind: decision.modelKind,
      reason: decision.reason,
      memoryHits: memories.length,
      matchedSkills: matchedSkills.length,
      mcpTools: mcpTools.length,
      hasVisionContext: Boolean(visionContext)
    });
    const systemPrompt = buildSystemPrompt(memories, matchedSkills, mcpTools);
    const userContent = [
      visionContext ? `Vision context:\n${visionContext}` : '',
      `User request:\n${input}`
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    try {
      const text = await this.models.get(decision.modelKind).chat({ messages });
      await this.memory.remember(`User: ${input}\nAssistant: ${text.slice(0, 1200)}`, ['session'], 'session');
      const createdSkill = await this.skills.maybeAutoCreate(input, text).catch(error => {
        this.logger.error('skill.autocreate.error', error);
        return undefined;
      });
      if (createdSkill) this.logger.info('skill.autocreate.success', { name: createdSkill.name, path: createdSkill.path });

      this.logger.info('agent.ask.success', {
        modelKind: decision.modelKind,
        outputChars: text.length,
        durationMs: Date.now() - start
      });
      return {
        text,
        modelKind: decision.modelKind,
        visionContext,
        memories,
        skills: matchedSkills
      };
    } catch (error) {
      this.logger.error('agent.ask.error', error, { durationMs: Date.now() - start });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
    this.logger.info('agent.close');
    await this.logger.flush();
  }
}
