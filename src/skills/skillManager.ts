import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, Skill, SkillScope } from '../types.js';
import { ensureDir, pathExists, readJsonFile, sanitizeName, writeJsonFile } from '../utils/fs.js';
import { SkillChangeDetector, type SkillChangeSummary } from './skillChangeDetector.js';
import { validateSkillContent } from './skillPackage.js';
import { applySkillUsage, skillUsageScore, updateSkillUsage, type SkillUsageStatus, type SkillUsageStore } from './skillUsage.js';

type PatternStore = Record<string, number>;

export class SkillManager {
  private readonly userSkillsDir: string;
  private readonly projectSkillsDir: string;
  private readonly patternsFile: string;
  private readonly usageFile: string;
  private readonly changeDetector: SkillChangeDetector;
  private cachedSkills: Skill[] | undefined;

  constructor(private readonly config: AppConfig, private readonly projectRoot = process.cwd()) {
    this.userSkillsDir = path.join(config.homeDir, 'skills');
    this.projectSkillsDir = path.join(projectRoot, '.neo-agent', 'skills');
    this.patternsFile = path.join(this.userSkillsDir, '.task-patterns.json');
    this.usageFile = path.join(this.userSkillsDir, '.usage.json');
    this.changeDetector = new SkillChangeDetector([
      { root: this.projectSkillsDir, scope: 'project' },
      { root: this.userSkillsDir, scope: 'user' }
    ]);
  }

  async loadSkills(): Promise<Skill[]> {
    const changes = await this.changeDetector.scan();
    if (this.cachedSkills && !changes.changed) return this.cachedSkills;
    const [projectSkills, userSkills, usage] = await Promise.all([
      this.loadSkillsFromRoot(this.projectSkillsDir, 'project'),
      this.loadSkillsFromRoot(this.userSkillsDir, 'user'),
      this.loadUsage()
    ]);
    this.cachedSkills = sortSkills(applySkillUsage([...projectSkills, ...userSkills], usage));
    return this.cachedSkills;
  }

  skillRoot(scope: SkillScope): string {
    return scope === 'project' ? this.projectSkillsDir : this.userSkillsDir;
  }

  async loadSkillsFromRoot(root: string, scope: SkillScope): Promise<Skill[]> {
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root, entry.name, 'SKILL.md');
      if (!(await pathExists(skillPath))) continue;
      const body = await readFile(skillPath, 'utf8');
      skills.push(parseSkill(entry.name, path.dirname(skillPath), skillPath, scope, body));
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkill(name: string, scope?: SkillScope): Promise<Skill | undefined> {
    const skills = await this.loadSkills();
    const safeName = sanitizeName(name);
    return skills.find(skill => (!scope || skill.scope === scope) && (skill.name === safeName || skill.name === name));
  }

  async skillFilePath(name: string, scope?: SkillScope): Promise<string | undefined> {
    const skill = await this.getSkill(name, scope);
    return skill?.filePath;
  }

  async deleteSkill(name: string, scope?: SkillScope): Promise<Skill | undefined> {
    const skill = await this.getSkill(name, scope);
    if (!skill) return undefined;
    await rm(skill.path, { recursive: true, force: true });
    this.invalidateCache();
    return skill;
  }

  async recordUsage(skill: Pick<Skill, 'name' | 'scope'>, status: SkillUsageStatus): Promise<void> {
    const usage = await this.loadUsage();
    await writeJsonFile(this.usageFile, updateSkillUsage(usage, skill, status));
    this.invalidateCache();
  }

  async loadUsage(): Promise<SkillUsageStore> {
    return readJsonFile<SkillUsageStore>(this.usageFile, {});
  }

  lastChangeSummary(): SkillChangeSummary {
    return this.changeDetector.lastChangeSummary();
  }

  invalidateCache(): void {
    this.cachedSkills = undefined;
    this.changeDetector.reset();
  }

  async match(input: string, limit = 4): Promise<Skill[]> {
    const skills = await this.loadSkills();
    return this.matchLoaded(input, skills, limit);
  }

