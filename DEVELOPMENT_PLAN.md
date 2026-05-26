# neo-agent 开发计划

最后整理：2026-05-26

本文档只保留当前开发主线、优先级和恢复检查清单。历史决策、长篇复盘和已完成流水账移入 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md)。日常开发先读本文档；需要追溯背景时再查历史日志。

## 最高原则

neo-agent 是基于 CC-Source 的个人化二次开发，不是从零另造 agent harness。

- 新功能、bug 修复和体验调整必须先查 CC-Source 的对应或相近实现。
- 不用硬编码补单点 case。先判断问题属于单个 bug、同类缺陷，还是架构能力缺口。
- 可以做“青出于蓝”的改进，但必须写清参考模块、偏离原因、收益、风险和验证方式。
- 长期影响模型行为的变更，例如 skill、记忆、权限、hook、MCP 持久授权，必须让用户确认。
- `DEVELOPMENT_PLAN.md` 只放可执行计划。详细背景写入 `DEVELOPMENT_LOG.md`，避免主线再次失控。

## 当前基线

代码状态：

- 分支：`main`
- 远端：整理前检查为 `main...origin/main`，业务代码无未提交变更
- 最近提交：`f27332d feat: budget web download content`
- 校验：2026-05-26 已运行 `npm run typecheck` 通过

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

### P1：稳定性和体验

- [x] 日志系统补 debug 开关、结构化错误码、usage/retry 统计和隐私分级。
  - 已交付：`--debug`/REPL `/debug on` 可把运行期日志提升到 debug；日志记录增加 `privacy` 标记、No-PII diagnostic 写入、结构化 `errorCode`；模型 retry/success 和 usage 记录补 `retryCount`。
- [x] 文件工具补图片/PDF/二进制处理、读取预算和更清晰的拒绝原因。
  - 已交付：Read 增加图片/PDF 元数据摘要、普通二进制拒绝、文本读取预算说明、分页提示和更清晰的路径越界/缺失错误；文件工具 prompt 已同步说明限制。
- [ ] MCP 补项目级 server 审批、权限建议和更完整权限 UI。
- [ ] Web 工具补更完整站点限制策略、重定向/下载预检和更细粒度进度。
- [ ] REPL 补更丰富消息渲染、记忆命中数、路由原因和更接近 CC-Source 的状态行。
- [ ] 增加手动 `/compact`，并让 compact/resume 的状态在 REPL 中可见。

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
- **M5：终端体验**：进行中。已补输入历史、多行输入、状态行、debug 视图、resume 选择器和粘贴处理；富消息渲染仍未完成。

## 下一次开发启动流程

1. 运行 `git status --short --branch`，确认工作区是否干净。
2. 运行 `npm run typecheck`，必要时再运行 `npm run build` 或 `npm run smoke`。
3. 只从本文档 P0 选择一个任务，不同时推进多个大方向。
4. 开始实现前先读 CC-Source 对应模块，并在 commit/计划中记录参考依据。
5. 实现后更新本文档的任务状态；需要背景说明时写入 `DEVELOPMENT_LOG.md`。
6. 提交前运行 `npm run typecheck` 和 `npm run build`；涉及核心流程时运行 `npm run smoke`。
7. 每次开发完成或修改后，必须创建 git commit 并推送到 GitHub，除非用户明确要求暂不提交。

## 当前建议下一步

建议下一步做 **MCP 补项目级 server 审批、权限建议和更完整权限 UI**。

理由：

- 权限、tool result 预算、doctor、日志和文件工具边界已经收口；下一步应回到 MCP 的项目级信任边界。
- `.mcp.json` 已兼容，但项目级 server 审批和权限建议还没有形成完整闭环，外部进程启动风险仍需要更清晰的用户确认。
- 这比继续扩展新工具更符合“权限与文件能力收口”的主线。

建议拆成三个小提交：

1. 对照 CC-Source MCP config/trust/permission UI，梳理 neo 当前 `.mcp.json`、readOnly、allow/deny 规则缺口。
2. 增加项目级 MCP server 审批状态、权限建议输出和更清晰的拒绝原因。
3. 补 smoke 覆盖项目 MCP 未审批、审批后可用、deny 优先和权限建议。

## 未决问题

- OpenViking 的持久化写入应该使用哪个稳定 API？
- 项目级 MCP server 应采用怎样的信任/审批模型？
- 文件系统权限是只做配置级规则，还是增加会话级临时授权？
- Web robots、域名 allow/deny、重定向和 Tavily 抓取策略应该如何合并成一个站点策略模型？
- 富 TUI 应继续增强 readline，还是引入更接近 CC-Source 的 Ink 层？
