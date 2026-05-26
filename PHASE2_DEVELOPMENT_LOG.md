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
- OpenViking mock `/mcp` 的 `health/remember/search/list/forget`
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

## 2026-05-26：OpenViking 真实服务联调条件检查

按二阶段计划继续检查 OpenViking 真实服务联调条件。

本机检查结果：

```bash
command -v openviking-server
command -v ov
node dist/index.js openviking doctor
```

结果：

- 本机没有 `openviking-server`。
- 本机没有 `ov` CLI。
- `neo openviking doctor` 报告 `http://localhost:1933` 离线，pending 为 0。

结论：

- OpenViking 真实服务联调当前受本机环境阻塞。
- 已有 mock `/mcp` smoke 覆盖主存储写入、搜索、列表、归档和 pending 同步。
- 不在当前支线尝试自动安装 OpenViking，避免扩大范围。
- 下一步转入二阶段下一个可推进项：拆分 Ink TUI 所需状态模型。

## 2026-05-26：拆分 TUI 状态模型第一版

由于本机缺少 OpenViking 真实服务，转入二阶段下一个可推进项：拆分 Ink TUI 所需状态模型。本次只做状态模型，不重写 REPL，也不扩展完整 Ink 交互。

新增文件：

- `src/tui/tuiState.ts`

新增能力：

- `buildTuiRuntimeState(...)`：从 `AppConfig` 和 OpenViking health 生成 TUI 运行时状态。
- `buildTuiTurnState(...)`：从 `AgentResponse`、耗时和状态事件生成 TUI 回合摘要。
- `formatTuiRuntimeSummary(...)`：格式化运行时摘要。
- `formatTuiTurnSummary(...)`：格式化回合摘要。

更新：

- `src/tui/startTui.ts` 改为使用 `buildTuiRuntimeState(...)`，不再直接拼装模型、workspace 和 OpenViking 状态。
- smoke 新增 `TUI 状态模型能生成运行时摘要和回合摘要`，覆盖 runtime summary、tool start 计数、file/exec/webContext、route 和 latest status。

边界：

- 这不是完整 Ink TUI。
- 输入、权限确认、消息流和工具进度仍由 legacy REPL 承担。
- 下一步应继续拆分输入和权限确认流程，而不是直接把 legacy REPL 代码搬进 Ink 组件。

## 2026-05-26：补 TUI 默认入口非交互回退 smoke

之前引入 TUI wrapper 时，smoke 曾发现非交互 `/help` 会被 TUI banner 截断。虽然当时已修复 `!process.stdin.isTTY` 回退，但缺少一条明确防回归测试。

本次新增 smoke：

- `TUI 默认入口在非交互 stdin 下回退 legacy REPL`

覆盖内容：

- `neo chat` 默认入口在 stdin 非 TTY 时直接进入 legacy REPL。
- `/help` 能完整输出。
- 输出中不应出现 TUI header 的 `openviking=` 或 `model=... workspace=...`。

新增测试暴露一个真实问题：短 stdin 输入下，`neo chat` 可能只打印 banner，没有消费 `/help`。根因是 chat/default 入口在初始化 agent 期间可能错过已经结束的 stdin。已修复为：非交互 chat/default 先读取 stdin 快照，再初始化 agent，随后把快照交给 legacy REPL 处理。

边界：

- 这不是完整 PTY 截图测试。
- 宽窄终端、中文宽度和真实 Ink 交互仍待后续专项处理。

## 2026-05-26：修复长落地页生成工具参数截断

用户反馈：让 neo 生成单 HTML 个人介绍落地页时，模型已经路由到 main，但连续多轮 `Write` 工具参数因为 `finish_reason=length` 被截断；neo 没有执行坏工具调用，最后却输出了一段不完整 HTML 兜底。

按总开发计划最高原则先查 CC-Source 相近实现：

- `CC-Source/src/tools/FileWriteTool/prompt.ts`：强调完整写入会覆盖文件，修改现有文件前要先读，修改小范围内容应使用 Edit。
- `CC-Source/src/tools/FileWriteTool/FileWriteTool.ts`：文件写入走权限、校验、结果渲染和 diff/历史记录，不靠最终回答刷代码。
- `CC-Source/src/tools/BashTool/prompt.ts`：复杂外部操作通过工具完成，不把执行结果伪装成已完成。

neo-agent 的偏离和原因：

- CC-Source 没有专门的 `Append` 工具；neo 当前模型在长 HTML 场景中会把完整文件塞入一次 `Write` JSON 参数，导致参数在模型输出层被截断。
- 本次新增 `Append` 作为二阶段 workspace 可靠生成能力的一部分：第一块 `mode=create`，后续块 `mode=append`，每块建议小于 4000 字符。
- QueryEngine 的截断恢复提示从“分块或重试”收紧为“必须用 Append 分块，禁止再次用 Write 传完整长 content”。
- 工具轮次耗尽且长文件没有成功写入时，最终提示禁止输出完整代码兜底；如果模型仍返回被截断长代码，QueryEngine 会替换为简短未完成说明。

