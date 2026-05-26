# neo-agent 开发计划

最后整理：2026-05-26

本文档只保留当前开发主线、优先级和恢复检查清单。历史决策、长篇复盘和已完成流水账移入 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md)。二阶段专项计划见 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)，二阶段实施流水见 [PHASE2_DEVELOPMENT_LOG.md](./PHASE2_DEVELOPMENT_LOG.md)。日常开发先读本文档；需要追溯背景时再查历史日志。

## 最高原则

neo-agent 是基于 CC-Source 的个人化二次开发，不是从零另造 agent harness。

- 新功能、bug 修复和体验调整必须先查 CC-Source 的对应或相近实现。
- 不用硬编码补单点 case。先判断问题属于单个 bug、同类缺陷，还是架构能力缺口。
- 可以做“青出于蓝”的改进，但必须写清参考模块、偏离原因、收益、风险和验证方式。
- 长期影响模型行为的变更，例如 skill、记忆、权限、hook、MCP 持久授权，必须让用户确认。
- 处理用户反馈和开发中发现的问题时，必须控制修正范围，不能无限发散成新的支线。先修正当前反馈直接指向的问题；发现的相邻问题只在阻塞当前目标或存在明显安全/数据风险时一并处理，其它问题记录到计划、日志或待办，不回填当前支线。
- `DEVELOPMENT_PLAN.md` 只放可执行计划。详细背景写入 `DEVELOPMENT_LOG.md`，避免主线再次失控。

## 反馈修正收敛规则

用户反馈、测试失败和开发中发现的问题，都按以下规则处理：

- 先明确当前反馈的直接目标和完成条件。
- 只修正完成该目标必须处理的问题。
- 如果发现相邻问题，先判断它是否阻塞当前目标、会破坏验证、或存在安全/数据风险。
- 只有阻塞当前目标或高风险的问题可以并入本次修正。
- 非阻塞体验改进、架构想法、可选增强和新能力，必须写入开发计划、开发日志或后续待办，不能让当前修正无限扩展。
- 每次修正结束时，要说明哪些问题已处理，哪些问题只是记录下来。
- 如果连续发现多个新问题，优先收束当前支线，通过验证后再决定是否开启新的明确任务。

## 当前基线

代码状态：

- 分支：`main`
- 远端：开发前检查为 `main...origin/main`
- 最近提交：以 `git log -1 --oneline` 为准，避免计划文档因每次提交反复产生无意义 churn。
- 校验：2026-05-26 已运行 `npm run typecheck` 和 `npm run smoke` 通过
- 二阶段第一版已落地：workspace 完整文件管理、Bash/Python 工具、OpenViking 主存储、TUI 入口层和长工具调用截断恢复。详见 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)。

产品状态：

- neo-agent 已是可运行的个人终端 agent MVP。
- 已有 CLI/REPL、DeepSeek/MiMo 路由、记忆、dreaming、skill、MCP、sub-agent、Web、文件工具、transcript/resume、usage、能力快照、任务评估、流式输出、workspace、发布自检。
- M1/M3/M4/P1/P2 的第一阶段已经基本收口。当前不应继续横向扩功能，主线应回到“稳定、权限、可恢复、体验一致性”。

## 主线判断

当前最重要的问题不是再加新能力，而是把已有能力变成可长期使用、可恢复、可调试、边界清楚的个人 agent。

近期主线固定为：

1. **权限与文件能力收口**：统一文件/MCP/Web/写入权限模型，避免能力越来越多但边界不一致。
2. **上下文与工具结果可恢复**：继续补 transcript pairing、历史消息预算、超大结果恢复和手动 compact。
3. **终端体验对齐 CC-Source**：优先补消息渲染、状态行信息、调试视图和权限确认 UI，不急着复制完整 Ink TUI。
4. **诊断与日志可运维**：doctor、debug、错误码、隐私分级和 usage/retry 统计需要成为排障入口。
5. **记忆/OpenViking 收口**：OpenViking 写入链路要等本地服务 API 确认后再做，不再凭猜测开发。

## 收口规则

P1 从现在开始冻结，不再因为完成一项又追加新的 P1 功能项。

- 当前唯一未完成 P1 是 **M5 终端体验回归复查**，它是收口闸门，不是新功能入口。
- 回归中发现的阻塞问题只允许作为该收口项的子修复处理；修完后仍关闭同一个收口项。
- 回归中发现的非阻塞体验改进、架构想法和新增能力，统一写入 P2、未决问题或 `DEVELOPMENT_LOG.md`，不回填 P1。
- P1 关闭标准：`npm run typecheck`、`npm run smoke`、关键 REPL 路径回归通过，并且没有影响日常使用的阻塞问题。
- P1 当前状态：已完成收口回归；后续不再追加 P1 功能项。
- P1 关闭后，近期只允许进入“稳定修 bug / 用户明确要求 / P2 单项升级”三类工作。

## 当前优先级

### P0：下一阶段主线

