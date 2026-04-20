# OpenClaude v3 商用 MVP 上线清单

> 创建: 2026-04-20
> 上一篇: [02-DEVELOPMENT-PLAN.md](./02-DEVELOPMENT-PLAN.md)(完整设计,R6.11.y APPROVE)
> 本篇定位: 把完整方案剪枝为"上线商用最小可行集",其它功能推迟到 V2 / V3 迭代

## 剪枝原则

商用 MVP 只保**单 host monolith 拓扑 + ephemeral 按量计费 + 充值消费**主干。砍掉:

| 砍掉的模块 | 原因 |
|---|---|
| 持久化容器订阅(整章 §13 + §7.5 月费 + 0016/0017 部分迁移 + 4F/4G/4K) | 全用户先跑 ephemeral 按量计费;persistent 月费等 PMF 验证再做 |
| Warm container pool(§9 3L) | cold-start P95 优化,初期并发低用户能忍 1-2s |
| 多 host 横向扩容(Phase 6 + §14.2/3/4) | 单 host 32GB 能撑很久,真扛不住再做 |
| Migration ledger + 双 ACK 屏障(R6.7→R6.11 全套) | **没有 multi-host = 没有 migration = ledger/ACK 全部用不上**;R6 全部 14 轮 codex 迭代主要为这块找正确性,MVP 完全不需要 |
| Edge sidecar 拆分 + edge_signing_secret 生命周期 | 单 host 时 edge 与 central 同进程,无签发问题 |
| Account 自动 ramp / probe / 健康曲线 | admin 手动 INSERT + 改 weight 即可 |

## 节奏

按 git commit 颗粒度推进,每个 task 完成立即 commit。三层进度跟踪:

1. 本文件 status 列实时更新(✅/🔧/⏳ = 完成/进行中/待开始)
2. git log 是真实 source of truth
3. 决策日志写在文末,跨会话可接力

## Phase 2 — 后端骨架(P0 必备)

