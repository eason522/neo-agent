import React from 'react';
import { Box, render, Text } from 'ink';
import type { NeoAgent } from '../neoAgent.js';
import { startRepl } from '../terminal/repl.js';

type TuiShellProps = {
  model: string;
  workspace: string;
  openViking: string;
};

function TuiShell(props: TuiShellProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'neo-agent'),
    React.createElement(
      Text,
      { color: 'gray' },
      `model=${props.model} workspace=${props.workspace} openviking=${props.openViking}`
    )
  );
}

export async function startTui(agent: NeoAgent): Promise<void> {
  if (!process.stdin.isTTY) {
    await startRepl(agent);
    return;
  }
  const health = await agent.memory.openVikingHealth().catch(() => ({ ok: false, mode: 'offline' as const }));
  const instance = render(React.createElement(TuiShell, {
    model: agent.config.models.main.model,
    workspace: agent.config.workspace.dir,
    openViking: health.ok ? health.mode : 'offline'
  }));
  await new Promise(resolve => setTimeout(resolve, 40));
  instance.unmount();
  await startRepl(agent);
}
