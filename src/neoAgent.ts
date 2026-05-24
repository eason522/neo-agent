import type { AgentResponse, AppConfig, Attachment, ChatMessage } from './types.js';
import { ModelRegistry } from './models/modelRegistry.js';
import { ModelRouter } from './router.js';
import { VisionAnalyzer } from './vision/visionAnalyzer.js';
import { MemoryService } from './memory/memoryService.js';
import { SkillManager } from './skills/skillManager.js';
import { McpManager } from './mcp/mcpManager.js';
import { SubAgentRunner } from './agents/subAgent.js';
import { buildSystemPrompt } from './prompts/systemPrompt.js';
import { loadSoul } from './prompts/soul.js';
import { Logger } from './logging/logger.js';
import { TranscriptService } from './transcript/transcriptService.js';
import { DreamService } from './dream/dreamService.js';
import { TavilyClient } from './web/tavilyClient.js';

export class NeoAgent {
  readonly models: ModelRegistry;
  readonly memory: MemoryService;
  readonly skills: SkillManager;
  readonly mcp: McpManager;
  readonly subAgent: SubAgentRunner;
  readonly logger: Logger;
  readonly transcripts: TranscriptService;
  readonly dreams: DreamService;
  readonly web: TavilyClient;

  private readonly router: ModelRouter;
  private readonly vision: VisionAnalyzer;

  constructor(readonly config: AppConfig) {
    this.logger = new Logger(config);
    this.transcripts = new TranscriptService(config, this.logger);
    this.models = new ModelRegistry(config, this.logger);
    this.memory = new MemoryService(config, this.logger);
    this.skills = new SkillManager(config);
    this.mcp = new McpManager(config, this.logger);
    this.subAgent = new SubAgentRunner(this.models, this.logger);
    this.dreams = new DreamService(config, this.models, this.memory, this.logger);
    this.web = new TavilyClient(config, this.logger);
    this.router = new ModelRouter(config);
    this.vision = new VisionAnalyzer(this.models);
  }

  async initialize(options: { scheduledDreams?: boolean } = {}): Promise<void> {
    this.logger.info('agent.initialize.start', {
      homeDir: this.config.homeDir,
      logFile: this.logger.filePath,
      memoryBackend: this.config.memory.backend
    });
    await this.transcripts.start();
    await this.mcp.connectAll();
    this.logger.info('agent.initialize.success');
    if (options.scheduledDreams ?? true) {
      void this.dreams.maybeRunScheduled().catch(error => {
        this.logger.error('dream.scheduled.error', error);
      });
    }
  }

  async ask(input: string, attachments: Attachment[] = []): Promise<AgentResponse> {
    const start = Date.now();
    this.logger.info('agent.ask.start', {
      inputChars: input.length,
      attachmentCount: attachments.length
    });
    await this.transcripts.append('user', input, {
      attachmentCount: attachments.length,
      attachments: attachments.map(attachment => ({
        type: attachment.type,
        path: attachment.path,
        mimeType: attachment.mimeType
      }))
    });
    const [memories, matchedSkills, mcpTools, visionContext, soul] = await Promise.all([
      this.memory.search(input),
      this.skills.match(input),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input),
      loadSoul()
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
    const systemPrompt = buildSystemPrompt({
      memories,
      skills: matchedSkills,
      mcpTools,
      soul,
      modelName: this.config.models[decision.modelKind].model
    });
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
      await this.transcripts.append('assistant', text, {
        modelKind: decision.modelKind,
        model: this.config.models[decision.modelKind].model,
        routerReason: decision.reason,
        memoryHits: memories.length,
        matchedSkills: matchedSkills.map(skill => skill.name),
        hasVisionContext: Boolean(visionContext)
      });
      await this.memory.remember(`User: ${input}\nAssistant: ${text.slice(0, 1200)}`, {
        category: 'session_summary',
        tags: ['session'],
        origin: 'session'
      });
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
      await this.transcripts.append('error', error instanceof Error ? error.message : String(error), {
        stage: 'agent.ask',
        durationMs: Date.now() - start
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
    this.logger.info('agent.close');
    await this.transcripts.end();
    await this.logger.flush();
  }
}
