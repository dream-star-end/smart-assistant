# B6+B7 统一根治设计：账号池 per-slot 租约 + TTL reaper

> 审计项 B6（per-account 并发上限多实例叠加）+ B7（Claude 侧无 inflight slot reaper）统一根治。
> base：`chore/audit-remediation` worktree。负责人：boss + Claude。
> 强制流程：本 design-doc → Codex 计划审批准 → 实现 → Codex 代码审 → 迭代 PASS。
> boss 决策（已拍板）：**方案 1 = per-slot 租约 + 切机 quiesce 兜底**；B6 分布式租约暂不建，标注技术债（偿还触发=常态双活）。

---

## 1. 问题陈述（根因，非症状）

`account-pool/scheduler.ts` 的并发控制是**匿名计数**：

```ts
private readonly inflight = new Map<string, number>()   // accountId → 在途计数
```

- `pick()`/`acquireCodexSlot()` 选中账号后 `incInflight(id)`（计数 +1）。
- `release({account_id})`/`releaseCodexSlot(account_id)` 按 **accountId** `decInflight(id)`（计数 -1）。

**三个根因级缺陷，全部源于"没有 per-slot 身份"：**

1. **B7 — Claude 侧无 reaper（对称性破坏）**：Codex 侧 bridge 有每-turn 600s 兜底
   `codexReleaseTimer`（`userChatBridge.ts:1857`），outbound 完成信号丢/ws 异常断时兜底 release；
   **Claude 侧（`http/proxy`）完全没有任何兜底**。**进程存活期间**请求在 release 之前泄漏
   （abort 路径漏接、finalizer 异常吞掉、某条早退 return 漏成对 release）→ 该账号计数虚高且
   **进程不重启就永不自愈**（计数只能靠新的成对 release 拉回，泄漏的那次永远拉不回）→ 被误判
   per-account cap → **虚假 429 / pool busy**。
   > 修正（Codex 计划审）：进程 crash 本身不会让内存计数永久虚高（重启即清空）；真正的病灶是
   > **进程仍活着、但某次 release 路径丢失/未执行**。reaper 正是为这种"活进程内泄漏"兜底。

2. **release 精度 bug（双重/错配 release 误伤活跃请求）**：`decInflight(accountId)` 只认账号、
   不认"哪一次 pick"。同一账号有 N 个在途请求时，任何一次**多余/重复**的 `release(accountId)`
   会把**另一个仍在跑**的请求的槽位扣掉 → 该请求结束时再 release → 计数被多扣 → 同样导致
   计数失真。当前代码靠"每条路径严格成对调用"的纪律维持，无结构性保证。

3. **B6 — 多实例计数不汇总**：`inflight` 是纯进程内 Map，蓝绿/双 master 各算各的，
   真实上限 = N×cap。**注**：生产稳态是单 master，此症状仅在 hot-standby 切机的瞬时双 master
   窗口出现，该切换已有独立 SOP。**单 master 下计数本身是正确的**——B6 的"多实例"维度
   按 boss 决策**不在本次根治范围**（见 §6 技术债）。

**为什么时间戳 reaper 必须先有 per-slot 身份**（B7 的硬前置）：匿名计数下，"账号 X 有 3 个在途"
只是个数字，无法知道这 3 个分别是何时 acquire 的。一个 now()-only 的 reaper 无法把"某个超时的槽"
对应到具体请求 → 要么不敢回收（B7 没修），要么误回收一个**仍在跑**的活跃槽（过并发，更糟）。
必须给每次 acquire 发一个带 `acquiredAt` 的身份（slotToken），reaper 才能按"这个具体槽 acquire
了多久"精确判定。

---

## 2. 根治方案：per-slot 租约

把"匿名计数" `Map<accountId, number>` 升级为"具名租约集" `Map<accountId, Map<slotId, acquiredAtMs>>`：

```ts
// accountId → (slotId → acquiredAtMs)。
// count(accountId) = inner.size；精确 release = inner.delete(slotId)；reaper 扫 acquiredAtMs。
private readonly slots = new Map<string, Map<string, number>>()
```

- **count（cap 判定）**：`this.slots.get(id)?.size ?? 0`，O(1)。
- **acquire**：`acquireSlot(id): string` —— mint 唯一 `slotId`，`inner.set(slotId, this.now().getTime())`，
  返回 slotId。**同步**（无 await），与旧 `incInflight` 处于 pick 循环同一个无 await 块 →
  **TOCTOU 不变量原样保留**。
  > **slotId 必须用独立的 `slotIdFn`（默认 `randomUUID`），不得复用 `ephemeralKey`**
  > （Codex 计划审 Blocking 1）：`ephemeralKey` 语义是"无 sessionId 时的临时 WRH key 生成器"，
  > 测试里可能被注入成确定性函数；若返回固定值，同账号并发 slot 会 `Map.set` 覆盖 → under-count，
  > 幂等/无别名假设失效。新增注入 `slotIdFn?: () => string` 到 `SchedulerDeps`，默认 `randomUUID`；
  > 测试可注入单调计数器保证唯一。
