# neo-agent 二阶段开发日志

创建时间：2026-05-26

本文档记录二阶段实际实施过程、关键决策、验证结果和遗留风险。计划视图见 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)。

## 2026-05-26：补充二阶段与总计划的关系

用户指出二阶段开发计划没有体现总开发计划中的最高指导思想和原则。这个问题成立：二阶段计划如果只写里程碑和任务，很容易让后续开发只盯二阶段局部目标，忽略总计划中“必须先参考 CC-Source”“不能硬编码补单点 case”“长期行为变更需要用户确认”等全局约束。

已修正 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)：

- 新增“与总开发计划的关系”。
- 明确二阶段计划不能替代 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)。
- 明确当前阶段开发时必须先读总计划最高原则，再读二阶段计划。
- 明确冲突时以总计划最高原则为准。
- 明确涉及 CC-Source 已有能力时，仍必须先查对应或相近实现。

后续恢复上下文时，不能只看二阶段文档。

## 2026-05-26：补充二阶段反馈修正收敛规则

用户继续指出：反馈修正不能无限制发散，否则二阶段会因为 workspace、执行工具、OpenViking、TUI 等能力相互牵连而无法收敛。

已修正 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)：

- 在二阶段继承原则中新增反馈修正收敛要求。
- 新增“二阶段反馈修正收敛规则”。
- 明确每次反馈必须先归属到一个二阶段里程碑。
- 本次修正只处理直接问题、阻塞验证问题，以及安全/权限/数据丢失等高风险问题。
- 其它相邻问题只记录到待收口或日志，不顺手实现。

后续二阶段开发如果发现更多可改进点，必须先记录，再结束当前支线；不能把“顺手修一下”变成新一轮无限扩展。

## 2026-05-26：二阶段实施总览

本轮根据二阶段计划直接实施四条主线：

1. workspace 完整文件管理和长文件生成可靠性。
2. Bash/Python 执行工具。
3. OpenViking 主记忆存储。
4. Ink TUI 入口层。

实施前重新读取了现有代码结构，确认当前仓库已有 `FileToolRunner`、`QueryEngine`、`MemoryService`、`OpenVikingMemory`、`CapabilitySnapshot`、`TaskAssessment` 和 legacy readline REPL。因此本轮没有推倒重写，而是在现有结构上增量接入。

## Workspace 和文件工具

改动文件：

- `src/files/fileTools.ts`
- `src/workspace/workspaceCommands.ts`
- `src/index.ts`
- `src/terminal/repl.ts`
- `src/types.ts`
- `src/permissions/permissions.ts`

新增能力：

- `List`
- `Mkdir`
- `Copy`
- `Move`
- `Delete`

关键行为：

- workspace 内完整文件管理免确认。
- 项目目录和额外写入目录仍然需要确认。
- `Write` 在 workspace 内自动创建父目录。
- `Delete` 默认移动到 `workspace/.neo-trash/`。
- `Delete permanent=true` 必须确认。

新增命令：

- `neo workspace show`
- `neo workspace set <path> --scope project|user`
- `neo workspace reset --scope project|user`
- REPL `/workspace`

手动验证：

- `neo workspace show` 正确输出 configured、path、trash、readable、writable 和 source。
- 使用文件工具创建、列出和删除 workspace 文件成功。

## 长文件生成和工具调用截断恢复

改动文件：

- `src/router.ts`
- `src/config.ts`
- `src/agent/queryEngine.ts`
- `src/files/fileTools.ts`

问题背景：

短提示生成落地页时可能被路由到 small 模型。长 HTML 工具调用参数被模型输出长度截断后，`Write` 收到非法 JSON，导致生成失败。

修复：

- 路由器识别 HTML/CSS/JS、落地页、单文件、写入文件、生成文件等任务，强制走 main。
- 默认 `forceMainKeywords` 增加相关关键词。
- QueryEngine 检测 `finish_reason=length` 且 tool call 参数 JSON 不完整时，不执行坏工具调用。
- QueryEngine 会把恢复提示回灌给模型，要求分块或重新生成完整 JSON 参数。
- 文件工具 prompt 明确要求长 HTML/CSS/JS 优先写入 workspace 文件，不要把完整长代码刷屏。

## Bash/Python 执行工具

改动文件：

