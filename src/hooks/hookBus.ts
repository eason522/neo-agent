import type { HookEventName, HookEventRecord } from '../types.js';
import type { Logger } from '../logging/logger.js';
import { stableId } from '../utils/fs.js';

export type HookEventHandler = (event: HookEventRecord) => void | Promise<void>;

export class HookBus {
  private readonly handlers: HookEventHandler[] = [];
  private readonly recentEvents: HookEventRecord[] = [];

  constructor(private readonly logger?: Logger, private readonly maxRecentEvents = 100) {}

  on(handler: HookEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  emit(event: HookEventName, name: string, metadata: Record<string, unknown> = {}): HookEventRecord {
    const record: HookEventRecord = {
      id: stableId('hook'),
      ts: new Date().toISOString(),
      event,
      name,
      metadata
    };
    this.recentEvents.push(record);
    if (this.recentEvents.length > this.maxRecentEvents) this.recentEvents.shift();
    this.logger?.debug('hook.event', {
      id: record.id,
      event: record.event,
      name: record.name,
      metadataKeys: Object.keys(metadata)
    });
    for (const handler of this.handlers) {
      void Promise.resolve(handler(record)).catch(error => {
        this.logger?.warn('hook.handler.error', {
          event: record.event,
          name: record.name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return record;
  }

  listRecent(): HookEventRecord[] {
    return [...this.recentEvents];
  }
}

export function getHooksPrompt(): string {
  return [
    '# Hooks 边界',
    '- neo 目前只预留 PostToolUse、PermissionRequest、Stop、Notification 事件并写入内部事件总线。',
    '- 不会执行外部 shell、HTTP、prompt 或 agent hook；不要声称 hook 已运行。',
    '- 需要外部自动化时，必须等权限模型成熟后再接入显式确认和脱敏日志。'
  ].join('\n');
}
