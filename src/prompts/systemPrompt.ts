import type { MemoryHit, Skill } from '../types.js';

export function buildSystemPrompt(memories: MemoryHit[], skills: Skill[], mcpTools: string[]): string {
  return [
    'You are neo-agent, a personal terminal AI agent for one user.',
    'Follow a pragmatic coding-agent style: direct, concrete, and action-oriented.',
    'Use the user memories and matched skills when relevant, but do not mention them unless useful.',
    'For coding tasks, prefer inspecting existing files before proposing changes.',
    'If image perception context is supplied, treat it as observations from a vision model and reason over it carefully.',
    '',
    formatSection('Relevant Memories', memories.map(hit => `- (${hit.source}) ${hit.content}`)),
    formatSection('Matched Skills', skills.map(skill => `- ${skill.name}: ${skill.description}`)),
    formatSection('Available MCP Tools', mcpTools.map(tool => `- ${tool}`))
  ].filter(Boolean).join('\n');
}

function formatSection(title: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return [`## ${title}`, ...lines].join('\n');
}
