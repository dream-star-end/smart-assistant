# 02 技术架构(ARCHITECTURE)

## 1. 总览

```
  Internet
     │
     ▼
  ┌──────────────────────────────────────────┐
  │  Cloudflare (orange cloud + Turnstile)   │
  └──────────────┬───────────────────────────┘
                 │ HTTPS (claudeai.chat)
                 ▼
  ┌──────────────────────────────────────────┐
  │  Caddy (reverse proxy, 38.55.134.227)    │
  └──────────────┬───────────────────────────┘
                 │ HTTP :18789
                 ▼
  ┌──────────────────────────────────────────────────────┐
  │  Gateway (Node + TSX, packages/gateway)              │
  │                                                       │
  │   Middlewares:                                       │
  │     · requestId → logger → cors                      │
  │     · rateLimit (global + per-user)                  │
  │     · authJwt (optional for public routes)           │
  │     · billingPreCheck (LLM 路由前置)                  │
  │                                                       │
  │   Routes:                                            │
  │     · /api/auth/*          (register/login/refresh)  │
  │     · /api/me              (profile)                 │
  │     · /api/billing/*       (balance/ledger/topup)    │
  │     · /api/payment/hupi/*  (create/callback)         │
  │     · /api/chat            (SSE/WS, 计费+路由)        │
  │     · /api/agent/*         (open/status/connect)     │
  │     · /api/admin/*         (超管,requireAdmin)       │
  │     · /ws/chat             (chat WebSocket)          │
  │     · /ws/agent/:uid       (agent WebSocket)         │
  └────┬─────────────┬─────────────┬──────────────┬──────┘
       │             │             │              │
       ▼             ▼             ▼              ▼
  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐
  │Postgres │  │  Redis   │  │Account   │  │Agent        │
  │(主数据) │  │(缓存/锁/ │  │Pool      │  │Supervisor   │
  │         │  │队列/限流)│  │Scheduler │  │(Docker API) │
  └─────────┘  └──────────┘  └────┬─────┘  └──────┬──────┘
                                   │               │
                                   ▼               ▼
                         ┌────────────────┐  ┌──────────────┐
                         │ Claude API     │  │Docker daemon │
                         │ (OAuth tokens) │  │(local socket)│
                         └────────────────┘  └──────┬───────┘
                                                    │
                                                    ▼
                                           ┌──────────────────┐
                                           │ Agent Containers │
                                           │  agent-u1        │
                                           │  agent-u2 ...    │
                                           └──────────────────┘
```

## 2. 模块划分

所有商业化代码放在 `packages/commercial/` 下,一个 npm workspace 子包。

```
packages/commercial/
├── package.json
├── src/
│   ├── index.ts                  # 模块入口,导出 registerCommercial(gateway)
│   ├── auth/
│   │   ├── index.ts
│   │   ├── passwords.ts          # argon2id 哈希/校验
│   │   ├── jwt.ts                # access/refresh token 签发与校验
│   │   ├── sessions.ts           # refresh token 存储与吊销
│   │   ├── register.ts           # 注册流程(含邮箱验证)
│   │   ├── login.ts              # 登录
│   │   └── middleware.ts         # authJwt 中间件
│   ├── billing/
│   │   ├── index.ts
│   │   ├── pricing.ts            # 模型定价 + 倍率查询
│   │   ├── ledger.ts             # 流水 append + 余额扣减(事务)
│   │   ├── preCheck.ts           # 请求前余额预检
│   │   └── calculator.ts         # 按 usage 计算 cost
│   ├── payment/
│   │   ├── hupijiao/
│   │   │   ├── client.ts         # 虎皮椒 HTTP client
│   │   │   ├── sign.ts           # MD5 签名
│   │   │   ├── createOrder.ts    # 创建订单
│   │   │   ├── callback.ts       # 异步回调处理
│   │   │   └── reconcile.ts      # 每日对账任务
│   │   └── orders.ts             # 订单状态机
│   ├── account-pool/
│   │   ├── index.ts
│   │   ├── scheduler.ts          # 调度算法(sticky / weighted)
│   │   ├── health.ts             # 健康度与熔断
│   │   ├── store.ts              # 账号 CRUD + 加密存储
│   │   ├── refresh.ts            # OAuth token refresh
│   │   └── proxy.ts              # 代理请求到 Claude API
│   ├── agent-sandbox/
│   │   ├── index.ts
│   │   ├── supervisor.ts         # Docker 编排(create/start/stop/rm)
│   │   ├── lifecycle.ts          # 订阅到期检查、volume GC
│   │   ├── network.ts            # 白名单 + 代理配置
│   │   ├── volumes.ts            # workspace/home volume 管理
│   │   └── audit.ts              # 工具调用审计
│   ├── admin/
│   │   ├── index.ts
│   │   ├── users.ts              # 用户 CRUD
│   │   ├── accounts.ts           # 账号池 CRUD
│   │   ├── pricing.ts            # 定价 CRUD
│   │   ├── audit.ts              # 审计日志
│   │   └── requireAdmin.ts       # 中间件
│   ├── db/
│   │   ├── index.ts              # pg Pool 单例
│   │   ├── migrations/           # SQL 迁移文件(见 03-DATA-MODEL)
│   │   └── queries.ts            # 参数化查询封装
│   ├── crypto/
│   │   ├── aead.ts               # AES-256-GCM 封装
│   │   └── keys.ts               # KMS 密钥加载
│   ├── config.ts                 # 环境变量解析
│   └── __tests__/                # 单元测试
└── tsconfig.json
```

