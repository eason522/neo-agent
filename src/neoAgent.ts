import type { AgentResponse, AppConfig, Attachment, ChatMessage, WebContext } from './types.js';
import { ModelRegistry } from './models/modelRegistry.js';
import { ModelRouter } from './router.js';
import { VisionAnalyzer } from './vision/visionAnalyzer.js';
import { MemoryService } from './memory/memoryService.js';
import { SkillManager } from './skills/skillManager.js';
import { McpManager } from './mcp/mcpManager.js';
import { getMcpToolPrompt, McpToolRunner } from './mcp/mcpToolRunner.js';
import { SubAgentRunner } from './agents/subAgent.js';
import { buildSystemPrompt } from './prompts/systemPrompt.js';
import { loadSoul } from './prompts/soul.js';
import { Logger } from './logging/logger.js';
import { TranscriptService } from './transcript/transcriptService.js';
import { DreamService } from './dream/dreamService.js';
import { formatWebContext, TavilyClient } from './web/tavilyClient.js';
import { planWebUseWithModel } from './web/webPlanner.js';
import { getWebToolPrompt, WebToolRunner } from './web/webTools.js';
import { ConversationHistory } from './conversation/history.js';
import { QueryEngine } from './agent/queryEngine.js';

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
  private readonly conversationHistory: ConversationHistory;
  private readonly webToolRunner: WebToolRunner;
  private readonly mcpToolRunner: McpToolRunner;
  private readonly queryEngine: QueryEngine;

  constructor(readonly config: AppConfig) {
    this.logger = new Logger(config);
    this.transcripts = new TranscriptService(config, this.logger);
    this.models = new ModelRegistry(config, this.logger);
    this.memory = new MemoryService(config, this.logger);
    this.skills = new SkillManager(config);
    this.mcp = new McpManager(config, this.logger);
    this.mcpToolRunner = new McpToolRunner(this.mcp, config.mcp.permissions);
    this.subAgent = new SubAgentRunner(this.models, this.logger);
    this.dreams = new DreamService(config, this.models, this.memory, this.logger);
    this.web = new TavilyClient(config, this.logger);
    this.webToolRunner = new WebToolRunner(config, this.web);
    this.queryEngine = new QueryEngine(this.models, [this.webToolRunner, this.mcpToolRunner], this.logger, {
      maxToolRounds: config.web.maxToolRounds
    });
    this.router = new ModelRouter(config);
    this.vision = new VisionAnalyzer(this.models);
    this.conversationHistory = new ConversationHistory(config.conversation.maxHistoryChars, config.conversation.maxMessageChars);
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
    const useWebToolLoop = this.shouldUseWebToolLoop();
    const [memories, matchedSkills, mcpTools, visionContext, soul, webContext] = await Promise.all([
      this.memory.search(input),
      this.skills.match(input),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input),
      loadSoul(),
      useWebToolLoop ? Promise.resolve(undefined) : this.buildWebContext(input)
    ]);

    const decision = this.router.decide(input, attachments);
    this.logger.info('router.decision', {
      modelKind: decision.modelKind,
      reason: decision.reason,
      memoryHits: memories.length,
      matchedSkills: matchedSkills.length,
      mcpTools: mcpTools.length,
      hasVisionContext: Boolean(visionContext),
      hasWebContext: Boolean(webContext),
      webToolLoop: useWebToolLoop
    });
    const useToolLoop = useWebToolLoop || mcpTools.length > 0;
    const systemPrompt = this.withToolPrompt(buildSystemPrompt({
      memories,
      skills: matchedSkills,
      mcpTools,
      soul,
      modelName: this.config.models[decision.modelKind].model
    }), useToolLoop);
    const userContent = [
      visionContext ? `Vision context:\n${visionContext}` : '',
      webContext ? `Web context:\n${formatWebContext(webContext, this.config.web.maxContextChars)}\n\n使用要求：如果你使用了 Web context，请在回答末尾列出“来源”，包含关键 URL 和联网时间 ${webContext.searchedAt}。不要编造来源。` : '',
      `User request:\n${input}`
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.recentMessages(),
      { role: 'user', content: userContent }
    ];
    const historyStats = this.conversationHistory.stats();

    try {
      const { text, webToolCalls, mcpToolCalls } = useToolLoop
        ? await this.queryEngine.run(decision.modelKind, messages)
        : { text: await this.models.get(decision.modelKind).chat({ messages }), webToolCalls: [], mcpToolCalls: [] };
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
          plannerSource: webContext.plannerSource,
          plannerAction: webContext.plannerAction,
          usesPreviousTurn: webContext.usesPreviousTurn,
          searchResults: webContext.search?.results.length ?? 0,
          extractResults: webContext.extracts?.results.length ?? 0,
          searchedAt: webContext.searchedAt
        } : undefined,
        webToolCalls: webToolCalls.map(call => ({
          name: call.name,
          query: call.query,
          url: call.url,
          resultCount: call.resultCount,
          failedCount: call.failedCount,
          searchedAt: call.searchedAt
        })),
        mcpToolCalls: mcpToolCalls.map(call => ({
          name: call.name,
          serverName: call.serverName,
          toolName: call.toolName,
          resultChars: call.resultChars,
          durationMs: call.durationMs
        }))
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
      this.conversationHistory.append(input, text);

      this.logger.info('agent.ask.success', {
        modelKind: decision.modelKind,
        outputChars: text.length,
        historyMessageCount: historyStats.messageCount,
        historyChars: historyStats.charCount,
        hasWebContext: Boolean(webContext),
        webToolCallCount: webToolCalls.length,
        mcpToolCallCount: mcpToolCalls.length,
        durationMs: Date.now() - start
      });
      return {
        text,
        modelKind: decision.modelKind,
        visionContext,
        memories,
        skills: matchedSkills,
        webContext,
        webToolCalls,
        mcpToolCalls
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

  private shouldUseWebToolLoop(): boolean {
    return this.config.web.autoSearch && this.config.web.toolLoopEnabled && Boolean(this.config.web.apiKey);
  }

  private withToolPrompt(systemPrompt: string, enabled: boolean): string {
    if (!enabled) return systemPrompt;
    return [
      systemPrompt,
      getWebToolPrompt(),
      getMcpToolPrompt()
    ].join('\n\n');
  }

  private async buildWebContext(input: string): Promise<WebContext | undefined> {
    const previousUserInput = this.conversationHistory.lastUserInput();
    if (!this.config.web.autoSearch) {
      this.logger.info('web.plan', {
        shouldUseWeb: false,
        reason: '自动联网已关闭。',
        autoSearch: false,
        webConfigured: Boolean(this.config.web.apiKey)
      });
      return undefined;
    }
    if (!this.config.web.apiKey) {
      this.logger.info('web.plan', {
        shouldUseWeb: false,
        reason: '未配置 Tavily API key，跳过联网规划。',
        autoSearch: this.config.web.autoSearch,
        webConfigured: false
      });
      return undefined;
    }

    const plan = await planWebUseWithModel(input, {
      autoSearchEnabled: this.config.web.autoSearch,
      plannerEnabled: this.config.web.plannerEnabled,
      previousUserInput,
      history: this.conversationHistory.recentMessagesForPlanning(8000),
      model: this.models.get(this.config.web.plannerModelKind),
      timeoutMs: Math.min(this.config.web.timeoutMs, 12000)
    });
    this.logger.info('web.plan', {
      shouldUseWeb: plan.shouldUseWeb,
      reason: plan.reason,
      source: plan.source,
      action: plan.action,
      usesPreviousTurn: plan.usesPreviousTurn,
      hasQuery: Boolean(plan.query),
      urlCount: plan.urls.length,
      plannerError: plan.error,
      hasPreviousUserInput: Boolean(previousUserInput),
      autoSearch: this.config.web.autoSearch,
      plannerEnabled: this.config.web.plannerEnabled,
      plannerModelKind: this.config.web.plannerModelKind,
      webConfigured: Boolean(this.config.web.apiKey)
    });
    if (!plan.shouldUseWeb) return undefined;

    const context: WebContext = {
      query: plan.query,
      reason: plan.reason,
      plannerSource: plan.source,
      plannerAction: plan.action,
      usesPreviousTurn: plan.usesPreviousTurn,
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

}