| Task | 内容 | 依赖 | Status | Commit |
|---|---|---|---|---|
| **2.0** | 设计落地:本文件 + 02-DEVELOPMENT-PLAN.md 已就位作 ADR(替代 docs/v3/adr/*) | — | ✅ | 29d10cd |
| **2A** | 删 v2 chat orchestrator + chat/debit + ws/chat + 相关测试(整个被容器化方案替代) | — | ✅ | de87712 |
| **2B** | 数据库迁移 0011-0015:user_preferences、agent_containers(secret_hash/bound_ip/state)、usage_records status+UNIQUE、credit_ledger UNIQUE、request_finalize_journal | — | ✅ | 45f26ac |
| **2I-1** | RequestId middleware + 结构化 log schema(自写无 pino dep;贯穿 bridge/proxy/preCheck/finalize/Anthropic call,全 log 必带 requestId+uid+containerId,**禁止落 prompt body**) | 2A | ✅ | 73bf28c |
| **2C** | `commercial/src/auth/containerIdentity.ts` 双因子校验(socket IP 反查 + secret hash timing-safe compare)+ 测试 | 2.0, 2B, 2I-1 | ✅ | bf1d805 |
| **2D** | `commercial/src/http/anthropicProxy.ts` central proxy(**仅 monolith 拓扑**,绑 `172.30.0.1:18791`):zod strict body schema + 字段字节预算 + 双侧 cost 估算 + header 值 allowlist + per-uid rate limit + concurrency cap + preCheck + 上游 fetch + 双向 abort + single-shot finalizer + `pipeStreamWithUsageCapture`。**MVP 跳过 split 拓扑、跳过 edge sidecar 子进程** | 2C, 2I-1 | ⏳ | — |
| **2E** | `commercial/src/ws/userChatBridge.ts` 用户 WS ↔ 容器 WS 桥 + 测试 | 2I-1 | ⏳ | — |
| **2F** | `commercial/src/http/models.ts` GET `/api/models`(从 model_pricing 过滤 enabled) | — | ⏳ | — |
| **2G** | `commercial/src/user/preferences.ts` GET/PATCH `/api/me/preferences` | 2B | ⏳ | — |
| **2H** | gateway `server.ts` 接入 commercialHandle + WS upgrade 路由 + `/healthz` 包含 commercial 状态 | 2A-2G | ⏳ | — |
| **2I-2** | prom-client `/metrics`:TTFT、stream duration、settle 三态分布、preCheck reject、billing_debit_failures_total、ws_bridge_buffered_bytes | 2H | ⏳ | — |
| **2J-1** | host 侧网络隔离:ufw 规则 + Caddyfile grep CI(`/internal/` 不能出现在 site config)+ `openclaude-v3-net` 子网创建 + IPv6 显式禁用 | 2D | ⏳ | — |

## Phase 3 — 容器调度(P0 必备,**单轨 ephemeral**)

| Task | 内容 | 依赖 | Status | Commit |
|---|---|---|---|---|
| **3A** | `Dockerfile.openclaude-runtime`(基于 node:22-slim,COPY 个人版 packages,ENTRYPOINT 跑 entrypoint.sh — `unset` provider 路由 env → 强制 `CLAUDE_CONFIG_DIR=/run/oc/claude-config` tmpfs → `npm run gateway`,EXPOSE 内部 WS 端口) | — | ⏳ | — |
| **3B** | 镜像 build 脚本(本地 build,docker save/load,无私有 registry) | 3A | ⏳ | — |
| **3C** | supervisor.provisionContainer:`--ip` 强制分配 IP + 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN=oc-v3.<cid>.<secret>` + `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` + `CLAUDE_CONFIG_DIR=/run/oc/claude-config` + `--cap-drop=NET_RAW --cap-drop=NET_ADMIN`,落 `agent_containers.bound_ip` + `secret_hash`。**MVP 全部容器走 mode='ephemeral'** | 2C, 3A | ⏳ | — |
| **3D** | userChatBridge 接入 supervisor.ensureRunning(单 host 单进程,**不需要 ACK 屏障**) | 2E, 3C, 3E | ⏳ | — |
| **3E** | 容器 `/healthz` + WS upgrade probe + 启动 readiness 等待(supervisor poll 直至就绪或超时) | 3A | ⏳ | — |
| **3F** | tickIdleSweep(idle 30min stop+remove,**单轨只回收 ephemeral,删 mode 字段**) | 3C, 3E | ⏳ | — |
| **3H** | gateway 启动时 reconcile + 每 1h 跑 orphan 清理:比对 docker `ps -a` 与 `agent_containers` 表,孤儿容器 stop+rm,数据库孤儿标 vanished | 3F | ⏳ | — |
| **3I** | `MAX_RUNNING_CONTAINERS=N`(默认 50)硬限 + 启动时 `docker pull` 预热 | 3F | ⏳ | — |
| **3J** | 容器侧网络隔离 e2e:`cap-drop NET_RAW/NET_ADMIN` 校验 + 容器内 spoof 别 IP 调内部代理必须 401 + `/internal/*` 公网无法访问 | 3C, 3E, 2J-1 | ⏳ | — |
| **3M** | `agent_containers` reader audit:**只保 R6.7 (a) 显式 state filter 一条 lint 规则**,删 R6.11 (b)/(c)/(d) 二选一 + RECONCILER_WHITELIST + 负例 fixture(都是为 multi-host 服务的) | 3F | ⏳ | — |

## Phase 4 — UI / admin 后台(P0 必备)

| Task | 内容 | 依赖 | Status | Commit |
|---|---|---|---|---|
| **4A** | `index.html` auth 模态(注册/登录/邮箱回调/Turnstile)+ `modules/auth.js` | — | ⏳ | — |
| **4B** | 顶栏余额 pill + 充值模态(套餐选择 + 二维码扫码 + 轮询订单)+ `modules/billing.js` | — | ⏳ | — |
| **4C** | 设置面板"默认模型/effort/通知"项 + `modules/userPrefs.js` | — | ⏳ | — |
| **4D** | `admin.html`(独立页面,沿用 style.css)+ `admin.js` 模块化各 tab | — | ⏳ | — |
| **4E** | admin 鉴权:所有 `/api/admin/*` handler 层验 `role=admin`;静态 `admin.html` 公开,前端拉 `/api/me`,role≠admin 则 302 → `/`(纯 UX,**安全边界在 API**) | — | ⏳ | — |
| **4H** | system_settings 后端:`getSetting(key, default)` helper(60s in-memory cache + LISTEN/NOTIFY 主动失效)+ admin GET/PUT `/api/admin/settings/:key`(改动写 admin_audit + Telegram 通知) | 2B | ⏳ | — |
| **4I** | admin "系统设置"页(SETTING_SCHEMAS 自动渲染)+ "compute hosts"页**只读单行 placeholder** | 4D, 4H | ⏳ | — |
| **4J** | admin "账号池"页:新增表单 + 立即 probe + 健康曲线(**MVP 跳过自动 ramp**,手动设 weight) | 4D | ⏳ | — |
| **4L** | 商用版健康面板(单页聚合)— **MVP 只保**:`cold_start_p95_ms` / `account_pool_health` / `billing_debit_failures_total` / `system_settings_invalid_writes_total`。**砍掉**:warm_pool_*、host_unreachable_*、host_agent_apply_*、supervisor_stale_recovery_*、edge_secret_*(全是 multi-host 用) | 4D, 4H | ⏳ | — |

## Phase 5 — 部署上线(P0 必备)

| Task | 内容 | 依赖 | Status | Commit |
|---|---|---|---|---|
| **5A** | `deploy-to-remote-v3.sh`(基于 v2 rsync 脚本,目标 `/opt/openclaude-v3`,服务名 `openclaude-v3.service`,端口 :18789) | — | ⏳ | — |
| **5B** | 45.76.214.99 准备:openclaude-v3 用户、新 PG database `openclaude_v3`、Redis db=1、docker network `openclaude-v3-net`(自定义 subnet 172.30.0.0/16,启用禁 IP-spoof) | — | ⏳ | — |
| **5C** | 数据迁移:v2 的 users/orders/credit_ledger/claude_accounts 导入 v3 PG;**写迁移幂等回放脚本** + **FK 一致性 check**;**MVP 跳过 v2 agent_subscriptions 回填**(全用户进 v3 都重置成 ephemeral 按量) | 5B | ⏳ | — |
| **5G** | 0017 迁移落地 + 写 `compute_hosts(name='main', ip_internal='127.0.0.1', docker_endpoint='unix:///var/run/docker.sock', ram_gb=32, ...)` 单 host 占位 | 5B | ⏳ | — |
| **5D** | 备份 + 回滚演练:PG `pg_dump --format=custom` 每 6h + 7 天保留;volume 快照 rsync;**写回滚手册** + 演练 30min 切回 v2 | 5C | ⏳ | — |
| **5E** | DNS / Caddy 切流(灰度 5% → 50% → 100%);**这步 boss 拍板按下** | 5D | ⏳ | — |
| **5F** | v2 stop+disable(留代码/数据 30 天作回滚) | 5E | ⏳ | — |

## 推迟到 V2 迭代的功能(已确认推迟,不在本次实现范围)

- **持久化订阅**:整章 §13 + §7.5 月费 + 0016/0017 双模式部分 + 3K setMode + 4F/4G/4K 订阅 UI/扣款/续费提醒
- **Warm container pool**:整 §9 3L + cleanupWarmBindFailure
- **多 host 横向扩容**:Phase 6(6A-6G)+ §14.2(无感加 host)+ §14.3(WireGuard)+ §14.4(admin 多 host 页)+ pickHost 跨 host + 跨 host migrate
- **Migration ledger + 双 ACK**:`agent_migrations` 表(0019)+ 7-phase machine + ACK#1/#2 + pollHostAgentApplyVersion + host-agent 进程 + supervisor stale recovery + R6.11 二选一 CI lint + tickHostAgentReconcile
- **Edge_signing_secret 生命周期**:KMS 密封 + rotate-edge-secret + revoke-edge-secret + tickEdgeSecretCacheResync + §14.2.2bis/ter
- **Account 自动 ramp**:§14.1 自动 weight×1.5 ramp / probe / 健康曲线;MVP 手动 INSERT + 手改 weight

## 决策日志(跨会话接力用)

- **2026-04-20** 创建本文件,基于 02-DEVELOPMENT-PLAN.md R6.11.y(codex 第二十四轮 APPROVE)。剪枝结论 boss 已授权"按你想法搞,直到部署上线"。开始 Phase 2 实施。
- **2026-04-20** Task 2B 完成(45f26ac):0011_user_preferences / 0012_agent_containers_v3(双因子 + state 单轨)/ 0015_request_finalize_journal 三张迁移;0013-0014 跳号说明已写在 migrate.ts 整数序列校验中。dry-run 干净。
- **2026-04-20** Task 2A 完成(de87712):4 个 v2 chat 源文件 + 5 个测试 + 11 处 index.ts/router.ts/handlers.ts 引用全部清理。tsc 0 error,bun test pass 数量减少完全归因于 5 个删除的测试文件(523 vs 543 = -20 chat 测试)。account-pool 全套保留(2D anthropicProxy 复用)。下一步:2I-1 requestId middleware + pino schema。
