import { constants } from 'node:fs';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../types.js';
import { loadConfig, loadConfigSources } from '../config.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';

type ConfigScope = 'user' | 'project';

export type WorkspaceInfo = {
  configuredDir: string;
  path: string;
  trashPath: string;
  readable: boolean;
  writable: boolean;
  source: 'env' | 'config';
};

export async function showWorkspace(cwd = process.cwd()): Promise<WorkspaceInfo> {
  const config = await loadConfig(cwd);
  const workspacePath = await resolveWorkspacePath(config, cwd);
  await mkdir(workspacePath, { recursive: true });
  const resolved = await realpath(workspacePath);
  const trashPath = path.join(resolved, '.neo-trash');
  await mkdir(trashPath, { recursive: true });
  return {
    configuredDir: config.workspace.dir,
    path: resolved,
    trashPath,
    readable: await canAccess(resolved, constants.R_OK),
    writable: await canAccess(resolved, constants.W_OK),
    source: process.env.NEO_AGENT_WORKSPACE_DIR ? 'env' : 'config'
  };
}

export async function setWorkspace(input: {
  path: string;
  scope?: ConfigScope;
  cwd?: string;
}): Promise<{ scope: ConfigScope; filePath: string; workspace: WorkspaceInfo }> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? 'project';
  const sources = await loadConfigSources(cwd);
  const filePath = scope === 'user' ? sources.userConfigPath : sources.projectConfigPath;
  const current = await readJsonFile<Record<string, unknown>>(filePath, {});
  current.workspace = {
    ...(typeof current.workspace === 'object' && current.workspace ? current.workspace as Record<string, unknown> : {}),
    dir: input.path
  };
  await writeJsonFile(filePath, current);
  const workspace = await showWorkspace(cwd);
  return { scope, filePath, workspace };
}

export async function resetWorkspace(input: {
  scope?: ConfigScope;
  cwd?: string;
} = {}): Promise<{ scope: ConfigScope; filePath: string; workspace: WorkspaceInfo }> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? 'project';
  const sources = await loadConfigSources(cwd);
  const filePath = scope === 'user' ? sources.userConfigPath : sources.projectConfigPath;
  const current = await readJsonFile<Record<string, unknown>>(filePath, {});
  if (current.workspace && typeof current.workspace === 'object' && !Array.isArray(current.workspace)) {
    delete (current.workspace as Record<string, unknown>).dir;
    if (Object.keys(current.workspace as Record<string, unknown>).length === 0) delete current.workspace;
  }
  await writeJsonFile(filePath, current);
  const workspace = await showWorkspace(cwd);
  return { scope, filePath, workspace };
}

async function resolveWorkspacePath(config: AppConfig, cwd: string): Promise<string> {
  return path.isAbsolute(config.workspace.dir) ? config.workspace.dir : path.resolve(cwd, config.workspace.dir);
}

async function canAccess(filePath: string, mode: number): Promise<boolean> {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}
