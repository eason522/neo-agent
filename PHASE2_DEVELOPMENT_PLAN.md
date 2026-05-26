# neo-agent 二阶段开发计划

创建时间：2026-05-26

本文档记录二阶段的目标、范围、交付状态和后续收口项。详细实施流水和验证记录见 [PHASE2_DEVELOPMENT_LOG.md](./PHASE2_DEVELOPMENT_LOG.md)。

## 与总开发计划的关系

二阶段计划不是独立替代总开发计划。任何二阶段开发开始前，都必须先回顾 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) 中的最高原则和当前基线，再回到本文档选择二阶段任务。

执行顺序固定为：

1. 先读总开发计划的“最高原则”。
2. 再读本文档的二阶段目标、里程碑和待收口项。
3. 如果二阶段计划和总开发计划冲突，以总开发计划的最高原则为准。
4. 如果任务涉及 CC-Source 已有能力，必须先查 CC-Source 的对应或相近实现，再决定 neo-agent 的实现方式。
5. 如果发现二阶段计划缺少原则、边界或风险说明，先补文档，再继续实现。

因此，在当前阶段开发时，不能只关注二阶段计划；必须同时遵守总开发计划。

## 二阶段继承的最高原则

以下原则从总开发计划继承，二阶段同样适用：

- neo-agent 是基于 CC-Source 的个人化二次开发，不是从零另造 agent harness。
- 新功能、bug 修复和体验调整必须先查 CC-Source 的对应或相近实现。
- 不用硬编码补单点 case。先判断问题属于单个 bug、同类缺陷，还是架构能力缺口。
- 可以做“青出于蓝”的改进，但必须写清参考模块、偏离原因、收益、风险和验证方式。
- 长期影响模型行为的变更，例如 skill、记忆、权限、hook、MCP 持久授权，必须让用户确认。
- 处理用户反馈和开发中发现的问题时，必须控制修正范围，不能无限发散成新的支线；非阻塞问题记录到后续待办，不回填当前修正。
- 二阶段文档只记录二阶段执行计划和日志；全局原则、长期边界和跨阶段取舍仍以总开发计划为准。

## 二阶段反馈修正收敛规则

二阶段尤其容易因为 workspace、执行工具、OpenViking、TUI 等能力相互牵连而发散。后续处理反馈时固定遵守：

- 先写清当前反馈直接指向哪个二阶段里程碑。
- 本次修正只处理该反馈的直接问题和阻塞验证的问题。
- 如果发现其它里程碑的问题，只记录到本文档对应“待收口”或 [PHASE2_DEVELOPMENT_LOG.md](./PHASE2_DEVELOPMENT_LOG.md)，不顺手实现。
- 如果问题涉及安全、权限、数据丢失或会导致现有 smoke 失败，可以并入当前修正，但必须在日志里说明原因。
- 修正完成后先跑对应验证；验证通过后结束当前支线。
- 不因为修正中发现了更多可改进点，就继续扩大二阶段范围。

## 二阶段目标

二阶段目标是把 neo-agent 从“可运行的个人终端 agent MVP”推进到“可长期使用、可写文件、可执行命令、可恢复记忆、终端体验可继续演进”的状态。

核心方向：

- workspace 具备完整文件管理能力，而不是只支持 `Write/Edit`。
- shell/python 成为显式工具能力，并纳入权限系统。
- OpenViking 从检索回退升级为主记忆存储，本地 JSON 作为备份和离线恢复。
- 终端体验开始引入 Ink/React 层，同时保留 legacy REPL 回退。
- 修复长文件生成被 small 模型截断导致坏工具调用的问题。

## 里程碑一：Workspace 完全操作与可靠文件生成

状态：已完成第一版。

已交付：

