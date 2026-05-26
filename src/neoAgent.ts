import type { AgentResponse, AgentStatusEvent, AppConfig, Attachment, ChatMessage, Skill, ToolCallRecord, ToolProgressEvent, WebContext } from './types.js';
import { ModelRegistry } from './models/modelRegistry.js';
import { ModelRouter } from './router.js';
import { VisionAnalyzer } from './vision/visionAnalyzer.js';
import { MemoryService } from './memory/memoryService.js';
import { SkillManager } from './skills/skillManager.js';
import { McpManager } from './mcp/mcpManager.js';
import { getMcpResourcePrompt, McpResourceRunner } from './mcp/mcpResourceRunner.js';
import { getMcpToolPrompt, McpToolRunner, type McpPermissionAsker } from './mcp/mcpToolRunner.js';
import { SubAgentRunner } from './agents/subAgent.js';
import { buildSystemPrompt } from './prompts/systemPrompt.js';
import { loadSoul } from './prompts/soul.js';
import { Logger } from './logging/logger.js';
import { TranscriptService, type TranscriptConversationSnapshot } from './transcript/transcriptService.js';
import { DreamService } from './dream/dreamService.js';
import { FileToolRunner, getFileToolPrompt, type FilePermissionAsker } from './files/fileTools.js';
import { ExecutionToolRunner, getExecutionToolPrompt, type ExecutionPermissionAsker } from './tools/executionTools.js';
import { formatWebContext, TavilyClient } from './web/tavilyClient.js';
import { planWebUseWithModel } from './web/webPlanner.js';
import { getWebToolPrompt, WebToolRunner } from './web/webTools.js';
import { ConversationHistory, type ConversationCompactResult, type ConversationHistoryStats } from './conversation/history.js';
import { QueryEngine } from './agent/queryEngine.js';
import { getToolSearchPrompt, ToolSearchRunner } from './tools/toolSearchRunner.js';
import { getSkillToolPrompt, SkillToolRunner } from './skills/skillToolRunner.js';
import { createAbortError } from './utils/abort.js';
import { updateMcpToolPermission } from './mcp/mcpConfigCommands.js';
import { stableId } from './utils/fs.js';
import { UsageTracker } from './usage/usageTracker.js';
import { getHooksPrompt, HookBus } from './hooks/hookBus.js';
import { buildCapabilitySnapshot, CapabilityToolRunner, formatCapabilitySnapshot, getCapabilitiesPrompt, type CapabilitySnapshot } from './capabilities/capabilities.js';
import { assessTaskAgainstCapabilities, formatTaskAssessment, getTaskAssessmentPrompt, TaskAssessmentToolRunner, type TaskAssessmentResult } from './capabilities/taskAssessment.js';
import type { ToolRunner } from './tools/tool.js';

export type AskOptions = {
  signal?: AbortSignal;
  onContentDelta?: (delta: string) => void;
  onStatus?: (event: AgentStatusEvent) => void;
};

export type NeoAgentOptions = {
  resumeSessionId?: string;
};

export type ResumeSessionResult = {
  status: 'resumed' | 'not_found';
  requested?: string;
  snapshot?: TranscriptConversationSnapshot;
};

