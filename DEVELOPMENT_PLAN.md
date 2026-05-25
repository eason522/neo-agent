# neo-agent 开发计划

本文档用于持续跟踪 neo-agent 的开发状态、优先级、待办事项和关键决策。每次做有意义的功能变更前后，都要同步更新这份文档，方便后续恢复上下文和回顾进度。

## 置顶指导思想

neo-agent 本质上是基于 CC-Source 的二次开发和深入个人定制。CC-Source 是成熟、优秀、设计合理、高效且功能完善的 agent harness；neo-agent 的所有功能开发都必须优先基于 CC-Source 的源代码和对应模块来推进。

任何新增能力、命令、提示词、工具、安全策略、记忆、skill、MCP、日志、会话、终端体验、权限模型、上下文管理和 agent loop 设计，都要先查找并阅读 CC-Source 的对应实现，理解其结构、边界、风险控制和工程取舍，再做适合 neo-agent 的个人化实现。只有在 CC-Source 没有对应功能或现有设计明显不适合 neo-agent 场景时，才考虑新开发；即使新开发，也必须借鉴 CC-Source 的设计思路和精髓。

严格参考 CC-Source 不等于机械照搬。如果在充分理解 CC-Source 源码、设计意图和风险边界后，发现 neo-agent 的个人化场景存在更好的方法、更清晰的抽象、更稳的安全策略、更低的上下文成本或更好的用户体验，可以在保留核心设计精神的前提下改进和优化，做到“青出于蓝而胜于蓝”。这类优化必须写清楚理由、收益、取舍和验证方式，不能用“优化”作为随意偏离 CC-Source 的借口。

这条是本项目最高优先级的开发原则。后续任何功能规划、架构调整、bug 修复和实现评审，都应先检查是否遵守这一原则。

## 当前状态

最后更新：2026-05-25

当前项目是一个个人终端 AI agent 的 MVP，已经具备：

- CLI 启动命令：`neo`
- 终端 REPL 交互和 slash command 命令体系
- DeepSeek 主模型/小模型文本路由
- MiMo 图片识别预分析，再交给文本模型推理
- 本地记忆存储，并支持 OpenViking 检索回退
- skill 发现和自动创建的基础框架
- skill 生命周期命令：`neo skill list/show/create/edit/delete/install/validate/export`，REPL 支持 `/skill list/show/path/edit/delete/create`
- skill 已支持从 `.md`、标准目录和 `.zip` 安装、校验、导出、`--scope user|project`、`--overwrite` 和 `--dry-run`
- skill 已作为标准 `Skill` tool 接入 `QueryEngine`，system prompt 只放预算化 skill 列表，调用时再加载完整 `SKILL.md`
- skill 已记录使用次数、最近使用时间、成功/失败信号，并用 usage 分数辅助排序
- skill 已支持按需文件变更检测和轻量 reload，外部编辑 `SKILL.md` 后无需重启 neo
- skill 已支持从 CC-Source plugin manifest 导入 `skills` / `skillsPath` / `skillsPaths` 指向的 skill
- MCP stdio server 连接基础框架，已连接工具会以 `mcp__server__tool` 形式进入 `QueryEngine`，并具备默认只读的权限保护
- MCP 配置命令：`neo mcp list/add/remove/test`
- MCP resource 工具：`ListMcpResources` / `ReadMcpResource`
- MCP deferred ToolSearch：MCP 工具过多时延迟加载 schema
- MCP 高风险工具 REPL 一次性权限确认，非交互入口继续默认拒绝
- 聚焦任务的 sub-agent 执行器
- 用于调试的 JSONL 日志系统
- 工具调用日志摘要：记录结果大小、域名、耗时和错误类别，不记录完整工具参数或工具正文
- tool loop 运行时状态事件：REPL 可见工具开始/成功/失败/达到上限，失败结果带恢复提示
- 请求级中断/取消：REPL 和 `neo ask` 使用 `AbortController` 取消当前回合，取消信号可传播到模型、联网工具和工具循环检查点
- 严格参考 CC-Source 分层结构重写的 system prompt
- `SOUL.md` 长期人格设定
- 对话 transcript 持久化
- 配置诊断命令：`neo doctor`
- 日志轮转和保留策略
- CLI 命令冒烟测试
- 结构化记忆 schema 和显式记忆管理命令
- dreaming 记忆整理命令和定时门控基础
- Tavily Search/Extract/Map/Crawl 联网搜索和网页浏览
- CC-Source 风格的联网 tool loop：`WebSearch` / `WebFetch` 作为模型可调用工具，过渡版小模型 planner 保留为兜底
- 项目文件只读工具：`Read`、`Glob`、`Grep`，只能访问 neo 启动目录内的文件
- 联网工具具备域名 allow/deny 和本地/内网/私有地址保护
- Tavily map/crawl 支持路径和域名正则过滤：select_paths、exclude_paths、select_domains、exclude_domains
- 参考 CC-Source `QueryEngine.ts` / `query.ts` / `Tool.ts` 拆出的最小 `QueryEngine` 和 `ToolRunner` 分层
- 按上下文预算保留 REPL 会话历史
- 接近上下文预算时自动 compact：用小模型总结较早对话，并保留近期原文
- GitHub `main` 分支同步

## 开发规则

- 增加、删除或调整开发任务时，要同步更新 `DEVELOPMENT_PLAN.md`。
- 不要把密钥提交到 git。API key 只能放在 `~/.neo-agent/config.json` 或环境变量里。
- 每次提交前运行 `npm run typecheck` 和 `npm run build`。
- 完成的提交默认推送到 `origin/main`，除非明确需要开分支。
- 不要提交 `node_modules/`、`dist/`、`.env`、本地截图、临时测试图片或临时 skill 实验文件。
- 项目文档和对话说明默认使用中文，除非代码、命令或第三方协议本身必须使用英文。
- 开发任何新功能前，先查找并阅读 CC-Source 中的对应功能；如果没有直接对应功能，也要参考其相近模块的组织方式、风险控制和用户体验。
- 如果在 CC-Source 基础上做“青出于蓝”的改进，要在提交或开发计划中说明：参考了哪个 CC-Source 模块、为什么不直接照搬、改进点是什么、如何验证没有破坏安全和可维护性。
- 用户测试暴露问题时，先判断这是单个 case、同类问题，还是架构能力缺口；优先修正能力层设计，避免用越来越多硬编码补洞。
- 如果后续审查发现某个已实现功能没有充分参考 CC-Source，要在计划中标记为过渡方案，并优先安排一次架构校正，而不是继续在旧方案上堆功能。

## 近期里程碑

### M1：可靠的个人 agent 核心

状态：已完成

说明：M1 的“已完成”表示 neo-agent 已具备可启动、可对话、可配置、可诊断、可记录日志和 transcript 的 MVP 核心，不表示这些基础设施已经完全达到 CC-Source 成熟度。M1 后续对齐债务继续放入待办池和 M5/M6，不再回滚 M1 状态。

