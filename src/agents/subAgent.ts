import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import type { ModelRegistry } from '../models/modelRegistry.js';
import type { Logger } from '../logging/logger.js';
import type { AppConfig } from '../types.js';
import { createAbortError } from '../utils/abort.js';
import { stableId } from '../utils/fs.js';

export type SubAgentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type SubAgentTaskRecord = {
  id: string;
  task: string;
  context?: string;
  status: SubAgentTaskStatus;
  mode: 'foreground' | 'background';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  model: string;
  transcriptPath: string;
  toolIsolation: 'none';
};

export class SubAgentRunner {
  private readonly tasksDir: string;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly models: ModelRegistry,
    private readonly logger?: Logger,
    config?: AppConfig
  ) {
    this.tasksDir = path.join(config?.homeDir ?? path.join(process.env.HOME ?? process.cwd(), '.neo-agent'), 'tasks', 'subagents');
  }

  async run(task: string, context = ''): Promise<string> {
    const record = await this.startTask(task, { context, background: false });
    const completed = await this.waitForTask(record.id);
    if (completed.status === 'completed' && completed.output !== undefined) return completed.output;
    throw new Error(completed.error ?? `sub-agent task ${completed.id} ended with ${completed.status}`);
  }

  async startTask(task: string, options: { context?: string; background?: boolean } = {}): Promise<SubAgentTaskRecord> {
    const now = new Date().toISOString();
    const id = stableId('agent');
    const record: SubAgentTaskRecord = {
      id,
      task,
      context: options.context,
      status: 'running',
      mode: options.background ? 'background' : 'foreground',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      model: this.models.config.models.small.model,
      transcriptPath: this.taskPath(id),
      toolIsolation: 'none'
    };
    await this.saveTask(record);
    const controller = new AbortController();
    this.active.set(id, controller);
    const execution = this.executeTask(record, controller.signal);
    if (options.background) {
      void execution.catch(() => undefined);
      return record;
    }
    await execution;
    return this.getTask(id) as Promise<SubAgentTaskRecord>;
  }

  async listTasks(limit = 20): Promise<SubAgentTaskRecord[]> {
    await mkdir(this.tasksDir, { recursive: true });
    const files = await readdir(this.tasksDir).catch(() => []);
    const tasks = (await Promise.all(files
      .filter(file => file.endsWith('.json'))
      .map(file => this.readTaskFile(path.join(this.tasksDir, file)))))
      .filter((task): task is SubAgentTaskRecord => Boolean(task));
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async getTask(id: string): Promise<SubAgentTaskRecord | undefined> {
    return this.readTaskFile(this.taskPath(id));
  }

  async stopTask(id: string): Promise<SubAgentTaskRecord | undefined> {
    const controller = this.active.get(id);
    if (controller && !controller.signal.aborted) controller.abort(createAbortError());
    const record = await this.getTask(id);
    if (!record) return undefined;
    if (record.status === 'running') {
      const cancelled = {
        ...record,
        status: 'cancelled' as const,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: '用户停止 sub-agent 任务。'
      };
      await this.saveTask(cancelled);
      return cancelled;
    }
    return record;
  }

  private async waitForTask(id: string): Promise<SubAgentTaskRecord> {
    while (true) {
      const record = await this.getTask(id);
      if (!record) throw new Error(`sub-agent task not found: ${id}`);
      if (record.status !== 'running') return record;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async executeTask(record: SubAgentTaskRecord, signal: AbortSignal): Promise<void> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are a focused sub-agent spawned by neo-agent.',
          'Solve only the delegated task. Be concise, cite assumptions, and return reusable findings.',
          record.context ? `Context:\n${record.context}` : '',
          'Tool isolation: no project, web, MCP, file write, or skill tools are available inside this sub-agent task.'
        ].filter(Boolean).join('\n\n')
      },
      {
        role: 'user',
        content: record.task
      }
    ];

    const start = Date.now();
    this.logger?.info('subagent.run.start', { taskId: record.id, taskChars: record.task.length, contextChars: record.context?.length ?? 0 });
    try {
      const output = await this.models.small.chat({ messages, signal });
      await this.saveTask({
        ...record,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output
      });
      this.logger?.info('subagent.run.success', { taskId: record.id, durationMs: Date.now() - start, outputChars: output.length });
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : 'failed';
      await this.saveTask({
        ...record,
        status,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      this.logger?.error('subagent.run.error', error, { taskId: record.id, durationMs: Date.now() - start });
    } finally {
      this.active.delete(record.id);
    }
  }

  private taskPath(id: string): string {
    return path.join(this.tasksDir, `${safeTaskId(id)}.json`);
  }

  private async saveTask(record: SubAgentTaskRecord): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    await writeFile(this.taskPath(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private async readTaskFile(filePath: string): Promise<SubAgentTaskRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as SubAgentTaskRecord;
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.status !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

function safeTaskId(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '_');
}
