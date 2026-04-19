# OpenClaude v3 — 商用版架构总览

> 创建日期: 2026-04-20
> 分支: `v3`(从 `master` 个人版拉出)
> 目标部署: 45.76.214.99 (替代 v2,域名 `claudeai.chat`)

## 为什么有 v3

v2 走的是 "shared Claude account pool + per-token 计费 + Anthropic SSE 透传 chat"
路线。问题:

1. 账号池失败/封禁会同时影响多个用户;运维负担重。
2. chat 是 stateless 单轮请求,每个用户每次都重头建上下文;没有 sessions、cron、
   mcp memory、agents 这些个人版独有的"AI 助理"特性。
3. 跟个人版功能两条线分叉,功能要双倍维护。

v3 推倒这条路线,改为:

> **"个人版 × N 个用户" — 每个用户都是完整的、隔离的 OpenClaude 个人版实例。**

## 核心思路

```
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare → Caddy → Gateway @ 18789                            │
│                          │                                       │
│   ┌──────────────────────┼──────────────────────┐                │
│   │                      │                      │                │
│   ▼                      ▼                      ▼                │
│  /api/auth/*          /api/billing/*        /api/admin/*         │
│  (注册/登录/邮箱       (充值/积分流水)       (用户/容器/审计)    │
│   /Turnstile)             │                      │               │
│                           │                      │               │
│                           ▼                      ▼               │
│                    PG: users / orders / credit_ledger /          │
│                        admin_audit / agent_subscriptions /       │
│                        agent_containers / refresh_tokens         │
│                                                                  │
│  /ws (chat)                                                      │
│   1. 验 JWT → uid                                                │
│   2. 检查 agent_subscriptions.active && credit_ledger 余额>0      │
│   3. 路由到 agent-u<uid> docker container 内的 OpenClaude WS     │
└──────────────────────────────────────────────────────────────────┘

Per-user docker container "agent-u<uid>":
┌──────────────────────────────────────────────────────────────────┐
│  跑着完整的 OpenClaude 个人版(master 分支)                       │
│  - 独立 sessions.db (用户的会话历史)                              │
│  - 独立 ~/.openclaude/ (用户的 Claude OAuth/API key、cron、agents)│
│  - 独立 mcp memory                                                │
│  - 独立 docker 资源限额(CPU/mem/disk/net)                        │
│  - 出口走宿主机或可选 egress proxy                                │
│  - 容器闲置 N 分钟后被 supervisor 暂停以省内存,下次请求自动唤起   │
└──────────────────────────────────────────────────────────────────┘
```

## 从 v2 继承的子系统

| 模块 | v2 路径 | v3 路径 | 说明 |
|---|---|---|---|
| 用户/认证 | `packages/commercial/src/auth/` | 同 | Argon2id + JWT/refresh + Resend mailer + Turnstile |
| 邮箱校验 | `packages/commercial/src/auth/email_verifications` | 同 | 注册后必校,token 24h 失效 |
| 积分/账本 | `packages/commercial/src/billing/ledger.ts` | 同 | append-only PG RULE,reason 枚举见 ledger.ts |
| 充值 | `packages/commercial/src/payment/hupijiao/` | 同 | 虎皮椒微信扫码 |
| Per-user docker | `packages/commercial/src/agent-sandbox/supervisor.ts` | 同 | docker container 调度 + 健康检查 + 资源限额 |
| Agent 订阅 | `packages/commercial/src/agent/index.ts` | 同 | 月费订阅,unique active per user |
| 管理后台 | `packages/web/public/admin.html` + `commercial/src/admin/*` | **重做**(融入个人版 UI) | 用户/容器/积分/审计 |
| 充值 UI | `packages/web/public/app.html` | **重做**(融入个人版 UI) | 套餐选择 + 二维码扫码 + 余额显示 |

## UI 决策(boss 2026-04-20 拍板)

> **整体 UI 基于个人版构建,不沿用 v2 那套"独立 admin/app/agent 三页"的设计。**