- [x] 创建 TypeScript CLI 项目
- [x] 注册简单启动命令 `neo`
- [x] 配置 DeepSeek 和 MiMo 模型客户端
- [x] 实现文本/图片模型路由
- [x] 添加本地记忆存储
- [x] 添加 OpenViking 检索回退
- [x] 添加 skill 管理基础框架
- [x] 添加 MCP 管理基础框架
- [x] 添加 sub-agent 执行器
- [x] 添加 JSONL 日志系统
- [x] 添加持续开发计划文档
- [x] 重写 system prompt，并接入 `SOUL.md`
- [x] 添加对话 transcript 持久化
- [x] 添加配置诊断命令：`neo doctor`
- [x] 添加日志轮转和保留策略
- [x] 添加 CLI 命令冒烟测试

M1 后续对齐债务：

- [ ] 配置体系补 `neo config show --redacted`、`neo config set`、配置 schema 校验和结构化错误码，参考 CC-Source settings/config/doctor。
- [ ] 模型客户端补请求超时、重试退避、用量统计、成本统计和速率限制提示，参考 CC-Source api、cost-tracker、rateLimitMessages。
- [ ] transcript/session 补 resume、会话标题、会话元数据恢复、compact boundary、tool result pairing，参考 CC-Source sessionStorage 和 ResumeConversation。
- [ ] doctor 补上下文体积、MCP、skill、配置权限、版本/更新、路径可写性等更细诊断，参考 CC-Source Doctor/context warnings。
- [ ] 日志系统补 debug 开关、结构化错误码、usage/retry 统计和隐私分级，参考 CC-Source debug/log/analytics 思路。
- [ ] sub-agent 从“一次性小模型调用”升级为任务状态模型，参考 CC-Source AgentTool、LocalAgentTask、任务 transcript 和停止/前后台能力。

### M2：更好的记忆和个性化

状态：进行中

- [x] 定义记忆 schema，区分偏好、项目事实、工作流和会话摘要
- [x] 添加显式记忆命令：更新、删除、置顶、导出
- [x] 添加 `neo dream` / `/dream`，用于整理记忆、归档旧记忆和提炼灵感报告
- [x] 添加 dreaming 定时门控配置，默认关闭，避免擅自消耗模型额度
- [ ] 改进相关性评分，不只依赖简单关键词搜索
- [ ] 确认本地 OpenViking 服务接口后，接入 OpenViking 写入链路
- [ ] 添加记忆复查流程，避免低价值或错误记忆长期留存
- [ ] 为 dreaming 增加锁文件，避免多个 neo 进程同时整理记忆
- [ ] 为 dreaming 增加更细的报告回放和人工采纳流程

### M3：skill 生命周期

状态：进行中

- [x] 添加 `neo skill list/show/create/edit/delete`
- [x] 添加 `neo skill install <path|url>`，支持从单个 `.md` 安装为标准 `SKILL.md`
- [x] 添加 `neo skill install <zip>`，支持从 zip skill 包安装，并做 zip-slip、防覆盖、大小和文件数量校验
- [x] 添加 `neo skill export <name>`，把 skill 打包为可分享 zip
- [x] 添加 `neo skill validate <path|name>`，校验 `SKILL.md` 必填字段、frontmatter、触发词、文件大小和潜在危险内容
- [x] 支持 `--scope user|project`，区分全局用户 skill 和项目本地 skill
- [x] 支持 `--overwrite`、`--dry-run` 和安装预览，避免误覆盖已有 skill
- [x] 兼容 CC-Source 风格：目录格式 `skill-name/SKILL.md` 和单 `.md` 导入
- [x] 兼容 CC-Source plugin manifest 中的 `skillsPath/skillsPaths`
- [x] 把 Skill 作为标准 tool 接入 `QueryEngine`，让模型显式调用 skill，而不是只把匹配到的 skill 摘要塞进 system prompt
- [x] 为 skill listing 增加上下文预算，只暴露名称、描述和 when-to-use，调用时再加载完整正文
- [x] 记录 skill 使用次数、最近使用时间、成功/失败信号，并用于排序和后续建议
- [x] 添加 skill 文件变更检测或轻量 reload，避免修改后必须重启 neo
- [ ] 改进自动创建 skill 的判断标准，先提出建议，经过用户确认再写入
- [ ] 针对重复任务提出 skill 更新建议，支持人工采纳
- [ ] 支持 skill 中引用本目录资源，例如 `${NEO_SKILL_DIR}`，并限制可访问范围
- [ ] 明确 skill 安全边界：默认不执行 skill 内 shell 片段；如果后续支持 hooks/命令，必须走权限确认

### M4：工具和 MCP 执行

状态：已完成

说明：M4 的“已完成”表示联网、MCP、文件工具已经进入统一 `QueryEngine` / `ToolRunner` 路径，并具备最小安全边界和可见状态；但工具系统距离 CC-Source 的权限、并发、后台任务、完整文件能力、远程 MCP 和 hook 生态仍有差距。M4 后续硬化项必须继续按 CC-Source 工具体系推进。

- [x] 添加联网能力配置：搜索、网页提取、超时、结果数量、脱敏日志
- [x] 添加站点 map/crawl 配置：最大深度、最大页面数、费用保护
- [x] 添加站点 map/crawl 路径过滤：select_paths、exclude_paths、select_domains、exclude_domains
- [x] 接入 Tavily Search，作为默认轻量搜索能力
- [x] 接入 Tavily Extract，用于读取指定 URL 的正文和引用来源
- [x] 接入 Tavily Map/Crawl，用于文档站、产品页、项目资料的有限深度浏览
- [x] 添加 `neo web search/extract/map/crawl` 命令和 REPL slash command
- [x] 把联网结果接入 agent 上下文，并要求回答中保留来源链接和时间
- [x] 添加自然语言自动联网判断，支持 `neo ask --no-web` 和 `NEO_AGENT_WEB_AUTO_SEARCH=0`
- [x] 添加 REPL 会话上下文，让“联网搜一下”这类追问能沿用上一轮问题
- [x] 过渡改进：自动联网决策从启发式升级为小模型规划器，并加入可解释的联网理由
- [x] 按 CC-Source 重构联网能力：WebSearch/WebFetch 作为标准 tool 暴露给主模型，由主循环处理 tool_use/tool_result，而不是预先把搜索结果塞进上下文
- [x] 添加联网工具 schema、工具 prompt、只读语义、结果预算、来源要求和日志脱敏
- [x] 从 `NeoAgent` 中拆出最小 `QueryEngine` 和通用 `ToolRunner` 接口，避免工具循环继续散落在 agent 外壳里
- [x] 为联网工具补齐更完整的权限/域名策略：允许/拒绝域名、私有地址保护、可持久化规则
- [x] 为 tool loop 添加更完整的工具结果摘要、失败恢复和 UI 可见状态
- [x] 将已连接 MCP 工具接入 `QueryEngine` 标准 tool loop，并采用 CC-Source 风格 `mcp__server__tool` 命名
- [x] 为 MCP 工具执行添加安全调用协议和权限确认
- [x] 针对高风险 MCP 工具添加 REPL 一次性权限确认
- [x] 添加 MCP 配置命令：添加、删除、列表、测试
- [x] 添加 MCP resource 工具：列出和读取已连接 server 暴露的只读资源
- [x] 添加工具结果日志，并做好脱敏
- [x] 添加项目感知的文件系统工具支持

