import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillScope } from '../types.js';

export type SkillChangeSummary = {
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  fileCount: number;
  checkedAt: string;
};

type SkillRoot = {
  root: string;
  scope: SkillScope;
};

type FileSignature = {
  mtimeMs: number;
  size: number;
};

const emptySummary = (): SkillChangeSummary => ({
  changed: true,
  added: [],
  updated: [],
  removed: [],
  fileCount: 0,
  checkedAt: new Date().toISOString()
});

export class SkillChangeDetector {
  private previous: Map<string, FileSignature> | undefined;
  private lastSummary: SkillChangeSummary = emptySummary();

  constructor(private readonly roots: SkillRoot[]) {}

  async scan(): Promise<SkillChangeSummary> {
    const current = await this.snapshot();
    if (!this.previous) {
      this.previous = current;
      this.lastSummary = {
        changed: true,
        added: [...current.keys()].sort(),
        updated: [],
        removed: [],
        fileCount: current.size,
        checkedAt: new Date().toISOString()
      };
      return this.lastSummary;
    }

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [filePath, signature] of current) {
      const old = this.previous.get(filePath);
      if (!old) added.push(filePath);
      else if (old.mtimeMs !== signature.mtimeMs || old.size !== signature.size) updated.push(filePath);
    }
    for (const filePath of this.previous.keys()) {
      if (!current.has(filePath)) removed.push(filePath);
    }

    this.previous = current;
    this.lastSummary = {
      changed: added.length > 0 || updated.length > 0 || removed.length > 0,
      added: added.sort(),
      updated: updated.sort(),
      removed: removed.sort(),
      fileCount: current.size,
      checkedAt: new Date().toISOString()
    };
    return this.lastSummary;
  }

  reset(): void {
    this.previous = undefined;
    this.lastSummary = emptySummary();
  }

  lastChangeSummary(): SkillChangeSummary {
    return this.lastSummary;
  }

  private async snapshot(): Promise<Map<string, FileSignature>> {
    const output = new Map<string, FileSignature>();
    for (const { root, scope } of this.roots) {
      const files = await listSkillFiles(root);
      for (const filePath of files) {
        const fileStat = await stat(filePath);
        output.set(`${scope}:${path.resolve(filePath)}`, {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size
        });
      }
    }
    return output;
  }
}

async function listSkillFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(root, entry.name, 'SKILL.md');
    try {
      const fileStat = await stat(skillFile);
      if (fileStat.isFile()) files.push(skillFile);
    } catch {
      // Ignore partial skill directories while a user is editing or installing.
    }
  }
  return files.sort();
}
