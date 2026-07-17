# V5 提示词队列 P1 完成记录

## 交付范围

- 新增固定生产序号 `0163_prompt_queue.sql`，建立 `prompt_queue_heads`、`prompt_queue_items`、`prompt_queue_item_attachments`、`prompt_queue_mutations` 四张表；migration runner 的清理/期望表清单同步更新。
- 新增 `PgPromptQueueStore`，把 enqueue/edit/delete/reorder/interject、snapshot/detail、claim acquire/release/activate 的直接 SQL 全部收口在 store 内。
- 新增四个容器双因子认证的内部 POST API：
  - `/internal/v5/prompt-queue/mutation`
  - `/internal/v5/prompt-queue/snapshot`
  - `/internal/v5/prompt-queue/detail`
  - `/internal/v5/prompt-queue/claim`
- `OC_PROMPT_QUEUE_V1` 仅在精确值 `1` 时实例化 store/handler 并注册路由；缺省/off 时沿用原 internal proxy fallthrough，不增加旧路由行为。
- 协议层只补充与 gateway 现有 300 MiB 总上传预算一致的共享常量；队列帧、snapshot、BigInt version helper 全部复用 P0，未复制第二套 DTO/状态机。
- `prompt_queue_mutations` 纳入中央 retention registry，保留 30 天；未增加第二个 sweeper。

## 表结构与状态机要点

- `heads` 的 `(owner_user_id, session_key)` 是事务锁、业务 version 与 active turn 权威。owner user 只来自验证后的 container identity；session/clientSession/agent/peer 需互相交叉校验。
- 所有 mutation 先锁 head，再检查持久化幂等 ledger。相同 key/hash 返回当前 snapshot 且 wire outcome=`duplicate`；不同 hash 返回 `IDEMPOTENCY_CONFLICT`。首次 version conflict/rejected 也留 ledger，但不提升业务 version。
- `items.position` 使用可延迟唯一约束，所有等待项始终从 1 连续编号。`queued/blocked` 必须有位置；`dispatch_claimed/active/steer_pending/delivery_unknown` 必须无位置；partial unique index 限制每会话最多一个 active 和一个 claim。
- head/item 两侧的 deferred constraint trigger 在事务提交时强制 `head.active_item_id` 与唯一 `state='active'` item 双向一致；store 可在同一事务内按任意顺序更新两侧，漂移状态不能提交。
- `blocked` 与 `(blocked_reason_code, blocked_at)` 是数据库双向等价约束；retryable release、edit 解阻和 activate 都显式清空原因字段。
- mutation ledger 只级联 head，`item_id` 故意不建 item FK，因此删除 item/附件后首次 mutation 证据仍保留。
- claim owner 固定由服务端派生为 `container:<verifiedContainerId>`；wire acquire 不接收 owner/epoch/token/TTL。token 为服务端 32-byte 随机值，lease 固定 30 秒并使用 PostgreSQL 时钟。
- 未过期 claim：同 owner 只续租、同 token/epoch、version 不变；异 owner 拒绝且不 bump。只有 DB 判定过期后异 owner 才能接管，epoch 严格 `+1`、token 轮换、version 只增一次。
- release/activate 使用 owner+epoch+token equality CAS；retryable 回队首，user-action-required 以稳定原因进入 blocked，activate 进入 active。active item 不再出现在等待投影，也不会被 acquire 自动重跑。
- interject 在 active turn 不匹配时回队首并返回 `turn_changed`；native/fork-native 匹配时进入 `steer_pending`，服务端 delivery token 同时写 item 与 mutation ledger，幂等重放返回同 token；boundary/interrupt intent 持久化后回队首。

## 验证证据

