# neo-agent

个人终端 AI agent MVP，按 `PRD.md` 的方向实现：

- 终端 REPL 交互，保留类似 CC-Source 的 slash command 使用习惯。
- 主模型 `deepseek-v4-pro`、小模型 `deepseek-v4-flash`、视觉模型 `mimo-v2.5`，都按 OpenAI-compatible API 调用。
- 文本智能路由：短文本走小模型，开发/架构/复杂任务走主模型。
- 图片智能路由：输入包含 `@image:/path/a.png` 或 `@/path/a.png` 时，先调用 `mimo-v2.5` 生成视觉 primitives，再交给 DeepSeek 推理。
- 记忆功能：OpenViking 可作为主存储，本地 `~/.neo-agent/memory/memories.json` 作为备份和离线回退；记忆按 `preference/project_fact/workflow/session_summary` 分类。
- skill 功能：`~/.neo-agent/skills/*/SKILL.md`，会按触发词匹配；重复任务达到阈值后会自动创建 skill。
- MCP：支持在配置中声明 stdio MCP server；已连接 MCP 工具会以 `mcp__server__tool` 形式进入模型 tool loop。
- sub-agent：`/agent <task>` 用小模型执行聚焦子任务。
- sub-agent 任务系统：支持前台/后台任务、状态列表、停止和任务记录回放。
- 灵魂设定：`SOUL.md` 定义 neo 的长期人格、风格和与你的协作关系，并会进入 system prompt。
- dreaming：`neo dream` 或 `/dream` 会整理记忆和近期 transcript，提炼长期记忆与灵感报告。
- 联网能力：`neo web search/extract/map/crawl` 通过 Tavily 搜索互联网、读取网页正文、发现站点 URL 和有限深度爬取。
- 自动联网：普通 ask/REPL 默认把 `WebSearch`、`WebFetch` 暴露为模型可调用工具，由模型在回答过程中自行搜索或读取网页；关闭 tool loop 后才回落到过渡版小模型 planner。
- 项目文件工具：普通 ask/REPL 默认提供 `Read`、`Glob`、`Grep`、`List`、`Write`、`Append`、`Edit`、`Mkdir`、`Copy`、`Move`、`Delete`，可访问当前项目目录、默认 `workspace/` 和显式授权的额外目录。
- 工作区目录：默认 `workspace/`，可用 `neo workspace show/set/reset`、`workspace.dir` 或 `NEO_AGENT_WORKSPACE_DIR` 配置；workspace 内拥有完整文件管理权限，写入项目其它位置仍需交互式确认。
- Shell/Python：模型可通过 `Bash` 和 `Python` 在 workspace 内执行命令；只读低风险 Bash 自动执行，高风险 Bash 和 Python 需要交互确认。
- TUI：`neo chat` 默认进入 Ink TUI 入口层；`neo chat --legacy` 或 `NEO_AGENT_LEGACY_REPL=1` 可回退 legacy readline REPL。
- 流式输出：REPL 默认流式显示模型文本；`neo ask --stream` 可对单次提问启用流式输出，工具进度会继续独立显示。
- 轻量 marketplace：`neo marketplace` 管理本地 skill/plugin 索引，复用 skill 安装和 plugin `skillsPath/skillsPaths` 导入。
- 发布自检：`neo self-check` 和 `npm run release:check` 检查版本、CHANGELOG、构建产物和基础配置。
- 能力快照：`neo capabilities`、REPL `/capabilities` 和模型工具 `Capabilities` 会读取当前运行时能力范围。
- 任务可行性评估：`neo assess`、REPL `/assess` 和模型工具 `TaskAssessment` 会基于运行时能力快照判断任务是否可完整完成。
- 会话上下文：REPL 会保留当前 session 的对话历史，并按上下文预算裁剪，不是固定几轮。

当前开发主线见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)，二阶段计划见 [PHASE2_DEVELOPMENT_PLAN.md](./PHASE2_DEVELOPMENT_PLAN.md)，历史决策和长篇复盘见 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md)。

## 安装与运行

```bash
npm install
npm run build
npm run dev -- chat
npm run dev -- chat --legacy
```

初始化配置：

```bash
npm run dev -- config:init
```

配置 API key：

```bash
cp .env.example .env
export DEEPSEEK_API_KEY=...
export MIMO_API_KEY=...
export MIMO_API_BASE=...
```

也可以编辑 `~/.neo-agent/config.json`。

配置 Tavily 联网搜索：

```bash
export TAVILY_API_KEY=...
```

## 常用命令