## 3. 数据存储

- **PostgreSQL 15+**:主数据(用户/订单/流水/账号/Agent 记录)
- **Redis 7+**:
  - 登录限流计数器
  - 余额预扣锁(TTL 5min 兜底)
  - Refresh token revocation list
  - 账号池健康度缓存
  - 支付订单临时状态
- **Docker volumes**:每 Agent container 两个命名 volume(`agent-u{uid}-workspace` / `agent-u{uid}-home`)
- **本地磁盘**:日志(`/var/log/openclaude/commercial.log`, 按日 rotate)

## 4. 运行时架构

### 4.1 Gateway 进程
单进程 Node.js(tsx),启动时:
1. 连接 DB + Redis,执行迁移(若有)
2. 加载定价表到内存(watch pg_notify 变更推送)
3. 加载账号池健康度
4. 挂载所有路由和中间件
5. 启动 Agent Supervisor(独立 async loop,与主进程同生命周期)
6. 启动定时任务:
   - 订单对账(每日 3:00)
   - Agent 订阅到期检查(每小时)
   - Volume GC(每日)
   - Refresh token 清理(每日)

### 4.2 Agent 容器
基础镜像:`openclaude/agent-runtime:latest`(自建,基于 `node:22-slim` + bun)
容器内:
- 无 systemd,PID 1 是 `supervisor.sh`
- 跑一个简化的 CCB 实例 + MCP 工具
- 通过 `/var/run/agent-rpc.sock`(Unix domain socket)接受 Gateway 的命令
- Gateway WebSocket 代理用户和容器的通信

### 4.3 部署形态
单机(38.55.134.227):
- systemd unit `openclaude.service` 跑 Gateway
- Docker daemon 本机 socket(`/var/run/docker.sock`,仅 root 可访问,Gateway 以 root 运行或 docker group)
- Postgres + Redis 本机容器(或系统包,选其一,MVP 用容器)
- Caddy 系统服务

## 5. 数据流

### 5.1 Chat 请求
```
用户 Web → WS/SSE → Gateway
  → authJwt(校验 JWT)
  → rateLimit(全局 + 用户级)
  → billingPreCheck(估算 max_cost, 若余额 < 则 403)
  → Router(选 chat 路径)
  → AccountPoolScheduler.pick(model=sonnet)
     → 返回 account_id + decrypt(token)
  → ClaudeAPI stream(走该 token)
  → 流式 token 转发给用户
  → stream end → 拿 usage
  → calculator.compute(usage, pricing_snapshot)
  → ledger.debit(user, cost)  [DB 事务]
  → AccountPool.updateHealth(account_id, success)
```

### 5.2 Agent 请求
```
用户 Web → WS /ws/agent/:uid → Gateway
  → authJwt
  → 校验 agent 订阅有效 + container 存在
  → 转发 frames 给 container 的 Unix socket
  → container 内 CCB 实例处理
     (工具调用时走 Gateway 代理回 Claude API, 同 5.1 的计费链)
  → container 回复通过 Unix socket 转回 Gateway → WS → 用户
```

