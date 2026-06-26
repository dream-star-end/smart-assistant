# P1 计划 v2(Codex 审计划 FAIL→修订)— ccb 单底座 + 容器/账号/控制面隔离

> P0 已上线:v5=同机第二 gateway(:18790),共享 openclaude_commercial,控制面静默、不起容器、Caddy secret 标签分流、现网零影响。
> P1 目标:v5 安全跑真实 ccb 对话,与 v3 在**共享 PG + 共享 claude_accounts + 共享 compute-pool 表**上并行隔离。
> **Codex 审 v1 关键更正**:①隔离面远比 agent_containers 表大(含 label/name/volume/network/compute_hosts/compute_pool_state/admin/node-agent 白名单);②不删共享 protocol 字段(v5 仅运行时不走 codex);③AccountScheduler 进程内槽多实例=N×cap 必须先治;④compute-pool 是共享单例语义必须 channel 化或 v5 纯本地;⑤codex 结构删除放最后。

## 子阶段(严格按序;每阶段独立 Codex 双审 + 测试 + 验收)

### P1a — 运行时隔离面(runtime_channel 贯穿;v3 行为零变化)
覆盖**全部** v5/v3 会碰的共享容器/调度状态:
1. **agent_containers 表**:加列 `runtime_channel NOT NULL DEFAULT 'v3'`;两步换索引——先 `CREATE UNIQUE INDEX CONCURRENTLY uniq_ac_user_channel_active ON agent_containers(user_id,runtime_channel) WHERE state='active'`,验证后 drop 旧 `uniq_ac_user_id_active`;同步审 `idx_ac_host_bound_ip_active`/`idx_ac_host_uuid_active`/`idx_ac_codex_account_active` 是否需加 channel 维度或查询谓词。
   - **⚠️ CONCURRENTLY 不能进现有 migration 框架**(`db/migrate.ts` 每个 .sql 包 BEGIN/COMMIT,concurrent index 会失败)。两选一:(a) 扩展 migrate runner 支持 `-- no-transaction` 标记(该 .sql 不包事务);(b) 把"建新索引/drop 旧索引"做成受控运维步骤(低峰人工执行)+ 手工登记 `schema_migrations`。加列(DEFAULT 'v3')可走普通事务 migration;仅换索引走 no-transaction/运维步骤。
2. **SQL 全审计(Codex 补全清单)**:`v3supervisor.ts`(getV3ContainerStatus/ensure/status/sweep)、`compute-pool/nodeScheduler.ts`、`compute-pool/queries.ts`、`auth/containerIdentity.ts`、`agent-sandbox/userMedia.ts`、`admin/accounts.ts`、`admin/containers*.ts`、`admin/metrics.ts`、`admin/users.ts`、`index.ts` 容器/账号 wiring、各 sweeper/reconciler。原则:每 instance 只见/操作本 channel 行;active-count/容量统计按 channel 分组。
3. **容器物理标识全 channel 化**:docker label(新增 `com.openclaude.runtime_channel`)、容器名(`oc-v5-u<uid>`)、volume 名(`oc-v5-*-u<uid>`)、network(`openclaude-v5-net`)、token/secret;`orphanReconcile` 等 label 过滤必须带 channel;node-agent AllowedDir/白名单加 `oc-v5-*`。
4. **lint 强化**:`scripts/lint-agent-containers-sql.ts` 覆盖 SELECT/UPDATE/INSERT 且强制出现 `runtime_channel`(不止 `state`)。
5. **channel 来源**:容器创建写当前 instance 的 `OC_RUNTIME_CHANNEL`。
- 验收:v3 全测试绿(默认 'v3' 零回归)+ 隔离单测(v3 查询不返回 v5 行、反之);CONCURRENTLY 迁移在线可回滚演练。

### P1b — compute-pool 隔离决策(P1a 内或紧随)
`compute_hosts`/`compute_pool_state` 是共享 v3 语义 + 单例 desired image。二选一(Codex 要求):
- **方案 A(推荐 P1 起步)**:v5 **纯本地 compute(local-only 硬门)**。不止设 env——必须代码级保证 v5:**强制 local placement(不调 `nodeScheduler/pickHost`)、不调 `initComputePool/imagePromote`、不起 `healthPoller/container events`、不注册 v5 为 compute_host、不绑会与 v3 冲突的 baseline 端口**;v5 容器只在 kl-mirror 本机起;所有 sweeper/reconcile **只扫 `runtime_channel=v5` + v5 label**。零污染 v3 compute_hosts/compute_pool_state。`OC_IMAGE_DISTRIBUTE_DISABLED=1` 仅是其中一项,不充分。
- **方案 B(后期)**:compute-pool 表 channel 化(desired image / host 角色按 channel)。P1 不做。