```text
/help                 查看命令
/remember <内容>      保存一条用户记忆，支持 --type/--tag/--pin
/memory [查询词]      查看或搜索记忆，支持 --type
/memory-update <id|uri> <新内容>
/memory-delete <id|uri>
/memory-pin <id|uri>
/memory-export [数量]
/skills               查看已加载的 skill
/skill create <名称> :: <描述>
/mcp                  查看已连接的 MCP 工具
/logs [行数]          查看最近的 JSONL 日志
/transcript [行数]    查看当前会话 transcript
/transcripts [数量]   查看最近会话 transcript 列表
/agent <任务>         把聚焦任务交给小模型 sub-agent
/agent bg <任务>      后台启动 sub-agent 任务
/agent list/show/stop 查看或停止 sub-agent 任务
/capabilities         查看当前运行时能力快照
/assess <任务>        评估任务是否可完成
/workspace            查看当前 workspace 路径和权限
/hooks                查看 hook 预留事件
/dream [--dry-run]    整理记忆并提炼灵感
/web search <查询词>  联网搜索
/web extract <url>    提取网页正文
/web map <url>        发现站点 URL
/web crawl <url>      有限深度爬取站点正文
```

一次性提问：

```bash
npm run dev -- ask "帮我总结 PRD.md"
npm run dev -- ask "分析这个页面 @image:/tmp/screen.png"
neo ask --stream "帮我解释这个仓库的入口"
neo ask "Tavily 最近的 API 文档有什么变化？"
neo ask --no-web "只根据你已有知识回答这个问题"
```

查看日志：

```bash
neo logs
neo logs --lines 200
```

默认日志写入 `~/.neo-agent/logs/neo-agent.log`，格式是 JSONL。日志会记录启动、路由、模型请求耗时、记忆检索、MCP 连接和错误摘要；API key、Authorization header 和图片 base64 会被脱敏。

日志默认单文件超过 5MB 会轮转，归档保留 14 天，最多保留 20 个归档文件。可通过 `NEO_AGENT_LOG_MAX_BYTES`、`NEO_AGENT_LOG_RETENTION_DAYS`、`NEO_AGENT_LOG_MAX_FILES` 调整。

查看对话 transcript：

```bash
neo transcripts
neo transcripts --tail <sessionId>
```

默认 transcript 写入 `~/.neo-agent/transcripts/YYYY-MM-DD/<sessionId>.jsonl`，用于回顾会话和后续调试。

记忆类型：

- `preference`：用户偏好、长期目标、沟通方式和协作习惯。
- `project_fact`：项目目标、约束、决策背景和时间点，且不是直接读代码就能知道的信息。
- `workflow`：用户认可的重复流程、检查清单和工作方法。
- `session_summary`：对未来有价值的会话摘要，不保存临时流水账。

示例：

```text
/remember --type workflow --tag debug --pin 每次改 CLI 后先跑 npm run smoke
/memory --type workflow smoke
/memory-update <id> <新内容>
/memory-delete <id>
/memory-export 20
```

诊断安装和配置：

```bash
neo doctor
```

整理记忆和灵感：

```bash
neo dream --dry-run
neo dream --force --sessions 5
```

默认不会自动调用模型做 dreaming。需要定时整理时，可在环境变量中开启：

```bash
export NEO_AGENT_DREAM_ENABLED=1
export NEO_AGENT_DREAM_MIN_HOURS=24
export NEO_AGENT_DREAM_MIN_SESSIONS=5
```

dream 报告写入 `~/.neo-agent/dream/reports/`，状态写入 `~/.neo-agent/dream/state.json`。

OpenViking 主存储诊断和迁移：

```bash
neo openviking doctor
neo openviking import-local --dry-run
neo openviking import-local --apply
neo openviking sync-pending
```

联网搜索和网页读取：

```bash
neo web search "DeepSeek 最新模型"
neo web search --depth advanced --max-results 8 "TypeScript 5.8 release notes"
neo web extract https://docs.tavily.com/documentation/api-reference/endpoint/search
neo web map https://docs.tavily.com --limit 20 --depth 1
neo web crawl https://docs.tavily.com --limit 5 --depth 1 --select-paths "/documentation/.*" --exclude-paths "/changelog/.*" --instructions "只看 API reference"
```

联网能力默认使用 Tavily，Base URL 为 `https://api.tavily.com`。日志只记录查询长度、URL 数量、结果数量、耗时等元数据，不记录 Tavily API key。`map/crawl` 默认深度为 1、最多 20 页、不开启外部域名，避免一次命令消耗过多额度。

