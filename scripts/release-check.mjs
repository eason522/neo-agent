#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const changelog = await readFile('CHANGELOG.md', 'utf8').catch(() => '');
if (!changelog.includes(`[${pkg.version}]`) && !changelog.includes(` ${pkg.version}`)) {
  throw new Error(`CHANGELOG.md does not mention package version ${pkg.version}`);
}

await run('npm', ['run', 'typecheck']);
await run('npm', ['run', 'build']);
await run('node', ['dist/index.js', 'self-check']);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit ${code ?? 'unknown'}`));
    });
  });
}