M4 后续硬化项：

- [ ] `Grep` 后端升级为 `rg`，补超时、最大输出、二进制跳过、错误分类和取消信号，参考 CC-Source `utils/ripgrep.ts` 和 `GrepTool`。
- [ ] 文件工具补完整权限模型、项目/额外目录 scope、图片/PDF/二进制处理、读取预算和结果落盘，参考 CC-Source FileRead/Glob/Grep/filesystem permissions。
- [ ] QueryEngine 补并发工具策略、orphan tool result 处理、长运行工具真实 kill、工具结果预算和可恢复 transcript pairing，参考 CC-Source `query.ts`、`StreamingToolExecutor`、tool orchestration。
- [ ] MCP 补 always allow/deny/ask 持久化、权限建议、远程 HTTP/SSE/OAuth、项目级 `.mcp.json`、企业 allow/deny 策略和更完整权限 UI，参考 CC-Source MCP manager、permission rules、settings schema。
- [ ] Web 工具补缓存、来源去重、跨来源冲突标注、robots/站点限制策略、下载内容预算和失败分类，参考 CC-Source WebSearch/WebFetch 的 prompt、preflight、blocklist 和 tool result 管理。
- [ ] Tool hooks 预留：PostToolUse、PermissionRequest、Stop/Notification 等 hook 点暂不实现执行，但 QueryEngine 结构要避免后续难以接入。

### M5：终端体验向 CC-Source 设计靠拢

状态：计划中

- [x] REPL/agent 按上下文预算保留当前 session 对话历史，而不是固定几轮
- [x] 添加自动 compact：接近上下文上限时生成可恢复摘要
- [x] 添加中断/取消行为
- [ ] 添加更丰富的消息渲染
- [ ] 添加输入历史和多行编辑
- [ ] 添加状态行，展示模型、记忆命中数和日志路径
- [ ] 添加轻量 debug 视图，展示路由结果和检索到的上下文

## 待办池

待办池按优先级管理。P0 是“真正可用”必须补齐的能力；P1 是稳定性和体验；P2 是发布、生态和长期增强。新增待办时必须归类，不再追加散乱列表。

### P0：核心可用闭环

- [x] M3：实现 `neo skill install/validate/export`，支持 `.md`、目录和 `.zip`，带路径穿越、zip-slip、覆盖保护、非法格式测试。
- [x] M3：实现 skill `--scope user|project`，加载时合并全局和项目 skill，并显示来源。
- [x] M3：把 Skill tool 接入 `QueryEngine`，让模型显式调用 skill，system prompt 只放预算化 skill 列表。
- [ ] M1：添加 `neo config show --redacted` 和 `neo config set`，并补配置 schema 校验、结构化错误码和敏感字段脱敏。
- [ ] M1：为模型请求添加超时、重试退避、取消分类、速率限制提示和用量统计。
- [ ] M4：将 `Grep` 工具后端从 JS 遍历升级为 `rg`，并增加超时、最大输出、二进制跳过和错误分类。
- [ ] M4：为 `QueryEngine` 增强长运行工具真实 kill、并发执行安全策略和 orphan tool result 处理。
- [ ] M5：补输入历史、多行编辑、状态行和轻量 debug 视图，让日常 REPL 可用性接近 CC-Source。

### P1：稳定性、安全和可调试性

- [ ] 为 `extractImageAttachments` 添加测试，覆盖不存在文件、非图片、大小限制和 mime 推断。
- [ ] 为 `Logger` 脱敏逻辑添加测试，覆盖 API key、URL query、MCP 参数、工具结果摘要。
- [ ] 为记忆搜索排序添加测试，并改进相关性评分。
- [ ] M2：dreaming 增加锁文件、报告回放、人工采纳和记忆复查。
- [ ] M4：MCP 权限增加 always allow/deny 持久化规则、远程 MCP、HTTP/SSE/OAuth 和更完整权限 UI。
- [ ] M4：Web 工具增加缓存、来源去重、失败分类和冲突事实提示。
- [ ] M1/M5：transcript/session 增加 resume、compact boundary、tool result pairing、会话标题和恢复校验。
- [ ] M1：模型用量和成本统计落盘，支持 `neo usage` 或 debug 视图查看。

### P2：生态、发布和长期能力

- [ ] 添加模型流式输出，并让 tool progress 与流式文本共存。
- [ ] 添加发布脚本、版本策略、变更日志和安装自检。
- [ ] 添加轻量 plugin/skill marketplace 规划，兼容 CC-Source plugin manifest 的 `skillsPath/skillsPaths`，但先不引入完整插件生态。
- [ ] sub-agent 升级为可恢复任务系统，支持状态、停止、前后台、任务 transcript 和工具隔离。
- [ ] 文件工具后续补编辑/写入能力，但必须先完成权限模型和用户确认 UI。
- [ ] hooks 生态预留：PostToolUse、PermissionRequest、Stop、Notification 等，不在权限模型成熟前执行外部 hook。

## CC-Source 对齐审查

最后审查：2026-05-25

本节用于回顾已开发模块是否符合“优先基于 CC-Source 二次开发”的置顶指导思想。结论不是一次性验收，后续每次新增核心能力都要更新。

### 2026-05-25：skill 能力专项梳理

对照 CC-Source 后，M3 不能只理解成 CRUD。CC-Source 的 skill 体系包含这些关键点：

- `skills/loadSkillsDir.ts`：正式技能目录采用 `skill-name/SKILL.md`；旧 commands 目录兼容单 `.md` 文件；解析 frontmatter、`when_to_use`、`user-invocable`、`disable-model-invocation`、`paths`、`allowed-tools` 等字段。
- `tools/SkillTool`：skill 不只是系统提示里的摘要，而是模型必须显式调用的 tool；listing 只占少量上下文预算，完整正文在调用时加载。
- `utils/suggestions/skillUsageTracking.ts`：skill 使用次数和最近使用时间会影响排序。
- `utils/skills/skillChangeDetector.ts`：skill 文件变化会触发缓存清理和重新加载。
- plugin 体系：plugin manifest 支持 `skillsPath` / `skillsPaths`，插件安装/启用后 skill 会进入统一发现链路。
- plugin/marketplace/zip cache：zip 下载和解压必须有缓存目录边界、原子替换、zip 解析错误分类和路径安全保护。

neo 已完成文件型 skill 生命周期第一阶段：全局和项目 scope、`SKILL.md` 目录格式、单 `.md`、标准目录、`.zip` 安装、导出、校验、覆盖保护、dry-run、大小/文件数限制和 zip-slip 防护。并已完成 Skill tool 第一阶段：预算化 listing、模型显式调用、调用时加载完整 `SKILL.md`、工具事件、transcript 摘要、usage tracking、按需轻量 reload，以及从 CC-Source plugin manifest 的 `skills` / `skillsPath` / `skillsPaths` 导入 skill。M3 后续重点转向 skill 自动创建确认、改进建议、本目录资源引用和更完整安全边界。