收敛边界：

- 本次只处理长文件生成、工具参数截断和不完整代码兜底。
- 没有扩展 TUI、OpenViking 或权限持久化。
- 没有引入 Bash heredoc 自动替代方案，避免把文件写入可靠性问题扩散到 shell 执行策略。

验证：

- smoke 新增 `Append` 分块写入 workspace 文件覆盖。
- smoke 新增 QueryEngine 截断恢复覆盖：坏 `Write` 参数不执行、恢复提示包含 `Append/mode=create`、连续截断写日志、最终禁止长代码兜底。

## 2026-05-26：补 TUI 状态行窄终端文本回归

按二阶段 TUI 待收口继续推进。本次只做状态行文本收口，不拆 legacy REPL 输入，也不实现完整 Ink 组件。

更新内容：

- 新增 `formatTuiRuntimeStatusLine(...)`，基于 `formatTuiRuntimeSummary(...)` 生成 TUI 运行时状态行。
- 状态行按显示宽度截断，中文字符按双宽处理，窄终端下用 `…` 收尾。
- `startTui` 的 header 改为使用状态行格式化函数，避免 workspace 或 OpenViking 状态过长时撑宽。
- smoke 在 36 列窄宽度下覆盖中文 workspace 路径，确保格式化结果显示宽度不超过终端宽度。

边界：

- 这仍不是 PTY 截图测试。
- 真实 Ink 多行输入、权限弹窗、工具进度和 ResumePicker 仍按二阶段计划后续拆分。

## 2026-05-26：修正 Append 分块过小策略

用户复测同一个单 HTML 落地页需求后反馈：8 次工具调用全部用完，文件仍未写完；deepseek-v4-pro 本身输出能力很大，不应该每次只写很小一段。

日志确认：

- 本次已经路由到 main。
- 没有再发生 `tool.arguments_truncated`。
- `Skill` 用掉第 0 轮，后续 7 次 `Append` 都成功。
- 但每次 `Append` 参数只有约 600-1500 字符，导致普通落地页被拆得过碎，最终触发 `tool.max_rounds_reached`。
- 当前用户配置里的 `models.main.maxTokens` 是 4096，不是服务端可能支持的更大输出上限。

判断：

- 上一次为了避免截断，把 `Append` 写成“每块 4000 字符以内”，这是过度保守。
- 正确策略不是“长文件一律小块 Append”，而是“能一次合法写完就 Write；确实超预算或发生截断时才 Append，并尽量大块写入”。

修正：

- 文件工具说明改为：普通单文件落地页应尽量 1-3 次工具调用写完，不按 section 拆成很多小块。
- QueryEngine 截断恢复提示改为要求 `Append` 写完整合法的大块，避免退化成极小块。
- README 明确：服务端最大输出不等于 neo 当前请求 `maxTokens`；新增 `NEO_AGENT_MAIN_MAX_TOKENS`、`NEO_AGENT_SMALL_MAX_TOKENS`、`NEO_AGENT_VISION_MAX_TOKENS` 运行时覆盖。
- capability 快照补上 `Append`，避免能力报告遗漏。

## 2026-05-26：同步三类模型输出上限配置

用户补充：`deepseek-v4-flash` 的最高输出同样是 384K，`mimo-v2.5` 是 131K。

修正：

- 默认配置中 `deepseek-v4-pro` 和 `deepseek-v4-flash` 的 `maxTokens` 调整为 393216。
- 默认配置中 `mimo-v2.5` 的 `maxTokens` 调整为 131072。
- 保留 `NEO_AGENT_MAIN_MAX_TOKENS`、`NEO_AGENT_SMALL_MAX_TOKENS`、`NEO_AGENT_VISION_MAX_TOKENS` 运行时覆盖。
- README 明确已有用户配置可能仍保留旧值，需要用 `neo config set` 更新。
- smoke 覆盖默认配置和三个环境变量覆盖。

## 2026-05-26：按 OpenViking 官方 GitHub 文档补本地服务提示

用户纠正：OpenViking 走本地服务，官方 GitHub 文档有详细的本地安装部署教程；之前只记录“本机没装所以阻塞”不够。

参考官方 GitHub 文档：

- `docs/en/getting-started/02-quickstart.md`
- `docs/en/getting-started/03-quickstart-server.md`
- `docs/en/guides/06-mcp-integration.md`

关键信息：