- `npm run typecheck`：PASS。
- `REQUIRE_TEST_DB=1 npm run test:commercial:prompt-queue`：20 tests / 6 suites，20 pass，0 fail。覆盖 0163 首行编号、SQL 精确 replay、schema/FK/check/index、active 双向 trigger、restart、多 owner、原子 detail snapshotVersion、双 tab CAS、同 key replay/异 hash 冲突、删除后 ledger、完整 reorder、live/expired claim、owner/epoch/token fencing、retryable/blocked/解阻、active 投影、native interject、HTTP 内存 admission 与固定 seed 性质序列。
- `npm run test:storage`：316 tests / 84 suites，316 pass，0 fail（含 six-tables direct-SQL architecture gate）。
- `npm run test:commercial:unit`（开工基线）：4335 tests，4228 pass，62 fail，39 cancelled，6 todo；`not ok` 去重 20 项。
- `npm run test:commercial:unit`（最终复跑）：4338 tests，4231 pass，62 fail，39 cancelled，6 todo；`not ok` 去重仍为相同 20 项，`comm -23 final base` 为 0，满足本树失败集 ⊆ 基线失败集。该套件存在少量依赖环境动态注册的用例数波动；较早一次实现后运行是 4344/4237，失败/取消集合相同。
- `npm run test:commercial:unit:gate`（仓库 canonical 基线门，`REQUIRE_TEST_DB=1`）：runner 4344 tests，known-failures diff 为 actual 24 / baseline 26 / new 0，最终 `PASS: no new failures beyond baseline`。
- `npm run test:commercial:integ:strict` 全量实际运行：1466 tests / 308 suites，697 pass，55 fail，714 cancelled。公共 `public` schema 的存量 suites 出现大量 `relation "system_settings" already exists` 及连锁取消；本批独立 `oc_prompt_queue_p1_test` schema 会先 DROP/CREATE，队列 migration/owner/CAS/property suites 除已修复的 release 参数显式 cast 外均通过，修复后的最新代码再由上述定向严格套件 19/19 证明。
- `git diff --check`：PASS。

## P2 / P4 接口交接

### P2 coordinator

- coordinator 使用四个 internal API，不获取 PG 凭据；每次都携带 canonical owner envelope，master 从 container identity 覆盖 userId，并以验证后的 containerId 派生 lease owner。
- acquire 只传 `expectedVersion`；成功响应携带 `{itemId, epoch, claimToken, leaseUntil, renewed}`。release/activate 回传 epoch+claimToken 做 CAS，绝不能自行推进 epoch 或指定 TTL。
- mutation 成功/冲突/重放都返回完整当前 snapshot；P2 应整体替换投影并按 BigInt version 收敛，不实现本地 patch reducer。
- snapshot/detail 均在只读 REPEATABLE READ 事务中组装；detail 的 `snapshotVersion` 必须作为编辑时的 expectedVersion 来源，不能拿另一时刻的 tab snapshot 拼接。
- native/fork interject 的 `deliveryToken` 是 coordinator→engine 的 server-only 防重键。P2/P5 必须增加 receipt/complete 协调流程；P1 不猜测 engine receipt，也不自动重跑 active。

### P4 billing/refund

- P1 没有 preCheck、账户槽、billing journal、扣费或退款行为；等待项不会预占/预扣。
- head 的 `active_turn_id` 固定为平台 turnKey，为 P4 的 `refundTurn(turnKey)` 精确冲正保留稳定关联。P4 不应回退到 session+time-window，也不应把 interject 拆成新账单。
- mutation ledger 是队列幂等审计，不是计费 ledger；P4 不应复用或延长其 30 天 retention 作为账务证据。

## 风险与未尽事项

- P1 只交付 repository/API；turn completion、engine receipt reconcile、delivery_unknown 恢复、grant/preCheck 和 all-tab broadcast 属于 P2/P5，当前 flag 必须保持 off。
- mutation body 上限继承现有 300 MiB 用户内容预算；handler 强制 Content-Length，64 MiB 内按总声明字节并发预算，大请求独占，并在读 body 前按 4 倍峰值估算检查 V8 heap 与系统空闲内存。读取按声明长度单 Buffer 预分配，避免 chunks+concat 副本；灰度时仍需观察大请求延迟与 admission 拒绝率。
- migration 必须按 v5 手册人工 apply 并登记 `schema_migrations`；本任务明确禁止 deploy，未修改线上 DB/env、未构建 runtime image、未重启服务。
- TASK 把本 worktree/base `ca32a35b` 的生产 ledger 下一号明确锁定为 0163；审计期间远端 canonical 因另一并行批次前进并出现同号 migration。本任务按用户硬约束未擅自 rebase/改号，集成负责人合并并行批次前必须以生产 ledger 再裁决同号冲突，不能同时应用两个 0163 文件。
- 本批触及 `packages/protocol` 仅为共享常量、触及 commercial master/store/API；未来随 P2 一起发布 protocol/runtime 时仍需按 V5 生效面矩阵判断 runtime image，不能把本批“flag off”误当作免部署规则。
- 全量 integ 的公共 schema 清理债会产生大量非本批取消；本批新增真库测试使用独立 schema 且每次重建，结果稳定。后续应单独修复 commercial integ 的公共 schema 隔离，不能用本批定向绿掩盖该债。