### 5.3 充值
```
用户 Web → POST /api/payment/hupi/create
  → 生成本地 order_id, 写 orders(status=pending)
  → 调虎皮椒 API 获取 qrcode_url
  → 返回给前端
用户扫码支付
虎皮椒 → POST /api/payment/hupi/callback
  → 校验签名
  → 幂等检查(order_id unique)
  → 事务:orders.status=paid + ledger.credit(user, amount)
  → 返回 success
```

### 5.4 Agent 开通
```
用户 Web → POST /api/agent/open (plan=basic)
  → 检查余额 >= ¥29(转积分)
  → 扣 ¥29 对应积分
  → 写 agent_subscriptions(user_id, plan=basic, start, end=+30d)
  → AgentSupervisor.provision(uid):
     - 创建 volumes(若不存在)
     - docker create + start container
  → 返回 {status: active, endpoint: /ws/agent/:uid}
```

## 6. 配置管理

所有敏感配置走环境变量:

```env
# DB
DATABASE_URL=postgres://...
REDIS_URL=redis://...

# Crypto
OPENCLAUDE_KMS_KEY=<base64 32 bytes>   # AES-256 key for account tokens
JWT_SECRET=<base64 64 bytes>
JWT_REFRESH_SECRET=<base64 64 bytes>

# Payment
HUPIJIAO_APP_ID=xxx
HUPIJIAO_APP_SECRET=xxx
HUPIJIAO_CALLBACK_URL=https://claudeai.chat/api/payment/hupi/callback
HUPIJIAO_RETURN_URL=https://claudeai.chat/topup/result

# Email (for verification)
SMTP_HOST=...
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="OpenClaude <noreply@claudeai.chat>"

# Turnstile
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...

# Commercial toggle
COMMERCIAL_ENABLED=1
COMMERCIAL_ADMIN_EMAIL=boss@example.com   # bootstrap admin

# Agent sandbox
AGENT_IMAGE=openclaude/agent-runtime:latest
AGENT_NETWORK=agent-net
AGENT_PROXY_URL=http://proxy:3128

# Feature flag for account pool fingerprint isolation (V2)
ACCOUNT_POOL_FINGERPRINT=0
```

文件位置:`/etc/openclaude/commercial.env`(systemd `EnvironmentFile`)
**不进 git**。部署脚本从 `.env.keys` 派生。

## 7. 可观测性

### 7.1 日志
- 所有日志 JSON 格式,字段:`ts / level / req_id / user_id / route / msg / ...`
- 输出到 `/var/log/openclaude/commercial.log`,logrotate 每日切割,保留 14 天
- 敏感字段(token、密码、prompt)**永不落盘**,脱敏为 `"<redacted>"`

### 7.2 指标
- Gateway 暴露 `/metrics`(Prometheus format),超管后台拉取展示
- 关键指标:
  - `gateway_http_requests_total{route, status}`
  - `billing_debit_total{result}`  (success/insufficient/error)
  - `account_pool_health{account_id}`
  - `agent_containers_running`
  - `claude_api_requests_total{account_id, status}`

### 7.3 trace
- 每个请求生成 `req_id` (UUID v7),传递到下游调用、日志、错误响应
- 用户报障可以 give `req_id`,超管一键检索

## 8. 与个人版的边界(再次强调)

**商业化代码不修改以下文件**(只读):
- `packages/gateway/src/sessionManager.ts`
- `packages/gateway/src/eventBus.ts`
- `packages/gateway/src/subprocessRunner.ts`
- `packages/gateway/src/ccbMessageParser.ts`
- `packages/gateway/src/promptSlots.ts`
- `packages/storage/src/memoryStore.ts`
- `packages/storage/src/taskStore.ts`
- `packages/storage/src/sessionsDb.ts`

**挂载点**:在 `packages/gateway/src/server.ts` 里加一个条件挂载:
```ts
if (process.env.COMMERCIAL_ENABLED === '1') {
  const { registerCommercial } = await import('@openclaude/commercial');
  await registerCommercial(app);
}
```
这是**唯一**允许的侵入点。

Last updated: 2026-04-17
