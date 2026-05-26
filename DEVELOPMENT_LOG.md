# neo-agent 开发历史日志

> 本文档由原 `DEVELOPMENT_PLAN.md` 迁移而来，用于保留历史决策、长篇复盘和已完成流水账。当前可执行主线见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)。

本文档用于持续跟踪 neo-agent 的开发状态、优先级、待办事项和关键决策。每次做有意义的功能变更前后，都要同步更新这份文档，方便后续恢复上下文和回顾进度。

## 置顶指导思想

neo-agent 本质上是基于 CC-Source 的二次开发和深入个人定制。CC-Source 是成熟、优秀、设计合理、高效且功能完善的 agent harness；neo-agent 的所有功能开发都必须优先基于 CC-Source 的源代码和对应模块来推进。

任何新增能力、命令、提示词、工具、安全策略、记忆、skill、MCP、日志、会话、终端体验、权限模型、上下文管理和 agent loop 设计，都要先查找并阅读 CC-Source 的对应实现，理解其结构、边界、风险控制和工程取舍，再做适合 neo-agent 的个人化实现。只有在 CC-Source 没有对应功能或现有设计明显不适合 neo-agent 场景时，才考虑新开发；即使新开发，也必须借鉴 CC-Source 的设计思路和精髓。

当用户在测试中发现问题并反馈 bug、体验缺陷或设计不合理之处时，修复前必须先回到 CC-Source 查找对应实现或相近模块，确认成熟 harness 在同类问题上的处理方式，再判断 neo-agent 应该修补具体 bug、调整同类能力，还是做架构层校正。不能在没有对照 CC-Source 的情况下直接用临时逻辑、硬编码或局部补丁应付测试反馈。

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
- skill 发现和自动创建建议的基础框架；写入 skill 必须由用户确认或显式命令触发
- skill 生命周期命令：`neo skill list/show/create/edit/delete/install/validate/export`，REPL 支持 `/skill list/show/path/edit/delete/create`
- skill 已支持从 `.md`、标准目录和 `.zip` 安装、校验、导出、`--scope user|project`、`--overwrite` 和 `--dry-run`
- skill 已作为标准 `Skill` tool 接入 `QueryEngine`，system prompt 只放预算化 skill 列表，调用时再加载完整 `SKILL.md`
- skill 已记录使用次数、最近使用时间、成功/失败信号，并用 usage 分数辅助排序
- skill 已支持按需文件变更检测和轻量 reload，外部编辑 `SKILL.md` 后无需重启 neo
- skill 已支持从 CC-Source plugin manifest 导入 `skills` / `skillsPath` / `skillsPaths` 指向的 skill
- MCP stdio/http/sse server 连接框架，已连接工具会以 `mcp__server__tool` 形式进入 `QueryEngine`，并具备默认只读、always allow/deny 持久化和 OAuth bearer 支持
- MCP 配置命令：`neo mcp list/add/remove/test`
- MCP resource 工具：`ListMcpResources` / `ReadMcpResource`
- MCP deferred ToolSearch：MCP 工具过多时延迟加载 schema
- MCP 高风险工具 REPL 一次性/始终允许/始终拒绝权限确认，非交互入口继续默认拒绝
- 配置管理命令：`neo config show` 默认脱敏显示 merged/user/project 配置，`neo config set` 写入 user/project 配置并做 schema 校验
- 模型客户端基础可靠性：请求超时、5xx/429/网络/超时重试、4xx 不重试、取消分类和 token usage 日志
- 模型 usage 账本：token usage 落盘到 JSONL，`neo usage` 和 REPL `/usage` 可按模型/日期查看 token 和配置化估算成本
- 聚焦任务的 sub-agent 执行器
- sub-agent 任务系统：支持前台/后台、状态记录、停止、任务 transcript 回放和无工具隔离边界
- 用于调试的 JSONL 日志系统
- 工具调用日志摘要：记录结果大小、域名、耗时和错误类别，不记录完整工具参数或工具正文
- tool loop 运行时状态事件：REPL 可见工具开始/成功/失败/达到上限，失败结果带恢复提示
- `QueryEngine` 已具备工具并发安全策略、工具级超时/取消、MCP stdio 取消断开和 orphan tool result 日志
- 请求级中断/取消：REPL 和 `neo ask` 使用 `AbortController` 取消当前回合，取消信号可传播到模型、联网工具和工具循环检查点
- 严格参考 CC-Source 分层结构重写的 system prompt
- `SOUL.md` 长期人格设定
- 对话 transcript 持久化，支持会话标题、启动参数 `--resume`、REPL `/resume`、compact boundary 和 tool result pairing 校验
- 配置诊断命令：`neo doctor`
- 日志轮转和保留策略
- CLI 命令冒烟测试
- 结构化记忆 schema 和显式记忆管理命令
- dreaming 记忆整理命令、定时门控、锁文件、报告回放、人工采纳和记忆复查
- Tavily Search/Extract/Map/Crawl 联网搜索和网页浏览，具备请求缓存、URL 去重、失败分类和多日期冲突提示
- CC-Source 风格的联网 tool loop：`WebSearch` / `WebFetch` 作为模型可调用工具，过渡版小模型 planner 保留为兜底
- 项目文件工具：`Read`、`Glob`、`Grep`、`Write`、`Edit`，可访问 neo 启动目录、默认 `workspace/` 和显式授权额外目录；工作区内写入/编辑无需额外确认，项目其它位置和额外写入目录仍必须交互式确认；`Grep` 后端已改为 `rg`，带超时、输出上限、二进制跳过和错误分类
- 模型流式输出：OpenAI-compatible SSE 增量解析，REPL 默认流式显示，`neo ask --stream` 支持单次流式输出，tool progress 独立显示
- 发布与安装自检：`CHANGELOG.md`、`npm run release:check`、`neo self-check`
- 轻量 skill/plugin marketplace 本地索引：复用 skill 安装和 plugin `skillsPath/skillsPaths` 导入，不启用完整插件生态
- hooks 事件预留：`PostToolUse`、`PermissionRequest`、`Stop`、`Notification` 只进入内部事件总线，不执行外部 hook
- 能力快照入口：`Capabilities` 模型工具、`neo capabilities` 和 REPL `/capabilities` 统一从运行时读取当前工具、skill、MCP、Web、文件权限、sub-agent 和 hooks 能力边界
- 任务可行性评估：`TaskAssessment` 模型工具、`neo assess` 和 REPL `/assess` 基于能力快照判断任务 complete/partial/blocked，并返回缺失能力、约束和推荐策略
- 联网工具具备域名 allow/deny 和本地/内网/私有地址保护
- Tavily map/crawl 支持路径和域名正则过滤：select_paths、exclude_paths、select_domains、exclude_domains
- 参考 CC-Source `QueryEngine.ts` / `query.ts` / `Tool.ts` 拆出的最小 `QueryEngine` 和 `ToolRunner` 分层
- 按上下文预算保留 REPL 会话历史，REPL 已支持持久输入历史、多行输入、状态行和轻量 debug 视图
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

- [x] 配置体系补 `neo config show` 默认脱敏、`neo config set`、配置 schema 校验，参考 CC-Source settings/config/doctor。
- [x] 模型客户端补请求超时、重试退避、取消分类、429/5xx/网络/超时错误分类和 token usage 日志，参考 CC-Source api、cost-tracker、rateLimitMessages。
- [x] 模型成本统计落盘和 `neo usage` 视图，参考 CC-Source cost-tracker。
- [x] transcript/session 补 resume、会话标题、会话元数据恢复、compact boundary、tool result pairing，参考 CC-Source sessionStorage 和 ResumeConversation。
- [ ] doctor 补上下文体积、MCP、skill、配置权限、版本/更新、路径可写性等更细诊断，参考 CC-Source Doctor/context warnings。
- [ ] 日志系统补 debug 开关、结构化错误码、usage/retry 统计和隐私分级，参考 CC-Source debug/log/analytics 思路。
- [x] sub-agent 从“一次性小模型调用”升级为任务状态模型，参考 CC-Source AgentTool、LocalAgentTask、任务 transcript 和停止/前后台能力。

### M2：更好的记忆和个性化

状态：进行中

- [x] 定义记忆 schema，区分偏好、项目事实、工作流和会话摘要
- [x] 添加显式记忆命令：更新、删除、置顶、导出
- [x] 添加 `neo dream` / `/dream`，用于整理记忆、归档旧记忆和提炼灵感报告
- [x] 添加 dreaming 定时门控配置，默认关闭，避免擅自消耗模型额度
- [x] 改进相关性评分，不只依赖简单关键词搜索
- [ ] 确认本地 OpenViking 服务接口后，接入 OpenViking 写入链路
- [x] 添加记忆复查流程，避免低价值或错误记忆长期留存
- [x] 为 dreaming 增加锁文件，避免多个 neo 进程同时整理记忆
- [x] 为 dreaming 增加更细的报告回放和人工采纳流程

### M3：skill 生命周期