- 新增 CLI：`neo workspace show/set/reset`。
- 新增 REPL：`/workspace`。
- 文件工具扩展：`List`、`Mkdir`、`Copy`、`Move`、`Delete`。
- `Delete` 默认移动到 `workspace/.neo-trash/`。
- `Delete permanent=true` 需要交互确认；没有确认回调时拒绝。
- `Write` 在 workspace 内会自动创建父目录。
- workspace 内文件管理免确认；项目根目录和额外写入目录仍走确认。
- 文件工具 prompt 已要求长 HTML/CSS/JS/落地页/完整单文件优先写入 `workspace/<name>`。
- 路由器已把 HTML/CSS/JS、落地页、单文件、写入文件等任务强制走 main 模型。
- 新增 `Append` 文件工具，用于内容超出当前输出预算或工具参数已截断后的长文件分块写入：第一块 `mode=create`，后续块 `mode=append`。
- 文件生成策略已调整为：能一次合法写完时优先 `Write`；必须分块时 `Append` 尽量大块写入，普通单文件落地页目标 1-3 次工具调用完成。
- 默认输出上限已按当前模型能力同步：`deepseek-v4-pro`/`deepseek-v4-flash` 为 393216，`mimo-v2.5` 为 131072；已有用户配置需用 `neo config set` 更新。
- QueryEngine 遇到 `finish_reason=length` 且工具参数 JSON 不完整时，不执行坏工具调用，而是强制回灌 `Append` 分块恢复提示。
- 工具轮次耗尽且长文件没有成功落盘时，最终提示禁止输出长代码兜底，避免返回被截断的不完整 HTML/CSS/JS。
- 对照 CC-Source 后，工具 loop 默认上限从 8 提高到 64；`NEO_AGENT_MAX_TOOL_ROUNDS` 为新的通用覆盖变量，旧 `NEO_AGENT_WEB_MAX_TOOL_ROUNDS` 继续兼容。

待收口：

- [x] 为新增 `List/Mkdir/Copy/Move/Delete` 增加更细的独立 smoke 覆盖。
- [x] README 中的文件工具章节需要同步补充完整文件管理能力。
- [x] 修复长落地页生成中 `Write` 参数反复被 length 截断、最后刷出不完整代码的问题。
- [x] 修正 `Append` 分块过小导致 8 轮工具调用仍写不完普通落地页的问题。
- [x] 同步 main/small/vision 三类模型的默认 `maxTokens` 和覆盖说明。

## 里程碑二：Shell / Python 执行能力

状态：已完成第一版。

已交付：

- 新增 `Bash` 工具：`command`、`timeoutMs`、`description`、`cwd`。
- 新增 `Python` 工具：`code`、`args`、`timeoutMs`、`description`。
- 默认执行目录为 workspace。
- `cwd` 必须位于 workspace 内。
- 只读低风险 Bash 自动允许：`pwd/ls/find/rg/grep/cat/head/tail/wc/stat/file/du/tree/date`。
- 高风险 Bash 需要确认：写入、删除、安装、网络、git mutation、权限变更、后台进程、环境变量导出、shell 组合和重定向等。
- 未知 Bash 命令默认需要确认，提示原因应明确为“不在只读低风险白名单内”，不能误导成已经命中写入/联网等危险模式。
- Python 默认每次确认。
- 执行结果包含退出码、stdout/stderr、超时状态、耗时和 cwd。
- stdout/stderr 有截断保护。
- 能力快照和任务评估已改为报告 Bash/Python 的真实能力和确认限制。

待收口：

- [x] 增加针对 Bash 低风险自动执行、高风险确认拒绝、Python 确认拒绝、cwd 越界拒绝的 smoke。
- 后续可考虑会话级临时授权，但二阶段第一版不做。

## 里程碑三：OpenViking 主记忆存储

状态：已完成第一版，但依赖本地 OpenViking 服务实际联调。

已交付：