### 2026-05-25：M1/M4 和待办池专项梳理

用户指出不能只梳理 M3，已完成的 M1/M4 和待办池也要重新对齐 CC-Source。结论：

- M1 已交付 MVP 核心，但仍缺 CC-Source 级别的配置 schema、redacted config、请求重试/超时、usage/cost、resume、compact boundary、结构化错误和 sub-agent 任务模型。M1 保持“已完成”，这些进入 M1 后续对齐债务和 P0/P1。
- M4 已完成统一 tool loop 的第一阶段，但仍缺 CC-Source 的完整权限体系、ripgrep 后端、长运行工具 kill、工具并发/orphan result、远程 MCP、Web 结果缓存和 hook 接入点。M4 保持“已完成”，这些进入 M4 后续硬化项和 P0/P1。
- 待办池从散乱列表改为 P0/P1/P2。后续开发优先级以 P0 为准；P0 完成前，除非用户明确要求，不应跳去做 P2 生态或发布类能力。

M4 完成后复盘结论：主方向符合最高指导思想，联网、MCP、文件工具已经收敛到 `QueryEngine` / `ToolRunner`，工具结果通过同一 loop 回灌，权限和状态事件也进入统一链路。已立即修复两个安全收口点：transcript 不再记录完整 Web query 或完整 URL，只记录 query 长度和 URL 域名；Web/File 工具参数解析错误不再回显原始参数片段，只记录参数长度。剩余增强已放入待办池：`Grep` 后端改 `rg`、工具取消/并发/orphan result、MCP 持久化权限和远程 MCP。

| neo-agent 模块 | CC-Source 参考 | 当前结论 | 后续动作 |
| --- | --- | --- | --- |
| system prompt / SOUL | `utils/messages.ts`、系统提示分层、memory/skill/tool 提示 | 基本符合。已采用分层 system prompt，SOUL 作为个人化扩展，不覆盖安全和事实规则。 | 持续随工具、权限、记忆变化同步提示词。 |
| doctor | `commands/doctor` | 基本符合。采用分项诊断和可执行修复建议。 | 后续补 `config show --redacted` 和更细错误码。 |
| transcript / session | `utils/sessionStorage*`、`QueryEngine` transcript 记录 | 部分符合。已有 JSONL transcript、会话列表和 compact 事件记录，但 resume、compact boundary 链接、tool result pairing 还没有。 | M5 继续补可恢复 resume 和更完整 compact boundary。 |
| 上下文历史 | `query.ts`、`services/compact/*`、`sessionStoragePortable.ts` | 部分符合。已从固定几轮改为预算化历史，并加入自动 compact 摘要；但还缺 token 估算、手动 `/compact`、可恢复 boundary 和更精细的消息分组。 | M5 继续按 CC-Source compact/session 机制补齐。 |
| 联网工具 | `tools/WebSearchTool`、`tools/WebFetchTool`、`query.ts` 工具循环 | 当前核心路径基本符合。已改为 `WebSearch` / `WebFetch` function tools，由 `QueryEngine` 处理 tool call/result 回灌，并补上域名 allow/deny、私有地址保护、Tavily map/crawl 路径过滤、工具状态事件和失败恢复提示。 | 后续继续补流式输出和更细粒度进度。 |
| 主 agent loop | `QueryEngine.ts`、`query.ts`、`Tool.ts` | 已完成第一轮校正。原来工具循环内嵌在 `NeoAgent`，现已拆出最小 `QueryEngine` 和 `ToolRunner`。 | 后续 MCP、文件系统、skill 工具都应进入同一 `QueryEngine`，不要再在 `NeoAgent` 里分散实现。 |
| 项目文件工具 | `FileReadTool`、`GlobTool`、`GrepTool`、filesystem permissions | 部分符合。已加入只读 `Read` / `Glob` / `Grep` 并进入 `QueryEngine`，限制在启动目录内，带读取/搜索上限和默认忽略目录。 | 后续补完整 permission rules、二进制/图片/PDF 支持、ripgrep 后端和 UI 状态。 |
| MCP | `MCPTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool`、`ToolSearchTool`、`services/mcp/mcpStringUtils.ts` | 部分符合。已连接 MCP 工具会以 `mcp__server__tool` 形式进入 `QueryEngine` 标准 tool loop，并加入默认只读、显式 allow/deny、stdio 配置命令、resource 工具、deferred ToolSearch 和 REPL 一次性权限确认；但还缺 always allow/deny 持久化选择、HTTP/SSE/OAuth 和更完整的安全策略。 | M4/M5 继续补持久化权限规则、远程 MCP 和更完整权限 UI。 |
| sub-agent | `tools/AgentTool`、`tasks/LocalAgentTask`、agent memory snapshot | 不充分。当前只是小模型一次性子任务，不具备 CC-Source 的任务状态、进度、工具隔离、resume。 | M4/M5 增加任务状态和 agent 工具化，避免继续扩展一轮式 sub-agent。 |
| skill | `skills/loadSkillsDir.ts`、`tools/SkillTool`、`tools/SkillTool/prompt.ts`、`utils/suggestions/skillUsageTracking.ts`、`utils/skills/skillChangeDetector.ts`、plugin `skillsPath/skillsPaths`、zip cache/install helpers | 部分符合。已有 SKILL.md 发现、自动创建、CLI 生命周期命令和 REPL 管理命令；已补 `.md`/目录/`.zip` 安装、导出、校验、项目/全局 scope、dry-run、覆盖保护、zip-slip 防护、预算化 listing、`QueryEngine` 中的显式 Skill tool、usage tracking、按需轻量 reload 和 plugin manifest skill 导入；但缺 skill 自动创建确认、改进建议、本目录资源引用和更完整安装安全边界。 | M3 下一步补自动创建确认和 skill 改进建议，再补资源引用与安全边界。 |
| memory / dreaming | `memdir`、auto-memory、compact/session memory | 部分符合。已有 schema、显式记忆和 dream，但相关性评分、复查、采纳、OpenViking 写入不完整。 | M2 继续按 memdir 和 session memory 思路推进。 |
| terminal REPL | `components/App.tsx`、commands、permission UI、message rendering、`hooks/useCancelRequest.ts` | 部分符合。当前 readline REPL 简洁可用，已有 MCP 一次性权限确认、工具状态行和请求级取消；但离 CC-Source TUI、状态行、消息渲染、输入历史和多行编辑差距仍明显。 | M5 按 CC-Source 终端体验分阶段校正。 |
| logging | 日志、debug、analytics 相关模块 | 部分符合。已有 JSONL、轮转、脱敏和工具结果摘要，但缺成本/usage、retry 统计和结构化错误码。 | 待办池继续补 usage/cost/retry/error code。 |
| vision | 附件处理、图片消息、文件读取限制 | 部分符合。MiMo 预分析适合 neo-agent 模型组合，但不是 CC-Source 原生多模态路径。 | 后续补附件大小限制、缓存、截断说明和测试。 |