状态：已完成

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
- [x] 改进自动创建 skill 的判断标准，先提出建议，经过用户确认再写入
- [x] 针对重复任务提出 skill 更新建议，支持人工采纳
- [x] 支持 skill 中引用本目录资源，例如 `${NEO_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}`，并限制可访问范围
- [x] 明确 skill 安全边界：默认不执行 skill 内 shell 片段；如果后续支持 hooks/命令，必须走权限确认
- [x] 支持对话内通过 `InstallSkillPackage` 工具安装项目目录内 `.md`、目录、plugin 目录和 `.zip` skill 包，zip 可批量安装多个 skill
- [x] 安装类工具结果标记为终止型结果，成功后直接进入最终回答，避免模型重复调用同一安装工具
- [x] skill 自动沉淀排除一次性安装、导入、删除、查看等操作型任务；安装工具调用后不触发“创建 skill”建议
- [x] 对话内安装不再向模型暴露 dry-run，用户说“安装”就真实安装；CLI 和对话安装都支持跳过已存在 skill
- [x] zip 安装识别并跳过目录占位项，避免资源目录被当作文件导致后续安装失败

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

- [x] `Grep` 后端升级为 `rg`，补超时、最大输出、二进制跳过、错误分类和取消信号，参考 CC-Source `utils/ripgrep.ts` 和 `GrepTool`。
- [x] 文件工具补额外目录 scope 第一阶段：默认项目内访问，`files.additionalReadDirs` / `files.additionalWriteDirs` 和环境变量显式授权项目外目录，写入仍需交互确认。
- [x] 文件工具补可配置工作区目录第一阶段：默认 `workspace/`，支持 `workspace.dir` / `NEO_AGENT_WORKSPACE_DIR`，工作区内 `Write`/`Edit` 拥有完全访问权限，项目其它位置和额外写入目录仍需交互确认。
- [ ] 文件工具补完整权限模型、会话级目录授权、图片/PDF/二进制处理、读取预算和结果落盘，参考 CC-Source FileRead/Glob/Grep/filesystem permissions。（P2 已补写入/编辑前交互式确认；当前已补 workspace 完全访问第一阶段；更完整 permission rules 和二进制/图片/PDF 仍属 M4 硬化项。）
- [x] QueryEngine 补并发工具策略、orphan tool result 处理和长运行工具真实 kill，参考 CC-Source `query.ts`、`StreamingToolExecutor`、tool orchestration。
- [x] transcript/session 补 tool result pairing 摘要和恢复校验，参考 CC-Source `query.ts`、`StreamingToolExecutor`、tool orchestration。
- [x] QueryEngine 补统一工具结果预算、超大结果落盘引用和 toolPairs 持久化路径摘要，参考 CC-Source `query.ts`、`StreamingToolExecutor`、tool result storage。
- [ ] QueryEngine 继续补更精细的可恢复 transcript pairing 和历史消息级 aggregate budget，参考 CC-Source `query.ts`、`StreamingToolExecutor`、tool orchestration。
- [x] MCP 补 always allow/deny/ask 持久化、远程 HTTP/SSE/OAuth 和 resource/deferred ToolSearch 第一阶段，参考 CC-Source MCP manager、permission rules、settings schema。
- [x] MCP 补项目级 `.mcp.json` 第一阶段：兼容顶层 `mcpServers`，`neo mcp add/list/remove --scope project` 可写入和读取项目共享 server。
- [ ] MCP 继续补项目级 server 审批、权限建议、企业 allow/deny 策略和更完整权限 UI，参考 CC-Source MCP manager、permission rules、settings schema。
- [x] Web 工具补缓存、来源去重、跨来源冲突标注和失败分类，参考 CC-Source WebSearch/WebFetch 的 prompt、preflight、blocklist 和 tool result 管理。
- [x] Web 工具补 robots.txt 限制第一阶段：`WebFetch` / extract / map / crawl 读取目标站点 robots.txt，命中 Disallow 时拒绝继续请求 Tavily，可用 `NEO_AGENT_WEB_RESPECT_ROBOTS_TXT=0` 显式关闭。
- [x] Web 工具补下载内容统一预算第一阶段：`extract/crawl` 按 `web.maxDownloadChars` / `NEO_AGENT_WEB_MAX_DOWNLOAD_CHARS` 限制返回正文总量，截断写入 warning。
- [ ] Web 工具继续补更完整站点限制策略和更细粒度进度，参考 CC-Source WebSearch/WebFetch 的 prompt、preflight、blocklist 和 tool result 管理。
- [x] Tool hooks 预留：PostToolUse、PermissionRequest、Stop/Notification 等 hook 点暂不实现执行，但 QueryEngine 结构要避免后续难以接入。

### M5：终端体验向 CC-Source 设计靠拢

状态：进行中

- [x] REPL/agent 按上下文预算保留当前 session 对话历史，而不是固定几轮
- [x] 添加自动 compact：接近上下文上限时生成可恢复摘要
- [x] 添加中断/取消行为
- [ ] 添加更丰富的消息渲染
- [x] 添加输入历史和多行编辑，按 CC-Source 启用增强键盘协议，支持 `Ctrl+Enter` / `Ctrl+J` 在当前输入缓冲区插入可继续编辑的换行
- [x] 添加状态行，展示模型、工具调用和耗时
- [x] 添加轻量 debug 视图，展示最近一轮工具事件、日志路径和 transcript 路径
- [ ] 状态行继续补记忆命中数、路由原因和更接近 CC-Source 的 TUI 渲染

## 待办池

待办池按优先级管理。P0 是“真正可用”必须补齐的能力；P1 是稳定性和体验；P2 是发布、生态和长期增强。新增待办时必须归类，不再追加散乱列表。

### P0：核心可用闭环

- [x] M3：实现 `neo skill install/validate/export`，支持 `.md`、目录和 `.zip`，带路径穿越、zip-slip、覆盖保护、非法格式测试。
- [x] M3：实现 skill `--scope user|project`，加载时合并全局和项目 skill，并显示来源。
- [x] M3：把 Skill tool 接入 `QueryEngine`，让模型显式调用 skill，system prompt 只放预算化 skill 列表。
- [x] M1：添加 `neo config show` 默认脱敏和 `neo config set`，并补配置 schema 校验和敏感字段脱敏。
- [x] M1：为模型请求添加超时、重试退避、取消分类、速率限制分类和 token usage 记录。
- [x] M4：将 `Grep` 工具后端从 JS 遍历升级为 `rg`，并增加超时、最大输出、二进制跳过和错误分类。
- [x] M4：为 `QueryEngine` 增强长运行工具真实 kill、并发执行安全策略和 orphan tool result 处理。
- [x] M5：补输入历史、多行编辑、状态行和轻量 debug 视图，让日常 REPL 可用性接近 CC-Source。

### P1：稳定性、安全和可调试性

- [x] 为 `extractImageAttachments` 添加测试，覆盖不存在文件、非图片、大小限制和 mime 推断。
- [x] 为 `Logger` 脱敏逻辑添加测试，覆盖 API key、URL query、MCP 参数、工具结果摘要。
- [x] 为记忆搜索排序添加测试，并改进相关性评分。
- [x] M2：dreaming 增加锁文件、报告回放、人工采纳和记忆复查。
- [x] M4：MCP 权限增加 always allow/deny 持久化规则、远程 MCP、HTTP/SSE/OAuth 和基础交互式权限确认。
- [x] M4：Web 工具增加缓存、来源去重、失败分类和冲突事实提示。
- [x] M1/M5：transcript/session 增加 resume、compact boundary、tool result pairing、会话标题和恢复校验。
- [x] M1：模型成本统计落盘，支持 `neo usage` 或 debug 视图查看。

### P2：生态、发布和长期能力

- [x] 添加模型流式输出，并让 tool progress 与流式文本共存。
- [x] 添加发布脚本、版本策略、变更日志和安装自检。
- [x] 添加轻量 plugin/skill marketplace 规划，兼容 CC-Source plugin manifest 的 `skillsPath/skillsPaths`，但先不引入完整插件生态。
- [x] sub-agent 升级为可恢复任务系统，支持状态、停止、前后台、任务 transcript 和工具隔离。
- [x] 文件工具后续补编辑/写入能力，但必须先完成权限模型和用户确认 UI。
- [x] hooks 生态预留：PostToolUse、PermissionRequest、Stop、Notification 等，不在权限模型成熟前执行外部 hook。

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

neo 已完成文件型 skill 生命周期第一阶段：全局和项目 scope、`SKILL.md` 目录格式、单 `.md`、标准目录、`.zip` 安装、导出、校验、覆盖保护、dry-run、大小/文件数限制和 zip-slip 防护。并已完成 Skill tool 第一阶段：预算化 listing、模型显式调用、调用时加载完整 `SKILL.md`、工具事件、transcript 摘要、usage tracking、按需轻量 reload、从 CC-Source plugin manifest 的 `skills` / `skillsPath` / `skillsPaths` 导入 skill、自动创建建议确认、skill 改进建议确认、本目录资源引用和默认不执行 shell/hook 的安全边界。

### 2026-05-25：M1/M4 和待办池专项梳理

用户指出不能只梳理 M3，已完成的 M1/M4 和待办池也要重新对齐 CC-Source。结论：

- M1 已交付 MVP 核心，配置 schema、redacted config、请求重试/超时、usage/cost、resume、compact boundary 和 sub-agent 任务模型已补到第一阶段；剩余 doctor 深度诊断、日志隐私分级和结构化错误继续放入 M1 对齐债务。
- M4 已完成统一 tool loop 的第一阶段，并已补 `rg` 后端、工具级取消/超时、并发安全策略、orphan result 日志、流式输出和 hook 事件预留；仍缺 CC-Source 的完整权限体系、工具结果预算和更细文件能力。M4 保持“已完成”，这些进入 M4 后续硬化项。
- 待办池从散乱列表改为 P0/P1/P2。后续开发优先级以 P0 为准；P0 完成前，除非用户明确要求，不应跳去做 P2 生态或发布类能力。

