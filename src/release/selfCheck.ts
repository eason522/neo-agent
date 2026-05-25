import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../types.js';

export type SelfCheckItem = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};

export type SelfCheckReport = {
  status: 'pass' | 'warn' | 'fail';
  version: string;
  items: SelfCheckItem[];
};

export async function runInstallSelfCheck(config: AppConfig): Promise<SelfCheckReport> {
  const version = await readPackageVersion();
  const items: SelfCheckItem[] = [
    {
      name: 'node',
      status: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 20 ? 'pass' : 'fail',
      detail: process.version
    },
    {
      name: 'config',
      status: config.homeDir ? 'pass' : 'fail',
      detail: config.homeDir
    },
    {
      name: 'api_keys',
      status: config.models.main.apiKey && config.models.small.apiKey ? 'pass' : 'warn',
      detail: config.models.main.apiKey && config.models.small.apiKey ? 'main/small configured' : 'main or small model API key missing'
    },
    {
      name: 'build_output',
      status: await pathExists(path.resolve('dist', 'index.js')) ? 'pass' : 'warn',
      detail: 'dist/index.js'
    },
    {
      name: 'changelog',
      status: (await changelogMentionsVersion(version)) ? 'pass' : 'warn',
      detail: `CHANGELOG.md version ${version}`
    }
  ];
  return {
    status: items.some(item => item.status === 'fail') ? 'fail' : items.some(item => item.status === 'warn') ? 'warn' : 'pass',
    version,
    items
  };
}

export function formatSelfCheckReport(report: SelfCheckReport): string {
  return [
    `neo-agent ${report.version} self-check: ${report.status}`,
    ...report.items.map(item => `${item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : 'x'} ${item.name}: ${item.detail}`)
  ].join('\n');
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(path.resolve('package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

async function changelogMentionsVersion(version: string): Promise<boolean> {
  const raw = await readFile(path.resolve('CHANGELOG.md'), 'utf8').catch(() => '');
  return raw.includes(` ${version}`) || raw.includes(`[${version}]`) || raw.includes(`v${version}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}