- [x] 设计统一权限模型第一阶段。
  - 范围：文件读写、workspace、额外目录、MCP 高风险工具、Web 域名策略、未来 hook。
  - CC-Source 参考：filesystem permissions、permission rules、MCP permission、Web preflight、permission UI。
  - 已交付：新增 `src/permissions/permissions.ts`，统一 `allow|ask|deny` decision、规则匹配、文件写入、MCP、Web hostname 判定；文件/MCP/Web 已接入但保持原有默认行为。
  - 后续：REPL 确认 UI、配置/会话级授权、项目级 MCP 审批继续放入 P1/P0 后续小步。

- [x] 补 QueryEngine 历史消息级预算和可恢复 tool result 策略。
  - 范围：tool result pairing、persisted tool result、resume 后恢复、aggregate budget。
  - CC-Source 参考：`query.ts`、`StreamingToolExecutor`、tool result storage、session storage。
  - 已交付：单个大工具结果继续落盘；同一 tool loop 内累计 tool result 超过预算时，会将较早结果替换为可读取的落盘引用；`toolPairs` 记录历史预算产生的 `persistedPath/originalResultChars`；resume snapshot 会恢复历史持久化路径引用。

- [x] 补 doctor 深度诊断。
  - 范围：上下文体积、MCP 连接、skill 状态、配置权限、版本/更新、路径可写性、workspace、Web key/robots 配置。
  - CC-Source 参考：Doctor/context warning/config diagnostics。
  - 已交付：`neo doctor` 新增版本/ripgrep、上下文预算、workspace、额外文件范围、tool result 目录、skill 根目录、配置文件权限等诊断；保留模型、日志、transcript、SOUL、OpenViking、Web 和 MCP 检查。

### P1：稳定性和体验（已收口）

- [x] 日志系统补 debug 开关、结构化错误码、usage/retry 统计和隐私分级。
  - 已交付：`--debug`/REPL `/debug on` 可把运行期日志提升到 debug；日志记录增加 `privacy` 标记、No-PII diagnostic 写入、结构化 `errorCode`；模型 retry/success 和 usage 记录补 `retryCount`。
- [x] 文件工具补图片/PDF/二进制处理、读取预算和更清晰的拒绝原因。
  - 已交付：Read 增加图片/PDF 元数据摘要、普通二进制拒绝、文本读取预算说明、分页提示和更清晰的路径越界/缺失错误；文件工具 prompt 已同步说明限制。
- [x] MCP 补项目级 server 审批、权限建议和更完整权限 UI。
  - 已交付：项目 `.mcp.json` 中的 server 默认只列出不加载；审批状态保存在用户配置的 `mcp.projectApprovals`，按项目绝对路径绑定，避免仓库配置自我授权；新增 `neo mcp approve/unapprove`；`neo mcp list/add` 会展示 pending/approved 和启用建议；MCP 权限拒绝原因和 REPL 确认提示补持久允许命令。
- [x] Web 工具补更完整站点限制策略、重定向/下载预检和更细粒度进度。
  - 已交付：URL 策略补 2000 字符长度限制、用户名/密码拒绝、单标签非公开主机拒绝；WebFetch/Tavily extract/map/crawl 前新增 HEAD 预检，阻止跨域或降级重定向，允许同域/www 重定向，拒绝超大 `content-length`，对二进制内容、401/403 和异常状态写入 warning；Web prompt 和 map/extract/crawl 输出同步预检提示。
- [x] REPL 补更丰富消息渲染、记忆命中数、路由原因和更接近 CC-Source 的状态行。
  - 已交付：`NeoAgent.ask` 新增状态事件回调，覆盖 context/routing/model/compact/done 阶段；REPL 运行时输出上下文、路由和模型阶段；每轮 status/debug  now 包含路由原因、记忆命中数、匹配 skill 数、vision/web context、工具事件和状态事件。
- [x] 增加手动 `/compact`，并让 compact/resume 的状态在 REPL 中可见。
  - 已交付：`ConversationHistory.compact()` 支持强制手动压缩和自定义要求；`NeoAgent.compactConversation()` 上报 compact 状态并写入 transcript boundary；REPL 新增 `/compact [说明]`、`/status` history 摘要和 `/resume` compact boundary 提示。
- [x] REPL 富消息渲染第一阶段。
  - 范围：在不引入完整 Ink TUI 的前提下，改善 assistant/tool/status/compact 输出分组、折叠长内容、错误提示和 transcript 路径展示。
  - CC-Source 参考：message rendering、tool result UI、progress display、resume/compact message boundary。
  - 已交付：新增轻量 `terminal/rendering` helpers；assistant 多行响应改为分组缩进；stream header 单独成行；tool/status/debug 事件统一摘要截断；长错误会截断并提示日志路径。