- **release**：`releaseSlot(id, slotId): void` —— `inner.delete(slotId)`；inner 空则
  `slots.delete(id)`（防 Map 膨胀）。**幂等**：删一个不存在的 slotId 是 no-op。
  **精确**：只动 slotId 这一个租约，绝不误伤同账号其它在途租约（根治缺陷 2）。
- **slotId 唯一且永不复用** → 无别名问题：reaper / bridge timer / finalizer 即使对同一 slotId
  重复 release 也只是幂等 no-op，不会错扣到后来复用同 accountId 的新租约。

### 2.1 契约变更（slotId 设为**必填** → tsc 编译期强制全量 caller 更新，零遗漏）

| 符号 | 现状 | 变更后 |
|------|------|--------|
| `PickResult` | 无 slot 身份 | **+ `slotId: string`** |
| `ReleaseInput` | `{account_id, result}` | **+ `slotId: string`** |
| `pick()` 两条 helper | inc 计数 | `acquireSlot` 发 slotId，装入 PickResult |
| `release(input)` | `decInflight(accountId)` | `releaseSlot(accountId, input.slotId)` + 健康 tracker（不变） |
| `releasePickResult(r)` | `decInflight(r.account_id)` | `releaseSlot(r.account_id, r.slotId)` |
| `acquireCodexSlot(id)` | `void` | **返回 `string`（slotId）** |
| `releaseCodexSlot(id)` | `releaseCodexSlot(id)` | **`releaseCodexSlot(id, slotId)`** |
| `getInflight(id)` | `inflight.get(id) ?? 0` | `slots.get(id)?.size ?? 0`（测试/监控签名不变） |

> 健康 tracker（`onSuccess`/`onFailure`）、`ReleaseResult` 四态语义、pick 的 WRH/pin/retry
> 控制流、egress 权威源字段——**全部零改动**。本项只换"并发槽位"这一层的数据结构与契约。

> **两条 pick helper 都 mint 槽，必须同样改**（Codex 计划审 Blocking 3）：除 `runWRHLoop`
> （cap@1055、inc@1060、vanished dec@1085、AEAD dec@1089），`pickPinnedAccount`（pin 命中/切
> winner 路径）有**完全相同**的 inc/dec 模式——cap@1184、inc@1186、null-token dec@1194、
> catch dec@1212、返回 PickResult@1197。两者一并把 `incInflight`→`acquireSlot`、`decInflight`
> →`releaseSlot(id, slotId)`、PickResult 装入 slotId。pin enforce 下的 TOCTOU/cap 语义随之被覆盖，
> 单测需对 pin-hit 路径单独验。

### 2.2 调用方 slotId 数据流（全链路闭合）

**Claude 路径**（`http/proxy` + `billing/proxyBilling.ts`）：
```
scheduler.pick() → PickResult.slotId
  → 存到 PreparedUpstreamSession.slotId（upstream.ts；新增字段 string|null）
       OAuth session = pick.slotId；DeepSeek/MiniMax（无池）= null
    → preparation 期 4 处早 release（upstream.ts:612/663/748/790）：slotId: pick.slotId
    → refresh rebind（upstream.ts:715）：必须保留同一 slotId（槽未释放，账号没变只是刷 token）
    → case(c) releaseUpstreamSession（upstream.ts:835）：slotId: session.slotId
    → finalizer 装配（proxy/index.ts:625 makeFinalizer，传 slotId: session.slotId）
      → FinalizeContext.slotId（billing/proxyBilling.ts:51；新增字段 string|null）
        → finalize 内权威 release（billing/proxyBilling.ts:359，受 ctx.accountId!==null 守门）：
          scheduler.release({ account_id, slotId, result })
```
> 修正（Codex 计划审 Blocking 2）：权威 release **不在 core.ts，在 `billing/proxyBilling.ts:359`**。
> slotId 随 session 一路带到 `FinalizeContext` 即可，无需新增传递通道。`accountId===null`
> （DeepSeek/MiniMax，无池）路径 release 本就被跳过，slotId 置 null 占位、不影响。
> refresh rebind 切换 token 时槽仍持有 → slotId 必须原样保留（upstream.ts:715），不可丢字段。