联网工具默认阻止 localhost、内网 IP、链路本地地址和私有地址。可用 `NEO_AGENT_WEB_ALLOWED_DOMAINS` 设置逗号分隔的允许域名列表，用 `NEO_AGENT_WEB_BLOCKED_DOMAINS` 设置拒绝域名列表；`blockedDomains` 优先级更高。确实需要关闭私有地址保护时，可以设置 `NEO_AGENT_WEB_BLOCK_PRIVATE_ADDRESSES=0`，但不建议长期关闭。

`map/crawl` 支持 Tavily 官方的正则过滤参数：`--select-paths`、`--exclude-paths`、`--select-domains`、`--exclude-domains`。也可以通过 `NEO_AGENT_WEB_SELECT_PATHS`、`NEO_AGENT_WEB_EXCLUDE_PATHS`、`NEO_AGENT_WEB_SELECT_DOMAINS`、`NEO_AGENT_WEB_EXCLUDE_DOMAINS` 写入默认过滤规则。

普通自然语言提问默认使用 CC-Source 风格的 tool loop：模型先回答或发起 `WebSearch` / `WebFetch` 工具调用，工具结果作为 `tool` 消息回灌给模型，再继续推理直到最终回答。可用 `neo ask --no-web` 临时关闭，也可设置 `NEO_AGENT_WEB_AUTO_SEARCH=0` 全局关闭。默认最多允许 8 轮联网工具调用，可通过 `NEO_AGENT_WEB_MAX_TOOL_ROUNDS` 调整。若设置 `NEO_AGENT_WEB_TOOL_LOOP_ENABLED=0`，neo 会回落到过渡版小模型 planner；可设置 `NEO_AGENT_WEB_PLANNER_ENABLED=0` 关闭 planner，或通过 `NEO_AGENT_WEB_PLANNER_MODEL_KIND=main` 改用主模型规划。

交互式 REPL 会显示工具开始、成功、失败和达到上限的简短状态行。状态行和日志只展示查询长度、域名、结果数、字符数、MCP server/tool 名等元数据，不展示完整查询词、完整 URL query 或 MCP 参数值。工具失败时，neo 会把结构化错误和恢复提示回灌给模型，让它继续换路径或明确说明未执行。

工具结果默认启用统一预算保护。超过 `NEO_AGENT_TOOL_RESULTS_MAX_INLINE_CHARS` 的结果会完整写入 `.neo-agent/tool-results/YYYY-MM-DD/`，模型上下文里只保留路径和预览，避免大网页、MCP resource 或文件片段挤爆上下文。可用 `NEO_AGENT_TOOL_RESULTS_DIR` 调整目录，`NEO_AGENT_TOOL_RESULTS_PREVIEW_CHARS` 调整预览大小，或用 `NEO_AGENT_TOOL_RESULTS_ENABLED=0` 关闭。

REPL 会保留当前 session 的对话上下文，默认最多约 300000 字符，可通过 `NEO_AGENT_CONVERSATION_MAX_HISTORY_CHARS` 调整。单条消息默认最多保留 50000 字符，可通过 `NEO_AGENT_CONVERSATION_MAX_MESSAGE_CHARS` 调整。接近上下文预算时，neo 会参考 CC-Source compact 思路，用小模型把较早对话压缩成“自动压缩的历史摘要”，再保留近期原文；可用 `NEO_AGENT_CONVERSATION_COMPACT_ENABLED=0` 关闭，或用 `NEO_AGENT_CONVERSATION_COMPACT_THRESHOLD_RATIO`、`NEO_AGENT_CONVERSATION_COMPACT_KEEP_RECENT_CHARS`、`NEO_AGENT_CONVERSATION_COMPACT_MAX_SUMMARY_CHARS` 调整阈值和摘要大小。

普通 ask/REPL 会向模型提供项目文件工具：`Read` 读取文件片段，`Glob` 按文件名查找文件，`Grep` 搜索文件内容，`List` 列出目录，`Write/Append/Edit/Mkdir/Copy/Move/Delete` 管理文件。这些工具默认可以访问启动 neo 时所在项目目录、工作区目录和显式授权的额外目录，并默认跳过 `.git`、`node_modules`、`dist` 等噪声目录。

工作区默认是当前项目下的 `workspace/`。可以用以下命令查看和修改：

```bash
neo workspace show
neo workspace set ./workspace --scope project
neo workspace set /tmp/neo-workspace --scope user
neo workspace reset --scope project
```