审查结论：当前最明显的不合规点是“主 agent loop 和工具循环曾内嵌在 `NeoAgent` 中”。已立即校正为最小 `QueryEngine` / `ToolRunner` 分层，并已把 MCP 工具和 Skill tool 接入该 loop，同时补上默认只读权限保护、deferred ToolSearch、resource 工具和 REPL 一次性权限确认。仍不充分的模块主要是 sub-agent、REPL 和 skill 改进建议；MCP 仍需继续补 always allow/deny 持久化规则、远程 MCP 和更完整权限 UI。开发这些模块时不得继续做孤立实现，必须先对照 CC-Source 对应源代码。

## 决策记录

### 2026-05-24：先做轻量自研 CLI，而不是直接改 CC-Source

CC-Source 体量很大，而且当前是提取出来的源码，缺少完整包元数据。先做一个聚焦的 TypeScript CLI，可以立刻运行和迭代，同时保留后续迁移 CC-Source 终端交互设计的空间。

### 2026-05-24：先把本地记忆作为可靠来源

在本机 OpenViking 服务接口完全确认之前，OpenViking 先作为可选检索后端。本地记忆保持始终可用，避免 OpenViking 没启动时 agent 不可用。

### 2026-05-24：采用 JSONL 文件日志

JSONL 方便 tail、grep、解析和脱敏。默认日志记录运行元数据，不记录完整提示词正文，降低泄露风险。

### 2026-05-24：项目文档和沟通默认使用中文

用户明确要求全程中文交流。后续说明、计划、回顾和文档默认使用中文；只有代码标识符、命令、配置 key、第三方协议名等必须保持英文。

### 2026-05-24：system prompt 采用 CC-Source 的分层思想，并用 SOUL.md 承载人格

CC-Source 的 system prompt 按身份、系统规则、任务执行、行动安全、工具使用、语气风格、输出效率、环境和动态上下文分层。neo 采用同样的组织方式，但内容改成个人 agent 场景，并把人格、关系和长期风格放入独立的 `SOUL.md`，方便持续迭代。

### 2026-05-24：对话 transcript 使用 JSONL 按会话持久化

transcript 默认写入 `~/.neo-agent/transcripts/YYYY-MM-DD/<sessionId>.jsonl`，记录会话开始/结束、用户输入、助手回复、命令和错误。这样后续可以回顾上下文、排查问题，也能为记忆总结和长期个性化打基础。

### 2026-05-25：先实现请求级取消，再补完整任务系统

参考 CC-Source `useCancelRequest.ts`、`abortController.ts` 和 query lifecycle，neo 先把 `AbortSignal` 作为当前回合生命周期状态接入 `NeoAgent`、`QueryEngine`、模型请求、Tavily 请求和工具执行检查点。REPL 运行中按 `Ctrl+C` 取消当前请求，空闲时退出；`neo ask` 收到 `SIGINT` 返回 130。MCP stdio 等暂时不能真实 kill 的外部调用先做到调用前/调用后检查和不继续推进主循环，后续再结合任务系统补长运行工具 kill、orphan result 和后台任务管理。

### 2026-05-25：skill 生命周期先覆盖文件型用户 skill

参考 CC-Source `skills/loadSkillsDir.ts`、`SkillTool` prompt 和 skill change/usage tracking，neo 第一批先补 `~/.neo-agent/skills/<name>/SKILL.md` 的生命周期管理：CLI 提供 `neo skill list/show/create/edit/delete`，REPL 提供 `/skill list/show/path/edit/delete/create`。`edit` 只在交互式 TTY 且设置了 `VISUAL` 或 `EDITOR` 时打开编辑器，非交互模式只输出文件路径，避免脚本卡死。后来已补项目本地 skill、安装/导出/校验、只读 `Skill` tool、使用统计、按需轻量 reload 和 plugin manifest 导入；当前仍未做 CC-Source 的 skill 改进建议，继续放在 M3 后续任务中。

### 2026-05-25：M3 重新定义为 skill 可用闭环，而不是 CRUD

用户指出 `.md` 和 `.zip` 安装 skill 是基础能力。重新对照 CC-Source 后确认：neo 的 M3 必须覆盖安装、导出、校验、scope、显式调用、预算化 listing、usage tracking 和热加载。后续实现顺序调整为：

1. `neo skill install/validate/export`：先支持 `.md`、标准目录和 `.zip`，补路径安全、覆盖保护、dry-run 和测试。
2. `--scope user|project`：把项目 skill 放入 `.neo-agent/skills`，全局 skill 放入 `~/.neo-agent/skills`，加载时统一合并并显示来源。
3. `Skill` tool：接入 `QueryEngine`，让模型按 CC-Source 方式显式调用 skill；system prompt 只提供预算化 skill 列表。
4. usage tracking 和 success signal：记录使用次数、最近使用和结果信号，用于排序、debug 和 dream/skill 改进建议。
5. hot reload 和 improvement survey：文件变化后刷新缓存；重复任务或失败后提出更新建议，由用户确认后写入。

### 2026-05-25：skill install/validate/export 第一阶段按文件包闭环实现

参考 CC-Source `skills/loadSkillsDir.ts`、plugin zip/cache 安全思路和 `SkillTool` 的“列表轻量、正文按需读取”方向，neo 先把文件型 skill 生命周期补成可用闭环：`neo skill install` 支持 `.md`、标准目录、`.zip` 和 URL，安装目标支持 `--scope user|project`；`validate` 可校验来源或已安装 skill；`export` 可导出标准 zip 包。安装默认拒绝覆盖，必须显式 `--overwrite`；`--dry-run` 只做解析和校验，不写文件。

本阶段已经补 zip-slip、路径穿越、文件数量、单文件大小、包大小、symlink 跳过和危险 shell 片段警告；仍未实现 hook 执行能力。后续不得把 skill 继续当作静态 system prompt 拼接，应优先接入 `QueryEngine` 的标准 tool loop。

### 2026-05-25：Skill tool 第一阶段只做说明加载，不执行外部动作

参考 CC-Source `tools/SkillTool` 和 `tools/SkillTool/prompt.ts`，neo 将 skill 从“system prompt 中的静态摘要”升级为标准 `Skill` tool：system prompt 只放预算化 skill 列表，模型判断匹配后必须先调用 `Skill`，工具结果再返回完整 `SKILL.md` 正文、scope、触发词和参数，后续回答基于该正文继续。

本阶段刻意不实现 shell、hooks、forked agent、agent 指定模型和 allowed-tools 执行能力。Skill tool 当前是只读加载器，避免在权限模型成熟前让 skill 成为隐式执行入口。后续按 CC-Source 继续补 `disable-model-invocation` 更完整 UI 和 forked skill。

### 2026-05-25：skill usage tracking 采用文件型统计和衰减排序

参考 CC-Source `utils/suggestions/skillUsageTracking.ts`，neo 在 `Skill` tool 成功加载 skill 时记录使用次数、成功次数、失败次数、最近使用时间和最近状态，落盘到用户 skill 目录下的 `.usage.json`。排序使用 7 天半衰期的 recency score，并加入成功率因子；项目 skill 和用户 skill 共用同一 usage store，但 key 带 `scope:name`，避免同名 skill 混淆。