M4 完成后复盘结论：主方向符合最高指导思想，联网、MCP、文件工具已经收敛到 `QueryEngine` / `ToolRunner`，工具结果通过同一 loop 回灌，权限和状态事件也进入统一链路。已立即修复两个安全收口点：transcript 不再记录完整 Web query 或完整 URL，只记录 query 长度和 URL 域名；Web/File 工具参数解析错误不再回显原始参数片段，只记录参数长度。P0 已补 `Grep` 的 `rg` 后端、工具取消/并发/orphan result；P1/P2 已补 MCP 持久权限、远程 MCP、Web 缓存和 hook 事件预留；剩余增强继续放入待办池：统一权限模型、工具结果预算、项目级 MCP 配置、robots/站点限制策略和更完整权限 UI。

| neo-agent 模块 | CC-Source 参考 | 当前结论 | 后续动作 |
| --- | --- | --- | --- |
| system prompt / SOUL | `utils/messages.ts`、系统提示分层、memory/skill/tool 提示 | 基本符合。已采用分层 system prompt，SOUL 作为个人化扩展，不覆盖安全和事实规则。 | 持续随工具、权限、记忆变化同步提示词。 |
| doctor | `commands/doctor` | 基本符合。采用分项诊断和可执行修复建议。 | 后续补 `config show --redacted` 和更细错误码。 |
| transcript / session | `utils/sessionStorage*`、`QueryEngine` transcript 记录 | 基本符合第一阶段。已有 JSONL transcript、会话标题、`--resume`、REPL `/resume` 选择器、compact boundary 和 tool result pairing 校验。 | M5 继续补手动 `/compact`、更精细消息分组和超大工具结果恢复策略。 |
| 上下文历史 | `query.ts`、`services/compact/*`、`sessionStoragePortable.ts` | 部分符合。已从固定几轮改为预算化历史，并加入自动 compact 摘要；但还缺 token 估算、手动 `/compact`、可恢复 boundary 和更精细的消息分组。 | M5 继续按 CC-Source compact/session 机制补齐。 |
| 联网工具 | `tools/WebSearchTool`、`tools/WebFetchTool`、`query.ts` 工具循环 | 当前核心路径基本符合。已改为 `WebSearch` / `WebFetch` function tools，由 `QueryEngine` 处理 tool call/result 回灌，并补上域名 allow/deny、私有地址保护、Tavily map/crawl 路径过滤、工具状态事件、失败恢复提示和流式文本共存。 | 后续继续补更细粒度进度。 |
| 主 agent loop | `QueryEngine.ts`、`query.ts`、`Tool.ts`、`StreamingToolExecutor`、tool result storage | 基本符合第一阶段。已拆出最小 `QueryEngine` 和 `ToolRunner`，工具结果按同一 loop 回灌；已补工具级 timeout/abort、只读工具并发、独占工具串行、重复 tool id 规整、orphan result 日志、流式输出、终止型工具结果、统一工具结果预算、超大结果落盘引用和 hook 事件预留。 | 后续补历史消息级 aggregate budget、更精细的恢复策略和更完整任务状态。 |
| 项目文件工具 | `FileReadTool`、`GlobTool`、`GrepTool`、`utils/ripgrep.ts`、filesystem permissions | 基本符合第一阶段。已加入 `Read` / `Glob` / `Grep` / `Write` / `Edit` 并进入 `QueryEngine`；默认限制在启动目录内，可通过配置显式加入额外 read/write roots；`Grep` 后端已改为 `rg`，写入/编辑必须交互确认。 | 后续补完整 permission rules、会话级目录授权、图片/PDF/二进制专用处理和统一工具结果预算。 |
| MCP | `MCPTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool`、`ToolSearchTool`、`services/mcp/mcpStringUtils.ts`、`.mcp.json` | 基本符合第一阶段。已连接 MCP 工具会以 `mcp__server__tool` 形式进入 `QueryEngine` 标准 tool loop，并加入默认只读、显式 allow/deny、stdio/http/sse 配置、OAuth bearer、resource 工具、deferred ToolSearch、REPL 一次性/持久权限确认和项目级 `.mcp.json` server 配置。 | M4/M5 继续补项目级 server 审批、权限建议、企业 allow/deny 策略和更完整权限 UI。 |
| sub-agent | `tools/AgentTool`、`tasks/LocalAgentTask`、agent memory snapshot | 基本符合任务记录第一阶段。已从一次性调用升级为前台/后台任务、状态落盘、停止、任务 transcript 和无工具隔离边界。 | 后续补真正可恢复后台执行、工具化 sub-agent、进度事件和更细隔离策略。 |
| skill | `skills/loadSkillsDir.ts`、`tools/SkillTool`、`tools/SkillTool/prompt.ts`、`utils/suggestions/skillUsageTracking.ts`、`utils/skills/skillChangeDetector.ts`、`utils/hooks/skillImprovement.ts`、plugin `skillsPath/skillsPaths`、zip cache/install helpers | 基本符合。已有 SKILL.md 发现、自动创建建议、CLI 生命周期命令和 REPL 管理命令；已补 `.md`/目录/`.zip` 安装、导出、校验、项目/全局 scope、dry-run、覆盖保护、zip-slip 防护、预算化 listing、`QueryEngine` 中的显式 Skill tool、usage tracking、按需轻量 reload、plugin manifest skill 导入、用户确认后写入、skill 改进建议、本目录资源引用、只读执行边界和轻量 marketplace 本地索引。 | 后续继续补 `allowed-tools`、forked skill、hooks 权限确认和资源读取专用工具。 |
| memory / dreaming | `memdir`、auto-memory、compact/session memory | 部分符合。已有 schema、显式记忆和 dream，但相关性评分、复查、采纳、OpenViking 写入不完整。 | M2 继续按 memdir 和 session memory 思路推进。 |
| terminal REPL | `components/App.tsx`、commands、permission UI、message rendering、`hooks/useInputBuffer.ts`、`hooks/useCancelRequest.ts` | 部分符合。当前 readline REPL 简洁可用，已有 MCP 一次性权限确认、工具事件、请求级取消、持久输入历史、多行输入、每轮状态行和轻量 debug 视图；但离 CC-Source 的完整 TUI、虚拟滚动、富消息渲染和可恢复 UI 状态仍有差距。 | M5 继续补更丰富消息渲染、路由/记忆状态和更完整 TUI。 |
| logging | 日志、debug、analytics 相关模块 | 部分符合。已有 JSONL、轮转、脱敏、工具结果摘要、usage 账本和 retry 事件基础记录，但缺统一 debug 开关、隐私分级和结构化错误码。 | 待办池继续补 debug/error code/privacy level。 |
| vision | 附件处理、图片消息、文件读取限制 | 基本符合第一阶段。MiMo 预分析适合 neo-agent 模型组合；本地图片已做存在性、大小、文件头 mime 校验和测试。 | 后续补图片缓存、截断说明和 PDF/二进制附件处理。 |

审查结论：当前最明显的不合规点“主 agent loop 和工具循环曾内嵌在 `NeoAgent` 中”已经校正为最小 `QueryEngine` / `ToolRunner` 分层，并已把 MCP 工具、Skill tool、文件工具、Capabilities 和 TaskAssessment 接入该 loop。仍不充分的模块主要是统一权限模型、工具结果预算、REPL 富消息渲染、项目级 MCP 配置和更完整权限 UI。开发这些模块时不得继续做孤立实现，必须先对照 CC-Source 对应源代码。

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

参考 CC-Source `skills/loadSkillsDir.ts`、`SkillTool` prompt 和 skill change/usage tracking，neo 第一批先补 `~/.neo-agent/skills/<name>/SKILL.md` 的生命周期管理：CLI 提供 `neo skill list/show/create/edit/delete`，REPL 提供 `/skill list/show/path/edit/delete/create`。`edit` 只在交互式 TTY 且设置了 `VISUAL` 或 `EDITOR` 时打开编辑器，非交互模式只输出文件路径，避免脚本卡死。后来已补项目本地 skill、安装/导出/校验、只读 `Skill` tool、使用统计、按需轻量 reload、plugin manifest 导入、自动创建建议确认、skill 改进建议、本目录资源引用和安全边界。

### 2026-05-25：M3 重新定义为 skill 可用闭环，而不是 CRUD

用户指出 `.md` 和 `.zip` 安装 skill 是基础能力。重新对照 CC-Source 后确认：neo 的 M3 必须覆盖安装、导出、校验、scope、显式调用、预算化 listing、usage tracking 和热加载。后续实现顺序调整为：

1. `neo skill install/validate/export`：先支持 `.md`、标准目录和 `.zip`，补路径安全、覆盖保护、dry-run 和测试。
2. `--scope user|project`：把项目 skill 放入 `.neo-agent/skills`，全局 skill 放入 `~/.neo-agent/skills`，加载时统一合并并显示来源。
3. `Skill` tool：接入 `QueryEngine`，让模型按 CC-Source 方式显式调用 skill；system prompt 只提供预算化 skill 列表。
4. usage tracking 和 success signal：记录使用次数、最近使用和结果信号，用于排序、debug 和 dream/skill 改进建议。
5. hot reload 和 improvement survey：文件变化后刷新缓存；重复任务或失败后提出更新建议，由用户确认后写入。

