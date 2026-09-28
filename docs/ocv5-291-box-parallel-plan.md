# OCV5-291 · Box Opus 多会话并行（selfhost）

## 事实与缺陷

- 当前 live 对合格 Box 账号的准入执行 `SELECT 1 ... boxState IN ACTIVE AND (accountId=same OR uid+session=same)`；只要账号已有一笔运行，另一个会话即 `BOX_CAPACITY_HELD`。同一条远端工具链的多个 HTTP journal 行也都仍是 ACTIVE。
- 截至 2026-09-28 05:02 UTC，selfhost 仅账号 20 合格，故实际只有一个全局席位。这是 OpenClaude 自设围栏，不是已经证明的 Box/Claude CLI 上游限制。
- 已用同一账号 20、两个独立 pinned target 的**非模型** Sand Exec 同时执行各 2 秒 sleep：两次均正确返回，重叠执行段约 3.1 秒；证明 Box Exec 接口可重叠，不证明两个付费 `claude -p` 也能稳定共存。

## 目标与冻结边界

一期至少支持 **同 uid3 的两个不同 OpenClaude session 在唯一账号20上同时运行**；每个会话独立 runNonce/epoch/cwd/CLI transcript/spool/usage/终止证明，另一会话不能读取、停止或释放它。先有界 cap=2，真实付费并发验收后再评估更高并发；不是无限并发承诺。

只改 selfhost Box 的准入策略、文本进程内名额、错误出口及定向测试，商业版生产/其他模型保持现状；无 DB 迁移、不增加一串灰度旗、不重放歧义调用。旧异常行 `orphan_exception_closed` 永久保留指纹/alias，不算活动容量，也不能被当作新付费请求。自用实例身份必须显式钉定，不能仅凭 uid3/account20 放宽将来反合的商业实例。

## 设计

1. **原子准入**：保留现有 `box:account` + `box:fingerprint` + `box:session` advisory 锁、duplicate fingerprint/alias 拒绝。只替换全局 `occupied`：
   - 同 uid+session 若有任一其它 ACTIVE 远端 run，仍拒绝（同一会话不同 turn 不并发）。
   - 同 account 的 ACTIVE journal 行按 `(runNonce, leaseEpoch)` **分组计远端运行数**，同一工具链即使有多个 HTTP 行只占一个槽。无效/缺失身份不得从计数中消失，必须拒绝或单独占槽并保留证据。
   - selfhost uid3/account20 cap=2；其他 uid/account 仍 cap=1，且授权账号绑定不放松。账号容量按该账号**全部 uid**的合法组计数；任一 ACTIVE 行缺失或非法 nonce/epoch 时拒绝新 admit，绝不用裸 `COUNT(DISTINCT (nonce,epoch))` 把它漏掉。第二条独立 run 仅在活动组数 < cap 时 durable admit；第三条绝不可启动新的付费 CLI。
   - `BoxInvocationRegistry` 的文本路径目前在 journal 前还有 `maxPerUser=1,maxPerAccount=1`。同一 selfhost 准入策略把 uid3/account20 的这两个上限同步设为2，其他保持1；跨进程最终容量仍以 journal 锁内计数为准。工具路径的 `own()` 不加条数上限。
2. **隔离与生命周期**：首跳 runNonce 唯一的 0700 cwd，私有暂存/runner/spool/原生项目 transcript 不共享；续轮使用原 run 身份和 owner CAS，不能再占新槽。停止、unknown observer、计费恢复和清理都以 uid/account/runNonce/epoch 钉死；一个 run 结束只释放自己的组，不触碰另一个。
3. **预扣与错误**：Redis 原子预扣按请求独立保留；并行在余额不足时不能互相花掉对方的预扣。两槽已满时，`BoxDurableJournalError(BOX_CAPACITY_HELD)` 从文本/工具入口到 `core.ts` 保留固定错误类型，HTTP 409 和 `BOX_CAPACITY_HELD`，不再折成 500 `internal error`。响应文案避开网关 `model_capacity`/`upstream_failed` 的自动恢复匹配词；真实 `classifyRunError` 与 `supportsAutomaticTurnRecovery` 断言它**不触发轮内十次重试**。只释放本请求的预扣，客户端可稍后主动发新 turn，不自动重放 paid invocation。
4. **冷 Box**：`resolveBoxExec` 同账号并发 Get/Ensure 的真实行为需要负控；满槽时尤其不能反复扰动已在跑的 CLI。若负控显示 Ensure 会扰动在跑的 CLI，已验证 descriptor 的热运行请求直接复用，不再 Ensure；只串行化真正冷唤醒/descriptor 初始化，绝不串行整条模型运行。任何失联都按原 journal unknown/证明路径收口。

## 验收与判停

- 离线/PG：同 account 两个不同 session 准入、第三拒绝；同 session 第二拒绝；双连接竞争最多 cap 个成功；同一 run 多个 handoff/linked 行只算一个槽；非法身份 ACTIVE fail closed；文本 registry 可同时接两条且不能代替 journal；取消/失败/cleanup runA 不释放 runB；重复指纹/跨 uid/account/旧异常行防重放；并行预扣/终态 ledger 各一次。满槽走真实 handler→gateway 分类，409 不自动恢复、没有新 paid；真实业务结果断言而非仅 mock 调用次数。
- 先做真实 Box **非付费**多 Exec 已有证据，再做 Ensure 对已有长跑 Exec 的负控；通过后用签名 synthetic durable 路径一次性运行两个不同会话的付费 CLI 且制造可观察重叠；每条收独立 exact answer、终止 proof、usage/ledger、cleanup，核对不同 cwd/project/transcript 和 stdout 零交叉，停/清 A 不影响 B，零二次付费。失败留下原证据，不自动重试；若共享 HOME 实际发生配置锁/串读，再定向隔离配置且保留默认 Box OAuth，不提前凭猜测改行为。
- T2 审计范围覆盖 journal、egress/协议/计费和发布路径，成立 blocker 修复复审到 PASS；完整相关门绿才串行合共享、官方 selfhost lease；切流后只读核验。用户负责数小时长测。
- 判停：上游不支持并发 paid CLI、两个 run 使用同一 transcript/私有文件、跨 run Stop/cleanup、重复计费/钱包负数、活动数超过 cap、不能按原终止证明收口。命中即维持旧围栏/官方回退，不把生产灰度当调试。