- `OpenVikingMemory` 从检索回退改为主存储客户端。
- 首选调用 OpenViking `/mcp`：`health/search/list/remember/forget`。
- `/mcp` 不可用时仍兼容旧 HTTP `/search` 读取。
- 写入不可用时进入本地 pending queue：`~/.neo-agent/memory/openviking-pending.json`。
- 本地 JSON 继续作为备份和离线读取回退。
- 记忆 URI 固定映射：
  - `preference` -> `viking://user/default/memories/preferences/`
  - `project_fact` -> `viking://user/default/memories/project_facts/`
  - `workflow` -> `viking://user/default/memories/workflows/`
  - `session_summary` -> `viking://agent/neo-agent/memories/session_summaries/`
- 每条记忆写为 Markdown + YAML frontmatter。
- `remember/update/delete/dream apply` 继续写本地备份，并尝试同步 OpenViking。
- 新增 CLI：
  - `neo openviking doctor`
  - `neo openviking import-local --dry-run|--apply`
  - `neo openviking sync-pending`

当前验证结果：

- 当前机器上 `http://localhost:1933` 未运行，`neo openviking doctor` 正确报告 OpenViking 离线，pending 为 0。
- `neo doctor` / `neo openviking doctor` 已按 OpenViking 官方 GitHub 文档提示本地服务部署流程：`pip install openviking --upgrade --force-reinstall`、`openviking-server init`、`openviking-server doctor`、`openviking-server`、`curl http://localhost:1933/health`。
- 当前 Ubuntu server 已真实部署 OpenViking 0.3.20：Embedding 使用 SiliconFlow `Qwen/Qwen3-Embedding-8B`，VLM 使用 neo 现有 `mimo-v2.5`；`openviking-server doctor`、`neo openviking doctor` 和真实写入/搜索联调均通过。
- OpenViking 已配置为 systemd user service：`openviking.service` enabled/active，且 `loginctl enable-linger eason` 已开启，可随系统启动。

待收口：

- [x] 用真实 `openviking-server` 做 `/mcp` 联调。
- [x] 用 mock `/mcp` 增加 health/remember/search/list/forget 自动化测试。
- [x] 明确 OpenViking `/mcp` 返回结构后，收紧解析逻辑。
- 后续如切换 OpenViking 版本，需要复核 `/mcp` Streamable HTTP 会话和工具 schema 是否变化。

## 收口专项：记忆和梦境

状态：已完成第一版。

当前现状：

- 当前已有 `DreamService`、`neo dream` 和 `/dream`，可以整理近期 transcript 和记忆，生成报告，并通过 dry-run/apply 写入长期记忆。
- 当前 dreaming 已有报告目录、状态文件、锁、定时门控和记忆复查能力。
- 已补 deep dream / nap 分层、短期记忆层、运行时空闲 nap、用户级 cron 安装入口和 `SOUL.md` 受控区块自动维护。

目标设计：

- deep dreaming：作为深度梦境，每天中午 12:00 由 Ubuntu 用户级 cron 触发。首次运行时对所有记忆做全量深度分析、精炼和 baseline；之后根据 state 中的 memory/session watermark 做增量分析和精炼。
- nap：作为浅睡眠，放在 neo 运行时。当交互式运行空闲超过 2 小时，自动分析最近 1-2 天 transcript、近期短期上下文和少量相关长期记忆，粗略总结并写入短期记忆。
- deep dreaming 需要分析和精炼短期记忆，把真正有长期价值的内容晋升为长期记忆，把过期或低价值短期记忆归档。
- deep dreaming 的关注重点包括但不限于：用户近期一直关注的事情、一直没有想通的问题、反复卡住的项目、生活中的伤心难过或重大变故、特别高兴的事情、反复出现的偏好和协作模式。
- deep dreaming 可以对有趣、有价值、有意义的记忆做更自由的联想、整合和关联探索，产出可能带来意外启发的 insights；不确定内容必须标明为灵感或假设，不能伪装成事实。
- deep dreaming 可以自动维护 `SOUL.md`，但只能写入受控区块 `<!-- neo:dreaming:start --> ... <!-- neo:dreaming:end -->`，不能重写原有人格核心。