### P1c — 账号池并发权威(真实对话刚需,最危险)
v5 真实 ccb 对话的**请求路径刚需**:pricing、preCheck Redis、`AccountScheduler.pick`、token refresh、upstream proxy、finalizer/ledger/quota。
**核心风险**:`AccountScheduler` per-account slot 是**进程内 Map**,v3+v5 各自调度同一 `claude_accounts` → 并发槽变 N×cap + 污染 health/cooldown。
- **两层方案(Codex 建议,已采纳)**:
  - **P1e canary/首次真实 e2e:用 v5 独立 `account_group`**(account_groups 表已存在)。运营分配少量账号给 v5,容量碎片化但**现网最安全、失败半径清晰、绝不碰 v3 进程内并发槽**。
  - **长期并行生产:Redis 分布式租约**(共享账号池单一权威,保利用率)。需 token/slotId + TTL + Lua 原子 acquire/release + reaper + 指标 + Redis 故障 fail-closed。作为 P1c 专项(独立设计 + Codex 审)。
  - 未到对应层级前,v5 不放开该层级的真实对话规模(canary 限 v5 account_group 名额内)。
- 验收:v3+v5 并发不突破单账号上限;health/cooldown 不被双实例污染;扣费/ledger 正确且不双 finalize。

### P1d — ccb-only 镜像 + v5 容器接线(解除 P0 fail-closed 的前提)
解除"v5 设 OC_RUNTIME_IMAGE 即拒启"之前,必须代码级保证(Codex 要求):INSERT agent_containers 显式写 `runtime_channel='v5'`、所有 reader/writer 带 channel(P1a 完成)、label/name/volume/network/token 全带 channel、node-agent 白名单 `oc-v5-*`、reconcile label 过滤 channel、compute-pool 走方案 A 本地。
- 镜像:改 Dockerfile 删 `@openai/codex` 层 + codex 技能 populate + entrypoint codex app-server + codex auth volume;保留 Playwright/ScanSci/pandoc;构建 `openclaude-runtime-v5:<tag>`。
- commercial-v5.env:设 `OC_RUNTIME_IMAGE=openclaude-runtime-v5:<tag>`、`AGENT_NETWORK=openclaude-v5-net`;早期 fail-closed 改为"v5 必须 runtime_channel 隔离就绪"断言(而非禁止容器)。
- 验收:v5 起容器仅 ccb、镜像无 codex、与 v3 容器物理/逻辑隔离。

### P1e — v5 真实对话 e2e
secret 标签登录 v5 → ccb 对话 → v5 容器冷启(v5 网络/镜像)→ 流式 → 共享 PG 扣费;验 v3 并行零影响 + 容器/账号槽隔离。

### P1f — 去 codex 结构性清理(最后,v5 分支;不碰共享 protocol)
v5 运行时已不走 codex 后,清理 v5 分支上**不再被引用**的 codex-only 模块:gateway `codexRunner/codexAppServerRunner/codexLaunchOverrides/codexAutoPlanMode/v3CodexRelay/codexAuthSync/inferAgentForModel`(收敛为单一 ccb seam)、commercial `account-pool/codex*`/`codex-auth/*`/`http/internalCodexRelay`/`billing/codexFinalizer`、mcpVision codex backend、wechat codex route/billing。
- **不删** `@openclaude/protocol` 的 codex 字段(OutboundCodexBilling/conversationMode 等)——保兼容,留作 dead type;v5 public models 移除 gpt-*、agents 不含 codex provider。
- 验收:v5 grep 无 codex 运行时路径;protocol 不变;v3 树完全不动。

## 红线
- v5 共享表迁移仅 P1a 一次(加列 + CONCURRENTLY 换索引,向后兼容,v3 在线零中断);v5 仍 AUTO_MIGRATE=0,迁移由 v3 控制面/人工受控执行 + 可回滚。
- 去 codex 仅 v5 分支 + 不碰共享 protocol;v3 树保留(灰度期 v3 仍服务存量 gpt 用户)。
- 账号池权威(P1c)未定不放开真实对话。每子阶段 Codex 双审 PASS + 测试 + 验收;现网零影响;changelog 用户亲笔。

## 账号池路径(已采纳两层,执行前 boss 知晓即可)
- canary 先 v5 独立 account_group(需运营分配少量账号给 v5);成熟后做 Redis 分布式租约转为共享池单一权威。
- boss 可选:若不愿运营分账号,可直接上 Redis 租约(工作量大但免分摊)——默认走两层渐进。
