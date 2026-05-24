import type { AgentResponse, AppConfig, Attachment, ChatMessage, WebContext } from './types.js';
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
import { formatWebContext, TavilyClient } from './web/tavilyClient.js';
import { planWebUse } from './web/webPlanner.js';

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
  private readonly conversationHistory: ChatMessage[] = [];

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
    const [memories, matchedSkills, mcpTools, visionContext, soul, webContext] = await Promise.all([
      this.memory.search(input),
      this.skills.match(input),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input),
      loadSoul(),
      this.buildWebContext(input)
    ]);

    const decision = this.router.decide(input, attachments);
    this.logger.info('router.decision', {
      modelKind: decision.modelKind,
      reason: decision.reason,
      memoryHits: memories.length,
      matchedSkills: matchedSkills.length,
      mcpTools: mcpTools.length,
      hasVisionContext: Boolean(visionContext),
      hasWebContext: Boolean(webContext)
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
      webContext ? `Web context:\n${formatWebContext(webContext, this.config.web.maxContextChars)}\n\n使用要求：如果你使用了 Web context，请在回答末尾列出“来源”，包含关键 URL 和联网时间 ${webContext.searchedAt}。不要编造来源。` : '',
      `User request:\n${input}`
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.recentConversationHistory(),
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
        hasVisionContext: Boolean(visionContext),
        web: webContext ? {
          reason: webContext.reason,
          query: webContext.query,
          searchResults: webContext.search?.results.length ?? 0,
          extractResults: webContext.extracts?.results.length ?? 0,
          searchedAt: webContext.searchedAt
        } : undefined
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
      this.appendConversationHistory(input, text);

      this.logger.info('agent.ask.success', {
        modelKind: decision.modelKind,
        outputChars: text.length,
        hasWebContext: Boolean(webContext),
        durationMs: Date.now() - start
      });
      return {
        text,
        modelKind: decision.modelKind,
        visionContext,
        memories,
        skills: matchedSkills,
        webContext
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

  private async buildWebContext(input: string): Promise<WebContext | undefined> {
    const previousUserInput = this.lastUserInput();
    const plan = planWebUse(input, this.config.web.autoSearch, previousUserInput);
    this.logger.info('web.plan', {
      shouldUseWeb: plan.shouldUseWeb,
      reason: plan.reason,
      hasQuery: Boolean(plan.query),
      urlCount: plan.urls.length,
      hasPreviousUserInput: Boolean(previousUserInput),
      autoSearch: this.config.web.autoSearch,
      webConfigured: Boolean(this.config.web.apiKey)
    });
    if (!plan.shouldUseWeb) return undefined;
    if (!this.config.web.apiKey) {
      this.logger.warn('web.skip.missing_api_key', { reason: plan.reason });
      return undefined;
    }

    const context: WebContext = {
      query: plan.query,
      reason: plan.reason,
      searchedAt: new Date().toISOString()
    };

    try {
      if (plan.query) {
        context.search = await this.web.search(plan.query, {
          maxResults: this.config.web.maxResults,
          includeAnswer: true
        });
      }
      if (plan.urls.length > 0) {
        context.extracts = await this.web.extract(plan.urls);
      } else if (context.search?.results.length) {
        const urls = context.search.results.slice(0, 2).map(result => result.url);
        context.extracts = await this.web.extract(urls).catch(error => {
          this.logger.warn('web.auto_extract.error', {
            error: error instanceof Error ? error.message : String(error),
            urlCount: urls.length
          });
          return undefined;
        });
      }
      return context;
    } catch (error) {
      this.logger.error('web.context.error', error, { reason: plan.reason });
      return undefined;
    }
  }

  private recentConversationHistory(): ChatMessage[] {
    return this.conversationHistory.slice(-8);
  }

  private appendConversationHistory(userInput: string, assistantText: string): void {
    this.conversationHistory.push(
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantText.slice(0, 4000) }
    );
    if (this.conversationHistory.length > 12) {
      this.conversationHistory.splice(0, this.conversationHistory.length - 12);
    }
  }

  private lastUserInput(): string | undefined {
    for (let index = this.conversationHistory.length - 1; index >= 0; index -= 1) {
      const message = this.conversationHistory[index];
      if (message?.role === 'user') return message.content;
    }
    return undefined;
  }
}