也可以用 `NEO_AGENT_WORKSPACE_DIR=/path/workspace` 或配置 `workspace.dir` 改成相对项目目录的路径或绝对路径；环境变量优先级最高。确实需要读取项目外资料时，可以用 `NEO_AGENT_FILE_READ_DIRS=/path/a,/path/b` 或配置 `files.additionalReadDirs` 显式加入额外读取目录。

workspace 内拥有完整文件管理权限，不再额外询问；写入项目目录其它位置或 `files.additionalWriteDirs` 授权目录时，会显示路径、操作摘要和字符数，并要求用户确认。`Delete` 默认移动到 `workspace/.neo-trash/`；只有 `permanent=true` 且用户确认后才会永久删除。`neo ask` 等非交互入口只能自动写入 workspace；需要写入项目外目录时，必须用 `NEO_AGENT_FILE_WRITE_DIRS=/path/out` 或配置 `files.additionalWriteDirs` 显式加入额外写入目录，且仍然需要交互确认。

生成长 HTML/CSS/JS、落地页或完整单文件应用时，模型会优先写入 workspace 文件。如果完整文件能放进一次合法工具参数，优先用 `Write` 一次写完；只有内容明显超出当前输出预算或已经发生工具参数截断时，才用 `Append` 分块写入：第一块 `mode=create`，后续块 `mode=append`。`Append` 不应按 section 切成很多小块，普通单文件落地页应尽量 1-3 次工具调用写完。

模型服务端支持的最大输出不等于 neo 当前请求实际使用的输出上限。默认配置按当前模型能力设置：`deepseek-v4-pro` 和 `deepseek-v4-flash` 为 393216，`mimo-v2.5` 为 131072。已有用户配置文件可能仍保留旧值，可以用 `neo config set models.main.maxTokens <数字>`、`neo config set models.small.maxTokens <数字>`、`neo config set models.vision.maxTokens <数字>` 写入配置，或用 `NEO_AGENT_MAIN_MAX_TOKENS`、`NEO_AGENT_SMALL_MAX_TOKENS`、`NEO_AGENT_VISION_MAX_TOKENS` 临时覆盖。

模型还可以使用 `Bash` 和 `Python` 在 workspace 内执行命令。`Bash` 默认 cwd 是 workspace，显式 `cwd` 也必须位于 workspace 内；`pwd/ls/find/rg/grep/cat/head/tail/wc/stat/file/du/tree` 等只读低风险命令会自动执行。写入、删除、安装、网络、git mutation、权限变更、后台进程、环境变量导出、shell 组合和重定向等高风险 Bash 需要交互确认。`Python` 会写入 `workspace/.neo-agent/tmp/python-*.py` 后执行，默认每次都需要确认。

当前 hook 生态只预留 `PostToolUse`、`PermissionRequest`、`Stop`、`Notification` 内部事件，不执行外部 shell/HTTP/prompt hook。

联网工具默认阻止 localhost、内网 IP、链路本地地址、私有地址和配置中拒绝的域名。`WebFetch`、`web extract/map/crawl` 请求 Tavily 前会读取目标站点 `robots.txt`，命中 `Disallow` 时拒绝继续；可用 `NEO_AGENT_WEB_RESPECT_ROBOTS_TXT=0` 关闭 robots 检查，但不建议长期关闭。`extract/crawl` 的正文总量默认受 `web.maxDownloadChars` / `NEO_AGENT_WEB_MAX_DOWNLOAD_CHARS` 保护，超出后会截断并写入 warning。

sub-agent 任务：

```bash
neo agent run "检查 src/index.ts 的命令结构"
neo agent run --background "总结 README 中的配置说明"
neo agent list
neo agent show <taskId>
neo agent stop <taskId>
```

marketplace 第一阶段是本地索引文件，不引入完整插件生态：

```bash
neo marketplace init
neo marketplace list
neo marketplace install <name> --scope project
```

索引文件位于 `~/.neo-agent/marketplace/skills.json`，每个条目的 `source` 可以指向 `.md`、标准 skill 目录、`.zip` 或包含 `plugin.json` 的 plugin 目录。

发布和安装自检：

```bash
neo self-check
npm run release:check
```

查看 neo 当前真实能力范围：

```bash
neo capabilities
neo capabilities --json
```

在 REPL 中也可以使用 `/capabilities`。当普通对话里询问“你现在能做什么”“有哪些工具”“当前能力如何”时，neo 会优先调用 `Capabilities` 工具读取运行时快照，再基于事实回答。

评估一个任务当前能否完成：

```bash
neo assess "阅读 README 并总结"
neo assess --json "运行 npm test 并修复失败"
```

