# neo-agent

个人终端 AI agent MVP，按 `PRD.md` 的方向实现：

- 终端 REPL 交互，保留类似 CC-Source 的 slash command 使用习惯。
- 主模型 `deepseek-v4-pro`、小模型 `deepseek-v4-flash`、视觉模型 `mimo-v2.5`，都按 OpenAI-compatible API 调用。
- 文本智能路由：短文本走小模型，开发/架构/复杂任务走主模型。
- 图片智能路由：输入包含 `@image:/path/a.png` 或 `@/path/a.png` 时，先调用 `mimo-v2.5` 生成视觉 primitives，再交给 DeepSeek 推理。
- 记忆功能：本地 `~/.neo-agent/memory/memories.json` 为默认可靠存储，按 `preference/project_fact/workflow/session_summary` 分类，并可在 `hybrid/openviking` 模式下尝试读取 OpenViking。
- skill 功能：`~/.neo-agent/skills/*/SKILL.md`，会按触发词匹配；重复任务达到阈值后会自动创建 skill。
- MCP：支持在配置中声明 stdio MCP server，并列出/调用工具的基础能力。
- sub-agent：`/agent <task>` 用小模型执行聚焦子任务。
- 灵魂设定：`SOUL.md` 定义 neo 的长期人格、风格和与你的协作关系，并会进入 system prompt。
- dreaming：`neo dream` 或 `/dream` 会整理记忆和近期 transcript，提炼长期记忆与灵感报告。
- 联网能力：`neo web search/extract/map/crawl` 通过 Tavily 搜索互联网、读取网页正文、发现站点 URL 和有限深度爬取。

持续开发进度见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)。

## 安装与运行

```bash
npm install
npm run build
npm run dev -- chat
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

联网搜索和网页读取：

```bash
neo web search "DeepSeek 最新模型"
neo web search --depth advanced --max-results 8 "TypeScript 5.8 release notes"
neo web extract https://docs.tavily.com/documentation/api-reference/endpoint/search
neo web map https://docs.tavily.com --limit 20 --depth 1
neo web crawl https://docs.tavily.com --limit 5 --depth 1 --instructions "只看 API reference"
```

联网能力默认使用 Tavily，Base URL 为 `https://api.tavily.com`。日志只记录查询长度、URL 数量、结果数量、耗时等元数据，不记录 Tavily API key。`map/crawl` 默认深度为 1、最多 20 页、不开启外部域名，避免一次命令消耗过多额度。

运行 CLI 冒烟测试：

```bash
npm run smoke
```

## MCP 配置示例

在 `~/.neo-agent/config.json` 里添加：

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/eason"]
      }
    }
  }
}
```

## OpenViking

OpenViking 官方文档建议将它作为独立 HTTP 服务使用，客户端默认示例为 `http://localhost:1933`。当前实现采用保守接入：

- 本地记忆始终可用。
- `NEO_AGENT_MEMORY_BACKEND=hybrid` 时会优先尝试 OpenViking HTTP/CLI 检索，失败时自动回落到本地记忆。
- 记忆 URI 使用 `viking://user/memories/...` 形式，方便后续迁移到 OpenViking 的文件系统范式。

启动 OpenViking 后可设置：

```bash
export NEO_AGENT_MEMORY_BACKEND=hybrid
export NEO_AGENT_OPENVIKING_URL=http://localhost:1933
```