  matchLoaded(input: string, skills: Skill[], limit = 4): Skill[] {
    const lower = input.toLowerCase();
    return skills
      .map(skill => ({
        skill,
        score: skill.triggers.reduce((sum, trigger) => sum + (lower.includes(trigger.toLowerCase()) ? 2 : 0), 0) +
          (skill.whenToUse && lower.includes(skill.whenToUse.toLowerCase()) ? 1 : 0) +
          (lower.includes(skill.name.toLowerCase()) ? 3 : 0)
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || compareSkills(a.skill, b.skill))
      .slice(0, limit)
      .map(item => item.skill);
  }

  async createSkill(name: string, description: string, triggers: string[], workflow: string[], options: { scope?: SkillScope } = {}): Promise<Skill> {
    const safeName = sanitizeName(name);
    const scope = options.scope ?? 'user';
    const dir = path.join(this.skillRoot(scope), safeName);
    await mkdir(dir, { recursive: true });
    const body = [
      `# ${name}`,
      '',
      `Description: ${description}`,
      '',
      `Triggers: ${triggers.join(', ')}`,
      '',
      '## Workflow',
      ...workflow.map((step, index) => `${index + 1}. ${step}`),
      '',
      '## Notes',
      '- Keep this skill concise and update it when repeated tasks reveal a better workflow.',
      ''
    ].join('\n');
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, body, 'utf8');
    this.invalidateCache();
    return parseSkill(safeName, dir, filePath, scope, body);
  }

  async maybeAutoCreate(input: string, assistantOutput: string): Promise<Skill | undefined> {
    if (!this.config.skills.autoCreate) return undefined;
    const signature = taskSignature(input);
    if (!signature) return undefined;

    const patterns = await readJsonFile<PatternStore>(this.patternsFile, {});
    patterns[signature] = (patterns[signature] ?? 0) + 1;
    await writeJsonFile(this.patternsFile, patterns);

    if (patterns[signature] < this.config.skills.autoCreateThreshold) return undefined;
    const existing = await this.match(input, 1);
    if (existing.length > 0) return undefined;

    const name = signature.replace(/-/g, ' ');
    return this.createSkill(
      name,
      `Auto-created from repeated task pattern: ${signature}`,
      signature.split('-').filter(Boolean),
      [
        `Identify whether the task matches this repeated request: "${input.slice(0, 160)}".`,
        'Reuse the relevant context, commands, and output style from previous successful runs.',
        `Previous answer summary to preserve: ${assistantOutput.slice(0, 300)}`
      ]
    );
  }
}

function sortSkills(skills: Skill[]): Skill[] {
  return skills.sort(compareSkills);
}

function compareSkills(a: Skill, b: Skill): number {
  const usageDiff = skillUsageScore(b) - skillUsageScore(a);
  if (usageDiff !== 0) return usageDiff;
  if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function parseSkill(name: string, skillPath: string, filePath: string, scope: SkillScope, body: string): Skill {
  const validation = validateSkillContent(body, name);
  const description = validation.description || body.match(/^Description:\s*(.+)$/m)?.[1]?.trim() || body.split('\n').find(Boolean) || name;
  const triggers = validation.triggers.length > 0 ? validation.triggers : body.match(/^Triggers:\s*(.+)$/m)?.[1]?.split(',').map(item => item.trim()).filter(Boolean) ?? [name];
  return {
    name,
    path: skillPath,
    filePath,
    scope,
    description,
    whenToUse: validation.whenToUse,
    disableModelInvocation: validation.disableModelInvocation,
    userInvocable: validation.userInvocable,
    triggers,
    body
  };
}

function taskSignature(input: string): string | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized.length < 18) return undefined;
  const explicit = /(每次|以后|固定|流程|复用|记住这个做法|skill)/.test(normalized);
  const taskLike = /(开发|实现|总结|翻译|审查|review|生成|分析|整理|部署|调试)/.test(normalized);
  if (!explicit && !taskLike) return undefined;
  const terms = normalized.match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2}/g) ?? [];
  return terms.slice(0, 6).join('-') || undefined;
}
