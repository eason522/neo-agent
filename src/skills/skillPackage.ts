import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { sanitizeName } from '../utils/fs.js';

export type SkillValidationResult = {
  valid: boolean;
  name: string;
  description: string;
  triggers: string[];
  warnings: string[];
  errors: string[];
  bytes: number;
};

export type SkillInstallPlan = {
  name: string;
  description: string;
  triggers: string[];
  files: Array<{ relativePath: string; data: Uint8Array }>;
  validation: SkillValidationResult;
  sourceType: 'markdown' | 'directory' | 'zip';
};

export type SkillInstallResult = SkillInstallPlan & {
  targetDir: string;
  skillFilePath: string;
  installed: boolean;
};

const maxSkillFileBytes = 512 * 1024;
const maxPackageBytes = 5 * 1024 * 1024;
const maxPackageFiles = 100;
const maxSinglePackageFileBytes = 1024 * 1024;

export async function buildSkillInstallPlan(input: {
  source: string;
  name?: string;
}): Promise<SkillInstallPlan> {
  const source = input.source.trim();
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`下载 skill 失败：${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pathname = new URL(source).pathname.toLowerCase();
    if (pathname.endsWith('.zip')) return buildZipPlan(bytes, input.name);
    const nameHint = path.basename(pathname, path.extname(pathname)) || undefined;
    return buildMarkdownPlan(strFromU8(bytes), input.name, nameHint);
  }

  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) return buildDirectoryPlan(source, input.name);
  const bytes = await readFile(source);
  if (source.toLowerCase().endsWith('.zip')) return buildZipPlan(new Uint8Array(bytes), input.name);
  return buildMarkdownPlan(bytes.toString('utf8'), input.name, path.basename(source, path.extname(source)));
}

export async function installSkillPlan(input: {
  plan: SkillInstallPlan;
  targetRoot: string;
  overwrite?: boolean;
  dryRun?: boolean;
}): Promise<SkillInstallResult> {
  if (!input.plan.validation.valid) {
    throw new Error(`skill 校验失败：${input.plan.validation.errors.join('；')}`);
  }
  const safeName = sanitizeName(input.plan.name);
  const targetDir = path.join(input.targetRoot, safeName);
  const targetSkillFile = path.join(targetDir, 'SKILL.md');
  const exists = await pathExists(targetDir);
  if (exists && !input.overwrite) {
    throw new Error(`skill 已存在：${safeName}。如需覆盖，请加 --overwrite。`);
  }

  if (!input.dryRun) {
    if (exists) await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    for (const file of input.plan.files) {
      const safeRelative = normalizeArchivePath(file.relativePath);
      const target = path.join(targetDir, safeRelative);
      if (!isInside(targetDir, target)) throw new Error(`拒绝写入 skill 目录外路径：${file.relativePath}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data));
    }
  }

  return {
    ...input.plan,
    name: safeName,
    targetDir,
    skillFilePath: targetSkillFile,
    installed: !input.dryRun
  };
}

export async function validateSkillSource(source: string, name?: string): Promise<SkillValidationResult> {
  return (await buildSkillInstallPlan({ source, name })).validation;
}

export async function exportSkillPackage(input: {
  skillDir: string;
  skillName: string;
  outputPath: string;
}): Promise<{ outputPath: string; fileCount: number; bytes: number }> {
  const files = await collectFiles(input.skillDir);
  if (files.length === 0) throw new Error(`skill 目录为空：${input.skillDir}`);
  if (files.length > maxPackageFiles) throw new Error(`skill 文件过多：${files.length}，最多 ${maxPackageFiles}`);

  const archiveFiles: Record<string, Uint8Array> = {};
  for (const filePath of files) {
    const relative = path.relative(input.skillDir, filePath).replaceAll(path.sep, '/');
    const data = await readFile(filePath);
    if (data.byteLength > maxSinglePackageFileBytes) throw new Error(`skill 文件过大：${relative}`);
    archiveFiles[`${sanitizeName(input.skillName)}/${relative}`] = new Uint8Array(data);
  }
  const zipped = zipSync(archiveFiles, { level: 6 });
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, Buffer.from(zipped));
  return { outputPath: input.outputPath, fileCount: files.length, bytes: zipped.byteLength };
}