### 2026-05-25：skill install/validate/export 第一阶段按文件包闭环实现

参考 CC-Source `skills/loadSkillsDir.ts`、plugin zip/cache 安全思路和 `SkillTool` 的“列表轻量、正文按需读取”方向，neo 先把文件型 skill 生命周期补成可用闭环：`neo skill install` 支持 `.md`、标准目录、`.zip` 和 URL，安装目标支持 `--scope user|project`；`validate` 可校验来源或已安装 skill；`export` 可导出标准 zip 包。安装默认拒绝覆盖，必须显式 `--overwrite`；`--dry-run` 只做解析和校验，不写文件。

本阶段已经补 zip-slip、路径穿越、文件数量、单文件大小、包大小和 symlink 跳过；仍未实现 hook 执行能力。skill 文档里的 shell/命令示例不在安装阶段误报为问题，是否执行外部动作由后续工具权限系统控制。后续不得把 skill 继续当作静态 system prompt 拼接，应优先接入 `QueryEngine` 的标准 tool loop。

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

### 2026-05-25：自动创建 skill 改为建议确认，而不是静默写入

早期 `maybeAutoCreate` 会在重复任务达到阈值后直接写入 skill。重新对照 CC-Source 的权限确认和 skill 建议思路后，这个行为过于激进：skill 会长期影响后续模型行为，必须让用户知道并确认。neo 现在改为 `maybeSuggestSkill`：仍记录重复任务 pattern，但只生成 `SkillSuggestion`，写入 transcript 的 `skill_suggestion` 事件；REPL 在回答后询问用户是否创建，确认后才调用 `createSuggestedSkill`。`neo ask` 等非交互入口只输出建议提示，不自动创建。

这个调整保留了“发现重复工作流”的智能性，同时把长期行为变更的控制权交回用户。后续 skill 改进建议也必须沿用同一原则：提出建议、展示差异、用户确认后写入。

### 2026-05-25：skill 改进建议先检测长期偏好，确认后追加

参考 CC-Source `utils/hooks/skillImprovement.ts` 后，neo 先实现保守版本：当本轮实际调用了 `Skill` tool，并且用户输入包含“以后、每次、不要、也要、记住、always、never”等长期偏好或修正信号时，生成 `SkillImprovementSuggestion`。建议进入日志和 transcript，但不会直接改文件；REPL 展示建议后询问用户，确认后才在 `SKILL.md` 末尾追加 `User-confirmed improvements` 区块。

这里没有直接照搬 CC-Source 的“侧路模型重写完整 skill 文件”。原因是当前 neo 的权限和 diff UI 还不成熟，整文件重写风险较高。追加确认区块虽然不如自动重写优雅，但更可审计、可回滚、低风险；后续等 diff 展示和用户确认 UI 成熟后，再升级为模型生成补丁或结构化 rewrite。

### 2026-05-25：skill 本目录资源引用按 CC-Source 兼容，但先不绕过文件权限

参考 CC-Source `tools/SkillTool/SkillTool.ts` 和 `skills/loadSkillsDir.ts`，neo 在 `Skill` tool 返回完整正文时注入 `Base directory for this skill: <skillDir>`，并把 `${NEO_SKILL_DIR}` 和 `${CLAUDE_SKILL_DIR}` 都替换为当前 skill 根目录。这样从 CC-Source 导入的 skill 可以继续使用 `${CLAUDE_SKILL_DIR}`，neo 原生 skill 则使用 `${NEO_SKILL_DIR}`。

本阶段采用“青出于蓝”的保守边界：工具结果只列出 skill 根目录内的非隐藏资源相对路径和大小，不直接读取资源正文，也不允许模型把 skill 目录当作绕过项目文件权限的通道。skill 内 shell、hook 或命令片段仍只是说明文字，不会自动执行；如果未来支持 hooks、命令或专门的 skill resource 读取工具，必须接入 `QueryEngine` 的标准工具事件、权限确认和日志脱敏。

### 2026-05-25：对话内安装 skill 包必须走工具，而不是让模型读 zip

用户测试 `@skills-main.zip 安装这个包里所有skill` 时，neo 只暴露了 `Read` / `Glob` / `Grep`，导致模型尝试读取 zip 文本并失败。根因是 CLI 已有 `neo skill install`，但能力没有进入统一 `QueryEngine` 工具层，违反“功能入口统一 tool 化”的原则。

已补 `InstallSkillPackage` 工具，复用现有 `buildSkillInstallPlans` / `installSkillPlan`，默认只允许读取当前项目目录内的本地来源，默认安装到 project scope，不执行 skill 内 shell/hook。zip 解析也从“只支持单个 `SKILL.md`”升级为“按每个 `SKILL.md` 生成一个安装计划”，支持仓库包里批量安装所有 skill。包级文件数量上限从 100 提高到 1000，以适配 skills 仓库类 zip，同时继续保留包大小、单文件大小、路径穿越和 zip-slip 校验。

### 2026-05-25：安装类工具必须防重复调用，并跳过已存在 skill

继续测试发现，`InstallSkillPackage` 第一次已经成功安装 17 个 skill，但模型又重复调用安装工具，后续因为目录已存在而失败，最终回答误判为安装失败。修复方式不是继续增加重试，而是在 `ToolExecutionResult` 中加入 `terminal` 标记：安装类工具成功或确认已安装后，`QueryEngine` 直接以 `toolChoice=none` 要求模型总结结果，不再开放下一轮工具调用。

同时，`InstallSkillPackage` 在安装前会检查目标 scope 中已存在的 skill。若全部已存在，返回 `already_installed`；若部分已存在，则跳过已有项并安装缺失项，避免用户上次半安装后需要手动清理。skill 自动沉淀也增加了操作型任务过滤：安装、导入、删除、查看、解压、同步这类一次性动作不会触发“创建 skill”建议；如果工具调用中包含 `InstallSkillPackage`，本轮也不会做自动沉淀建议。

### 2026-05-25：用户说安装就安装，不让模型自作主张 dry-run

继续测试发现，模型在用户明确说“安装”时仍自行传入 `dry_run=true`，导致 neo 只预览不写入。修复方式是从对话内 `InstallSkillPackage` 的模型可见 schema 中移除 `dry_run`，并在工具实现中强制真实安装；dry-run 只保留在 CLI `neo skill install --dry-run` 入口。这样自然语言入口符合直觉：用户说安装就是安装，只有命令行显式传 `--dry-run` 才预览。

真实 `skills-main.zip` 还暴露了 zip 目录项兼容问题：部分资源目录会以目录占位项进入 zip，如果先当文件写入，后续创建同名目录会失败。zip 解析现在会在 normalize 前识别并跳过目录项和目录占位项。CLI 安装也统一为“跳过已存在、安装缺失项”，和对话工具保持一致。

### 2026-05-25：skill 校验按 CC/Codex 常见格式收敛，避免误报

继续测试发现，neo 把 CC/Codex 常见 skill 包误报为“缺少 triggers/when_to_use”和“包含 shell 执行片段”。这不符合 CC-Source 的实际设计：`description` 本身就是模型发现 skill 的主要依据之一，`triggers` 不是必填项；skill 文档里出现命令示例也不代表安装风险，因为 neo 不会在安装或加载 skill 时自动执行命令。

已调整校验器：只把缺少 `description`、空 `SKILL.md`、文件过大、路径安全等作为安装校验问题；不再把缺少 triggers 或存在命令示例作为 warning 返回给模型。执行安全继续放在工具权限层处理，而不是在安装阶段制造噪音。

### 2026-05-25：配置命令先做轻量 user/project 分层和脱敏输出

参考 CC-Source `utils/settings/settings.ts`、`utils/settings/types.ts` 和 doctor/status notice 对配置来源与校验的处理，neo 先补最小可用配置闭环：`neo config show` 默认输出 merged 配置并脱敏 API key、token、secret、password 等敏感字段；可用 `--source user|project|merged` 查看不同来源；`neo config set <path> <value>` 默认写入用户配置，也支持 `--scope project` 写入 `neo-agent.config.json`。

没有直接照搬 CC-Source 的 managed settings、MDM/policy、drop-in 目录和复杂 setting source 优先级。原因是 neo 当前是个人 agent，先需要简单、可审计、不会泄露密钥的配置管理。写入前会把 defaults/user/project 合并后过完整 schema 校验，非法值不会落盘；后续如果补企业/团队共享配置，再按 CC-Source 的 setting source 和 policy 体系升级。

### 2026-05-25：模型客户端先补可靠调用，再补成本账本

参考 CC-Source `QueryEngine.ts` 中对 abort controller、retry event、usage 累计和 cost tracker 的处理，neo 先在 OpenAI-compatible 客户端补基础可靠性：每个模型配置包含 `requestTimeoutMs`、`maxRetries` 和 `retryBaseDelayMs`；请求会合并用户取消信号和超时信号；5xx、429、网络错误和超时会指数退避重试，4xx 参数/认证错误不重试；取消会单独记录为 cancelled，不进入错误重试。

本阶段没有直接实现完整 cost tracker 和 `neo usage` 命令。原因是不同模型供应商的价格表和返回 usage 字段不完全一致，先把响应中的 `prompt_tokens`、`completion_tokens`、`total_tokens` 解析出来并写入结构化日志，保证后续成本账本可以复用同一字段。后续再补按模型价格配置计算成本、按天落盘和 `neo usage` 视图。

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

