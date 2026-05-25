import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../types.js';
import { buildSkillInstallPlans, installSkillPlan } from '../skills/skillPackage.js';
import { SkillManager } from '../skills/skillManager.js';

const marketplaceIndexSchema = z.object({
  version: z.number().optional(),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string(),
    plugin: z.boolean().optional(),
    tags: z.array(z.string()).optional()
  })).default([])
});

export type MarketplaceSkillEntry = z.infer<typeof marketplaceIndexSchema>['skills'][number];

export class MarketplaceService {
  readonly indexPath: string;

  constructor(private readonly config: AppConfig) {
    this.indexPath = path.join(config.homeDir, 'marketplace', 'skills.json');
  }

  async init(force = false): Promise<{ path: string; created: boolean }> {
    const exists = await readFile(this.indexPath, 'utf8').then(() => true, () => false);
    if (exists && !force) return { path: this.indexPath, created: false };
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`, 'utf8');
    return { path: this.indexPath, created: true };
  }

  async list(): Promise<MarketplaceSkillEntry[]> {
    const raw = await readFile(this.indexPath, 'utf8').catch(() => '{"version":1,"skills":[]}');
    const parsed = marketplaceIndexSchema.parse(JSON.parse(raw));
    return parsed.skills;
  }

  async show(name: string): Promise<MarketplaceSkillEntry | undefined> {
    const normalized = name.toLowerCase();
    return (await this.list()).find(entry => entry.name.toLowerCase() === normalized);
  }

  async installSkill(name: string, options: { scope?: 'user' | 'project'; overwrite?: boolean } = {}): Promise<{ installed: string[]; skipped: string[]; source: string }> {
    const entry = await this.show(name);
    if (!entry) throw new Error(`marketplace 中没有找到 skill：${name}`);
    const manager = new SkillManager(this.config);
    const scope = options.scope ?? 'user';
    const plans = await buildSkillInstallPlans({ source: resolveMarketplaceSource(entry.source) });
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const plan of plans) {
      const existing = !options.overwrite ? await manager.getSkill(plan.name, scope) : undefined;
      if (existing) {
        skipped.push(existing.name);
        continue;
      }
      const result = await installSkillPlan({
        plan,
        targetRoot: manager.skillRoot(scope),
        overwrite: options.overwrite,
        dryRun: false
      });
      installed.push(result.name);
    }
    return { installed, skipped, source: entry.source };
  }
}

export function formatMarketplaceEntries(entries: MarketplaceSkillEntry[]): string {
  if (entries.length === 0) return 'marketplace 为空。编辑 skills.json 添加条目，source 可指向 .md、skill 目录、plugin 目录或 .zip。';
  return entries.map(entry => {
    const tags = entry.tags?.length ? ` #${entry.tags.join(' #')}` : '';
    return `${entry.name} - ${entry.description ?? '(无描述)'}${tags}\n${entry.source}`;
  }).join('\n\n');
}

function resolveMarketplaceSource(source: string): string {
  if (/^https?:\/\//i.test(source)) return source;
  return path.resolve(source);
}
