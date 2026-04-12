# Smart Assistant

> 基于 Claude Code 的全能个人 AI 助理

把 Claude Code Best (CCB) 的强 agent 内核装进多渠道 Gateway 里,支持 Web、Telegram 多端对话,内置三层记忆、技能自进化、多媒体生成、浏览器自动化、多 Agent 协作。

## ✨ 核心特性

### 🤖 多 Provider 支持
- **Claude 订阅** (OAuth PKCE) — 使用 Pro/Team 套餐额度
- **OpenAI Codex** (OAuth) — GPT-5.4 / GPT-5.3-Codex
- **MiniMax** — 图片生成、语音合成、视频生成
- **DeepSeek / 自定义** — 任意 OpenAI 兼容 API

### 🧠 三层记忆系统 (Letta/MemGPT 启发)
- **Core Memory** — USER.md + MEMORY.md,每次对话自动注入 system prompt
- **Recall Memory** — SQLite FTS5 全文搜索历史会话
- **Archival Memory** — 无限容量归档知识库,BM25 检索

### 🛠 技能自进化
- Agent 完成复杂任务后自动 `skill_save` 创建可复用技能
- 每 6 小时 cron job 自动审查会话,提取新技能
- 每日反思 + 每周整理,持续优化记忆和技能库

### 📱 多渠道
- **WebChat** — 现代化 Web UI,支持深色/浅色/跟随系统主题
- **Telegram** — grammY 适配器,DM + 群组
- 活跃渠道智能投递:提醒/心跳推送到用户最后活跃的会话

### 🎨 多媒体
- 图片/音频/视频/PDF 上传与内联渲染
- MiniMax MCP 工具:text_to_image、text_to_audio (speech-2.8-hd)、generate_video
- Lightbox 图片放大,图片操作按钮(复制/下载/新标签页)
- 本地文件路径自动转为内联播放器 (`/api/file`)

