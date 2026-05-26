import React from 'react';
import { Box, render, Text } from 'ink';
import type { NeoAgent } from '../neoAgent.js';
import { startRepl } from '../terminal/repl.js';
import { buildTuiRuntimeState, formatTuiRuntimeStatusLine, formatTuiRuntimeSummary } from './tuiState.js';

type TuiShellProps = {
  statusLine: string;
};

function TuiShell(props: TuiShellProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'neo-agent'),
    React.createElement(
      Text,
      { color: 'gray' },
      props.statusLine
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
    statusLine: formatTuiRuntimeStatusLine(runtime, process.stdout.columns || Number(process.env.COLUMNS) || 80)
  }));
  agent.logger.debug('tui.runtime', { summary: formatTuiRuntimeSummary(runtime) });
  await new Promise(resolve => setTimeout(resolve, 40));
  instance.unmount();
  await startRepl(agent, { preloadedInput: options.preloadedInput });
}