记忆分层：

- 长期记忆：稳定、少量、权重高。用于人格默契、长期偏好、长期项目背景、反复出现的问题、重要关系认知和长期有价值的灵感。
- 短期记忆：新鲜、任务相关、可过期。用于最近 1-2 天正在推进的事情、刚整理出的 nap 摘要、临时卡点和待观察事项。
- `MemoryRecord` 需要增加 `tier: "long_term" | "short_term"` 和可选 `expiresAt`。旧记忆缺少 `tier` 时按 `long_term` 处理。
- nap 默认写入 `short_term`，短期记忆默认 14 天过期。
- deep dreaming 默认写入 `long_term`，并可将短期记忆晋升为长期记忆。
- OpenViking Markdown frontmatter 需要同步写入和读取 `tier`、`expiresAt`。

记忆注入策略：分层平衡

- neo 不应把全部记忆直接塞进聊天上下文。每轮对话前，先根据用户输入检索相关记忆，再按长期/短期分层注入 prompt。
- 注入时分两个 prompt 区块：`# 长期记忆` 和 `# 短期记忆`，让模型知道哪些是稳定事实，哪些只是近期上下文。
- 检索时不是简单混排：先查长期和短期，再按“相关度 + 新鲜度 + pinned + tier 权重”合并。
- 默认预算为长期 4 条、短期 4 条，总上限 8 条；如果短期无关，就把额度让给长期，反之亦然。
- 短期记忆带 `expiresAt`，过期后不再默认注入。
- 关键原则：短期记忆不能直接污染 neo 的长期人格和判断；长期记忆也不能让 neo 忽略最近两天正在发生的上下文。分层注入用来同时保留稳定默契和近期连续性。

后续记忆召回：二段式回忆展开

- 当前第一版记忆召回是一次检索：用户输入命中若干 `MemoryRecord` 后，直接把命中的记忆内容注入 prompt。
- 后续需要增加 recall expansion：当用户提到某个久远长期记忆，或检索命中的是高相关但较短、较模糊的长期记忆时，neo 应把它当作“记忆碎片”，再沿着线索继续回忆更完整的上下文。
- 第二阶段回忆展开可以根据 `id`、`uri`、`tags`、`metadata.sourceTranscript`、`metadata.reportId`、未来的 `relatedMemoryIds` 等线索，继续拉取关联记忆、源 transcript 摘要、dream report、insights 和当时的归档/晋升理由。
- 展开后的内容不应直接混入长期/短期记忆区块，而应单独注入 `# 回忆展开`，明确这是从命中记忆延伸出来的补充上下文。
- 回忆展开必须有预算限制和触发条件，避免每次普通检索都回看大量旧 transcript 或 dream report。
- 目标效果是模拟人类“先想起一个模糊线索，再顺着线索慢慢想起更完整内容”的记忆过程。

接口计划：

- `neo dream --mode deep|nap --dry-run --force --scheduled`
- `/dream` 默认执行 deep dreaming。
- `/dream nap` 手动执行 nap。
- `neo dream install-cron --time 12:00 --dry-run` 用于预览或安装用户级 crontab，幂等维护 neo-agent deep dream 标记块。
- `NEO_AGENT_DREAM_ENABLED=1` 控制 deep scheduled gate。
- `NEO_AGENT_DREAM_TIME=12:00` 作为 cron 生成默认时间。
- `NEO_AGENT_NAP_ENABLED=1` 默认开启运行时 nap。
- `NEO_AGENT_NAP_IDLE_MINUTES=120`
- `NEO_AGENT_NAP_LOOKBACK_HOURS=48`

待收口：