**Codex 路径**（`ws/userChatBridge.ts` + `index.ts` codexBinding 包装）：
```
index.ts:2715 scheduler.acquireCodexSlot(account_id) → slotId
  → CodexBindingHandle.acquire 返回 {account_id, slotId}
    → bridge 存 acquiredCodexSlotId（与 acquiredCodexAccountId 同生命周期，成对重置）
      → 5 处 release（1765/1836/1860/2667/3013）+ codexReleaseTimer:
         codexBinding.release(account_id, slotId)
          → scheduler.releaseCodexSlot(account_id, slotId)
```

### 2.3 reaper（B7 兜底网，统一覆盖两路）

新增 `reapExpiredSlots(nowMs?): number`：遍历 `slots`，对 `nowMs - acquiredAtMs > ttlMs` 的租约
`releaseSlot` 回收，返回回收数。

- **不调健康 tracker**：超时是 ambiguous（可能是泄漏，也可能是合法长 turn 已被别处释放只剩残影），
  按 `transient_network`/`client_error` 既定哲学**不扣健康分**，只回收容量。
- **可观测**：每回收一个 log `account_slot_reaped`（accountId + age），ops 可监测泄漏率。
- **与 Codex bridge timer 共存安全**：Codex 槽正常由 bridge 600s timer 先 release（按 slotId 幂等）；
  reaper 是更长 TTL 的二级网；两者都按唯一 slotId 操作，重复即 no-op，**绝不双扣**。

**TTL 设计（关键，沿用 B1 "不误伤活跃流" 的推理）**：
- 令 `floor = max(CODEX_SESSION_MAX_MS, 30min)`、`ceil = max(floor, 24h)`；
  `ttl = clamp(configured ?? 默认30min, floor, ceil)` + `Number.isSafeInteger` 守卫。
  > 修正（Codex 计划审 Blocking 4）：上界写死 24h 会与"下界 ≥ Codex cap"矛盾——若运维把
  > `CODEX_SESSION_MAX_MS` 设成 >24h，旧规则会把 TTL 压回 24h < Codex timer → reaper 抢跑误收
  > 活跃 Codex turn。改成 **`ceil = max(floor, 24h)`**，保证 `ttl ≥ floor ≥ CODEX_SESSION_MAX_MS`
  > 恒成立，上界永不低于下界。
- **下界 = max(Codex 硬 session cap, 30min)** 的理由：Codex turn 被 bridge 在 `sessionMaxMs`（默认
  600s）硬终止，reaper TTL 必须 > 该值，保证 Codex 槽永远是 bridge timer 先释放、reaper 不抢跑
  误回收活跃 Codex turn。Claude turn（深度思考/长生成）也可能很长，30min 下界给足余量。
- **偏向 under-reap**：误回收一个**活跃**槽 → 该账号过并发 → 上游 429 / 触发反风控（严重）；
  漏回收一个**泄漏**槽 → 仅浪费 cap=10 中的 1 格容量（轻微，且下次进程重启清零）。两害相权，
  TTL 宁长勿短。
- **挂载**：`startAccountSlotReaper({ scheduler, intervalMs, log })`（镜像现有
  `pendingOrdersExpirer`/`refreshEventsSweeper` 的 SweeperHandle 模式），默认 interval 60s，
  `timer.unref()`，shutdown 时 `.stop()`（接进 index.ts 既有 sweeper 启停序列 ~2856/2954）。

---

## 3. 改动文件清单（原子改动，tsc 闭合）

1. `account-pool/scheduler.ts`（核心）：slots Map；`acquireSlot`/`releaseSlot`；`slotIdFn` dep；
   `PickResult.slotId`/`ReleaseInput.slotId`；**两条 pick helper**（runWRHLoop + pickPinnedAccount，
   cap 判定改 `.size`、chosen 走 acquireSlot、null-token/vanished/AEAD reselect 走 releaseSlot）；
   `release`/`releasePickResult`/`acquireCodexSlot`/`releaseCodexSlot`/`getInflight`；
   `reapExpiredSlots` + TTL 配置 `sanitizeSlotLeaseTtl`。
2. `account-pool/accountSlotReaper.ts`（新）：SweeperHandle 模式 reaper 调度器（镜像 pendingOrdersExpirer）。
3. `http/proxy/upstream.ts`：`PreparedUpstreamSession.slotId`（string|null）；pick→session.slotId；
   4 处早 release（612/663/748/790）+ refresh rebind（715 保留 slotId）+ `releaseUpstreamSession`（835）带 slotId。
4. `http/proxy/index.ts`：makeFinalizer 传 `slotId: session.slotId`（:625）。
5. `billing/proxyBilling.ts`：`FinalizeContext.slotId`（:51，string|null）；finalize 权威 release（:359）
   透传 `slotId: ctx.slotId`。**（修正：权威 release 在此，非 core.ts）**
