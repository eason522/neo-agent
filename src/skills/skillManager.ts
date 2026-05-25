import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, Skill } from '../types.js';
import { ensureDir, pathExists, readJsonFile, sanitizeName, writeJsonFile } from '../utils/fs.js';

type PatternStore = Record<string, number>;

export class SkillManager {
  private readonly skillsDir: string;
  private readonly patternsFile: string;

  constructor(private readonly config: AppConfig) {
    this.skillsDir = path.join(config.homeDir, 'skills');
    this.patternsFile = path.join(this.skillsDir, '.task-patterns.json');
  }

  async loadSkills(): Promise<Skill[]> {
    await ensureDir(this.skillsDir);
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!(await pathExists(skillPath))) continue;
      const body = await readFile(skillPath, 'utf8');
      skills.push(parseSkill(entry.name, path.dirname(skillPath), body));
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkill(name: string): Promise<Skill | undefined> {
    const skills = await this.loadSkills();
    const safeName = sanitizeName(name);
    return skills.find(skill => skill.name === safeName || skill.name === name);
  }

  async skillFilePath(name: string): Promise<string | undefined> {
    const skill = await this.getSkill(name);
    return skill ? path.join(skill.path, 'SKILL.md') : undefined;
  }

  async deleteSkill(name: string): Promise<Skill | undefined> {
    const skill = await this.getSkill(name);
    if (!skill) return undefined;
    await rm(skill.path, { recursive: true, force: true });
    return skill;
  }

  async match(input: string, limit = 4): Promise<Skill[]> {
    const skills = await this.loadSkills();
    const lower = input.toLowerCase();
    return skills
      .map(skill => ({
        skill,
        score: skill.triggers.reduce((sum, trigger) => sum + (lower.includes(trigger.toLowerCase()) ? 2 : 0), 0) +
          (lower.includes(skill.name.toLowerCase()) ? 3 : 0)
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.skill);
  }

  async createSkill(name: string, description: string, triggers: string[], workflow: string[]): Promise<Skill> {
    const safeName = sanitizeName(name);
    const dir = path.join(this.skillsDir, safeName);
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
    await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
    return parseSkill(safeName, dir, body);
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

function parseSkill(name: string, skillPath: string, body: string): Skill {
  const description = body.match(/^Description:\s*(.+)$/m)?.[1]?.trim() ?? body.split('\n').find(Boolean) ?? name;
  const triggers = body.match(/^Triggers:\s*(.+)$/m)?.[1]?.split(',').map(item => item.trim()).filter(Boolean) ?? [name];
  return {
    name,
    path: skillPath,
    description,
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
