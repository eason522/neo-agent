import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function loadSoul(cwd = process.cwd()): Promise<string> {
  const candidates = [
    path.join(cwd, 'SOUL.md'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'SOUL.md')
  ];

  for (const filePath of candidates) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      // Try the next candidate.
    }
  }

  return '';
}