6. `ws/userChatBridge.ts`：`CodexBindingHandle.acquire` 返回 `{account_id, slotId}` + `.release` 形参加 slotId；
   `acquiredCodexSlotId` 状态（与 acquiredCodexAccountId 成对重置）；5 处 release（1765/1836/1860/2667/3013）
   + `codexReleaseTimer`（1857）透传。
7. `index.ts`：codexBinding.acquire（:2715 `scheduler.acquireCodexSlot` 返回 slotId）/release（:2719 透传）
   实现；wire `startAccountSlotReaper` + shutdown stop（镜像 :2856/:2954）。
8. 测试：`accountScheduler.test.ts`（单元）+ `accountScheduler.integ.test.ts`（PG）+ 新 reaper 单测；
   `proxyBilling` finalizer slotId 透传单测；upstream/bridge 既有测试随签名变更编译修正。

---

## 4. 测试计划

**单元（无 DB）**：
- 精度：同账号 acquire 两个 slotId A/B，release(A) 后 count=1 且 B 仍在；release(B) 后 count=0、
  账号 entry 被 delete。
- 幂等：release(A) 两次、release 不存在的 slotId → 无副作用、count 不变负。
- cap：slots.size 到 maxConcurrent 时 pick 候选过滤 / acquireCodexSlot 抛 AccountPoolBusyError。
- reaper：注入 fake now，acquiredAt 超 TTL 的被回收、未超的保留，返回值=回收数；不调健康 tracker。
- TTL sanitize：env 解析、clamp 上下界（含 CODEX_SESSION_MAX_MS>24h 时 ceil 抬到 floor）、
  非法/非 SafeInteger 回落默认。
- getInflight = inner.size。
- **pin-hit 路径**（pickPinnedAccount）：cap 命中返 null、acquire 后 null-token/异常走 releaseSlot、
  返回 PickResult 带 slotId。
- **slotId 唯一性回归**：即使 `ephemeralKey` 被注入成固定值，`slotIdFn` 仍产唯一 slotId、
  同账号并发不互相覆盖。
- **Codex 重复 release 同一 slotId 幂等**：bridge timer + 早 release 对同 slotId 双调 → 不双扣。
- **proxyBilling makeFinalizer slotId 透传**：finalize 成功/失败/client_error 三态都把
  ctx.slotId 透到 scheduler.release；accountId=null 时跳过 release（slotId 不参与）。

**集成（真 PG，octest）**：
- pick 返回非空 slotId；release(slotId) 后 getInflight 归零。
- 连续多 pick 拿到互异 slotId；cap 到达 → busy。
- reaper 在 PG 路径回收泄漏槽。
- 回归：accountScheduler.integ 现有 pin/health/反关联用例全绿。

**回归**：`test:commercial:unit` + `test:commercial:integ`（PG）+ tsc build + biome。

---

## 5. 风险与回滚

- **风险面**：hot-path（Claude 聊天代理 + Codex bridge 并发管控）。但改动是**纯进程内数据结构
  替换 + 契约字段透传**，无 SQL/migration/schema、无网络行为变化、无健康分逻辑变化。
- **TOCTOU**：acquireSlot 同步、处于原 incInflight 同一无 await 块 → 硬上限不变量保留。
- **完整性**：slotId 必填 → tsc 不编译直到所有 caller 更新；无静默漏改。
- **回滚**：每文件小 commit；整体可 `git revert`。无状态迁移，重启即清。
- **部署分类**：改动全在 `packages/commercial/src/**`（TS，master gateway 进程），**不碰
  runtime image / 容器 / node-agent** → master-only deploy，**无需 runtime image 重建**
  （按 v3-commercial-deploy 判定，落地阶段复核确认）。

---

## 6. B6 多实例维度 —— 技术债（boss 决策：暂不建分布式设施）

- **现状不变量**：单 master 下 per-account 计数正确，cap 严格成立。
- **双 master 窗口**：仅 hot-standby 切机瞬时出现，真实上限 N×cap。
- **兜底**：依赖 `v3-master-hot-standby-migration` 切换 SOP 在切换窗口 quiesce 账号池
  （切换期短暂、有人值守、已有独立流程）。
- **偿还触发条件**：若未来转为**常态双活**（非切机瞬时），需把 slot 租约后端做成 Redis
  （SETNX+TTL/Lua CAS 跨实例汇总，复用 B9 "Redis-down 降级而非开闸" 回退进程内的哲学）。
  per-slot 租约结构已为此预留（slotId 即天然的分布式租约 key）。
- 代码层在 `slots` 字段注释标注此技术债 + 偿还触发，避免未来误以为已分布式。
