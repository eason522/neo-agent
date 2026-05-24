# neo-agent

个人终端 AI agent MVP，按 `PRD.md` 的方向实现：

- 终端 REPL 交互，保留类似 CC-Source 的 slash command 使用习惯。
- 主模型 `deepseek-v4-pro`、小模型 `deepseek-v4-flash`、视觉模型 `mimo-v2.5`，都按 OpenAI-compatible API 调用。
- 文本智能路由：短文本走小模型，开发/架构/复杂任务走主模型。
- 图片智能路由：输入包含 `@image:/path/a.png` 或 `@/path/a.png` 时，先调用 `mimo-v2.5` 生成视觉 primitives，再交给 DeepSeek 推理。
- 记忆功能：本地 `~/.neo-agent/memory/memories.json` 为默认可靠存储，并可在 `hybrid/openviking` 模式下尝试读取 OpenViking。
- skill 功能：`~/.neo-agent/skills/*/SKILL.md`，会按触发词匹配；重复任务达到阈值后会自动创建 skill。
- MCP：支持在配置中声明 stdio MCP server，并列出/调用工具的基础能力。
- sub-agent：`/agent <task>` 用小模型执行聚焦子任务。
- 灵魂设定：`SOUL.md` 定义 neo 的长期人格、风格和与你的协作关系，并会进入 system prompt。

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

## 常用命令

```text
/help                 查看命令
/remember <内容>      保存一条用户记忆
/memory [查询词]      查看或搜索记忆
/skills               查看已加载的 skill
/skill create <名称> :: <描述>
/mcp                  查看已连接的 MCP 工具
/logs [行数]          查看最近的 JSONL 日志
/transcript [行数]    查看当前会话 transcript
/transcripts [数量]   查看最近会话 transcript 列表
/agent <任务>         把聚焦任务交给小模型 sub-agent
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

查看对话 transcript：

```bash
neo transcripts
neo transcripts --tail <sessionId>
```

默认 transcript 写入 `~/.neo-agent/transcripts/YYYY-MM-DD/<sessionId>.jsonl`，用于回顾会话和后续调试。

诊断安装和配置：

```bash
neo doctor
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