- 本地安装：`pip install openviking --upgrade --force-reinstall`
- 首次配置：`openviking-server init`
- 启动前检查：`openviking-server doctor`
- 启动服务：`openviking-server`
- 验证服务：`curl http://localhost:1933/health`
- `/mcp` 是 `openviking-server` 同一进程同一端口暴露的 HTTP MCP endpoint；localhost 开发模式不需要额外 API key。

修正：

- `OpenVikingMemory.health()` 离线提示中加入官方本地服务流程。
- `neo doctor` 的 OpenViking 检查改为优先探测 `/health`，服务可用后再探测 `/mcp` 的 `health` tool。
- README 和二阶段计划同步说明本地服务安装部署流程。

## 2026-05-26：OpenViking 本地服务真实部署和 neo 联调

按用户要求在 Ubuntu server 上完成 OpenViking server 本地部署，并配置为 systemd user service 随系统启动。

部署结果：

- 使用 `uv tool install openviking --upgrade` 安装 OpenViking 0.3.20。
- OpenViking 配置文件：`/home/eason/.openviking/ov.conf`。
- Embedding 使用 SiliconFlow OpenAI-compatible endpoint：
  - model：`Qwen/Qwen3-Embedding-8B`
  - dimension：4096
- VLM 使用 neo 现有视觉模型配置：
  - model：`mimo-v2.5`
  - apiBase：`https://token-plan-cn.xiaomimimo.com/v1`
- `openviking-server doctor` 全部通过。
- 创建并启用 systemd user service：`/home/eason/.config/systemd/user/openviking.service`。
- `systemctl --user is-enabled openviking.service` 输出 `enabled`。
- `systemctl --user is-active openviking.service` 输出 `active`。
- `loginctl enable-linger eason` 成功，`Linger=yes`，服务可在用户未登录时随系统启动。

联调发现和修正：

- OpenViking `/mcp` 使用 Streamable HTTP MCP，要求 `Accept: application/json, text/event-stream`。
- `/mcp` 工具调用不能直接裸 `tools/call`，需要先 `initialize`，保存 `mcp-session-id`，发送 `notifications/initialized`，再调用工具。
- 实际 OpenViking 0.3.20 暴露的写入工具是 `remember`，不是二阶段计划中假设的 `store`。
- 已修正 `OpenVikingMemory` 和 `neo doctor` 的 MCP 调用流程。

验证：

```bash
openviking-server doctor
curl http://127.0.0.1:1933/health
node dist/index.js openviking doctor
node dist/index.js openviking sync-pending
node dist/index.js doctor
npm run typecheck
npm run smoke
```

结果：

- `/health` 返回 healthy。
- `neo openviking doctor` 返回 `ok mode=mcp`。
- 3 条离线 pending 记忆已成功同步。
- neo 通过 OpenViking 真实服务写入测试记忆，并能搜索命中。
- `npm run typecheck` 通过。
- `npm run smoke` 通过。

## 2026-05-26：拆分 REPL 输入和权限确认核心模型

回到二阶段 TUI 里程碑，按计划推进 Ink/React 体验等价的前置拆分。本次只做可复用核心模型，不实现完整 Ink PromptInput 或 PermissionDialog，避免扩大支线。

CC-Source 参考：

- `src/components/PromptInput/*`：输入组件把粘贴、历史、模式和快捷键作为独立交互能力组织。
- `src/components/permissions/*` 与 `src/utils/permissions/*`：权限请求先形成结构化决策/展示模型，再交给 UI 渲染和用户选择。
- `src/hooks/useInputBuffer.ts`、`src/hooks/useTextInput.ts`：输入编辑状态和 UI 渲染分层处理。

neo-agent 的偏离和原因：

- neo 当前仍以 legacy REPL 为主，不直接移植 CC-Source 完整 Ink 输入组件。
- 先把 REPL 中已经稳定的纯逻辑抽出，减少后续 Ink 层对 legacy REPL 私有函数的依赖。

更新：

- 新增 `src/terminal/permissionPrompts.ts`：
  - `buildMcpPermissionPromptInput`
  - `buildFilePermissionPromptInput`
  - `buildExecutionPermissionPromptInput`
  - 继续保留对应 `format*PermissionPrompt` 和 `parse*PermissionAnswer`
- 新增 `src/terminal/inputModel.ts`：
  - 粘贴识别、粘贴文本规范化、长粘贴折叠、占位符展开和历史脱敏过滤。
- `src/terminal/repl.ts` 改为复用上述模块，并继续 re-export 旧函数，保持现有 smoke 和外部引用兼容。

验证：

- smoke 扩展权限确认测试，覆盖结构化 prompt model、执行权限提示和输入粘贴/历史纯逻辑。
- `npm run typecheck` 通过。
- `npm run smoke` 通过。

## 2026-05-26：修复记忆回灌缺少时间戳