CLI 和 REPL 的 skill list/show 会展示使用次数和最近使用信息。后续 skill 推荐、dreaming 复盘和 skill 改进建议都应复用这份 usage 数据，不再另造一套统计。

### 2026-05-25：skill hot reload 采用按需扫描，而不是常驻 watcher

参考 CC-Source `utils/skills/skillChangeDetector.ts` 后，neo 没有直接照搬 chokidar 常驻 watcher。原因是 neo 当前 skill 读取已经集中在 `SkillManager.loadSkills()` 和 `ToolRunner.refresh()`，不存在大型缓存链需要全局清理；对个人终端 agent 来说，常驻 watcher 会增加依赖、资源占用和跨平台复杂度。

本阶段采用“青出于蓝”的轻量优化：`SkillChangeDetector` 只在需要加载 skill 时扫描用户和项目 `SKILL.md` 的 mtime/size，检测 added/updated/removed 后才刷新 `SkillManager` 缓存；create/delete/usage 写入会主动失效缓存。这样外部编辑 `SKILL.md` 后下一轮对话、CLI 或 REPL 查询即可生效，不需要重启 neo，同时避免 watcher 死锁、批量事件风暴和额外依赖。验证通过 smoke 测试覆盖外部写入后自动重载。

### 2026-05-25：plugin manifest skill 导入先作为安装入口，不引入完整插件生态

参考 CC-Source `loadPluginCommands.ts` 和 `pluginLoader.ts`，插件 skill 的核心规则是：默认读取插件根目录的 `skills/`，并读取 manifest 中的额外 skill 路径；路径必须是插件根目录内的相对路径；路径本身可以是一个直接包含 `SKILL.md` 的 skill 目录，也可以是包含多个 `skill-name/SKILL.md` 的集合目录。

neo 本阶段支持 `neo skill install <pluginDir|plugin.json>` 和 `neo skill validate <pluginDir|plugin.json>`：读取 `plugin.json` 的 `skills`、`skillsPath`、`skillsPaths`，批量转换为标准 neo skill 并安装到 user/project scope。为了避免过早引入完整插件生态，本阶段不实现插件 enable/disable、marketplace、版本缓存、hooks 和 MCP 注入；导入后的 skill 就是普通 neo skill，继续走现有 `Skill` tool、usage tracking、hot reload 和安全边界。插件 skill 命名采用 `plugin-name-skill-name`，避免把 CC-Source 的 `plugin:skill` 名称直接暴露给当前较保守的文件名和 tool 参数体系。

### 2026-05-24：开发过程以 CC-Source 对应功能为核心参考

后续开发 neo-agent 时，必须优先查找 CC-Source 的对应实现。参考范围包括命令设计、诊断方式、system prompt 组织、工具安全、MCP、skill、记忆、日志、会话持久化和终端交互。neo-agent 不盲目照搬品牌和内部专有逻辑，但要吸收 CC-Source 作为 agent harness 的结构、工程质量和风险控制思路。

### 2026-05-24：`neo doctor` 采用 CC-Source `/doctor` 的分项诊断思路

CC-Source 的 doctor 会检查安装、版本、配置、工具和警告，并给出可执行建议。neo 的 doctor 先实现文本版，检查 Node、npm、neo 命令、git、配置加载、模型 key/base-url、数据目录、日志目录、transcript、SOUL、OpenViking、MCP 配置和构建产物。

### 2026-05-24：日志轮转采用“主流程不受清理失败影响”的策略

参考 CC-Source 日志和诊断模块的思路，日志写入和清理都不能阻塞 agent 主流程。neo 默认在日志超过 5MB 时轮转为时间戳归档，并按保留天数和归档数量做 best-effort 清理；清理失败不会影响对话、模型调用或命令执行。

### 2026-05-25：CLI 冒烟测试优先覆盖真实命令路径

参考 CC-Source 对命令、诊断和测试环境的处理方式，neo 的 smoke tests 不直接打模型 API，而是通过真实 CLI 子进程覆盖 `--help`、`config:init`、`doctor`、默认 REPL、记忆、日志和 transcript。这样能尽早发现命令注册、默认入口、配置加载和持久化路径的回归。

### 2026-05-25：记忆 schema 采用固定分类并兼容旧数据

参考 CC-Source memdir 的四类记忆、去重、更新/删除和过期校验思路，neo 先在本地 JSON 记忆中固定四类：`preference`、`project_fact`、`workflow`、`session_summary`。旧版 `kind` 记录会在读取时迁移到新 schema；显式删除先做归档，避免误删长期资料。后续再做更强相关性评分和 OpenViking 写入链路。

### 2026-05-25：dreaming 放在 M2，联网搜索和网页浏览放在 M4

dreaming 本质上是记忆生命周期：整理 transcript、合并重复记忆、归档过期记忆、提炼灵感，所以放在 M2 继续推进。联网搜索和网页浏览属于工具执行能力，应放在 M4；但 Tavily Search/Extract 可以作为 M4 的第一批内置工具提前开发，因为 DeepSeek 和 MiMo 当前不自带联网能力。网页浏览按四层实现：搜索 `search`、单页正文提取 `extract`、站点结构发现 `map`、有限深度爬取 `crawl`，每层都要有超时、数量限制、来源记录和日志脱敏。

### 2026-05-25：dreaming 默认不自动消耗模型额度

参考 CC-Source autoDream 的门控思路，neo 先实现 `neo dream` 和 `/dream` 手动整理能力，并预留 `NEO_AGENT_DREAM_ENABLED`、最小间隔和最小会话数量。默认关闭自动 dreaming，避免用户只是启动 neo 就发生后台模型调用。开启后只在 chat 生命周期中按门控触发；单次 `ask` 和 `dream` 命令不会额外触发定时 dreaming。

### 2026-05-25：Tavily 先作为显式联网工具，不自动混入普通 ask

第一版联网能力先实现 `neo web search/extract/map/crawl` 和对应 `/web` slash command。这样用户能主动查最新信息、读取网页正文、发现文档站 URL 和做有限深度爬取，但普通 `neo ask` 暂不自动联网，避免不透明的额度消耗和来源混乱。下一步再把联网结果作为显式上下文接入 agent 回答，并要求保留来源链接和检索时间。

### 2026-05-25：自然语言提问默认支持自动联网

用户希望 neo 像真正的 agent 一样自己判断是否需要搜索或验证。第一版曾采用低成本启发式：遇到“最新、今天、当前、搜索、联网、验证、价格、新闻、版本、URL”等信号时自动调用 Tavily Search/Extract，并把联网时间、来源 URL、摘要和正文片段放入模型上下文。该方案只能作为兜底，不应成为最终判断层。普通 `ask` 可用 `--no-web` 禁用，环境变量 `NEO_AGENT_WEB_AUTO_SEARCH=0` 可全局关闭。

### 2026-05-25：REPL 追问必须带上短期上下文

用户指出“你可以联网搜索一下吧”这种追问应该指向上一轮问题，而不是搜索这句话本身。neo 的 REPL/agent 需要保留当前 session 的预算化对话上下文，并在自动联网规划时让模型判断追问指向的真实问题。政治人物访问、行程是否结束等问题也应默认联网核实，不能只凭模型旧知识回答。

