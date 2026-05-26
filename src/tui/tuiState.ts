import type { AgentResponse, AgentStatusEvent, AppConfig, ToolProgressEvent } from '../types.js';
import type { OpenVikingHealth } from '../memory/openVikingMemory.js';

export type TuiRuntimeState = {
  model: string;
  workspace: string;
  openViking: 'mcp' | 'http-search' | 'offline' | 'local';
  openVikingMessage: string;
  legacyFallbackAvailable: boolean;
};

export type TuiTurnState = {
  modelKind: string;
  routerReason?: string;
  memoryHits: number;
  matchedSkills: number;
  durationMs: number;
  toolStarts: number;
  webToolCalls: number;
  mcpToolCalls: number;
  fileToolCalls: number;
  executionToolCalls: number;
  skillToolCalls: number;
  hasVisionContext: boolean;
  hasWebContext: boolean;
  latestStatus?: string;
};

export function buildTuiRuntimeState(input: {
  config: AppConfig;
  openVikingHealth?: OpenVikingHealth;
  legacyFallbackAvailable?: boolean;
}): TuiRuntimeState {
  const memoryBackend = input.config.memory.backend;
  const openViking = memoryBackend === 'local'
    ? 'local'
    : input.openVikingHealth?.ok
      ? input.openVikingHealth.mode
      : 'offline';
  return {
    model: input.config.models.main.model,
    workspace: input.config.workspace.dir,
    openViking,
    openVikingMessage: memoryBackend === 'local'
      ? '当前使用本地记忆'
      : input.openVikingHealth?.message ?? 'OpenViking 状态未知',
    legacyFallbackAvailable: input.legacyFallbackAvailable ?? true
  };
}

export function buildTuiTurnState(input: {
  response: AgentResponse;
  durationMs: number;
  statusEvents?: AgentStatusEvent[];
}): TuiTurnState {
  return {
    modelKind: input.response.modelKind,
    routerReason: input.response.routerReason,
    memoryHits: input.response.memories.length,
    matchedSkills: input.response.skills.length,
    durationMs: input.durationMs,
    toolStarts: countToolStarts(input.response.toolEvents ?? []),
    webToolCalls: input.response.webToolCalls?.length ?? 0,
    mcpToolCalls: input.response.mcpToolCalls?.length ?? 0,
    fileToolCalls: input.response.fileToolCalls?.length ?? 0,
    executionToolCalls: input.response.executionToolCalls?.length ?? 0,
    skillToolCalls: input.response.skillToolCalls?.length ?? 0,
    hasVisionContext: Boolean(input.response.visionContext),
    hasWebContext: Boolean(input.response.webContext),
    latestStatus: input.statusEvents?.at(-1)?.message
  };
}

export function formatTuiRuntimeSummary(state: TuiRuntimeState): string {
  const memory = state.openViking === 'local' ? 'local' : `openviking:${state.openViking}`;
  return `model=${state.model} workspace=${state.workspace} memory=${memory}`;
}

export function formatTuiRuntimeStatusLine(state: TuiRuntimeState, columns = 80): string {
  const safeColumns = Math.max(20, Math.floor(columns));
  return truncateDisplayWidth(formatTuiRuntimeSummary(state), safeColumns);
}

export function formatTuiTurnSummary(state: TuiTurnState): string {
  const details = [
    state.webToolCalls > 0 ? `web=${state.webToolCalls}` : '',
    state.fileToolCalls > 0 ? `file=${state.fileToolCalls}` : '',
    state.executionToolCalls > 0 ? `exec=${state.executionToolCalls}` : '',
    state.mcpToolCalls > 0 ? `mcp=${state.mcpToolCalls}` : '',
    state.skillToolCalls > 0 ? `skill=${state.skillToolCalls}` : '',
    state.hasVisionContext ? 'vision' : '',
    state.hasWebContext ? 'webContext' : ''
  ].filter(Boolean);
  return [
    `model=${state.modelKind}`,
    `memory=${state.memoryHits}`,
    `skills=${state.matchedSkills}`,
    `tools=${state.toolStarts}`,
    `durationMs=${state.durationMs}`,
    details.length > 0 ? details.join(',') : '',
    state.routerReason ? `route=${state.routerReason}` : '',
    state.latestStatus ? `status=${state.latestStatus}` : ''
  ].filter(Boolean).join(' ');
}

function countToolStarts(events: ToolProgressEvent[]): number {
  return events.filter(event => event.phase === 'start').length;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    width += codePoint >= 0x1100 ? 2 : 1;
  }
  return width;
}

function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';
  let width = 0;
  let output = '';
  const suffix = '…';
  const target = Math.max(0, maxWidth - displayWidth(suffix));
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (width + charWidth > target) break;
    output += char;
    width += charWidth;
  }
  return `${output.trimEnd()}${suffix}`;
}