export function validateSkillContent(body: string, nameHint?: string): SkillValidationResult {
  const name = sanitizeName(readFrontmatterValue(body, 'name') ?? firstHeading(body) ?? nameHint ?? 'skill');
  const description = readFrontmatterValue(body, 'description') ?? body.match(/^Description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const triggers = parseList(readFrontmatterValue(body, 'triggers') ?? readFrontmatterValue(body, 'when_to_use') ?? body.match(/^Triggers:\s*(.+)$/m)?.[1]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const bytes = Buffer.byteLength(body, 'utf8');

  if (!name || name === 'untitled') errors.push('缺少有效 skill 名称。');
  if (!description) errors.push('缺少 description。请在 frontmatter 中写 description，或使用 Description:。');
  if (!body.trim()) errors.push('SKILL.md 不能为空。');
  if (bytes > maxSkillFileBytes) errors.push(`SKILL.md 过大：${bytes} bytes，最多 ${maxSkillFileBytes} bytes。`);
  if (triggers.length === 0) warnings.push('没有 triggers/when_to_use，模型可能不容易发现这个 skill。');
  if (/```!|!`/.test(body)) warnings.push('检测到 shell 执行片段。neo 当前不会自动执行 skill 内 shell；后续如支持必须走权限确认。');

  return {
    valid: errors.length === 0,
    name,
    description,
    triggers,
    warnings,
    errors,
    bytes
  };
}

async function buildDirectoryPlan(sourceDir: string, overrideName?: string): Promise<SkillInstallPlan> {
  const skillFile = await findDirectorySkillFile(sourceDir);
  const skillRoot = path.dirname(skillFile);
  const body = await readFile(skillFile, 'utf8');
  const validation = withOverrideName(validateSkillContent(body, path.basename(skillRoot)), overrideName);
  const files = await Promise.all((await collectFiles(skillRoot)).map(async filePath => ({
    relativePath: path.relative(skillRoot, filePath).replaceAll(path.sep, '/'),
    data: new Uint8Array(await readFile(filePath))
  })));
  return {
    name: sanitizeName(overrideName ?? validation.name),
    description: validation.description,
    triggers: validation.triggers,
    files,
    validation,
    sourceType: 'directory'
  };
}

function buildMarkdownPlan(body: string, overrideName?: string, fallbackName?: string): SkillInstallPlan {
  const validation = withOverrideName(validateSkillContent(body, fallbackName ?? overrideName), overrideName);
  return {
    name: sanitizeName(validation.name),
    description: validation.description,
    triggers: validation.triggers,
    files: [{ relativePath: 'SKILL.md', data: strToU8(body) }],
    validation,
    sourceType: 'markdown'
  };
}

function buildZipPlan(bytes: Uint8Array, overrideName?: string): SkillInstallPlan {
  if (bytes.byteLength > maxPackageBytes) throw new Error(`skill zip 过大：${bytes.byteLength} bytes，最多 ${maxPackageBytes} bytes。`);
  const unzipped = unzipSync(bytes);
  const entries = Object.entries(unzipped)
    .map(([name, data]) => ({ name: normalizeArchivePath(name), data }))
    .filter(entry => !entry.name.endsWith('/'));
  if (entries.length > maxPackageFiles) throw new Error(`skill zip 文件过多：${entries.length}，最多 ${maxPackageFiles}`);
  for (const entry of entries) {
    if (entry.data.byteLength > maxSinglePackageFileBytes) throw new Error(`skill zip 内文件过大：${entry.name}`);
  }
  const skillEntry = chooseSkillEntry(entries.map(entry => entry.name));
  const prefix = skillEntry === 'SKILL.md' ? '' : skillEntry.slice(0, -'SKILL.md'.length);
  const body = strFromU8(entries.find(entry => entry.name === skillEntry)!.data);
  const validation = withOverrideName(validateSkillContent(body, prefix ? prefix.split('/')[0] : undefined), overrideName);
  const files = entries
    .filter(entry => prefix ? entry.name.startsWith(prefix) : !entry.name.includes('/') || entry.name === 'SKILL.md')
    .map(entry => ({
      relativePath: prefix ? entry.name.slice(prefix.length) : entry.name,
      data: entry.data
    }))
    .filter(entry => entry.relativePath.length > 0);
  return {
    name: sanitizeName(overrideName ?? validation.name),
    description: validation.description,
    triggers: validation.triggers,
    files,
    validation,
    sourceType: 'zip'
  };
}

async function findDirectorySkillFile(sourceDir: string): Promise<string> {
  const rootSkill = path.join(sourceDir, 'SKILL.md');
  if (await pathExists(rootSkill)) return rootSkill;
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(sourceDir, entry.name, 'SKILL.md');
    if (await pathExists(candidate)) matches.push(candidate);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('目录中包含多个 SKILL.md，请指定单个 skill 目录。');
  throw new Error('目录中没有找到 SKILL.md。');
}

function chooseSkillEntry(paths: string[]): string {
  const matches = paths.filter(item => item === 'SKILL.md' || item.endsWith('/SKILL.md'));
  if (matches.length === 0) throw new Error('zip 中没有找到 SKILL.md。');
  if (matches.includes('SKILL.md')) return 'SKILL.md';
  const topLevel = matches.filter(item => item.split('/').length === 2);
  if (topLevel.length === 1) return topLevel[0]!;
  if (matches.length === 1) return matches[0]!;
  throw new Error('zip 中包含多个 SKILL.md，请只打包一个 skill。');
}

function withOverrideName(validation: SkillValidationResult, overrideName?: string): SkillValidationResult {
  if (!overrideName) return validation;
  return { ...validation, name: sanitizeName(overrideName) };
}

async function collectFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const entryStat = await lstat(fullPath);
      if (entryStat.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) output.push(fullPath);
      if (output.length > maxPackageFiles) throw new Error(`skill 文件过多，最多 ${maxPackageFiles}`);
    }
  }
  return output.sort();
}

function normalizeArchivePath(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) throw new Error(`拒绝不安全的归档路径：${input}`);
  if (path.isAbsolute(input)) throw new Error(`拒绝绝对路径：${input}`);
  return parts.join('/');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function readFrontmatterValue(body: string, key: string): string | undefined {
  if (!body.startsWith('---\n')) return undefined;
  const end = body.indexOf('\n---', 4);
  if (end === -1) return undefined;
  const lines = body.slice(4, end).split(/\r?\n/);
  const prefix = `${key}:`;
  const line = lines.find(item => item.trim().toLowerCase().startsWith(prefix));
  return line?.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function parseList(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/)
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}