- [x] REPL 权限确认 UI 一致化。
  - 范围：把 MCP 和文件写入确认提示整理成统一样式，明确一次允许/持久允许/拒绝选项、风险摘要和对应持久化命令。
  - CC-Source 参考：permission request UI、filesystem permission rules、MCP permission prompt。
  - 已交付：新增统一 `formatPermissionPrompt` 文本渲染；MCP 权限确认展示工具来源、原因、风险、参数字段、一次/持久允许和一次/持久拒绝；文件写入确认使用相同边界并明确当前仅支持本次确认，长期授权走 workspace/额外写入目录配置。
- [x] M5 终端体验回归复查（P1 收口闸门）。
  - 范围：围绕状态流、富消息渲染、compact/resume、权限确认、图片预分析和工具事件跑一轮 REPL 回归，清理影响长期使用的小缺口。
  - CC-Source 参考：message rendering、StatusLine、PermissionRequest、ResumeConversation、tool progress UI。
  - 收口约束：只修复回归中发现的阻塞或明显错乱问题；非阻塞改进不新增 P1 项。
  - 已交付：新增 M5 终端体验收口 smoke，覆盖 assistant 分组、状态行、状态事件、工具事件、debug 行、长错误和 compact reason；修复状态行长 `routerReason` 未截断导致终端撑宽的问题。

### P2：暂缓，除非用户明确要求

- [ ] OpenViking 写入链路：等待本地 OpenViking 稳定 API 确认。
- [ ] 完整 TUI/Ink 化：等权限 UI 和消息渲染第一阶段稳定后再评估。
- [ ] 完整插件生态、hook 执行器、远程 marketplace：权限模型成熟前不推进。
- [ ] 真正可恢复的后台 sub-agent：等任务系统和 transcript 恢复进一步稳定后再做。

## 暂停/归档事项

以下事项不是取消，而是暂时不作为近期主线：

- 继续扩展 marketplace。
- 继续增加新 slash command，除非服务于 P0/P1。
- 做完整插件安装/启用/禁用生态。
- 执行外部 hook、shell hook 或 prompt hook。
- 凭猜测接入 OpenViking 写入 API。
- 复制 CC-Source 完整 TUI，而不是先抽取当前最需要的交互能力。

## 已完成里程碑概览

- **M1：可靠个人 agent 核心**：已完成第一阶段。剩余债务归入 P0/P1。
- **M2：记忆和 dreaming**：本地记忆、dreaming、复查和人工采纳已可用；OpenViking 写入待确认。
- **M3：skill 生命周期**：已完成第一阶段，包括安装、校验、导出、scope、Skill tool、usage、reload、plugin manifest 导入和用户确认建议。
- **M4：工具和 MCP 执行**：已完成第一阶段，包括 Web、MCP、文件工具、ToolSearch、tool loop、超时/取消、结果预算、workspace。
- **M5：终端体验**：P1 已收口。已补输入历史、多行输入、状态行、debug 视图、resume 选择器、粘贴处理、富消息渲染第一阶段、权限确认 UI 第一阶段和收口回归；完整 Ink/TUI 明确放入 P2，不作为 P1 收尾条件。

## 下一次开发启动流程

1. 运行 `git status --short --branch`，确认工作区是否干净。
2. 运行 `npm run typecheck`，必要时再运行 `npm run build` 或 `npm run smoke`。
3. 只从本文档 P0 选择一个任务，不同时推进多个大方向。
4. 开始实现前先读 CC-Source 对应模块，并在 commit/计划中记录参考依据。
5. 实现后更新本文档的任务状态；需要背景说明时写入 `DEVELOPMENT_LOG.md`。
6. 提交前运行 `npm run typecheck` 和 `npm run build`；涉及核心流程时运行 `npm run smoke`。
7. 每次开发完成或修改后，必须创建 git commit 并推送到 GitHub，除非用户明确要求暂不提交。

## 当前建议下一步

建议下一步进入 **稳定修 bug / 用户明确要求 / P2 单项升级** 三类工作之一。

理由：

- P1 已按冻结规则完成收口，不能再追加新的 P1 功能项。
- 之后如果用户反馈 bug，先按“稳定修 bug”处理；如果用户明确要求某个 P2 能力，再单项升级。
- OpenViking 写入、完整 Ink/TUI、插件生态和后台 sub-agent 恢复仍是 P2/未决事项，不主动推进。

建议下一次启动时：

1. 先运行 `git status --short --branch` 和 `npm run typecheck`。
2. 如果没有用户指定任务，优先处理实际测试反馈中的 bug。
3. 需要做 P2 时一次只选一个单项，并继续先参考 CC-Source。

## 未决问题

- OpenViking 的持久化写入应该使用哪个稳定 API？
- 项目级 MCP server 后续是否需要会话级临时审批，还是继续只支持用户配置持久审批？
- 文件系统权限是只做配置级规则，还是增加会话级临时授权？
- Web preflight 是否需要从当前 HEAD 预检升级为可配置的站点策略审计和会话级域名授权？
- 富 TUI 应继续增强 readline，还是引入更接近 CC-Source 的 Ink 层？