### 2026-05-25：会话上下文不能固定几轮丢弃

CC-Source 的设计不是“只保留最近几轮”，而是保留消息流，并通过 token 估算、自动 compact、summary、transcript 和 session memory 来管理上下文压力。neo 当前接入的 DeepSeek/MiMo 支持大上下文，所以 REPL 应按上下文预算保留当前 session 历史，默认 `NEO_AGENT_CONVERSATION_MAX_HISTORY_CHARS=300000`，单条消息默认最多 `50000` 字符。后续要实现自动 compact，而不是依赖固定轮数裁剪。

### 2026-05-25：联网搜索由小模型 planner 决定，启发式只作 fallback

用户指出自动联网不能靠不断追加关键词硬编码。neo 现在默认在普通 ask/REPL 中先调用小模型联网规划器，由模型结合当前输入、上一轮用户问题和预算化会话历史，输出结构化计划：是否联网、使用 search 还是 extract、查询词、URL、是否沿用上一轮问题和理由。规则层只保留开关、API key、URL 合法性、数量限制、超时和失败兜底。这样把“是否需要查最新信息”交给模型判断，同时保留 `NEO_AGENT_WEB_PLANNER_ENABLED=0` 和启发式 fallback，避免规划器故障时整个 agent 不可用。

### 2026-05-25：联网 planner 是过渡方案，不符合 CC-Source 的最终工具架构

重新审查 CC-Source 后确认，CC-Source 的联网设计不是在主回答前另起一个 planner 预取网页内容，而是把 `WebSearch` 和 `WebFetch` 作为标准工具交给主模型，由主循环执行模型发出的 `tool_use`，再把 `tool_result` 回灌到同一条 agent loop 中继续推理。相关参考文件包括 `src/query.ts`、`src/QueryEngine.ts`、`src/Tool.ts`、`src/tools/WebSearchTool/WebSearchTool.ts`、`src/tools/WebSearchTool/prompt.ts`、`src/tools/WebFetchTool/WebFetchTool.ts` 和 `src/tools/WebFetchTool/prompt.ts`。neo 当前的小模型 planner 解决了“是否联网”和“追问沿用上一轮”的短期问题，但它不是严格参考 CC-Source 的最终形态。下一步 M4 必须优先重构为 CC-Source 风格的 tool loop：工具 schema 明确、主模型自行选择工具、工具结果进入消息流、权限和域名策略独立、结果预算可控、来源要求由工具 prompt 和系统提示共同约束。

### 2026-05-25：普通 ask/REPL 默认走 WebSearch/WebFetch tool loop

neo 已添加最小 CC-Source 风格联网工具循环：普通 ask/REPL 在配置了 Tavily key 且自动联网开启时，会把 `WebSearch` 和 `WebFetch` 作为 OpenAI-compatible function tools 传给 DeepSeek。模型如果返回 `tool_calls`，neo 执行 Tavily Search/Extract，把结果作为 `role=tool` 消息回灌，再继续调用模型，直到模型给出最终回答或达到 `NEO_AGENT_WEB_MAX_TOOL_ROUNDS` 上限。旧的小模型 planner 保留为关闭 tool loop 后的过渡兜底。后续要继续补齐 CC-Source 更完整的权限系统、域名规则、工具调用 UI、工具结果摘要和恢复策略。

DeepSeek V4 默认启用 thinking mode。真实验证发现，当模型在 thinking mode 下返回工具调用时，下一轮必须把该 assistant message 的 `reasoning_content` 与 `tool_calls` 一起传回 API，否则会返回 400。neo 的 OpenAI-compatible 客户端已保留并回传 `reasoning_content`，用于支持工具调用续轮。

### 2026-05-25：主 agent loop 拆出最小 QueryEngine / ToolRunner

回顾已开发模块时发现，联网 tool loop 虽然行为上接近 CC-Source，但实现仍放在 `NeoAgent` 内部，和 CC-Source 的 `QueryEngine.ts`、`query.ts`、`Tool.ts` 分层不一致。已立即拆出 `src/agent/queryEngine.ts` 和 `src/tools/tool.ts`：`NeoAgent` 负责组装记忆、skill、vision、system prompt 和 transcript；`QueryEngine` 负责模型循环、工具调用、工具结果回灌和轮次上限；具体工具通过 `ToolRunner` 暴露 schema 和执行逻辑。后续 MCP、文件系统、skill 工具都应进入这个工具循环，不再散落在 `NeoAgent` 主流程里。

### 2026-05-25：MCP 工具进入 QueryEngine，权限系统先做最小安全边界

参考 CC-Source 的 `MCPTool`、`services/mcp/client.ts` 和 `services/mcp/mcpStringUtils.ts`，neo 已把 MCP 工具从“只能列出/手动调用”推进到标准 tool loop：连接后的 MCP tools 会被转换为 OpenAI-compatible function tools，命名采用 `mcp__server__tool`，输入 schema 来自 MCP `listTools()`，模型可在 `QueryEngine` 中直接调用，结果作为 `role=tool` 回灌。权限系统先实现最小安全边界：默认只读自动允许，显式 allow/deny 可配置。当前仍未完成 CC-Source 那套交互式 ask、deferred ToolSearch、MCP resource 工具和 URL elicitation retry。所以下一阶段继续完善 MCP 安全调用协议。

### 2026-05-25：MCP 权限默认只读，写操作需要显式允许

参考 CC-Source `MCPTool` 的权限语义和 always allow/deny/ask 思路，neo 先实现非交互式最小安全边界：`mcp.permissions.mode` 默认为 `readOnly`，只有 MCP tool 明确声明 `readOnlyHint=true` 且不是 `destructiveHint=true` 时才会自动执行。高风险、未知语义或写入类工具必须加入 `mcp.permissions.allowedTools`，`deniedTools` 始终优先。第一版拒绝时会把工具名和配置方式回灌给模型，让 neo 明确说明没有执行该外部操作；后续已补 REPL 一次性 ask。M4/M5 还需要继续补 CC-Source 风格的持久化 always allow/deny 规则和更完整权限 UI。

### 2026-05-25：联网工具默认阻止私有地址，并支持域名 allow/deny

参考 CC-Source 工具安全边界的思路，neo 的 Tavily 调用现在统一经过 URL/domain policy：`WebFetch`、`neo web extract`、`/web extract`、map/crawl 都会阻止 localhost、内网 IP、链路本地地址和私有地址；`WebSearch` 会合并模型请求的 `allowed_domains` / `blocked_domains` 与用户配置。`NEO_AGENT_WEB_ALLOWED_DOMAINS` 可收窄允许域名，`NEO_AGENT_WEB_BLOCKED_DOMAINS` 可拒绝域名，拒绝规则优先。这样安全策略放在 TavilyClient 层，而不是只在某一个命令或工具入口做局部修补。

### 2026-05-25：Tavily map/crawl 路径过滤进入统一 crawler body