参考 CC-Source `mcp add/list/remove` 的命令结构，neo 先实现用户级 stdio MCP 配置管理：`neo mcp add/list/remove/test`。命令直接维护 `~/.neo-agent/config.json` 中的 `mcp.servers`，`list` 默认只展示 env 数量而不打印 env 值，`test` 会尝试连接并列出工具数量。后续已补 HTTP/SSE/OAuth 和 REPL 持久权限确认；项目级 scope、交互式导入和 token 安全存储仍待继续按 CC-Source 的 MCP config/service 分层补齐。

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

### 2026-05-25：Grep 后端改为 rg

参考 CC-Source `utils/ripgrep.ts` 和 `tools/GrepTool/GrepTool.ts`，neo 将 `Grep` 从 Node.js 手写遍历文件内容升级为调用 `rg`。这样默认继承 ripgrep 的二进制跳过、正则搜索性能和大仓库表现，同时在 neo 层继续保留项目根目录边界、忽略目录、超时、最大输出、取消信号和错误分类。

本阶段没有直接照搬 CC-Source 的内置/embedded ripgrep 分发逻辑。原因是 neo 当前通过 npm/本机环境运行，先依赖 PATH 中的 `rg` 更简单；如果后续发布成单文件或跨平台安装包，再按 CC-Source 的 bundled ripgrep 策略补齐。验证覆盖 content 输出、以 `-` 开头的 pattern、二进制文件不返回匹配、项目外路径拒绝和 smoke 全量测试。

### 2026-05-25：QueryEngine 工具生命周期补并发、超时和 orphan result

参考 CC-Source `StreamingToolExecutor`、`query.ts` 和 `QueryEngine.ts`，neo 在 `ToolRunner` 上增加 `executionMode`：只读安全工具可并发，默认工具串行，写入或会改变工具集合的工具独占执行。同一轮如果出现独占工具，其它 sibling tool call 会收到结构化 skipped tool result，避免模型消息里出现 tool_use 没有对应 tool_result 的不合法状态。

每个工具调用现在都有子 `AbortController` 和工具级超时。超时或用户取消会先 abort 子信号；`rg` 子进程会 SIGTERM 后升级 SIGKILL，MCP stdio 工具会关闭对应 client 并从连接表移除，Tavily/模型请求继续走 fetch abort。若底层工具忽略取消并在超时后迟到返回，`QueryEngine` 会记录 `tool.orphan_result` 日志，但不会把迟到结果回灌给模型，避免污染当前对话轨迹。这是对 CC-Source orphan tool result 思路的个人版实现。

### 2026-05-25：REPL 先补日常可用性的最小 TUI 能力

参考 CC-Source `ink/components/App.tsx`、`ink/termio/csi.ts`、`ink/parse-keypress.ts`、`hooks/useTextInput.ts` 和 `useCancelRequest.ts`，neo 的 readline REPL 先补四个日常能力：持久输入历史、多行输入、每轮状态行和轻量 debug 视图。历史写入 `~/.neo-agent/repl_history`，但会跳过疑似 API key/token 的输入；进入交互式 REPL 时主动开启 raw mode、bracketed paste，并写入 `CSI >1u`（Kitty keyboard protocol）和 `CSI >4;2m`（xterm modifyOtherKeys），退出时恢复。这让支持增强键盘协议的终端在 SSH 场景中也能把 `Ctrl+Enter` 发成可区分的 CSI 序列。`Ctrl+Enter` / `Ctrl+J` 不再把上一行放进不可编辑的临时 buffer，而是在当前输入缓冲区插入真正换行，用户可以继续移动光标和修改前文；直接粘贴多行文本也会作为同一个输入缓冲区处理。启动提示仍会根据 `TERM_PROGRAM`、`TERM`、`WEZTERM_PANE`、`KITTY_WINDOW_ID`、`WT_SESSION`、`TMUX`、`VTE_VERSION`、`SSH_CONNECTION` 等环境变量显示当前终端判断；可用 `NEO_AGENT_TERMINAL=powershell|wezterm|kitty|vscode|iterm|windows-terminal` 手动覆盖显示。每轮回答后显示模型、工具调用数和耗时；`/debug on|off|last` 可查看最近一轮工具事件、日志路径和 transcript 路径。

这里没有直接复制 CC-Source 的 Ink TUI。原因是 neo 当前仍是轻量 CLI，直接引入完整 TUI 会显著增加复杂度；先把最影响日常使用的输入和调试能力补齐。后续 M5 继续补更丰富消息渲染、路由/记忆状态和更接近 CC-Source 的交互层。

用户测试发现两类问题：启动 banner 输出了过多终端协议说明；粘贴两行长文本时出现 prompt 重复刷屏，并且粘贴末尾换行会被当成提交。修复前对照 CC-Source `parse-keypress.ts`、`hooks/useTextInput.ts`、`utils/Cursor.ts` 和 Ink 渲染层：CC-Source 会把 bracketed paste 汇总为一次 paste key，普通多字符 paste 中的 `\r` 会转为 `\n`，同时按终端列宽和 wrap 后屏幕行数管理光标与重绘。neo 已按这个方向修正：启动 banner 只保留简短入口提示，终端细节移到 `/status`/`/help`；bracketed paste 支持跨 chunk 汇总，非 bracketed 的多字符粘贴会归一化换行并去掉末尾单个换行，避免自动提交；输入重绘按 `stdout.columns` 估算实际屏幕行数，防止长行 wrap 后旧内容残留。验证方式：`npm run smoke`、真实 TTY bracketed paste 两行长文本、真实 TTY 普通 CR 分隔粘贴，两者均未自动提交且未重复刷 prompt。

继续参考 CC-Source `hooks/usePasteHandler.ts`、`components/PromptInput/PromptInput.tsx` 和 `history.ts` 的大段粘贴处理：CC-Source 超过 `PASTE_THRESHOLD=800` 或行数超过输入框展示预算时，会在输入框里插入粘贴引用，旁路保存完整内容，提交时再展开。neo 已加入同类机制：大段粘贴或超过两处换行的粘贴在输入框里显示为 `[Pasted Content N chars]`，但回车提交、slash command、transcript 和模型输入拿到的都是完整原文。验证方式：真实 TTY 中 `/remember ` 后粘贴四行文本，输入框只显示 `[Pasted Content 203 chars]`，提交后的 transcript 和 memory 均保存完整四行内容。

### 2026-05-25：P1 附件解析测试和图片校验前移

参考 CC-Source `utils/imagePaste.ts`、`utils/imageResizer.ts`、`utils/imageValidation.ts` 和 `bridge/inboundAttachments.ts`，图片附件不应只靠扩展名进入后续模型链路。neo 的 `extractImageAttachments` 现在会对本地图片做存在性、普通文件、大小和文件头格式校验，并根据文件头推断 `mimeType`；URL 图片仍按 URL pathname 推断 mime，避免查询参数影响扩展名判断。大小限制按 CC-Source API 图片 base64 5MB 上限折算为约 3.75MB 原始文件预算。REPL 的附件解析错误已移入单轮错误处理范围，错误只结束当前请求，不退出 REPL。新增 smoke 测试覆盖：不存在文件、伪装成图片的非图片、本地大图、文件头 mime 推断和带 query 的远程 URL mime 推断。

### 2026-05-25：P1 Logger 脱敏测试和日志隐私兜底

参考 CC-Source 日志和隐私处理思路，日志只应记录调试所需的结构化摘要，不应落盘完整密钥、Bearer token、URL query、图片 base64 或 MCP/tool 原始参数。neo 的 `Logger` 现在会对 URL query 做统一脱敏，对 `arguments/args/params/parameters` 只保留 `keys/chars/items` 摘要；具体工具层仍由 `toolLog` 保留域名、参数键、查询长度、结果长度等可调试信息。新增 smoke 测试覆盖 `redact`、`serializeError` 和真实日志文件写入，确保 API key、URL query、MCP 参数和错误栈不会泄露原文。

### 2026-05-25：P1 记忆搜索排序相关性硬化

参考 CC-Source `memdir/findRelevantMemories.ts` 和 `memoryScan.ts` 的思路，记忆召回不能只靠“命中任意词 + 新近/置顶”排序，否则弱相关置顶记忆会压过真正有用的上下文。neo 当前仍是本地 JSON 记忆阶段，先在 `LocalMemory` 层增强候选评分：中文改为连续片段和重叠二元词，评分区分 category、tag、content、完整短语、命中覆盖率、指数新近度和受限置顶加分。新增 smoke 测试覆盖强相关优先、归档过滤、弱相关置顶不抢首位，以及 workflow 分类和内容共同命中的排序。

### 2026-05-25：P1 剩余项收口

参考 CC-Source `ResumeConversation`、session storage、compact boundary 和 tool result pairing 思路，neo 现在支持从 transcript 恢复上下文：`neo --resume` / `neo chat --resume` 默认恢复最近会话，也可以指定 session id 或 transcript 文件路径。恢复时会读取最后一个 compact 之后的用户/助手消息，并把 compact 摘要重新注入 `ConversationHistory`；`transcripts` 和 `/transcripts` 会显示从首个用户消息推断出的会话标题。assistant transcript 元数据现在记录每轮 tool call 与 tool result 的配对摘要，恢复时会校验是否存在未配对结果并写入 warning。