- `src/tools/executionTools.ts`
- `src/neoAgent.ts`
- `src/terminal/repl.ts`
- `src/capabilities/capabilities.ts`
- `src/capabilities/taskAssessment.ts`
- `src/tools/toolLog.ts`
- `src/types.ts`

新增工具：

- `Bash`
- `Python`

权限策略：

- Bash 默认 cwd 为 workspace。
- Bash `cwd` 必须位于 workspace 内。
- 只读低风险 Bash 自动执行。
- 高风险 Bash 需要交互确认。
- Python 默认每次确认。
- 没有确认回调时，高风险 Bash 和 Python 拒绝。

输出结构：

- command
- cwd
- exitCode
- stdoutChars
- stderrChars
- durationMs
- timedOut

实现细节：

- Python 代码写入 `workspace/.neo-agent/tmp/python-*.py` 后执行。
- stdout/stderr 使用尾部截断保护。
- 权限请求走现有 `PermissionRequest` hook。
- REPL 增加执行权限确认提示。

手动验证：

- `Bash pwd` 在 workspace 内执行，退出码为 0。

## OpenViking 主记忆存储

改动文件：

- `src/memory/openVikingMemory.ts`
- `src/memory/memoryService.ts`
- `src/memory/localMemory.ts`
- `src/index.ts`

关键决策：

- OpenViking 是主存储。
- 本地 JSON 是备份和离线恢复。
- OpenViking 不可用时，写入进入 pending queue。
- 读取优先 OpenViking；OpenViking 不可用或无结果时回退本地。

新增 CLI：

- `neo openviking doctor`
- `neo openviking import-local --dry-run|--apply`
- `neo openviking sync-pending`

记忆 URI 映射：

- `preference` -> `viking://user/default/memories/preferences/`
- `project_fact` -> `viking://user/default/memories/project_facts/`
- `workflow` -> `viking://user/default/memories/workflows/`
- `session_summary` -> `viking://agent/neo-agent/memories/session_summaries/`

写入格式：

- Markdown 正文。
- YAML frontmatter 包含 `id/category/tags/pinned/status/origin/createdAt/updatedAt/sourceTranscript`。

本机验证：

- `neo openviking doctor` 输出 OpenViking 离线。
- pending 为 0。
- 这符合本机没有启动 `openviking-server` 的实际状态。

遗留风险：

- `/mcp` 返回结构需要真实 OpenViking 服务联调后收紧。
- 需要补 mock `/mcp` 自动化测试。

## Ink TUI 入口层

改动文件：

- `src/tui/startTui.ts`
- `src/index.ts`
- `package.json`
- `package-lock.json`

新增依赖：

- `ink`
- `react`
- `@types/react`

行为：

- `neo chat` 默认进入 TUI wrapper。
- `neo chat --legacy` 使用 legacy REPL。
- `NEO_AGENT_LEGACY_REPL=1` 强制使用 legacy REPL。
- 非交互 stdin 自动绕过 Ink，直接使用 legacy REPL。

原因：

smoke 发现非交互 `/help` 被 TUI banner 截断，说明 TUI wrapper 不能拦截 stdin 脚本场景。因此加了 `!process.stdin.isTTY` 回退，保留现有自动化和管道行为。

当前边界：

- 这只是 TUI 入口壳层。
- 完整 CC-Source 等价体验尚未完成。
- 后续需要把消息流、输入、状态行、权限弹窗、工具进度和 debug 面板逐步 Ink 化。

## Capabilities 和 TaskAssessment 更新

改动文件：

- `src/capabilities/capabilities.ts`
- `src/capabilities/taskAssessment.ts`

更新内容：

- 能力快照新增 `execution` 区块。
- 不再报告“没有 shell/python/git 执行工具”。
- 任务评估会区分执行工具完全缺失、执行工具存在但当前入口没有确认回调、执行工具可用且可确认。

smoke 调整过程中发现：

- 非交互 `neo assess "运行 npm test 并修复失败"` 应保持 `partial`，因为 CLI 没有交互确认回调，高风险 Bash 和 Python 不能自动执行。
- 已修复为：执行工具存在但无确认回调时，shell 能力在该入口下仍视为缺失或部分受限。

## 验证记录

已运行并通过：

```bash
npm run typecheck
npm run build
npm run smoke
```

