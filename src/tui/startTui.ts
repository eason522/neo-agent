import React from 'react';
import { Box, render, Text } from 'ink';
import type { NeoAgent } from '../neoAgent.js';
import { startRepl } from '../terminal/repl.js';
import { buildTuiRuntimeState, formatTuiRuntimeSummary } from './tuiState.js';

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

export type StartTuiOptions = {
  preloadedInput?: string;
};

export async function startTui(agent: NeoAgent, options: StartTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    await startRepl(agent, { preloadedInput: options.preloadedInput });
    return;
  }
  const health = await agent.memory.openVikingHealth().catch(() => ({
    ok: false,
    mode: 'offline' as const,
    message: 'OpenViking 状态检查失败'
  }));
  const runtime = buildTuiRuntimeState({
    config: agent.config,
    openVikingHealth: health
  });
  const instance = render(React.createElement(TuiShell, {
    model: runtime.model,
    workspace: runtime.workspace,
    openViking: runtime.openViking
  }));
  agent.logger.debug('tui.runtime', { summary: formatTuiRuntimeSummary(runtime) });
  await new Promise(resolve => setTimeout(resolve, 40));
  instance.unmount();
  await startRepl(agent, { preloadedInput: options.preloadedInput });
}