参考 CC-Source cost-tracker，neo 新增 `UsageTracker` 和 `neo usage`。模型客户端在成功响应后把 token usage 写入 `usage/model-usage.jsonl`，`neo usage` 可按模型和日期聚合 token 与估算成本。价格表不写死在代码中，避免供应商调价后误导用户；可以通过配置 `usage.prices.<model>.inputPerMillion/outputPerMillion/currency` 或环境变量 `NEO_AGENT_USAGE_PRICES_JSON` 提供单价，未配置时会显示“未配置单价”。

同一轮完成的 P1 项还包括：dreaming 锁文件、报告回放、人工采纳和记忆复查；MCP always allow/deny 持久化、远程 HTTP/SSE/OAuth；Web 工具缓存、URL 去重、失败分类和多日期冲突提示。验证方式：`npm run typecheck` 和 `npm run smoke` 全量通过。

用户复查后指出：只提供启动参数 `--resume` 和 CLI `neo usage` 不符合 REPL 的日常使用方式，也不方便在不知道 session id 时恢复会话。已补齐 REPL `/resume [session]` 和 `/usage [天数]`；`/resume` 不带参数时等价于恢复上一个会话，且会跳过当前刚启动的空 session，避免“latest 恢复到自己”。`/transcripts` 用于查看最近会话 id 和标题；启动前仍可用 `neo --resume` 或 `neo chat --resume`。验证覆盖 `TranscriptService latest` 跳过当前 session、REPL `/resume latest` 无历史时给出明确提示，以及 `/usage` 在 REPL 内输出 usage 视图。

用户进一步指出：恢复会话不应该要求先 `/transcripts` 再复制 session id，CC-Source 已有无参数 `/resume` 打开历史会话选择器的交互。已重新对照 CC-Source `commands/resume/resume.tsx`、`screens/ResumeConversation.tsx`、`components/ResumeTask.tsx` 和 `CustomSelect`：其核心是无参数打开 picker、过滤当前 session、按最近更新时间排序、用 ↑/↓ 和 Enter 选择；带参数时才按 session id 或标题直接恢复。neo 已按这个模式补轻量 raw TTY 选择器：`/resume` 直接列出最近 50 个可恢复 transcript，支持 ↑/↓、j/k、PageUp/PageDown、Enter 恢复、Esc/q 取消；非交互输入仍保持 `/resume` 走 latest，便于脚本和 smoke 测试。验证方式：`npm run typecheck` 和 `npm run smoke`。

用户测试发现 `/resume` 选择器在长中文标题下刷新错位。原因是 neo 的轻量选择器按逻辑行数清屏，而终端会把过长标题自动换行成多屏幕行；CC-Source 的 Ink/Select 会按终端宽度进行布局和渲染。neo 已修正为：每个 session 选项按 `stdout.columns` 计算显示宽度，标题按中英文显示宽度裁剪到单行；刷新清屏按实际屏幕行数计算，避免 wrapped line 残留。验证方式：`npm run typecheck` 和 `npm run smoke`。

### 2026-05-25：P2 发布、生态和长期能力闭环

参考 CC-Source `StreamingToolExecutor`、`LocalAgentTask`、`AgentTool`、`FileWriteTool`、`FileEditTool`、`schemas/hooks.ts`、`hookEvents.ts`、plugin marketplace 和 `releaseNotes` / `version` 命令后，neo 的 P2 按个人版边界完成第一阶段：

1. 流式输出：`OpenAICompatibleClient` 支持 OpenAI-compatible SSE，能够增量拼接 `content`、`reasoning_content` 和 streaming tool call delta。`QueryEngine` 在 tool loop 内传递 `onContentDelta`，REPL 默认流式展示，`neo ask --stream` 支持单次流式输出；工具进度继续走独立 `ToolProgressEvent`。
2. 发布与安装自检：新增 `CHANGELOG.md`、`neo self-check` 和 `npm run release:check`。release check 会校验 CHANGELOG 覆盖当前 package version，并运行 typecheck、build 和安装自检。
3. marketplace：新增本地 `~/.neo-agent/marketplace/skills.json` 索引和 `neo marketplace init/list/show/install`。条目 source 可指向 `.md`、skill 目录、zip 或 plugin 目录；plugin source 继续复用已有 `skillsPath/skillsPaths` 导入能力，不启用完整插件安装、hooks、MCP 注入和远程 marketplace UI。
4. sub-agent 任务系统：`SubAgentRunner` 从一次性调用升级为任务记录，写入 `~/.neo-agent/tasks/subagents/*.json`，支持前台/后台、list/show/stop、状态、输出/错误记录和无工具隔离边界。当前后台任务是当前 neo 进程内执行；进程退出后可恢复记录但不能恢复已中断推理。
5. 文件写入：`FileToolRunner` 增加 `Write`/`Edit`，仅允许项目内普通文件，拒绝符号链接，写入前必须通过 REPL 权限确认；非交互入口默认拒绝。`Write` 用于创建/覆盖完整文本，`Edit` 用于精确字符串替换，默认要求唯一匹配。
6. hooks 预留：新增 `HookBus`，已预留 `PostToolUse`、`PermissionRequest`、`Stop`、`Notification` 事件。当前只记录内部事件和日志，不执行 shell、HTTP、prompt 或 agent hook，避免在权限模型成熟前引入隐式外部执行。

本阶段没有直接照搬 CC-Source 完整 TUI、后台任务运行器、插件市场和 hook 执行器，原因是 neo 当前是个人终端 MVP，权限、任务面板和插件信任模型还未达到完整承载条件。保留的接口和事件名与 CC-Source 对齐，后续可以继续向完整 permission rules、后台任务恢复、hook 执行和 marketplace 缓存演进。

### 2026-05-25：运行时能力快照，避免模型凭记忆自述能力

用户测试发现，问 neo “目前你的能力如何”时，neo 会基于 system prompt、记忆和已有上下文回答，但没有强制读取当前真实工具集，因此容易把“本轮没有调用工具”误理解成“没有工具变化”，也可能漏掉刚新增的能力。已新增统一能力快照：

- `Capabilities` 工具：进入 `QueryEngine` 标准 tool loop，返回当前模型、工作目录、Web、文件工具、写入确认状态、skill、MCP、sub-agent、hooks 和 runtime tool definitions。
- `neo capabilities` / `neo capabilities --json`：CLI 直接查看同一份快照。
- REPL `/capabilities` / `/caps`：交互中查看同一份快照。
- system prompt 新增规则：用户询问当前能力、能力范围、可用工具、是否能读写文件/联网/MCP/skill/sub-agent 时，必须先调用 `Capabilities`，不能只凭记忆回答。

这让“neo 如何知道自己能做什么”从模型自述升级为运行时事实查询。后续如果新增 shell、浏览器、图片生成、完整 hooks 等能力，只要对应 ToolRunner 或配置进入快照，neo 的自我描述就会同步更新。

### 2026-05-25：任务可行性评估，规划前先比对能力边界

用户进一步追问：当用户给出任务时，neo 如何知道自己是否可以完成？如果只靠模型根据 prompt 自行判断，复杂任务会把“推理能力”和“执行环境能力”混在一起。已新增 `TaskAssessment`：

- `TaskAssessment` 工具：从任务文本识别文件读写、联网、shell、MCP/API、sub-agent、hook、图片、vision、skill 等需求，并和 `Capabilities` 快照比对。
- `neo assess <任务>` / `neo assess --json <任务>`：CLI 直接查看 complete/partial/blocked、缺失能力、需要用户输入和推荐策略。
- REPL `/assess <任务>`：交互中快速判断任务边界。
- system prompt 新增规则：复杂任务或用户询问能否完成时，先调用 `TaskAssessment`；partial/blocked 时要先说明缺失能力和替代路径，再继续能做的部分。

这让“neo 如何知道自己能不能做某个任务”从模型主观估计升级为“任务需求解析 + 运行时能力快照”的显式判定。当前规则仍是轻量确定性分类，后续可继续加入模型辅助分解、任务 DAG、风险分级和执行后校验。

### 2026-05-25：文件工具 scope 权限硬化第一步

继续参考 CC-Source `utils/permissions/filesystem.ts`、`FilePermissionDialog/permissionOptions.tsx` 和 workspace directory 的设计后，neo 先补保守版额外目录 scope：默认仍只允许访问启动目录；用户可以通过 `files.additionalReadDirs` / `files.additionalWriteDirs` 或 `NEO_AGENT_FILE_READ_DIRS` / `NEO_AGENT_FILE_WRITE_DIRS` 显式加入项目外目录。写入目录会同时进入读取 scope，便于 `Edit` 先读后改；但所有 `Write` / `Edit` 仍必须走 REPL 交互式确认，非交互入口继续拒绝。

本阶段没有实现 CC-Source 的会话内 “allow this directory during session” UI，也不持久化文件权限规则。原因是 neo 当前还没有完整权限面板和规则冲突检测；先做配置级白名单可以满足明确的项目外资料访问，又不会把一次性确认扩大成长期授权。验证覆盖额外读取目录的 `Read`/`Grep`、额外写入目录的 `Write`，以及未授权路径仍被拒绝。

### 2026-05-25：workspace 目录成为默认完全访问工作区

