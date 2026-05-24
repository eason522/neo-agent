import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { NeoAgent } from '../neoAgent.js';
import { extractImageAttachments } from '../input/attachments.js';

export async function startRepl(agent: NeoAgent): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: chalk.gray('neo> ') });
  const isInteractive = Boolean(input.isTTY);
  printBanner();

  try {
    if (isInteractive) rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        if (isInteractive) rl.prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') break;
      if (await handleCommand(agent, line)) {
        if (isInteractive) rl.prompt();
        continue;
      }

      const { text, attachments } = extractImageAttachments(line);
      output.write(chalk.gray('thinking...\n'));
      try {
        const response = await agent.ask(text, attachments);
        output.write(`${chalk.cyan(`neo:${response.modelKind}`)} ${response.text.trim()}\n\n`);
      } catch (error) {
        output.write(`${chalk.red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
      }
      if (isInteractive) rl.prompt();
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

async function handleCommand(agent: NeoAgent, line: string): Promise<boolean> {
  if (!line.startsWith('/')) return false;
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command) {
    case '/help':
      printHelp();
      return true;
    case '/memory': {
      const records = arg ? await agent.memory.search(arg) : await agent.memory.list(12);
      if (records.length === 0) console.log(chalk.gray('no memory found'));
      for (const item of records) console.log(`${chalk.gray(item.uri)}\n${item.content}\n`);
      return true;
    }
    case '/remember': {
      if (!arg) console.log('usage: /remember <text>');
      else {
        const record = await agent.memory.remember(arg, ['manual'], 'user');
        console.log(`${chalk.green('remembered')} ${record.uri}`);
      }
      return true;
    }
    case '/skills': {
      const skills = await agent.skills.loadSkills();
      if (skills.length === 0) console.log(chalk.gray('no skills found'));
      for (const skill of skills) console.log(`${chalk.cyan(skill.name)} - ${skill.description}`);
      return true;
    }
    case '/skill': {
      const [subCommand, ...skillRest] = rest;
      if (subCommand !== 'create' || skillRest.length === 0) {
        console.log('usage: /skill create <name> :: <description>');
        return true;
      }
      const [name, description = 'Manual skill'] = skillRest.join(' ').split(/\s+::\s+/, 2);
      const skill = await agent.skills.createSkill(name, description, name.split(/\s+/), [
        'Confirm the task matches this skill.',
        'Apply the remembered workflow and adapt only where the current request differs.'
      ]);
      console.log(`${chalk.green('created skill')} ${skill.path}`);
      return true;
    }
    case '/mcp': {
      const tools = await agent.mcp.listTools();
      if (tools.length === 0) console.log(chalk.gray('no MCP tools connected'));
      else tools.forEach(tool => console.log(tool));
      return true;
    }
    case '/agent': {
      if (!arg) console.log('usage: /agent <delegated task>');
      else console.log(await agent.subAgent.run(arg));
      return true;
    }
    default:
      console.log(`unknown command: ${command}`);
      return true;
  }
}

function printBanner(): void {
  console.log(chalk.bold('neo-agent'));
  console.log(chalk.gray('Type /help for commands. Use @image:/path/to/file.png or @/path/file.png for images.\n'));
}

function printHelp(): void {
  console.log([
    '/help                 Show commands',
    '/exit                 Exit',
    '/remember <text>      Store a user memory',
    '/memory [query]       List or search memories',
    '/skills               List skills',
    '/skill create <name> :: <description>',
    '/mcp                  List connected MCP tools',
    '/agent <task>         Delegate a focused task to the small model',
    '@/path/image.png      Attach an image to a normal prompt'
  ].join('\n'));
}
