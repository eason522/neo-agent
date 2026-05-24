# neo-agent 开发计划

本文档用于持续跟踪 neo-agent 的开发状态、优先级、待办事项和关键决策。每次做有意义的功能变更前后，都要同步更新这份文档，方便后续恢复上下文和回顾进度。

核心要求：neo-agent 的开发要尽可能参考 CC-Source 的对应功能和设计。CC-Source 是优秀且强大的 agent harness 框架；新增能力、命令、提示词、工具、安全策略、记忆、skill、MCP、日志、会话和终端体验，都应先查找 CC-Source 的对应实现，理解其结构和取舍，再做适合 neo-agent 的轻量实现。

## 当前状态

最后更新：2026-05-25

当前项目是一个个人终端 AI agent 的 MVP，已经具备：

- CLI 启动命令：`neo`
- 终端 REPL 交互和 slash command 命令体系
- DeepSeek 主模型/小模型文本路由
- MiMo 图片识别预分析，再交给文本模型推理
- 本地记忆存储，并支持 OpenViking 检索回退
- skill 发现和自动创建的基础框架
- MCP stdio server 连接基础框架
- 聚焦任务的 sub-agent 执行器
- 用于调试的 JSONL 日志系统
- 严格参考 CC-Source 分层结构重写的 system prompt
- `SOUL.md` 长期人格设定
- 对话 transcript 持久化
- 配置诊断命令：`neo doctor`
- 日志轮转和保留策略
- CLI 命令冒烟测试
- 结构化记忆 schema 和显式记忆管理命令
- dreaming 记忆整理命令和定时门控基础
- Tavily Search/Extract/Map/Crawl 联网搜索和网页浏览
- GitHub `main` 分支同步

## 开发规则

- 增加、删除或调整开发任务时，要同步更新 `DEVELOPMENT_PLAN.md`。
- 不要把密钥提交到 git。API key 只能放在 `~/.neo-agent/config.json` 或环境变量里。
- 每次提交前运行 `npm run typecheck` 和 `npm run build`。
- 完成的提交默认推送到 `origin/main`，除非明确需要开分支。
- 不要提交 `node_modules/`、`dist/`、`.env`、本地截图、临时测试图片或临时 skill 实验文件。
- 项目文档和对话说明默认使用中文，除非代码、命令或第三方协议本身必须使用英文。
- 开发任何新功能前，先查找并阅读 CC-Source 中的对应功能；如果没有直接对应功能，也要参考其相近模块的组织方式、风险控制和用户体验。

## 近期里程碑

### M1：可靠的个人 agent 核心

状态：已完成

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

状态：计划中

- [ ] 添加 `neo skill list/show/edit/delete`
- [ ] 记录 skill 使用次数和成功信号
- [ ] 改进自动创建 skill 的判断标准
- [ ] 针对重复任务提出 skill 更新建议
- [ ] 区分全局用户 skill 和项目本地 skill

### M4：工具和 MCP 执行

状态：进行中

- [x] 添加联网能力配置：搜索、网页提取、超时、结果数量、脱敏日志
- [x] 添加站点 map/crawl 配置：最大深度、最大页面数、费用保护
- [ ] 添加站点 map/crawl 路径过滤：select_paths、exclude_paths、select_domains、exclude_domains
- [x] 接入 Tavily Search，作为默认轻量搜索能力
- [x] 接入 Tavily Extract，用于读取指定 URL 的正文和引用来源
- [x] 接入 Tavily Map/Crawl，用于文档站、产品页、项目资料的有限深度浏览
- [x] 添加 `neo web search/extract/map/crawl` 命令和 REPL slash command
- [x] 把联网结果接入 agent 上下文，并要求回答中保留来源链接和时间
- [x] 添加自然语言自动联网判断，支持 `neo ask --no-web` 和 `NEO_AGENT_WEB_AUTO_SEARCH=0`
- [x] 添加 REPL 短期上下文，让“联网搜一下”这类追问能沿用上一轮问题
- [ ] 改进自动联网决策，从启发式升级为小模型规划器，并加入可解释的联网理由
- [ ] 为 MCP 工具执行添加安全调用协议
- [ ] 针对高风险工具添加权限确认
- [ ] 添加 MCP 配置命令：添加、删除、列表、测试
- [ ] 添加工具结果日志，并做好脱敏
- [ ] 添加项目感知的文件系统工具支持

### M5：终端体验向 CC-Source 设计靠拢

状态：计划中

- [ ] 添加更丰富的消息渲染
- [ ] 添加输入历史和多行编辑
- [ ] 添加中断/取消行为
- [ ] 添加状态行，展示模型、记忆命中数和日志路径
- [ ] 添加轻量 debug 视图，展示路由结果和检索到的上下文

## 待办池

- 为 `extractImageAttachments` 添加测试。
- 为 `Logger` 脱敏逻辑添加测试。
- 为记忆搜索排序添加测试。
- 添加 `neo config show --redacted`。
- 添加 `neo config set`，用于修改常见配置。
- 添加模型流式输出。
- 为模型请求添加重试和退避。
- 添加请求超时配置。
- 添加模型用量和成本统计。
- 为常见配置问题添加结构化错误码。
- 添加发布脚本和版本策略。

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

用户希望 neo 像真正的 agent 一样自己判断是否需要搜索或验证。neo 先采用低成本启发式：遇到“最新、今天、当前、搜索、联网、验证、价格、新闻、版本、URL”等信号时自动调用 Tavily Search/Extract，并把联网时间、来源 URL、摘要和正文片段放入模型上下文。普通 `ask` 可用 `--no-web` 禁用，环境变量 `NEO_AGENT_WEB_AUTO_SEARCH=0` 可全局关闭。后续再升级为小模型规划器，降低误触发和漏触发。

### 2026-05-25：REPL 追问必须带上短期上下文

用户指出“你可以联网搜索一下吧”这种追问应该指向上一轮问题，而不是搜索这句话本身。neo 的 REPL/agent 需要保留最近几轮短期对话上下文，并在自动联网规划时把明显的搜索追问改写为上一轮用户问题。政治人物访问、行程是否结束等问题也应默认联网核实，不能只凭模型旧知识回答。

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
