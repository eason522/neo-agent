import type { Skill, SkillScope, SkillUsage } from '../types.js';

export type SkillUsageStore = Record<string, SkillUsage>;
export type SkillUsageStatus = 'success' | 'failure';

const halfLifeDays = 7;

export function skillUsageKey(input: Pick<Skill, 'name' | 'scope'> | { name: string; scope: SkillScope }): string {
  return `${input.scope}:${input.name}`;
}

export function applySkillUsage(skills: Skill[], usage: SkillUsageStore): Skill[] {
  return skills.map(skill => ({
    ...skill,
    usage: usage[skillUsageKey(skill)]
  }));
}

export function updateSkillUsage(
  usage: SkillUsageStore,
  skill: Pick<Skill, 'name' | 'scope'>,
  status: SkillUsageStatus,
  now = new Date()
): SkillUsageStore {
  const key = skillUsageKey(skill);
  const existing = usage[key] ?? { usageCount: 0, successCount: 0, failureCount: 0 };
  return {
    ...usage,
    [key]: {
      usageCount: existing.usageCount + 1,
      successCount: existing.successCount + (status === 'success' ? 1 : 0),
      failureCount: existing.failureCount + (status === 'failure' ? 1 : 0),
      lastUsedAt: now.toISOString(),
      lastStatus: status
    }
  };
}

export function skillUsageScore(skill: Skill, now = new Date()): number {
  const usage = skill.usage;
  if (!usage?.usageCount || !usage.lastUsedAt) return 0;
  const lastUsedAt = Date.parse(usage.lastUsedAt);
  if (!Number.isFinite(lastUsedAt)) return usage.usageCount;
  const daysSinceUse = Math.max(0, (now.getTime() - lastUsedAt) / (1000 * 60 * 60 * 24));
  const recencyFactor = Math.max(Math.pow(0.5, daysSinceUse / halfLifeDays), 0.1);
  const reliabilityFactor = usage.usageCount > 0 ? Math.max(0.2, usage.successCount / usage.usageCount) : 1;
  return usage.usageCount * recencyFactor * reliabilityFactor;
}