用户确认的目标是：给 neo 分配一个工作区目录，并赋予它对这个目录内文件和文件夹的完整操作权限。参考 CC-Source workspace directory 的思路后，neo 增加 `workspace.dir` 配置和 `NEO_AGENT_WORKSPACE_DIR` 环境变量，默认值为当前项目下的 `workspace/`。启动时会自动创建并解析真实路径；`Read`/`Glob`/`Grep` 可访问项目、workspace 和显式授权目录，`Write`/`Edit` 在 workspace 内无需额外确认，写入项目其它位置或额外写入目录仍必须走 REPL 权限确认。

这里没有把整个项目目录都升级为无确认可写。原因是项目根目录通常包含源码、配置和密钥引用，完全放开会让一次模型误判直接覆盖关键文件；workspace 则是明确分配给 neo 的可操作区域，边界更清楚，也更符合后续做会话级目录授权和权限 UI 的方向。验证覆盖 workspace 写入/编辑无需确认、项目写入仍被确认拦截、额外写入目录仍需确认，以及能力快照展示当前 workspace 配置。

### 2026-05-26：Web robots.txt 限制第一阶段

继续收敛 M4 Web 硬化项时，先补最小 robots 执行边界：`WebFetch`、`neo web extract`、map 和 crawl 在请求 Tavily 前读取目标站点 `robots.txt`，对 `User-agent: *` 或 `neo-agent` 命中的 `Disallow` 路径直接拒绝，不再把该 URL 交给 Tavily。默认开启，可用 `NEO_AGENT_WEB_RESPECT_ROBOTS_TXT=0` 关闭。

这一步只解决执行期 robots 拒绝，不扩展成完整站点策略面板；后续仍保留下载预算、重定向预检和更细粒度进度等 Web 硬化项。

### 2026-05-26：Web 下载正文预算第一阶段

继续收敛 M4 Web 硬化项时，`extract` 和 `crawl` 返回正文现在会经过 `web.maxDownloadChars` 总量预算，默认 200000 字符，也可用 `NEO_AGENT_WEB_MAX_DOWNLOAD_CHARS` 调整。超过预算的正文会截断并写入 warning，避免大页面或 crawl 结果直接挤爆上下文。

这一步只处理 Tavily 返回正文进入 neo 内部结构前的预算保护；后续仍保留更细粒度下载进度和完整站点策略。

### 2026-05-25：统一工具结果预算和落盘引用

参考 CC-Source `utils/toolResultStorage.ts` 的大结果持久化和 message-level budget 思路，neo 在 `QueryEngine` 成功工具结果路径上加入统一预算层。默认 `toolResults.enabled=true`，超过 `toolResults.maxInlineChars` 的工具结果会完整写入 `.neo-agent/tool-results/YYYY-MM-DD/`，回灌给模型的 tool result 只保留路径、预览和提示；模型需要完整内容时可以用 `Read` 读取该路径。配置支持 `NEO_AGENT_TOOL_RESULTS_DIR`、`NEO_AGENT_TOOL_RESULTS_MAX_INLINE_CHARS`、`NEO_AGENT_TOOL_RESULTS_PREVIEW_CHARS` 和 `NEO_AGENT_TOOL_RESULTS_ENABLED=0`。

本阶段刻意放在 `QueryEngine` 层，而不是每个工具单独截断，确保 Web、MCP、文件、Skill、Capabilities 等工具共享同一预算策略。`toolPairs` 会记录 `persistedPath` 和 `originalResultChars`，便于 transcript 恢复和调试。尚未实现 CC-Source 的历史消息级 aggregate budget 和稳定 replacement state；后续如果恢复历史时发现旧 tool result 总量过大，需要继续补“按消息组冻结替换决策”的机制，避免破坏 prompt cache 或 tool result pairing。验证覆盖超大工具结果落盘、预览回灌、原始文件可读取、toolPairs 摘要和 `tool.result_persisted` 日志。

### 2026-05-25：MCP 项目级 `.mcp.json` 兼容

参考 CC-Source `services/mcp/config.ts` 对项目级 `.mcp.json` 的处理，neo 新增第一阶段兼容：启动时会读取当前目录 `.mcp.json` 的顶层 `mcpServers` 并合并到 `config.mcp.servers`；`neo mcp add/list/remove` 增加 `--scope user|project`，项目 scope 写入 `.mcp.json`，用户 scope 继续写入 `~/.neo-agent/config.json`。`neo mcp list` 默认同时列出 user 和 project，并显示 scope；`config show --source merged` 也能看到 `.mcp.json` 进入后的 merged MCP server。

本阶段没有照搬 CC-Source 的 workspace trust / server approval dialog。原因是 neo 当前还没有完整权限面板和项目可信任状态；贸然自动审批或持久化项目 server 选择会扩大外部进程启动风险。当前边界是：`.mcp.json` 只负责共享 server 配置，MCP 工具执行仍受 readOnly、allowedTools/deniedTools 和 REPL 权限确认约束；持久 allow/deny 仍写用户级配置。验证覆盖项目 `.mcp.json` 写入、项目 scope list、merged config 读取、用户级 MCP 行为不回退。

## 恢复开发检查清单

开始新的开发任务前：

1. 运行 `git status --short --branch`。
2. 阅读本文档的“当前状态”和“近期里程碑”。
3. 选择下一个未完成任务；如果优先级变化，先更新任务列表。
4. 实现功能或修复问题。
5. 运行 `npm run typecheck` 和 `npm run build`。
6. 如果状态、决策或优先级变化，更新本文档。
7. 提交并推送到 GitHub。

## 近期执行记录

### 2026-05-26：开发计划重新收束

用户反馈长期开发、中断和需求叠加导致计划失控。已将原 `DEVELOPMENT_PLAN.md` 的长篇历史迁移为 `DEVELOPMENT_LOG.md`，并重写短版 `DEVELOPMENT_PLAN.md`：只保留当前基线、P0/P1/P2、暂停事项、恢复流程和建议下一步。结论是：M1/M3/M4/P1/P2 第一阶段基本收口，近期不再横向扩功能，主线回到权限、可恢复、终端体验、诊断日志和 OpenViking 收口。

### 2026-05-26：统一权限模型第一阶段

按新计划推进 P0“统一权限模型第一阶段”。先对照 CC-Source：

- `src/types/permissions.ts` 和 `utils/permissions/PermissionResult.ts`：权限结果统一为 `allow` / `ask` / `deny` / `passthrough`。
- `utils/permissions/PermissionRule.ts` 和 `utils/permissions/permissions.ts`：权限规则按来源和行为组织，由统一入口判断工具是否可用。
- `utils/permissions/filesystem.ts` 与 `components/permissions/FilePermissionDialog/permissionOptions.tsx`：文件权限区分工作区、一次允许和会话级目录允许。
- `tools/MCPTool/MCPTool.ts`：MCP tool 自身返回 passthrough，由统一权限系统处理确认。

neo 没有直接照搬完整 CC-Source 权限系统，因为当前还没有完整 TUI、permission mode、会话级目录授权和多来源 settings 规则。第一阶段采用保守抽象：新增 `src/permissions/permissions.ts`，统一 `PermissionDecision`、`allow|ask|deny`、通配规则匹配、文件写入、MCP 和 Web hostname 判定。随后把三个已存在入口接入：

- `FileToolRunner.requireWritePermission`：workspace 内 allow，项目/额外写入目录 ask，非交互 deny，默认行为不变。
- `McpToolRunner.evaluateMcpToolPermission`：保留旧的 `{ allowed, code, reason }` 外部返回，内部改由统一 decision 生成。
- `web/urlPolicy.validateHostname`：先生成 Web permission decision，再沿用原有抛错行为。

验证：`npm run typecheck`、`npm run build`、`npm run smoke` 全部通过；新增 smoke 覆盖统一权限核心、Web decision、MCP deny 优先和文件非交互写入拒绝。

### 2026-05-26：QueryEngine 历史 tool result 预算和恢复引用

继续推进 P0“QueryEngine 历史消息级预算和可恢复 tool result 策略”。先对照 CC-Source：

- `utils/toolResultStorage.ts`：大工具结果写入 session 目录，只把预览和路径放回上下文。
- `services/api/claude.ts`：API 前会修复 tool_use/tool_result pairing，避免 resume 后消息不合法。
- `utils/sessionStoragePortable.ts`：resume 时按 compact boundary 读取，避免大 transcript 全量进入内存。
- `commands/branch/branch.ts`：fork/resume 要保留 content-replacement 记录，否则旧工具结果会重新以完整内容进入上下文。

neo 之前已经有单个大工具结果落盘，但多个中等工具结果在同一轮 tool loop 中累计后，仍可能把下一轮模型上下文撑大。此次补齐：

- `applyToolHistoryBudget`：对当前 `loopMessages` 中的 tool result 做 aggregate budget；累计超过 `toolResults.maxInlineChars` 时，将较早 tool result 写入同一 tool-results 目录，并把消息替换成 `<neo_tool_result_persisted>` 引用。
- `QueryEngine.applyHistoryToolResultBudget`：每轮工具执行后应用历史预算，并更新对应 `toolPairs` 的 `persistedPath` 和 `originalResultChars`，避免 transcript metadata 与实际上下文脱节。
- `TranscriptService.loadConversationSnapshot`：resume snapshot 遇到 assistant metadata 中有持久化 tool result 时，会在恢复上下文里附加“历史工具结果引用”，让模型知道完整结果仍可通过路径读取。