export type CompactConversationOptions = {
  signal?: AbortSignal;
  onStatus?: (event: AgentStatusEvent) => void;
};

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
  readonly usage: UsageTracker;
  readonly hooks: HookBus;

  private readonly router: ModelRouter;
  private readonly vision: VisionAnalyzer;
  private readonly conversationHistory: ConversationHistory;
  private readonly webToolRunner: WebToolRunner;
  private readonly fileToolRunner: FileToolRunner;
  private readonly executionToolRunner: ExecutionToolRunner;
  private readonly skillToolRunner: SkillToolRunner;
  private readonly toolSearchRunner: ToolSearchRunner;
  private readonly mcpToolRunner: McpToolRunner;
  private readonly mcpResourceRunner: McpResourceRunner;
  private readonly capabilityToolRunner: CapabilityToolRunner;
  private readonly taskAssessmentToolRunner: TaskAssessmentToolRunner;
  private readonly toolRunners: ToolRunner<ToolCallRecord>[];
  private readonly queryEngine: QueryEngine;
  private toolEventHandler?: (event: ToolProgressEvent) => void;
  private contentDeltaHandler?: (delta: string) => void;

  constructor(readonly config: AppConfig, private readonly options: NeoAgentOptions = {}) {
    this.logger = new Logger(config);
    this.transcripts = new TranscriptService(config, this.logger);
    this.usage = new UsageTracker(config, this.logger);
    this.hooks = new HookBus(this.logger);
    this.models = new ModelRegistry(config, this.logger, this.usage);
    this.memory = new MemoryService(config, this.logger);
    this.skills = new SkillManager(config);
    this.mcp = new McpManager(config, this.logger);
    this.mcpToolRunner = new McpToolRunner(this.mcp, config.mcp.permissions, config.mcp.toolSearchThreshold, undefined, async (toolName, behavior) => {
      await updateMcpToolPermission({ tool: toolName, behavior });
    });
    this.toolSearchRunner = new ToolSearchRunner(this.mcpToolRunner);
    this.mcpResourceRunner = new McpResourceRunner(this.mcp);
    this.subAgent = new SubAgentRunner(this.models, this.logger, config);
    this.dreams = new DreamService(config, this.models, this.memory, this.logger);
    this.web = new TavilyClient(config, this.logger);
    this.fileToolRunner = new FileToolRunner(process.cwd(), undefined, this.hooks, {
      workspaceDir: config.workspace.dir,
      additionalReadDirs: config.files.additionalReadDirs,
      additionalWriteDirs: config.files.additionalWriteDirs
    });
    this.executionToolRunner = new ExecutionToolRunner(config, process.cwd(), undefined, this.hooks);
    this.skillToolRunner = new SkillToolRunner(this.skills, process.cwd());
    this.webToolRunner = new WebToolRunner(config, this.web);
    this.capabilityToolRunner = new CapabilityToolRunner(() => this.capabilitySnapshot());
    this.taskAssessmentToolRunner = new TaskAssessmentToolRunner(() => this.capabilitySnapshot());
    this.toolRunners = [this.capabilityToolRunner, this.taskAssessmentToolRunner, this.skillToolRunner, this.fileToolRunner, this.executionToolRunner, this.webToolRunner, this.toolSearchRunner, this.mcpToolRunner, this.mcpResourceRunner];
    this.queryEngine = new QueryEngine(this.models, this.toolRunners, this.logger, {
      maxToolRounds: config.web.maxToolRounds,
      toolResultBudget: config.toolResults,
      onToolEvent: event => this.toolEventHandler?.(event),
      onContentDelta: delta => this.contentDeltaHandler?.(delta),
      hooks: this.hooks
    });
    this.router = new ModelRouter(config);
    this.vision = new VisionAnalyzer(this.models, this.logger);
    this.conversationHistory = new ConversationHistory(config.conversation.maxHistoryChars, config.conversation.maxMessageChars, {
      enabled: config.conversation.compactEnabled,
      thresholdRatio: config.conversation.compactThresholdRatio,
      keepRecentChars: config.conversation.compactKeepRecentChars,
      maxSummaryChars: config.conversation.compactMaxSummaryChars
    });
  }

  async initialize(options: { scheduledDreams?: boolean; resumeSessionId?: string } = {}): Promise<void> {
    this.logger.info('agent.initialize.start', {
      homeDir: this.config.homeDir,
      logFile: this.logger.filePath,
      memoryBackend: this.config.memory.backend
    });
    const resumeSessionId = options.resumeSessionId ?? this.options.resumeSessionId;
    let resumeMetadata: Record<string, unknown> = {};
    if (resumeSessionId) {
      const resume = await this.resumeSession(resumeSessionId, { appendTranscript: false });
      if (resume.status === 'resumed' && resume.snapshot) {
        resumeMetadata = buildResumeMetadata(resume.snapshot);
      } else {
        resumeMetadata = { resumeRequested: resumeSessionId, resumeStatus: 'not_found' };
        this.logger.warn('session.resume.not_found', { resumeSessionId });
      }
    }
    await this.transcripts.start(resumeMetadata);
    await this.mcp.connectAll();
    this.logger.info('agent.initialize.success');
    if (options.scheduledDreams ?? true) {
      void this.dreams.maybeRunScheduled().catch(error => {
        this.logger.error('dream.scheduled.error', error);
      });
    }
  }

  async resumeSession(selector = 'latest', options: { appendTranscript?: boolean } = {}): Promise<ResumeSessionResult> {
    const snapshot = await this.transcripts.loadConversationSnapshot(selector);
    if (!snapshot) {
      this.logger.warn('session.resume.not_found', { resumeSessionId: selector });
      if (options.appendTranscript ?? true) {
        await this.transcripts.append('command', 'resume failed', {
          command: '/resume',
          requested: selector,
          status: 'not_found'
        });
      }
      return {
        status: 'not_found',
        requested: selector
      };
    }
    this.conversationHistory.hydrate(snapshot.messages, snapshot.compactSummary);
    const metadata = buildResumeMetadata(snapshot);
    this.logger.info('session.resume.success', metadata);
    if (options.appendTranscript ?? true) {
      await this.transcripts.append('command', 'resume session', {
        command: '/resume',
        requested: selector,
        ...metadata
      });
    }
    return {
      status: 'resumed',
      requested: selector,
      snapshot
    };
  }

  conversationStats(): ConversationHistoryStats {
    return this.conversationHistory.stats();
  }

  async compactConversation(
    instructions?: string,
    options: CompactConversationOptions = {}
  ): Promise<ConversationCompactResult> {
    if (options.signal?.aborted) throw createAbortError();
    emitAgentStatus(options.onStatus, {
      stage: 'compact',
      message: instructions ? '开始手动压缩会话上下文（含自定义要求）' : '开始手动压缩会话上下文'
    });
    const compactResult = await this.conversationHistory.compact(this.models.get('small'), {
      force: true,
      instructions
    });
    if (options.signal?.aborted) throw createAbortError();

    if (!compactResult.compacted) {
      emitAgentStatus(options.onStatus, {
        stage: 'compact',
        message: `未执行手动 compact：${compactResult.reason ?? 'unknown'}`,
        metadata: compactResult
      });
      this.logger.debug('conversation.compact.manual.skip', compactResult);
      return compactResult;
    }

    await this.transcripts.append('compact', '手动压缩会话上下文', {
      source: compactResult.source,
      beforeChars: compactResult.beforeChars,
      afterChars: compactResult.afterChars,
      summarizedMessages: compactResult.summarizedMessages,
      keptMessages: compactResult.keptMessages,
      summaryChars: compactResult.summaryChars,
      summary: compactResult.summary,
      compactId: stableId('compact'),
      manual: true,
      instructionsChars: instructions?.length ?? 0
    });
    emitAgentStatus(options.onStatus, {
      stage: 'compact',
      message: `手动 compact 完成：${compactResult.beforeChars} -> ${compactResult.afterChars} 字符`,
      metadata: compactResult
    });
    this.logger.info('conversation.compact.manual.success', compactResult);
    return compactResult;
  }

  setMcpPermissionAsker(permissionAsker: McpPermissionAsker | undefined): void {
    this.mcpToolRunner.setPermissionAsker(permissionAsker);
  }

  setFilePermissionAsker(permissionAsker: FilePermissionAsker | undefined): void {
    this.fileToolRunner.setPermissionAsker(permissionAsker);
  }

  setExecutionPermissionAsker(permissionAsker: ExecutionPermissionAsker | undefined): void {
    this.executionToolRunner.setPermissionAsker(permissionAsker);
  }

  setToolEventHandler(handler: ((event: ToolProgressEvent) => void) | undefined): void {
    this.toolEventHandler = handler;
  }

  setContentDeltaHandler(handler: ((delta: string) => void) | undefined): void {
    this.contentDeltaHandler = handler;
  }

  async capabilitySnapshot(): Promise<CapabilitySnapshot> {
    await Promise.all(this.toolRunners.map(tool => tool.refresh?.() ?? Promise.resolve()));
    const [skills, mcpTools] = await Promise.all([
      this.skills.loadSkills(),
      this.mcp.listTools().catch(() => [])
    ]);
    return buildCapabilitySnapshot({
      config: this.config,
      cwd: process.cwd(),
      skills,
      mcpTools,
      connectedMcpServers: this.mcp.connectedServerNames(),
      runtimeTools: this.queryEngine.toolDefinitions(),
      fileWriteConfirmationAvailable: this.fileToolRunner.hasPermissionAsker(),
      executionConfirmationAvailable: this.executionToolRunner.hasPermissionAsker(),
      hookRecentEventCount: this.hooks.listRecent().length
    });
  }

  async formatCapabilities(): Promise<string> {
    return formatCapabilitySnapshot(await this.capabilitySnapshot());
  }

  async assessTask(task: string): Promise<TaskAssessmentResult> {
    return assessTaskAgainstCapabilities(task, await this.capabilitySnapshot());
  }

  async formatTaskAssessment(task: string): Promise<string> {
    return formatTaskAssessment(await this.assessTask(task));
  }

  async ask(input: string, attachments: Attachment[] = [], options: AskOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    const previousContentDeltaHandler = this.contentDeltaHandler;
    if (options.onContentDelta) this.contentDeltaHandler = options.onContentDelta;
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
    emitAgentStatus(options.onStatus, {
      stage: 'context',
      message: '加载记忆、skills、MCP、视觉和 Web 上下文',
      metadata: {
        attachmentCount: attachments.length,
        webToolLoop: useWebToolLoop
      }
    });
    const [memories, allSkills, mcpTools, visionContext, soul, webContext] = await Promise.all([
      this.memory.search(input),
      this.skills.loadSkills(),
      this.mcp.listTools().catch(() => []),
      this.vision.analyze(attachments, input, options.signal),
      loadSoul(),
      useWebToolLoop ? Promise.resolve(undefined) : this.buildWebContext(input, options.signal)
    ]);
    const matchedSkills = this.skills.matchLoaded(input, allSkills);
    emitAgentStatus(options.onStatus, {
      stage: 'context',
      message: `上下文已就绪：记忆 ${memories.length}，skills ${matchedSkills.length}，MCP tools ${mcpTools.length}`,
      metadata: {
        memoryHits: memories.length,
        matchedSkills: matchedSkills.length,
        mcpTools: mcpTools.length,
        hasVisionContext: Boolean(visionContext),
        hasWebContext: Boolean(webContext)
      }
    });
    const skillChanges = this.skills.lastChangeSummary();
    if (skillChanges.changed) {
      this.logger.info('skill.reload', {
        added: skillChanges.added.length,
        updated: skillChanges.updated.length,
        removed: skillChanges.removed.length,
        fileCount: skillChanges.fileCount
      });
    }

    const decision = this.router.decide(input, attachments);
    emitAgentStatus(options.onStatus, {
      stage: 'routing',
      message: `路由到 ${decision.modelKind}：${decision.reason}`,
      metadata: {
        modelKind: decision.modelKind,
        reason: decision.reason
      }
    });
    const hasMcpServers = this.mcp.connectedServerNames().length > 0;
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
    const useToolLoop = true;
    const systemPrompt = this.withToolPrompt(buildSystemPrompt({
      memories,
      skills: matchedSkills,
      mcpTools,
      soul,
      modelName: this.config.models[decision.modelKind].model
    }), {
      skills: allSkills,
      file: true,
      web: useWebToolLoop,
      mcp: hasMcpServers
    });
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
      emitAgentStatus(options.onStatus, {
        stage: 'model',
        message: useToolLoop ? `开始模型/tool loop：${decision.modelKind}` : `开始模型请求：${decision.modelKind}`,
        metadata: {
          modelKind: decision.modelKind,
          toolLoop: useToolLoop,
          historyMessages: messages.length,
          historyChars: historyStats.charCount
        }
      });
      const { text, webToolCalls, mcpToolCalls, fileToolCalls, executionToolCalls, skillToolCalls, toolEvents, toolPairs } = useToolLoop
        ? await this.queryEngine.run(decision.modelKind, messages, { signal: options.signal })
        : { text: await this.models.get(decision.modelKind).chat({ messages, signal: options.signal, stream: options.onContentDelta ? { onContentDelta: options.onContentDelta } : undefined }), webToolCalls: [], mcpToolCalls: [], fileToolCalls: [], executionToolCalls: [], skillToolCalls: [], toolEvents: [], toolPairs: [] };
      const safeWebToolCalls = webToolCalls ?? [];
      const safeMcpToolCalls = mcpToolCalls ?? [];
      const safeFileToolCalls = fileToolCalls ?? [];
      const safeExecutionToolCalls = executionToolCalls ?? [];
      const safeSkillToolCalls = skillToolCalls ?? [];
      const safeToolEvents = toolEvents ?? [];
      const safeToolPairs = toolPairs ?? [];
      await this.transcripts.append('assistant', text, {
        modelKind: decision.modelKind,
        model: this.config.models[decision.modelKind].model,
        routerReason: decision.reason,
        memoryHits: memories.length,
        matchedSkills: matchedSkills.map(skill => skill.name),
        hasVisionContext: Boolean(visionContext),
        web: webContext ? {
          reason: webContext.reason,
          queryChars: webContext.query?.length,
          plannerSource: webContext.plannerSource,
          plannerAction: webContext.plannerAction,
          usesPreviousTurn: webContext.usesPreviousTurn,
          searchResults: webContext.search?.results.length ?? 0,
          extractResults: webContext.extracts?.results.length ?? 0,
          searchedAt: webContext.searchedAt
        } : undefined,
        webToolCalls: safeWebToolCalls.map(call => ({
          name: call.name,
          queryChars: call.query?.length,
          urlDomain: call.url ? safeUrlDomain(call.url) : undefined,
          resultCount: call.resultCount,
          failedCount: call.failedCount,
          searchedAt: call.searchedAt
        })),
        mcpToolCalls: safeMcpToolCalls.map(call => ({
          name: call.name,
          serverName: call.serverName,
          toolName: call.toolName,
          resultChars: call.resultChars,
          durationMs: call.durationMs
        })),
        fileToolCalls: safeFileToolCalls.map(call => ({
          name: call.name,
          path: call.path,
          operation: call.operation,
          pattern: call.pattern,
          resultCount: call.resultCount,
          resultChars: call.resultChars,
          durationMs: call.durationMs
        })),
        executionToolCalls: safeExecutionToolCalls.map(call => ({
          name: call.name,
          commandChars: call.command?.length,
          cwd: call.cwd,
          exitCode: call.exitCode,
          stdoutChars: call.stdoutChars,
          stderrChars: call.stderrChars,
          durationMs: call.durationMs,
          timedOut: call.timedOut
        })),
        skillToolCalls: safeSkillToolCalls.map(call => ({
          name: call.name,
          skillName: call.skillName,
          scope: call.scope,
          bodyChars: call.bodyChars,
          installedCount: call.installedCount,
          resultChars: call.resultChars,
          durationMs: call.durationMs
        })),
        toolEvents: safeToolEvents.map(event => ({
          phase: event.phase,
          name: event.name,
          round: event.round,
          summary: event.summary,
          metadata: event.metadata
        })),
        toolPairs: safeToolPairs
      });
      await this.memory.remember(`User: ${input}\nAssistant: ${text.slice(0, 1200)}`, {
        category: 'session_summary',
        tags: ['session'],
        origin: 'session'
      });
      const skillSuggestion = safeSkillToolCalls.some(call => call.name === 'InstallSkillPackage')
        ? undefined
        : await this.skills.maybeSuggestSkill(input, text).catch(error => {
          this.logger.error('skill.suggest.error', error);
          return undefined;
        });
      if (skillSuggestion) {
        this.logger.info('skill.suggest', {
          name: skillSuggestion.name,
          signature: skillSuggestion.signature,
          observedCount: skillSuggestion.observedCount
        });
        await this.transcripts.append('skill_suggestion', skillSuggestion.reason, {
          name: skillSuggestion.name,
          signature: skillSuggestion.signature,
          observedCount: skillSuggestion.observedCount,
          triggerCount: skillSuggestion.triggers.length,
          workflowSteps: skillSuggestion.workflow.length
        });
      }
      const skillImprovementSuggestion = await this.skills.maybeSuggestSkillImprovement(input, text, safeSkillToolCalls).catch(error => {
        this.logger.error('skill.improvement.suggest.error', error);
        return undefined;
      });
      if (skillImprovementSuggestion) {
        this.logger.info('skill.improvement.suggest', {
          skillName: skillImprovementSuggestion.skillName,
          scope: skillImprovementSuggestion.scope,
          updateCount: skillImprovementSuggestion.updates.length
        });
        await this.transcripts.append('skill_suggestion', skillImprovementSuggestion.reason, {
          kind: 'improvement',
          skillName: skillImprovementSuggestion.skillName,
          scope: skillImprovementSuggestion.scope,
          updateCount: skillImprovementSuggestion.updates.length
        });
      }
      const compactResult = await this.conversationHistory.append(input, text, this.models.get('small'));
      if (compactResult.compacted) {
        emitAgentStatus(options.onStatus, {
          stage: 'compact',
          message: `会话上下文已自动压缩：${compactResult.beforeChars} -> ${compactResult.afterChars} 字符`,
          metadata: compactResult
        });
        await this.transcripts.append('compact', '自动压缩会话上下文', {
          source: compactResult.source,
          beforeChars: compactResult.beforeChars,
          afterChars: compactResult.afterChars,
          summarizedMessages: compactResult.summarizedMessages,
          keptMessages: compactResult.keptMessages,
          summaryChars: compactResult.summaryChars,
          summary: compactResult.summary,
          compactId: stableId('compact')
        });
        this.logger.info('conversation.compact.success', compactResult);
      } else {
        this.logger.debug('conversation.compact.skip', compactResult);
      }

      emitAgentStatus(options.onStatus, {
        stage: 'done',
        message: `完成：${decision.modelKind}，工具事件 ${toolEvents.length}`,
        metadata: {
          modelKind: decision.modelKind,
          outputChars: text.length,
          toolEvents: toolEvents.length,
          durationMs: Date.now() - start
        }
      });
      this.logger.info('agent.ask.success', {
        modelKind: decision.modelKind,
        outputChars: text.length,
        historyMessageCount: historyStats.messageCount,
        historyChars: historyStats.charCount,
        hasWebContext: Boolean(webContext),
        webToolCallCount: webToolCalls.length,
        mcpToolCallCount: mcpToolCalls.length,
        fileToolCallCount: fileToolCalls.length,
        skillToolCallCount: skillToolCalls.length,
        toolEventCount: toolEvents.length,
        toolPairCount: toolPairs.length,
        hasSkillSuggestion: Boolean(skillSuggestion),
        hasSkillImprovementSuggestion: Boolean(skillImprovementSuggestion),
        durationMs: Date.now() - start
      });
      return {
        text,
        modelKind: decision.modelKind,
        routerReason: decision.reason,
        visionContext,
        memories,
        skills: matchedSkills,
        webContext,
        webToolCalls: safeWebToolCalls,
        mcpToolCalls: safeMcpToolCalls,
        fileToolCalls: safeFileToolCalls,
        executionToolCalls: safeExecutionToolCalls,
        skillToolCalls: safeSkillToolCalls,
        toolEvents: safeToolEvents,
        toolPairs: safeToolPairs,
        skillSuggestion,
        skillImprovementSuggestion
      };
    } catch (error) {
      if (options.signal?.aborted) {
        const abortError = createAbortError();
        this.logger.info('agent.ask.cancelled', { durationMs: Date.now() - start });
        await this.transcripts.append('cancel', abortError.message, {
          stage: 'agent.ask',
          durationMs: Date.now() - start
        });
        throw abortError;
      }
      this.logger.error('agent.ask.error', error, { durationMs: Date.now() - start });
      await this.transcripts.append('error', error instanceof Error ? error.message : String(error), {
        stage: 'agent.ask',
        durationMs: Date.now() - start
      });
      throw error;
    } finally {
      this.contentDeltaHandler = previousContentDeltaHandler;
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
    this.logger.info('agent.close');
    await this.transcripts.end();
    await this.usage.flush();
    await this.logger.flush();
  }

  private shouldUseWebToolLoop(): boolean {
    return this.config.web.autoSearch && this.config.web.toolLoopEnabled && Boolean(this.config.web.apiKey);
  }

  private withToolPrompt(systemPrompt: string, enabled: { skills: Skill[]; file: boolean; web: boolean; mcp: boolean }): string {
    return [
      systemPrompt,
      getCapabilitiesPrompt(),
      getTaskAssessmentPrompt(),
      getSkillToolPrompt(enabled.skills),
      enabled.file ? getFileToolPrompt() : '',
      enabled.file ? getExecutionToolPrompt() : '',
      enabled.web ? getWebToolPrompt() : '',
      enabled.mcp ? getToolSearchPrompt() : '',
      enabled.mcp ? getMcpToolPrompt() : '',
      enabled.mcp ? getMcpResourcePrompt() : '',
      getHooksPrompt()
    ].filter(Boolean).join('\n\n');
  }

  private async buildWebContext(input: string, signal?: AbortSignal): Promise<WebContext | undefined> {
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
    if (signal?.aborted) throw createAbortError();
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
          includeAnswer: true,
          signal
        });
      }
      if (plan.urls.length > 0) {
        context.extracts = await this.web.extract(plan.urls, { signal });
      } else if (context.search?.results.length) {
        const urls = context.search.results.slice(0, 2).map(result => result.url);
        context.extracts = await this.web.extract(urls, { signal }).catch(error => {
          if (signal?.aborted) throw createAbortError();
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

function emitAgentStatus(handler: ((event: AgentStatusEvent) => void) | undefined, event: AgentStatusEvent): void {
  handler?.(event);
}

function safeUrlDomain(input: string): string | undefined {
  try {
    return new URL(input).hostname;
  } catch {
    return undefined;
  }
}

function buildResumeMetadata(snapshot: TranscriptConversationSnapshot): Record<string, unknown> {
  return {
    resumedFrom: snapshot.sessionId,
    resumedTitle: snapshot.title,
    resumedPath: snapshot.path,
    resumedMessages: snapshot.messages.length,
    resumedCompactSummaryChars: snapshot.compactSummary?.length ?? 0,
    resumeWarnings: snapshot.warnings
  };
}