用户测试“我们认识多久了？”时，neo 回答“记忆里没有保留时间戳”。实际本地记忆结构和 OpenViking Markdown frontmatter 都有 `createdAt/updatedAt`，问题在回灌给模型的上下文丢了时间信息。

根因：

- `buildSystemPrompt()` 的相关记忆列表只包含 source/category/tags/content，没有把 `createdAt/updatedAt` 写入提示。
- OpenViking `/mcp search` 返回 Markdown 内容时，neo 只去掉 frontmatter，没有从 frontmatter 恢复 `createdAt/updatedAt`，导致命中记录退化为当前解析时间。

修正：

- 相关记忆回灌格式增加 `createdAt=...，updatedAt=...`。
- `OpenVikingMemory` 解析 Markdown frontmatter，恢复 `id/uri/category/tags/pinned/status/createdAt/updatedAt` 中可用字段。

验证：

- smoke 覆盖系统提示中包含命中记忆时间戳。
- smoke 覆盖 OpenViking Markdown frontmatter 恢复 `createdAt/updatedAt`。

## 2026-05-26：修正 `date` 被误判为高风险 Bash

用户测试记忆回溯时，neo 为了查看当前日期执行 `date +%Y-%m-%d`，但权限提示显示风险为 high。直接原因是 Bash 只读低风险白名单没有包含 `date`，未知命令默认高风险时又复用了“可能写入、删除、联网”等危险模式原因，导致提示过于保守且不准确。

收敛边界：

- 本次归属二阶段里程碑二：Shell / Python 执行能力。
- 只把明确只读的 `date` 加入低风险白名单。
- 将“命中危险模式”和“未知命令不在白名单”拆成不同原因。
- 没有扩大到 `env/printenv/id/hostname` 等可能泄露环境或身份信息的命令，避免权限策略发散。

验证：

- smoke 增加 `date +%Y-%m-%d` 自动执行覆盖。

## 2026-05-26：提高默认工具 loop 上限

用户测试复杂任务时发现 8 次工具调用很容易耗尽，要求对照 CC-Source 判断是否过于保守。

CC-Source 对照结论：

- `src/query.ts` 的主 `queryLoop` 是 `while (true)`。
- 只有调用方传入 `maxTurns` 时才会在工具结果回灌后停止。
- 普通主会话默认不固定 8 轮；子 agent 路径可配置，内置 fork subagent 默认 `maxTurns: 200`。

neo-agent 根因：

- 早期 `web.maxToolRounds` 是为 WebSearch/WebFetch tool loop 增加的保护。
- 二阶段后 QueryEngine 已统一承载文件、Bash/Python、Web、MCP、skill 等工具，但仍沿用 `web.maxToolRounds=8` 控制所有工具 loop。
- 这使普通复杂任务、长文件写入和多步排障过早触顶。

修正：

- 默认工具 loop 上限从 8 提高到 64。
- 新增通用环境变量 `NEO_AGENT_MAX_TOOL_ROUNDS`。
- 旧 `NEO_AGENT_WEB_MAX_TOOL_ROUNDS` 继续兼容。
- 仍保留 `web.maxToolRounds` 配置项，避免本次支线扩大到配置 schema 迁移。

收敛边界：

- 本次只修正默认轮次过低和命名说明不准确。
- 没有引入 CC-Source 的无限主循环、完整 `maxTurns` CLI、task budget 或自动继续机制；这些需要后续结合 TUI 状态和预算 UI 单独设计。

验证：

- smoke 覆盖默认 `maxToolRounds: 64`。
- smoke 覆盖 `NEO_AGENT_MAX_TOOL_ROUNDS` 运行时覆盖。

## 2026-05-26：区分 OpenViking 记忆 MCP 和外部 MCP 工具

用户测试时看到启动状态 `openviking=mcp`，随后执行 `/mcp` 却显示“没有已连接的 MCP 工具”，容易理解成前后矛盾。

根因：

- OpenViking 的 `/mcp` 是 `OpenVikingMemory` 作为记忆后端直接调用的本地服务接口。
- `/mcp` REPL 命令列出的是 `McpManager` 管理的外部 MCP server/tools。
- OpenViking 记忆连接没有注册进通用 MCP 工具列表，因此不会出现在 `/mcp` 输出中。

修正：

- TUI/启动状态从 `openviking=mcp` 改为 `memory=openviking:mcp`，明确它属于记忆后端。
- `/mcp` 命令文案改为“外部 MCP 工具”。
- 当外部 MCP 工具为空且记忆后端不是 local 时，提示 OpenViking `/mcp` 是记忆后端连接，应使用 `neo openviking doctor` 查看。

收敛边界：

- 本次只修正文案和状态含义，不把 OpenViking 记忆工具注册进 `McpManager`。
- 这样避免把记忆内部读写工具暴露成通用模型工具，保持当前 OpenViking 主存储边界。