在 REPL 中也可以使用 `/assess <任务>`。当普通对话里出现复杂任务或用户询问“你是否能完成这个任务”时，neo 会先调用 `TaskAssessment`，把任务需要的能力和当前可用能力做比对，再说明可以直接做、只能部分做，还是必须等待用户补齐能力或输入。

运行 CLI 冒烟测试：

```bash
npm run smoke
```

## MCP 配置示例

可以用命令管理用户级 MCP 配置：

```bash
neo mcp list
neo mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/eason
neo mcp add --env GITHUB_TOKEN=xxx github -- npx -y @modelcontextprotocol/server-github
neo mcp add --scope project playwright -- npx -y @playwright/mcp
neo mcp test filesystem
neo mcp remove filesystem
```

在 `~/.neo-agent/config.json` 里添加：

```json
{
  "mcp": {
    "permissions": {
      "mode": "readOnly",
      "allowedTools": [],
      "deniedTools": []
    },
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/eason"]
      }
    }
  }
}
```

MCP 工具会以 `mcp__server__tool` 的名字进入模型工具循环。默认权限模式是 `readOnly`：只有 MCP server 明确声明 `readOnlyHint=true` 且不是 destructive 的工具会自动执行。需要执行写入、创建、删除或未声明只读语义的工具时，REPL 会要求你确认是否允许执行；`neo ask` 等非交互入口仍会默认拒绝。也可以把完整工具名加入 `mcp.permissions.allowedTools`，或临时设置 `NEO_AGENT_MCP_PERMISSION_MODE=allowAll`。`deniedTools` 优先级最高，支持完整工具名、`server.tool` 和以 `*` 结尾的前缀规则。

权限确认只会展示工具名、来源、风险说明、参数长度和参数字段名，不会打印完整参数值。REPL 支持一次性允许、始终允许、拒绝和始终拒绝；始终允许/拒绝会写入用户级 `~/.neo-agent/config.json` 的 `allowedTools` / `deniedTools`。后续还需要继续补项目级 `.mcp.json`、更完整的权限建议和统一权限 UI。

当 MCP 工具数量超过 `NEO_AGENT_MCP_TOOL_SEARCH_THRESHOLD`（默认 20）时，neo 会先隐藏大部分 MCP schema，只暴露 `ToolSearch`。模型会先用 `ToolSearch` 搜索并加载需要的 MCP 工具，再在下一轮调用它们。

如果 MCP server 暴露 resources，neo 也会向模型提供只读 `ListMcpResources` 和 `ReadMcpResource` 工具，用于列出和读取资源内容。

`neo mcp add --scope project` 会写入当前目录的 `.mcp.json`，格式兼容 CC-Source 的顶层 `mcpServers`；`neo mcp list --scope project` 只查看项目级 server。启动 neo 时，用户级 `~/.neo-agent/config.json`、项目级 `neo-agent.config.json` 和 `.mcp.json` 会合并，`.mcp.json` 只负责项目共享 server 配置，MCP allow/deny 权限规则仍写入用户级配置。

## OpenViking

OpenViking 官方 GitHub 文档建议将它作为本地独立 HTTP 服务使用，客户端默认示例为 `http://localhost:1933`。neo 可以把 OpenViking 作为主记忆存储，本地 JSON 作为备份和离线恢复：

- 优先调用 OpenViking `/mcp` 的 `health/search/list/store/forget`。
- `/mcp` 不可用时，读取会回退到本地备份或旧 HTTP `/search`。
- 写入不可用时进入 `~/.neo-agent/memory/openviking-pending.json` pending queue。
- 恢复 OpenViking 后可用 `neo openviking sync-pending` 同步离线写入。
- 记忆 URI 使用固定目录：
  - `preference` -> `viking://user/default/memories/preferences/`
  - `project_fact` -> `viking://user/default/memories/project_facts/`
  - `workflow` -> `viking://user/default/memories/workflows/`
  - `session_summary` -> `viking://agent/neo-agent/memories/session_summaries/`

本地服务部署按 OpenViking 官方 GitHub 文档走：

```bash
pip install openviking --upgrade --force-reinstall
openviking-server init
openviking-server doctor
openviking-server
curl http://localhost:1933/health
```

`openviking-server` 同一进程会暴露 REST API 和 `/mcp`，本地 localhost 开发模式不需要额外 API key。启动 OpenViking 后可设置：

```bash
export NEO_AGENT_MEMORY_BACKEND=openviking
export NEO_AGENT_OPENVIKING_URL=http://localhost:1933
```

常用命令：

```bash
neo openviking doctor
neo openviking import-local --dry-run
neo openviking import-local --apply
neo openviking sync-pending
```
