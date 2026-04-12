# OpenClaude

> Claude Code 级 agent 质量 + OpenClaw 级产品形态 = 个人 AI 助理

把 [Claude Code Best (CCB)](https://github.com/dream-star-end/claude-code-best) 的强 agent 内核(QueryEngine、CLAUDE.md 上下文、智能压缩、细粒度权限、MCP、子 agent)装进一个多渠道 Gateway 里,让你能从浏览器、Telegram、微信、飞书任何一处跟同一个 agent 对话。

## 核心思想

- **CCB 内核完全不改一行**:auth (claude.ai OAuth 订阅 + API key)、API 客户端、工具系统、压缩、权限 全部沿用
- Gateway 给每个会话长驻一个 CCB 子进程,通过 `claude -p --input-format=stream-json --output-format=stream-json --resume <sessionId>` 双向流式 JSONL 通信
- 因为是 CCB 自己直接发请求,从 Anthropic 的视角看就是这台机器上的 Claude Code 在工作 —— 订阅模式天然合法可用
- 渠道适配器 + 路由 + 多 agent persona 全部新增,与 CCB 解耦

## 快速开始

```bash
# 1. 前置:在同级目录有 claude-code-best/(已 git clone),且能跑起来
cd ../claude-code-best && bun install && bun run build && cd ../openclaude

# 2. 安装 OpenClaude 依赖
bun install

# 3. 引导式配置(选登录方式 / 端口 / 渠道)
bun run onboard

# 4. 启动 Gateway
bun run gateway

# 5. 浏览器打开 http://localhost:18789
```

## 架构

```
Browser/Telegram/微信/飞书
        │
        ▼
   Channel Adapter (packages/channels/*)
        │
        ▼
   Gateway WS (packages/gateway)
        │ 路由 = (channel, peer) → sessionKey → agentId
        ▼
   SessionManager (per-session Mutex)
        │ 每个 sessionKey 一个 CCB 子进程
        ▼
   CCB subprocess (claude -p --input-format=stream-json ...)
        │
        ▼
   Anthropic API(用 CCB 自己的订阅 OAuth 或 API key)
```

## 包结构

| 包 | 作用 |
|---|---|
| `packages/protocol` | TypeBox WS 帧定义、sessionKey 派生 |
| `packages/storage` | `~/.openclaude/` 配置、JSONL 会话日志、凭据 |
| `packages/plugin-sdk` | ChannelAdapter 接口 |
| `packages/gateway` | WS server、sessionManager、subprocessRunner、router |
| `packages/channels/webchat` | 浏览器 ↔ Gateway WS 直连 |
| `packages/channels/telegram` | grammY 适配器(stub) |
| `packages/channels/wechat` | 企业微信(stub) |
| `packages/channels/feishu` | 飞书事件订阅(stub) |
| `packages/web` | Lit + Vite 浏览器 UI |
| `packages/cli` | `openclaude` CLI(onboard / gateway / agents / pairing / doctor) |

## License

学习研究用途。Claude Code 版权归 Anthropic。
