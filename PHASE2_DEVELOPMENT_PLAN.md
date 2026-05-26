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
- 新增 `Append` 文件工具，专门用于长文件分块写入：第一块 `mode=create`，后续块 `mode=append`。
- QueryEngine 遇到 `finish_reason=length` 且工具参数 JSON 不完整时，不执行坏工具调用，而是强制回灌 `Append` 分块恢复提示。
- 工具轮次耗尽且长文件没有成功落盘时，最终提示禁止输出长代码兜底，避免返回被截断的不完整 HTML/CSS/JS。

待收口：

- [x] 为新增 `List/Mkdir/Copy/Move/Delete` 增加更细的独立 smoke 覆盖。
- [x] README 中的文件工具章节需要同步补充完整文件管理能力。
- [x] 修复长落地页生成中 `Write` 参数反复被 length 截断、最后刷出不完整代码的问题。

## 里程碑二：Shell / Python 执行能力

状态：已完成第一版。

已交付：

- 新增 `Bash` 工具：`command`、`timeoutMs`、`description`、`cwd`。
- 新增 `Python` 工具：`code`、`args`、`timeoutMs`、`description`。
- 默认执行目录为 workspace。
- `cwd` 必须位于 workspace 内。
- 只读低风险 Bash 自动允许：`pwd/ls/find/rg/grep/cat/head/tail/wc/stat/file/du/tree`。
- 高风险 Bash 需要确认：写入、删除、安装、网络、git mutation、权限变更、后台进程、环境变量导出、shell 组合和重定向等。
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
- 首选调用 OpenViking `/mcp`：`health/search/list/store/forget`。
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

待收口：

- 用真实 `openviking-server` 做 `/mcp` 联调。
- [x] 用 mock `/mcp` 增加 health/store/search/list/forget 自动化测试。
- 明确 OpenViking `/mcp` 返回结构后，收紧解析逻辑。

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
- 拆分现有 REPL 输入和权限确认流程，使 Ink 层能复用核心交互逻辑。
- [x] 增加 TUI 默认入口的非交互 stdin 回退文本回归，防止 TUI header 截断脚本输入。
- 增加 PTY 截图或文本回归，覆盖宽窄终端和中文宽度。
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