根据 Tavily 官方 API，map/crawl 都支持 `select_paths`、`exclude_paths`、`select_domains`、`exclude_domains` 正则过滤。neo 已把这些参数加入 `TavilyClient.buildCrawlerBody()`，CLI 支持 `--select-paths`、`--exclude-paths`、`--select-domains`、`--exclude-domains`，配置支持 `NEO_AGENT_WEB_SELECT_PATHS` 等环境变量。配置级 `allowedDomains/blockedDomains` 仍是安全边界：存在 allowedDomains 时，crawler 的 select_domains 会优先由 allowedDomains 转换而来，避免命令输入扩大访问范围。

### 2026-05-25：MCP 配置命令先支持用户级 stdio server

参考 CC-Source `mcp add/list/remove` 的命令结构，neo 先实现用户级 stdio MCP 配置管理：`neo mcp add/list/remove/test`。命令直接维护 `~/.neo-agent/config.json` 中的 `mcp.servers`，`list` 默认只展示 env 数量而不打印 env 值，`test` 会尝试连接并列出工具数量。HTTP/SSE/OAuth、项目级 scope、交互式导入和 token 安全存储暂不做，后续继续按 CC-Source 的 MCP config/service 分层补齐。

### 2026-05-25：工具结果日志只记录脱敏摘要

参考 CC-Source 对工具执行状态、权限和 sandbox 规则的处理方式，neo 的 `QueryEngine` 现在会在 `tool.start`、`tool.success`、`tool.error` 中记录统一摘要：参数字符数、参数 key、Web URL 域名、查询字符数、结果字符数、MCP server/tool、耗时和错误类别。日志不记录完整查询词、完整 URL query、MCP 参数或工具返回正文，避免调试日志变成敏感数据仓库。

### 2026-05-25：tool loop 状态进入 REPL，并给失败结果恢复提示

参考 CC-Source 各工具的 `renderToolUseMessage`、`renderToolResultMessage`、progress message 和失败 UI 思路，neo 在 `QueryEngine` 中加入统一 `ToolProgressEvent`。每次工具开始、成功、失败、未知工具和达到轮次上限，都会产生脱敏事件；交互式 REPL 会实时显示简短状态行，transcript 也会记录这些事件摘要。工具失败时不再只回灌裸错误字符串，而是回灌结构化 JSON，包含错误类别和 `recoveryHint`，提醒模型不要伪造执行结果、可换工具或明确说明限制。UI 摘要仍只展示查询长度、域名、结果数、字符数、server/tool 名等元数据，不显示完整查询、完整 URL query 或 MCP 参数值。

### 2026-05-25：MCP resources 进入 QueryEngine

参考 CC-Source 的 `ListMcpResourcesTool` 和 `ReadMcpResourceTool`，neo 新增 `McpResourceRunner`，在已有 MCP server 连接后暴露只读 `ListMcpResources` / `ReadMcpResource`。资源读取结果通过同一个 `QueryEngine` 回灌给模型，文本内容会截断到 100K 字符；二进制 blob 不直接写入上下文，只记录字节数和说明，避免把大块 base64 塞进模型输入。后续仍需继续补资源缓存、变更通知、二进制落盘和 deferred ToolSearch。

### 2026-05-25：项目文件工具先做只读、项目内访问

参考 CC-Source `FileReadTool`、`GlobTool` 和 `GrepTool`，neo 新增 `FileToolRunner`，默认向普通 ask/REPL 暴露 `Read`、`Glob`、`Grep`。第一版只允许访问 neo 启动目录内的真实路径，拒绝项目外路径和 symlink 跳转；默认跳过 `.git`、`node_modules`、`dist` 等噪声目录，并限制读取大小、读取行数、搜索文件数和返回条数。当前不支持编辑、写入、图片/PDF 原生读取、完整 permission rules 或 ripgrep 后端；后续继续对齐 CC-Source 的 filesystem permission 和更完整文件能力。

### 2026-05-25：MCP 工具过多时使用 ToolSearch 延迟加载

参考 CC-Source `ToolSearchTool` 的 deferred tool 设计，neo 新增 `ToolSearchRunner`。当 MCP 工具数量超过 `mcp.toolSearchThreshold`（默认 20，可用 `NEO_AGENT_MCP_TOOL_SEARCH_THRESHOLD` 调整）时，`McpToolRunner` 不再一次性暴露全部 MCP schema，而是只保留已激活工具，并暴露 `ToolSearch`。模型通过关键词或 `select:mcp__server__tool` 加载需要的 MCP 工具；`QueryEngine` 每轮重新读取 tool definitions，使 ToolSearch 激活的工具能在下一轮被调用。当前 deferred 先覆盖 MCP 工具，后续再考虑 skill/sub-agent 等更多 deferred 类型。

### 2026-05-25：MCP 高风险工具先做 REPL 一次性确认

参考 CC-Source permission ask 的设计，neo 在 `McpToolRunner` 中加入可插拔的权限询问回调。配置规则仍然优先：`deniedTools` 直接拒绝，`allowedTools`、`allowAll` 和明确只读工具直接允许；只有未获授权且可能有副作用的 MCP 工具会在交互式 REPL 中询问用户是否允许本次执行。确认界面只展示工具名、来源、风险、参数长度和参数字段名，不打印完整参数值；`neo ask` 等非交互入口不设置询问回调，仍默认拒绝。当前只支持 allow once / deny，后续再补持久化 always allow/deny。

### 2026-05-25：自动 compact 先做会话内摘要，不再直接丢旧消息

参考 CC-Source `services/compact/compact.ts` 和 `services/compact/prompt.ts`，neo 在 `ConversationHistory` 中加入自动 compact：当当前 session 历史超过 `conversation.maxHistoryChars * compactThresholdRatio` 时，用小模型把较早对话压缩成中文摘要，并保留近期原文。摘要会作为“自动压缩的历史摘要”放回后续模型上下文，同时写入 transcript 的 `compact` 事件和 JSONL 日志。compact 模型调用失败时会退回抽取式摘要，不能影响用户刚刚那轮正常回复。当前还不是完整 CC-Source compact：缺 token 估算、手动 `/compact`、compact boundary 链接、resume 恢复和 tool result pairing，后续 M5 继续补齐。

## 恢复开发检查清单

开始新的开发任务前：

1. 运行 `git status --short --branch`。
2. 阅读本文档的“当前状态”和“近期里程碑”。
3. 选择下一个未完成任务；如果优先级变化，先更新任务列表。
4. 实现功能或修复问题。
5. 运行 `npm run typecheck` 和 `npm run build`。
6. 如果状态、决策或优先级变化，更新本文档。
7. 提交并推送到 GitHub。

## 未决问题

- OpenViking 的持久化写入应使用哪一个稳定 API 接口？
- 项目本地 skill 默认应该放在 `.neo-agent/skills`，还是继续放在用户全局 `~/.neo-agent/skills`？
- CC-Source 的终端 UI 代码应该复制多少，哪些部分应该在更小的 TUI 层里重新实现？
- MCP 工具和未来文件系统动作应该采用怎样的权限模型？
- Tavily API key 应放入 `~/.neo-agent/config.json` 还是只支持 `TAVILY_API_KEY` 环境变量？
- 网页浏览结果是否需要本地缓存，缓存保留多久，是否进入长期记忆？