### 📊 富内容渲染
- Markdown (marked.js) + 代码高亮 (highlight.js)
- Chart.js 图表 (` ```chart ` JSON 配置)
- Mermaid 流程图/时序图 (` ```mermaid `)
- HTML Preview 沙盒 (` ```htmlpreview ` 含 Canvas/JS)
- DOMPurify 安全清洗所有输出

### 🌐 浏览器自动化
- Playwright MCP 集成,headless Chromium
- 反检测 stealth 脚本 (WebGL/plugins/languages/webdriver)
- Snapshot-driven 操作:accessibility tree + ref 编号

### 🤝 多 Agent 协作
- 每个 Agent 独立配置:model / provider / memory / skills / persona / toolsets
- `send_to_agent` MCP 工具:Agent 间异步消息传递
- `delegate_task` MCP 工具:同步子 Agent 委派(等待结果返回)
- `session_search(agentId)` 跨 Agent 会话搜索
- 动态注入 Agent 列表 + 能力描述到 system prompt

### ⏰ 定时任务 & 提醒
- `create_reminder` / `CronCreate` 均可创建(自动桥接到统一调度)
- Cron YAML 配置,本地时区 (Asia/Shanghai)
- 后台任务系统(TaskStore):持久化任务定义 + 执行记录
- Web UI 任务中心:定时任务 / 后台任务 / 执行记录三 tab
- Heartbeat 每 4 小时主动检查待办事项
- 一次性 (oneshot) 任务自动清理

### 🔔 Webhook 自动化
- YAML 配置 webhook 路由 (`~/.openclaude/webhooks.yaml`)
- HMAC-SHA256 签名验证 (GitHub 兼容)
- 模板变量 `{{dot.path}}` 注入 prompt
- 通过 EventBus 驱动 agent 执行

### 🔌 OpenAI 兼容 API
- `POST /v1/chat/completions` (SSE 流式 + 非流式)
- `GET /v1/models` (列出所有 agent 作为 model)
- 可直接对接 Open WebUI / LobeChat / 其他 OpenAI 兼容客户端

### 🔒 安全
- DOMPurify 清洗所有 HTML 输出
- HttpOnly cookie + Bearer header 双认证
- /api/file 黑名单拦截秘密文件
- WS 上传服务端校验 (25MB 单文件 / 50MB 总量 / MIME 白名单)
- htmlpreview iframe `sandbox="allow-scripts"` (无 same-origin)
- OAuth token 自动刷新 (每 30 分钟)

### ⚡ 可靠性
- stdout 活性超时 (3 分钟无输出才判定卡死)
- API 指数退避重试 (3 次,529/503/502 自动恢复)
- WS ping 保活 (服务端 25s + 客户端 30s 心跳)
- 检查点恢复 (resume-map.json + CCB `--resume`)
- 进程组清理 (detached + SIGKILL 整组)

---

## 🚀 快速开始

### 前置要求
- Node.js 18+
- Bun (用于 CCB agent runtime)
- Linux 服务器 (推荐 Ubuntu 20.04+,2GB+ RAM)

### 安装

```bash
git clone https://github.com/dream-star-end/smart-assistant.git
cd smart-assistant

# 安装 CCB 依赖
cd claude-code-best && bun install && cd ..

# 安装 OpenClaude 依赖
npm install

# 引导式配置
npm run onboard

# 启动 Gateway
npm run gateway
```

### 部署到 VPS

```bash
# 配置部署环境变量
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env 填入服务器信息

# 部署
export DEPLOY_HOST=your-server-ip
export DEPLOY_PORT=22
export DEPLOY_PASSWORD=your-password
python3 deploy/deploy_runner.py local_file remote_path
```

### systemd 服务

```bash
sudo cp deploy/openclaude.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable openclaude
sudo systemctl start openclaude
```

---

## 📁 项目结构

```
smart-assistant/
├── claude-code-best/          # CCB agent runtime (反编译 Claude Code)
│   ├── src/                   # 原 CCB 源码 (QueryEngine, 工具系统, OAuth)
│   └── scripts/dev.ts         # 开发入口
├── packages/
│   ├── protocol/              # TypeBox WS 帧定义
│   ├── storage/               # 配置 / 记忆 / 技能 / 归档存储
│   │   ├── config.ts          # OpenClaudeConfig + AgentDef 接口
│   │   ├── memoryStore.ts     # Core Memory (USER.md + MEMORY.md)
│   │   ├── archivalStore.ts   # Archival Memory (SQLite FTS5)
│   │   ├── sessionsDb.ts      # Recall Memory (FTS5 会话索引)
│   │   └── skillStore.ts      # 技能库 (YAML frontmatter + MD)
│   ├── gateway/               # HTTP + WS 网关
│   │   ├── server.ts          # 路由 / OAuth / Cron / 文件服务
│   │   ├── sessionManager.ts  # 会话管理 (Mutex / 重试 / 超时)
│   │   ├── subprocessRunner.ts# CCB 子进程管理 + 上下文工程
│   │   └── cron.ts            # 定时任务调度器
│   ├── mcp-memory/            # MCP 工具服务器
│   │   └── index.ts           # 12 个工具: memory / session_search / skill_* / archival_* / create_reminder / send_to_agent
│   ├── web/public/            # 前端
│   │   ├── index.html         # HTML 骨架 (413 行)
│   │   ├── style.css          # CSS (1866 行)
│   │   ├── app.js             # JS 逻辑 (2600 行)
│   │   └── vendor/            # 本地化依赖 (marked/hljs/mermaid/DOMPurify/Chart.js)
│   ├── channels/
│   │   ├── telegram/          # grammY Telegram 适配器
│   │   └── webchat/           # WebChat 直连
│   ├── cli/                   # CLI 入口 (onboard / gateway)
│   └── plugin-sdk/            # ChannelAdapter 接口
├── deploy/                    # 部署脚本 + systemd 配置 + 种子 skills
│   ├── .env.example           # 环境变量模板
│   ├── deploy_runner.py       # SSH 部署工具
│   ├── guard.py               # PreToolUse 安全钩子
│   ├── browser-stealth.js     # Playwright 反检测脚本
│   └── seeds/skills/          # 7 个预置系统 skills
└── AUDIT_REMEDIATION_TASKS_2026-04-11.md  # 安全审计整改清单
```

---

## ⚙️ 配置

### `~/.openclaude/openclaude.json`

```json
{
  "version": 1,
  "gateway": { "bind": "0.0.0.0", "port": 18789, "accessToken": "..." },
  "auth": {
    "mode": "subscription",
    "claudeCodePath": "/opt/openclaude/claude-code-best",
    "claudeOAuth": { "accessToken": "...", "refreshToken": "...", "expiresAt": ... }
  },
  "defaults": { "model": "claude-opus-4-6", "permissionMode": "acceptEdits" },
  "provider": "minimax",
  "mcpServers": [
    { "id": "browser", "command": "npx", "args": ["@playwright/mcp@latest", "--headless"] }
  ]
}
```

### `~/.openclaude/agents.yaml`

```yaml
agents:
  - id: main
    model: claude-opus-4-6
    provider: claude-subscription
    displayName: 小米
    avatarEmoji: 🤖
    greeting: 你好！我是你的 AI 助手
    permissionMode: acceptEdits
  - id: research
    model: deepseek-chat
    provider: deepseek
    displayName: 调研助手
routes:
  - match: { channel: webchat }
    agent: main
default: main
```

---

## 🧪 测试

```bash
# 运行安全测试 (23 个用例)
npm test

# 类型检查
npm run typecheck

# 完整检查
npm run check
```

---

## 📜 License

学习研究用途。Claude Code 版权归 Anthropic。