具体落地:
- 单页 `index.html` 仍是入口,沿用个人版 `style.css` + `modules/*.js` 的设计体系
- 商业化功能作为新视图/模态/模块融入,而不是另开 HTML 页面
- 视觉上跟个人版一致(暗色卡片 + 侧边栏 + 主内容区),保持品牌连贯
- 待加的新模块(phase 2/4 落地):
  - `modules/auth.js` — 注册 / 登录 / 邮箱校验回调 / 密码找回
  - `modules/billing.js` — 充值面板(套餐+二维码) / 余额显示 / 流水
  - `modules/admin.js` — 管理面板(只在用户角色 = admin 时挂载)
- 不要 v2 那套独立的 `app.html` / `admin.html` / `agent.html`(已删)

## 从 v2 弃用 / 待清理

| 模块 | 原因 |
|---|---|
| `packages/commercial/src/chat/` | v3 不再做 SSE 透传 chat,改走 docker 内的个人版 chat |
| `packages/commercial/src/ws/chat.ts` + `http/chat.ts` | 同上 |
| `packages/commercial/src/account-pool/` | 不再做账号池;每用户用自己 docker 内的 Claude 凭据 |
| `packages/commercial/src/db/migrations/0009_chat_idempotency.sql` 等 chat 相关迁移 | 留作历史,新部署不需要 |
| `claude_accounts`、`model_pricing`、`usage_records` 表 | 同上,phase 2 一并 drop |

> Phase 1 暂时保留,phase 2 做 chat-removal + drop-tables 迁移。

## 与个人版的关系

v3 = 个人版 × N + 商业化壳层。
- 个人版代码在 `packages/{gateway,storage,cli,web,...}/`
- 商业化代码在 `packages/commercial/`
- 个人版仍然单租户跑,boss 自己的 45.32.41.166 不变
- v3 跑在 45.76.214.99,个人版作为容器镜像被 v3 反复实例化

## 阶段路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | Fork v3 + 导入 v2 commercial 子系统 + 文档 | ✅ 进行中 |
| Phase 2 | WS JWT 鉴权;chat 模块清理;`/ws` 路由层 | 待 |
| Phase 3 | Per-user docker 容器调度 + 个人版镜像构建 | 待 |
| Phase 4 | 计费接入(消息/会话扣费 + 余额门控) | 待 |
| Phase 5 | 部署到 45.76.214.99 切换 Caddy + 数据迁移 | 待 |

## 跑/测/部署

```bash
# 安装
cd /opt/openclaude/openclaude-v3 && npm install

# 类型检查(commercial 子包)
npx tsc --noEmit -p packages/commercial/tsconfig.json

# 单测(commercial,无需 PG)
npm run test:commercial:unit

# 集成测(需要 PG fixture: tests/fixtures/docker-compose.test.yml)
npm run test:commercial:integ

# 启动(需要 COMMERCIAL_ENABLED=1 + DATABASE_URL/REDIS_URL/JWT_SECRET 等环境)
COMMERCIAL_ENABLED=1 npm run gateway

# 部署(phase 5 才会有)
./deploy-to-remote-v3.sh
```

## 安全模型

- 所有面向用户的端点过 Turnstile + rate-limit
- 用户密码 Argon2id (`time=3, memory=64MB, parallelism=4`)
- JWT secret 从 `JWT_SECRET` 环境变量,refresh token 在 PG `refresh_tokens` 可吊销
- 用户容器内 root,但容器外是 unprivileged + seccomp + cap-drop + tmpfs `/tmp` + readonly rootfs(部分)+ no docker socket 进入
- 出口流量默认走宿主网卡(可选注入 egress proxy)
- admin 操作全部走 `admin_audit` PG RULE 强制 append-only,不可篡改

## 决策记录(本次会话 boss 拍板)

1. 部署目标: v3 替换 v2,落地到 45.76.214.99
2. 计费模型: 保留积分/支付(虎皮椒)
3. 隔离粒度: **每用户独立 docker 容器,所有 chat 消息走容器**(不是只 agent 走)
4. v2 上的 chat-removal 工作弃掉(已 stash)