这不是完整 CC-Source content-replacement 系统；neo 仍保持轻量 JSONL transcript 和字符串消息结构。当前实现重点是防止当前 tool loop 被累计结果撑爆，同时让被移出的结果可追溯、可读取、可在 resume 后被模型看见路径。验证：`npm run typecheck` 和 `npm run smoke` 通过；新增 smoke 覆盖累计工具结果预算落盘、`toolPairs` 路径记录和 resume snapshot 恢复历史工具结果引用。

### 2026-05-26：doctor 深度诊断第一阶段

继续推进 P0“doctor 深度诊断”。先对照 CC-Source：

- `utils/doctorDiagnostic.ts`：安装类型、版本、PATH、多安装、更新权限和 ripgrep 诊断。
- `utils/doctorContextWarnings.ts`：上下文体积、agent/工具描述、MCP 工具上下文和规则可达性 warning。
- `screens/Doctor.tsx`：doctor 不是单点自检，而是把安装、配置、上下文、权限、MCP、环境变量和 sandbox 等问题集中展示。

neo 当前没有完整 Ink Doctor screen，也没有 CC-Source 的多 settings source、sandbox manager 和 plugin runtime。因此第一阶段不引入 UI 层，只扩展现有 `neo doctor` 文本报告：新增版本信息、ripgrep、上下文预算、workspace 可写性、额外文件读写范围、tool results 目录和预算、skill 根目录扫描、配置文件权限检查。已有模型 key、日志、transcript、SOUL、OpenViking、Web、MCP 和构建产物检查保持原样。

验证：`npm run typecheck` 和 `npm run smoke` 通过；doctor smoke 现在覆盖新增的上下文预算、Workspace、Tool results、Skills、配置文件权限和 ripgrep 输出。

### 2026-05-26：日志 debug、错误码和隐私分级第一阶段

继续推进 P1“日志系统补 debug 开关、结构化错误码、usage/retry 统计和隐私分级”。先对照 CC-Source：

- `utils/debug.ts`：debug 日志可以由启动参数或运行期命令开启，并写入可 tail 的 session log。
- `utils/log.ts`：错误会进入内存/持久化错误日志，并保留足够的 stack 和错误元数据用于排障。
- `utils/diagLogs.ts`：诊断日志必须明确 No-PII 边界，不能写入路径、prompt、query、URL、token 等敏感数据。
- `skills/bundled/debug.ts`：debug 入口应能提示当前日志路径，并读取最近日志辅助排障。

neo 当前已有 JSONL Logger、日志轮转、脱敏和 REPL `/debug` 视图，因此没有引入新的日志后端。第一阶段采用增量扩展：

- `Logger` 增加运行期 debug 提升：`NEO_AGENT_DEBUG=1`、`--debug` 和 REPL `/debug on` 都会把当前进程日志级别提升到 debug。
- 所有日志记录增加 `privacy` 标记；默认 `redacted`，新增 `logger.diagnostic(...)` 用于 No-PII 诊断字段，路径、prompt、content、query、URL、token/key 等字段会被强制替换。
- `logger.error(...)` 自动生成结构化 `errorCode`，`serializeError` 保留脱敏后的 `code/status/category`。
- 模型请求日志补 `retryCount`、retry 的 `errorCode/maxAttempts`，usage 记录补 `retryCount` 并增加 debug 级 `usage.record` 摘要。
- 工具错误日志补结构化 `errorCode`，便于从日志中区分权限、超时、网络和工具自身失败。

验证：`npm run typecheck` 和 `npm run smoke` 通过；新增/扩展 smoke 覆盖运行期 debug 开关、`privacy` 标记、No-PII diagnostic、结构化 `errorCode`、模型 retry 日志和 retryCount。

### 2026-05-26：文件工具类型预检和读取预算第一阶段

继续推进 P1“文件工具补图片/PDF/二进制处理、读取预算和更清晰的拒绝原因”。先对照 CC-Source：

- `tools/FileReadTool/FileReadTool.ts`：Read 是只读工具，但会先做二进制扩展名/设备文件/PDF/图片等预检；大文件受 maxSize 和 maxTokens 双重预算约束。
- `tools/FileReadTool/prompt.ts`：Read prompt 会明确行号格式、offset/limit、图片、PDF、notebook、目录不可读和空文件提示。
- `tools/GrepTool/GrepTool.ts`：Grep 会把分页限制写回 tool result，让模型知道可以用 offset/head_limit 继续。

neo 当前没有 CC-Source 的多模态 tool result block、PDF renderer 或 notebook reader，因此第一阶段不假装已经能抽取完整图片/PDF 内容，而是把边界说清楚：

- `Read` 新增文件头和扩展名预检。图片返回 `mimeType/size/dimensions` 元数据摘要；PDF 返回 `size/estimatedPages` 元数据摘要；普通二进制直接拒绝，并给出恢复建议。
- 文本读取保留 512KB 总字节预算，并明确说明 `offset/limit` 只控制返回行数，不能绕过总字节预算。
- 文本结果新增 `[Showing lines ...; offset=...; limit=...]` 分页提示，截断时提示继续读取方式；空文件用 system reminder 风格提示。
- 路径不存在、读取越界、写入越界和缺失父目录的错误信息更具体，减少模型重复错误参数。
- 文件工具 prompt 同步说明图片/PDF/二进制和预算限制。

验证：`npm run typecheck` 和 `npm run smoke` 通过；新增 smoke 覆盖图片元数据、PDF 元数据、二进制拒绝、大文件预算、分页提示、缺失路径和越界读写拒绝。

### 2026-05-26：视觉预分析卡住排查和取消修复

用户测试“描述项目目录下的 `test.png`”时，REPL 长时间停留在 thinking。排查最近日志和 transcript 后确认：图片附件已正确识别，问题发生在视觉预分析阶段。`test.png` 为 1024x1536、约 2.6MB 的 PNG，本地转 data URL 后进入 MiMo 视觉模型；第一次请求 60 秒超时，随后重试，约 101 秒后视觉模型返回，但用户已经取消请求，因此主模型没有机会生成最终回答。

根因不是文件 Read 工具，而是 `VisionAnalyzer.analyze(...)` 没有接收/传递 `AbortSignal`，导致 Ctrl-C 后仍要等待视觉请求结束；同时视觉预分析发生在主模型/tool loop 之前，REPL 只有 `thinking...`，没有说明当前在图片预分析。

修复：

- `VisionAnalyzer.analyze` 增加 `signal` 参数，并传给视觉模型请求；本地图片读取和请求前后都会检查取消。
- 视觉阶段新增 `vision.analyze.start`、`vision.attachment.prepared`、`vision.analyze.success/cancelled/error` 日志，记录附件数量、字节数、data URL 字符数、耗时等排障信息。
- 图片请求的 `image_url` 增加 `detail: 'low'`，降低视觉模型处理压力。
- REPL 检测到图片附件时输出“vision: 正在预分析...”提示，避免用户只看到 thinking。
- smoke 增加视觉预分析取消信号和日志覆盖。

验证：`npm run typecheck` 和 `npm run smoke` 通过。

### 2026-05-26：MCP 项目级 server 审批和权限建议

继续推进 P1“MCP 补项目级 server 审批、权限建议和更完整权限 UI”。先对照 CC-Source：

- `services/mcp/config.ts`：项目 `.mcp.json` 属于独立 scope，配置读取要保留来源和权限信息，不能把项目配置当作无条件可信用户配置。
- `commands/mcp/addCommand.ts`：MCP server 写入 scope 时要明确 transport、目标和配置来源。
- `commands/plugin/PluginTrustWarning.tsx`：外部 server、插件和本地软件需要用户显式信任，不能假设仓库内容安全。

neo 当前已经兼容 `.mcp.json`，但之前会把项目 `mcpServers` 直接合入运行时配置，意味着仓库里的项目 MCP server 会被 agent 初始化和 `mcp test` 看到。修复后：

- 项目 `.mcp.json` 中的 MCP server 默认只列出为 `approval=pending`，不会进入 merged config，也不会被 agent 加载或测试。
- 审批状态保存在用户配置 `mcp.projectApprovals`，按项目绝对路径绑定；审批不写入 `.mcp.json`，避免仓库配置自我授权。
- 新增 `neo mcp approve <name> --scope project` 和 `neo mcp unapprove <name> --scope project`。
- `neo mcp add/list` 会展示 `approval=pending|approved`，并提示启用命令。
- MCP 权限拒绝原因和 REPL 权限确认提示补充 `neo mcp permission allow <tool>`，让持久授权路径更直接。

验证：`npm run typecheck`、`npm run smoke` 和 `git diff --check` 通过；smoke 覆盖项目 MCP 未审批不进入 merged config、审批后进入、撤销审批后移除，以及权限建议输出。

## 未决问题

- OpenViking 的持久化写入应使用哪一个稳定 API 接口？
- 项目本地 skill 默认应该放在 `.neo-agent/skills`，还是继续放在用户全局 `~/.neo-agent/skills`？
- CC-Source 的终端 UI 代码应该复制多少，哪些部分应该在更小的 TUI 层里重新实现？
- MCP 工具和未来文件系统动作应该采用怎样的权限模型？
- Tavily API key 应放入 `~/.neo-agent/config.json` 还是只支持 `TAVILY_API_KEY` 环境变量？
- 网页浏览结果是否需要本地缓存，缓存保留多久，是否进入长期记忆？