- [x] 扩展 `DreamService` 为 deep dream / nap 两种模式，并保留现有 `run()` 兼容入口。
- [x] 增加短期记忆字段、过期过滤、OpenViking frontmatter 同步和本地 JSON 兼容读取。
- [x] 改造 `memory.search()` 和 system prompt，使长期记忆与短期记忆按分层平衡策略注入上下文。
- [x] 实现运行时空闲 2 小时自动 nap。
- [x] 实现 `neo dream install-cron`，默认生成用户级 crontab 12:00 deep dreaming。
- [x] 实现 deep dreaming 对 `SOUL.md` 受控区块的自动维护和报告审计。
- [x] 增加 smoke 覆盖 deep 首次 baseline、nap 短期记忆、短期过期过滤、SOUL 受控区块写入、cron dry-run 和分层 prompt 注入。
- [x] 后续继续强化 deep 增量策略和短期记忆晋升/归档的更细粒度自动化断言。
- [x] 设计并实现二段式 recall expansion 第一版：久远、模糊或高相关但信息不足的长期记忆命中后，沿 source transcript、dream report 和关联记忆继续展开，并以 `# 回忆展开` 注入上下文。

## 里程碑四：Ink TUI 体验等价重建

状态：已完成入口层第一版，完整体验等价尚未完成。

已交付：

- 新增 `src/tui/startTui.ts`。
- 新增依赖：`ink`、`react`、`@types/react`。
- `neo chat` 默认进入 TUI wrapper。
- `neo chat --legacy` 保留 legacy readline REPL。
- `NEO_AGENT_LEGACY_REPL=1` 可强制回退 legacy REPL。
- 非交互 stdin 会自动绕过 Ink，直接使用 legacy REPL，避免破坏脚本和 smoke。

当前边界：

- 当前 TUI 是入口壳层，展示模型、workspace、OpenViking 状态后交给现有 REPL。
- 还没有完整实现消息流、PromptInput、StatusLine、PermissionDialog、ResumePicker、ToolProgress 和 DebugPanel 的 Ink 组件。

待收口：

- [x] 拆分 TUI 运行时状态和回合摘要模型第一版，使 Ink 层不直接依赖 legacy REPL 私有状态。
- [x] 拆分现有 REPL 输入粘贴/历史纯逻辑和权限确认模型第一版，使 Ink PromptInput/PermissionDialog 能复用核心交互数据结构。
- [x] 增加 TUI 默认入口的非交互 stdin 回退文本回归，防止 TUI header 截断脚本输入。
- [x] 增加 TUI 状态行窄终端文本回归，覆盖中文宽度截断。
- [x] 增加 PTY 文本回归，覆盖真实 Ink 交互下的宽窄终端渲染。
- 分步实现消息流、PromptInput、StatusLine、PermissionDialog、ToolProgress、ResumePicker 和 DebugPanel。

## 全局验证

已通过：

```bash
npm run typecheck
npm run build
npm run smoke
```

手动验证：

- `neo workspace show` 可显示真实 workspace 路径、trash、读写状态。
- `neo openviking doctor` 在本机 OpenViking 未启动时正确报告离线。
- 文件工具手动验证：`Write` 创建文件、`List` 看到文件、`Delete` 移动到 `.neo-trash`。
- `Bash pwd` 可在 workspace 内执行并返回退出码 0。

## 当前风险

- OpenViking `/mcp` 协议仍需真实服务联调；当前实现偏兼容和防失败。
- Ink TUI 目前只是入口层，不应宣称已达到 CC-Source 体验等价。
- 新增文件工具、执行工具和 OpenViking mock 已有二阶段专项 smoke 保护。
- README 已同步二阶段新增命令和能力。

## 下一步建议

优先级从高到低：

1. 用真实 OpenViking 服务联调 `/mcp`。
2. 继续拆分 legacy REPL 输入和权限确认流程，为 Ink PromptInput/PermissionDialog 做准备。
3. 增加 TUI PTY 文本回归，覆盖非交互回退、宽窄终端和中文宽度。