`npm run smoke` 最终全部通过。

额外手动验证：

```bash
node dist/index.js workspace show
node dist/index.js openviking doctor
```

结果：

- workspace 显示真实路径、trash、读写权限。
- OpenViking 在本机未启动时正确报告 offline，pending 为 0。

还做了一个临时 Node 脚本验证：

- `Write` 创建 `workspace/site/index.html`。
- `List` 能看到该文件。
- `Delete` 会移动到 `.neo-trash`。
- `Bash pwd` 在 workspace 内执行，退出码为 0。

## 已知未完成项

- README 尚未同步所有二阶段新命令。
- 二阶段专项 smoke 还不足，需要补：
  - workspace set/reset 优先级。
  - `List/Mkdir/Copy/Move/Delete` 权限边界。
  - `Delete permanent=true` 确认拒绝。
  - Bash 低风险自动执行。
  - Bash 高风险确认拒绝。
  - Python 默认确认拒绝。
  - cwd 越界拒绝。
  - OpenViking mock `/mcp`。
- Ink TUI 目前只是入口层，完整体验等价仍待后续实现。

## 结论

二阶段第一版核心能力已经落地并通过现有全量 smoke。当前最需要的不是继续扩功能，而是补二阶段专项测试、README 同步和 OpenViking 真实服务联调。

## 2026-05-26：补二阶段专项 smoke，并修复 workspace env 优先级

按照二阶段计划继续推进“补二阶段专项 smoke”。本次只覆盖已经落地的二阶段能力，不扩展新功能。

新增 smoke：

- `workspace 命令支持 show/set/reset 和环境变量优先级`
- `二阶段文件工具支持完整 workspace 文件管理`
- `Bash/Python 工具限制在 workspace 并按风险确认`
- `OpenViking 主存储支持 MCP 写入、搜索、列表、归档和 pending 同步`

覆盖范围：

- `neo workspace show/set/reset`
- `NEO_AGENT_WORKSPACE_DIR` 优先级
- `List/Mkdir/Copy/Move/Delete`
- `Write` 自动创建 workspace 父目录
- `Delete` 默认进入 `.neo-trash`
- `Delete permanent=true` 必须确认
- Bash 只读命令自动执行
- Bash 高风险命令无确认时拒绝
- Python 无确认时拒绝
- Bash `cwd` 越界拒绝
- Bash/Python 确认后可执行
- OpenViking mock `/mcp` 的 `health/store/search/list/forget`
- OpenViking 离线 pending queue 和恢复后 `sync-pending`

专项 smoke 暴露一个真实问题：`NEO_AGENT_WORKSPACE_DIR` 在 `workspace show` 中显示来源为 env，但实际路径仍会被项目配置覆盖。根因是 `defaultConfig()` 先读取环境变量，随后 `loadConfig()` 又用 user/project config 覆盖了 defaults。已修复为：在 `loadConfig()` 和 `mergeConfigSources()` 合并配置后，再应用 `NEO_AGENT_WORKSPACE_DIR` 运行时覆盖，确保 env 优先级最高。

验证：

```bash
npm run smoke
```

结果：全部 smoke tests 通过。

## 2026-05-26：同步 README 二阶段能力说明

按二阶段计划继续推进 README 同步。本次只更新文档，不扩展新功能。

更新内容：

- 顶部能力概览同步：
  - OpenViking 主存储和本地 JSON 备份。
  - 完整文件工具：`Read/Glob/Grep/List/Write/Edit/Mkdir/Copy/Move/Delete`。
  - workspace 命令：`neo workspace show/set/reset`。
  - Bash/Python workspace 执行工具和权限边界。
  - TUI 入口层和 legacy REPL 回退。
- 常用命令新增 `/workspace`。
- 新增 OpenViking 诊断、导入和 pending 同步命令说明。
- 文件工具章节补充：
  - workspace 内完整文件管理免确认。
  - `Delete` 默认进入 `.neo-trash`。
  - `permanent=true` 必须确认。
  - Bash/Python 的 cwd 和确认规则。
- OpenViking 章节改为主存储语义：
  - `/mcp` 优先。
  - pending queue。
  - 固定记忆 URI 映射。
  - `NEO_AGENT_MEMORY_BACKEND=openviking` 示例。

验证：文档变更，无需重新跑 smoke。
