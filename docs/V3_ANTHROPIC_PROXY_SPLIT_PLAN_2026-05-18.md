# V3 Anthropic Proxy Handler 三层拆分计划 (2026-05-18)

> Status: **DRAFT v7** — Codex round 1-6 反馈已整合,pending Codex final approve
> Branch: `feat/anthropic-proxy-strategy-split` (worktree `/opt/openclaude/openclaude-v3-proxy-split`)
> Base: `origin/v3` @ `e149dc7a`
> Scope: 纯重构,**不引入新功能**。新增对外 CC 接入端点是本拆分之后的独立任务,不在本计划范围内。

---

## 1. 动机

`packages/commercial/src/http/anthropicProxy.ts` 当前 2390 行,把三件本应分层的事绑在一起:

- **(a) Identity** — 容器身份双因子(`host_uuid` + `bound_ip` + `Bearer secret`)
- **(b) Billing** — preCheck / 手动 rollback / journal / finalizer / settle / WS 广播 / scheduler.release
- **(c) Proxy Core** — header allowlist / device_id pin / scheduler.pick / OAuth refresh / per-account egress / stream pipe / quota harvest

**问题不是文件长**,问题是:

1. **现实需求已经在推它拆分**。`packages/commercial/src/billing/codexFinalizer.ts:60-65` 直接 import 了 `abortInflightJournal` / `finalizeInflightJournal` / `settleUsageAndLedger` / `SettleResult`。`packages/commercial/src/ws/userChatBridge.ts:58-60` runtime import 了 `startInflightJournal` / `abortInflightJournal`。也就是说 (b) 已经被两个外部模块**运行时消费**,只是物理位置还压在 `http/anthropicProxy.ts` 里。这是层错位。
2. **未来加任何新接入端点都得改这个文件**(对外 CC、SDK、第三方集成…)。
3. **整链 0 测试覆盖**(`packages/commercial/src/__tests__/anthropicProxy.test.ts` 18 个 describe / 99 个 test 全是 export 工具函数,handler 主流程 `makeAnthropicProxyHandler` 没有任何 e2e)。这条债拆分前必须先补一份 baseline,否则"重构悄悄改了行为没人知道"。

---

## 2. 当前架构(事实地图)

### 2.1 主流程行号(`makeAnthropicProxyHandler` L1613-2333)

| 行号 | 行为 | 层 |
|------|------|---|
| L1613-1641 | 工厂装配 + security headers + reqLog | wiring + (c) |
| L1642-1649 | 路径白名单 `POST /v1/messages` | (c) |
| L1650-1677 | `verifyContainerIdentity` → `{ userId, containerId, hostUuid, boundIp }`(source-of-truth 字段名;L1675-1676 转 `uid = BigInt(userId)`) | **(a)** |
| L1679-1681 | `recordHostRequest(ctx.hostUuid)` admin metric | **post-auth side effect**(不是 identity 语义) |
| L1683-1734 | per-uid rate-limit + concurrency `acquire` | **Gate**(admission control,非 identity) |
| L1737-1758 | body 解析 + zod strict + 字段字节预算 | (c) |
| L1760-1767 | `pricing.get(model)` + enabled 检查 | (b) |
| L1769-1806 | `loadUserModelAuthz(uid)` + `canUseModel(authz, pricing, model)` | **authz**(identity 延伸面,但依赖 pricing) |
| L1808-1823 | `isDeepseekModel` 路由分叉 | (c) |
| L1825-1856 | `estimateInputTokens` + `estimateMaxCostBothSides` + `preCheckWithCost` | (b) |
| L1867-1913 | `scheduler.pick` + `getDispatcherForAccount` | (c) |
| L1914-1991 | `refreshAccountToken`(同 dispatcher 绑定)+ **失败手动 rollback**:`scheduler.release` + `releasePreCheck` | (c) + **(b) Phase-1 rollback** |
| L1994-2022 | `startInflightJournal` + **失败手动 rollback**:`scheduler.release` + `releasePreCheck` | **(b) Phase-1 rollback** |
| L2024-2047 | `makeFinalizer({ ... })` — **从这一行起,release 权唯一归 finalizer** | **(b) Phase-2 finalizer** |
| L2049-2053 | `AbortController` + req/res close 绑定 | (c) |
| L2056-2087 | `buildSafeUpstreamHeaders` + Authorization + `oauth-2025-04-20` beta 注入(deepseek 路径 strip beta + 注入 deepseek key) | (c) — **upstream-specific auth/header mutation** |
| L2088-2104 | `stripMalformedThinkingBlocks`(非 deepseek) | (c) |
| L2105-2135 | `rewriteMetadataDeviceId(pick.pinned_user_id)`(deepseek 跳过)+ 强制 `stream:true` | (c) — 反风控核心 |
| L2137-2153 | `fetch(endpoint, { dispatcher })` | (c) |
| L2154-2189 | 上游 4xx/5xx 错误分类:`finalize.failClient` vs `finalize.fail` | (c) + **(b) Phase-2** |
| L2190-2199 | `maybeUpdateAccountQuota` 反写 5h/7d utilization(deepseek 跳过) | (c) |
| L2200-2219 | `pipeStreamWithUsageCapture` + TTFT / duration metrics | (c) |
| L2230-2291 | `finalize.commit/fail/failClient` + **`appendCostCredits` durable persist** + **`broadcastToUser({type:'outbound.cost_charged'})`** | **(b) Phase-2 finalizer + post-commit hook**(顺序敏感:persist first, broadcast second) |
| L2300-2332 | catch + finally(token zero-fill + releaseSlot) | Gate + (c) |

### 2.2 已经天然成模块的代码段(L1-1605,handler 之外)

| 行号 | 内容 | 归属 |
|------|------|------|
| L195-214 | `DEFAULT_PROXY_RATE_LIMIT` / `DEFAULT_MAX_CONCURRENT_PER_UID` | Gate |
| L216-310 | `proxyBodySchema` / `enforceFieldByteBudgets` | (c) |
| L311-380 | `extractSessionId` / `rewriteMetadataDeviceId` | (c) — 反风控 |
| L381-432 | `estimateInputTokens` / `estimateMaxCostBothSides` | **(b)** — 成本估算 |
| L433-466 | `buildSafeUpstreamHeaders` | (c) — header allowlist |
| L467-563 | `ConcurrencyLimiter` / `FallbackRateLimiter` | Gate |
| L564-810 | SSE 解析 + `pipeStreamWithUsageCapture` | (c) |
| L811-955 | error helpers + `stripMalformedThinkingBlocks` | (c) |
| **L956-1492** | **`makeFinalizer` + `startInflightJournal` + `finalizeInflightJournal` + `abortInflightJournal` + `settleUsageAndLedger`** | **(b) — 已被 codexFinalizer.ts + userChatBridge.ts 外部 runtime import** |

### 2.3 数据依赖矩阵(分清"identity 输出" vs "ctx 入参")

| 字段 | 来源 | (b) 消费 | (c)/Gate/Obs 消费 |
|------|------|---------|------------------|
| `uid` (bigint) | `verifyContainerIdentity` 返回 | preCheck / authz / FinalizeCtx / `appendCostCredits` / `broadcastToUser` / settle | Gate: rate-limit + concurrency key |
| `containerId` (bigint) | `verifyContainerIdentity` 返回 | journal `container_id` 写入 + log 标签 | — |
| `ctx.hostUuid` | listener 注入(self-host: SELF_HOST_UUID;mTLS: SPIFFE SAN) | — | Obs: `recordHostRequest`(post-auth)|
| `ctx.boundIp` | `req.socket.remoteAddress`(self-host)或 `X-V3-Container-IP` 头(mTLS) | — | reqLog 日志标签 |
| `identity.boundIp` (DB 字段) | `agent_containers.bound_ip` | — | 仅 verifyContainerIdentity 内部双因子校验,**外部不消费** |
| `authz` (role + grantedModelIds) | `loadUserModelAuthz(uid)` | — | 仅 `canUseModel` 决策一次,**用完即丢** |
| `pricing` (ModelPricing) | `deps.pricing.get(body.model)` | preCheck / finalizer.pricing | authz `canUseModel`(read-only) |

**关键事实**:
- `uid` 是唯一双层共用字段
- `containerId` 只进 billing(journal/log)
- `hostUuid` / `boundIp` **不是** identity 输出,是 ctx 入参,只用于 reqLog + admin metric

### 2.4 唯一 mount 点

`packages/commercial/src/index.ts:788` 是 `makeAnthropicProxyHandler` 的唯一构造点。listener bind 在 `INTERNAL_PROXY_BIND:INTERNAL_PROXY_PORT`(默认 `172.30.0.1:18791` plain HTTP)+ 可选 `EXTERNAL_MTLS_ENABLED` 时再开 18443 mTLS。两个 listener 共享同一 dispatcher,通过 ctx (`hostUuid`/`boundIp`) 区分来源。

**这意味着:只要新 handler 的对外签名仍是 `(deps) => (req, res, ctx) => Promise<void>`,index.ts 几乎无侵入。**

---

## 3. 目标架构

### 3.1 控制流(顶层 wiring)

```
http/proxy/index.ts  ← 薄 wiring (~100-180 LoC)

  makeAnthropicProxyHandler(deps) → (req, res, ctx) =>
    1.  identity      = await deps.identity.resolve(req, ctx)              // verify + post-auth obs
    2.  gateRelease   = await deps.gate.acquire(identity.uid)               // rate-limit + concurrency
    3.  body          = await parseBody(req)                                // (c) — zod strict
    4.  pricing       = deps.pricing.get(body.model)                        // (b) — model enabled?
    5.  authzResult   = await deps.identity.authorize(identity, pricing, body.model)
    6.  billingPhase1 = await deps.billing.preCheck(identity, pricing, body)  // returns { reservation, precheckCredits }
    7.  upstreamPick  = await proxyCore.pickUpstream(body, pricing)         // OAuth pool pick + refresh OR deepseek-route
    8.  if (upstreamPick.failed) {
          await deps.billing.rollbackBeforeFinalizer(billingPhase1, reason)
          // Release ownership 四段铁律(见 §5.4),此 step 处理 (a)(b):
          //  (a) pick 本身失败 → 还没拿到 account,proxyCore 不调 scheduler.release
          //  (b) pick 成功但 refresh 失败 → proxyCore 内部已调 scheduler.release(account, 'transient_network')
          //  此处 wiring 只负责回滚 billing reservation
        }
    8b. try {
          journal = await deps.billing.startJournal(billingPhase1, upstreamPick.accountId)
        } catch (journalErr) {
          // 四段铁律 (c):session 已成功但 finalizer 建立前的失败窗口。
          // wiring 不该直接调 scheduler.release(scheduler 不是 wiring 的 dep);
          // 通过 ProxyCore.releaseBeforeFinalizer 显式补偿(§3.4)。
          // releaseBeforeFinalizer 是 best-effort 永不抛(§3.4 契约),
          // 因此 rollbackBeforeFinalizer 必然执行,reservation 必然回滚。
          await proxyCore.releaseBeforeFinalizer(upstreamPick)        // best-effort
          await deps.billing.rollbackBeforeFinalizer(billingPhase1, 'journal_failed')
          throw journalErr
        }
    9.  finalizer     = await deps.billing.createFinalizer(billingPhase1, journal, upstreamPick.accountId)
       // **release 权转移点是这一行成功返回**,不是 upstreamPick 成功。
       // 从这一刻起,release 权唯一归 finalizer。proxyCore 不能再调 scheduler.release。
    10. result        = await proxyCore.run({ identity, body, upstreamPick, finalizer, req, res })
    11. // proxyCore 内部在 stream 结束/出错时调 finalizer.commit/fail/failClient。
       // commit 内部串行执行 durable persist + broadcastToUser
       //   (gate: committed && debitedCredits > 0; broadcast fire-and-forget)。
    12. // gate release / session.zeroizeSecrets() / etc finally
```

**注意**:`billing.finalize(billing, result)` 顶层钩子**不存在**。core 持有 `finalizer` 句柄,在恰当时机自己调三态方法。post-commit 的 persist + broadcast 是 billing 内部串行执行,不暴露给 core。

### 3.2 Identity 层契约

```ts
interface ProxyIdentity {
  uid: bigint;
  containerId: bigint;       // strategy-specific; container=db id, future api-key=key id
  // 注:hostUuid/boundIp 不进 ProxyIdentity。它们是 listener 入参 ctx,由 wiring 直传 Obs 层。
}

interface IdentityStrategy {
  resolve(req, ctx): Promise<ProxyIdentity>;
  // throws IdentityError(401/403)
  // 实现内部职责:verifyContainerIdentity + post-auth side effects (recordHostRequest等)

  authorize(
    identity: ProxyIdentity,
    pricing: ModelPricing,   // 显式接受 pricing,不做隐藏依赖
    model: string,
  ): Promise<void>;
  // throws AuthzError(403)
  // 当前实现:loadUserModelAuthz(uid) + canUseModel(authz, pricing, model)
}
```

**当前 v3 实现**:`ContainerIdentityStrategy`。

**Authz 不进 `ProxyIdentity` 字段**:它依赖 pricing(body 解析后才有),且决策一次即丢,不进下游消费。把它揉进 `resolve()` 返回会让"每个请求查 role/grants"成强制开销;独立 `authorize()` 才符合现状(身份 verify 与 authz 查询是两条独立 DB 路径)。

### 3.3 Billing 层契约 — 两段 lifecycle

当前代码真实的 billing lifecycle 有两个明确阶段,新契约必须显式建模:

```ts
// Phase 1: reservation 建立 → finalizer 建立之前
//   此阶段任何下游失败(scheduler.pick / refresh / startJournal)
//   都必须手动 rollback。core/wiring 通过 billing.rollbackBeforeFinalizer 回滚 reservation;
//   scheduler.release 责任见 §5.4 四段铁律。
interface BillingPhase1 {
  reservation: ReservationHandle;   // billing 内部不透出细节,但是个 opaque token
  precheckCredits: bigint;          // 给 finalizer ctx 用
  pricing: ModelPricing;            // 透传,避免 wiring 二次查询
}

// Phase 1.5: journal 是公开 phase boundary,因为 journal insert 失败本身就是
//   "finalizer 前最后一个高风险窗口"(§5.4 (c)),不能藏在 createFinalizer 内部。
interface JournalHandle {
  // opaque token;billing 内部持有 inflight journal row id 等
  // core 不消费 handle 内容,只把它穿到 createFinalizer
}

// Phase 2: finalizer 建立之后
//   release 权唯一归 finalizer。core 调 finalizer.commit/fail/failClient,
//   billing 内部串行执行:scheduler.release + ledger settle + appendCostCredits + broadcastToUser。
//
// 关键契约:accountId 在 createFinalizer() 时一次性绑定,三态方法不再各自传 accountId
// (避免 accountId 双源)。observation 由 core 持有 mutable closure,调用时以"当下值"传入,
// 不让 observation 状态搬进 billing 内部(避免破坏 §5.3 闭包边界)。
interface FinalizerHandle {
  commit(obs: UsageObservation): Promise<void>;
  fail(obs: UsageObservation, error: Error): Promise<void>;        // 上游 5xx / 网络 → 健康分扣
  failClient(obs: UsageObservation, error: Error): Promise<void>;  // 客户端 abort / 4xx → 不扣健康分
}

interface BillingStrategy {
  preCheck(identity, pricing, body): Promise<BillingPhase1>;
  // throws InsufficientCreditsError(402)

  rollbackBeforeFinalizer(phase1: BillingPhase1, reason: 'pick_failed' | 'refresh_failed' | 'journal_failed'): Promise<void>;
  // 只回滚 reservation;不碰 scheduler(那是 core 的责任,因为 core 才知道 pick 是否成功)

  startJournal(phase1: BillingPhase1, accountId: bigint | null): Promise<JournalHandle>;
  // 公开 phase boundary。失败 throw JournalError,core 视为四段铁律 (c) 处理。

  createFinalizer(phase1: BillingPhase1, journal: JournalHandle, accountId: bigint | null): Promise<FinalizerHandle>;
  // 必须吃 journal handle(billing 内部 finalizer 需要 journal row id 做 settle/rollback)。
  // 一旦返回,core 必须只通过 FinalizerHandle 操作账务/release;不可再调 rollbackBeforeFinalizer 或 startJournal。

  // 注:post-commit hook (appendCostCredits + broadcastToUser) 不暴露为独立方法。
  // 它是 FinalizerHandle.commit 的内部串行延续,gate 保留现状:
  //   仅 `committed && debitedCredits > 0` 才 persist/broadcast;
  //   顺序保证:durable persist first, broadcast second;broadcast 失败 fire-and-forget,不回滚账务。
}
```

**当前 v3 实现**:`V3CommercialBilling` 包装现有逻辑。

### 3.4 Proxy Core 契约

```ts
interface ProxyCoreInput {
  identity: ProxyIdentity;
  body: ParsedRequestBody;
  upstreamPick: PreparedUpstreamSession;   // 见 §5.4,已经 pick + refresh 完毕
  finalizer: FinalizerHandle;
  req: IncomingMessage;
  res: ServerResponse;
}

interface ProxyCore {
  // upstream 选择 + pick + refresh + dispatcher 准备
  pickUpstream(body, pricing): Promise<PreparedUpstreamSession | PickError>;
  // 失败时 core 内部已 scheduler.release(如果 pick 已发生),wiring 只回滚 billing。

  // 显式补偿入口 — 仅四段铁律 (c) 使用:session 已成功返回但 createFinalizer 之前 wiring 侧失败。
  // 内部:core 持有 scheduler dep,执行 scheduler.release(session.accountId, 'failure')。
  // session.accountId === null(deepseek 等)时 noop。
  //
  // **best-effort 契约**:实现内部 swallow + log scheduler.release 的失败,
  //   永远不向调用方抛错。理由:billing rollback (releasePreCheck) 不能被
  //   release 补偿失败阻断;贴近现有代码 `scheduler.release(...).catch(() => {})` 语义。
  //   Phase 0 不变量 1 必须有 negative test:stub scheduler.release reject,
  //   验证 releaseBeforeFinalizer 不抛 + 后续 rollbackBeforeFinalizer 仍执行。
  releaseBeforeFinalizer(session: PreparedUpstreamSession): Promise<void>;

  run(input: ProxyCoreInput): Promise<void>;
  // 内部:apply upstream auth + device_id pin + fetch + SSE pipe + quota harvest。
  // 在恰当时机调 finalizer.commit/fail/failClient。
  // 不可再调 scheduler.release(那归 finalizer 内部)。
}
```

**Core 内部 scheduler.release 的允许窗口**:
1. `pickUpstream` 内部、pick 成功但 refresh 失败 → 内部调,返回 PickError(不暴露给 wiring)。
2. `releaseBeforeFinalizer(session)` 被 wiring 调 → 显式补偿,语义对应四段铁律 (c)。
3. 一旦 `createFinalizer` 成功返回,release 权转移给 finalizer,以上两个窗口均关闭。

### 3.5 Gate / Observability — 不是 identity,是 wiring 侧 side effect

- **Gate**(rate-limit + concurrency):本质 admission control,放 wiring 层调用,不放 IdentityStrategy。理由:Gate 输入是 `uid`,不是 identity 特性;未来 ApiKeyIdentity 也用同一套 Gate。
- **Observability**(`recordHostRequest`):语义是"身份通过的请求计数"。当前归 `ContainerIdentityStrategy.resolve()` 内部调用,**但这是策略实现细节**,不是 Identity 接口约束。Future `ApiKeyIdentityStrategy` 可以不调或调不同 metric。

---

## 4. 拆分映射(具体文件搬运清单)

| 现位置 | 新位置 | 行数 | 备注 |
|--------|--------|------|------|
| `http/anthropicProxy.ts:L956-1492` | `billing/proxyBilling.ts`(新建) | ~540 | finalizer / journal / settle 整段切出 |
| `http/anthropicProxy.ts:L1650-1681`(verifyContainerIdentity + recordHostRequest)+ `loadUserModelAuthz` 调用 + `canUseModel` 调用 | `auth/proxyIdentity.ts`(新建) | ~100 | `ContainerIdentityStrategy.resolve/authorize` |
| `http/anthropicProxy.ts:L1867-1991`(pick + dispatcher + refresh)+ L2056-2135(authorize + device_id pin) | `http/proxy/upstream.ts`(新建,见 §5.4) | ~280 | `OAuthPoolUpstream` + `DeepSeekUpstream` 两实现 + `PreparedUpstreamSession` |
| `http/anthropicProxy.ts:L216-466` 中 (b) 部分(estimateInputTokens / estimateMaxCostBothSides) | 留原文件或并入 `billing/proxyBilling.ts` | ~50 | 二选一,看 import 简洁度 |
| `http/anthropicProxy.ts:L1613-2333`(handler 主流程瘦身) | `http/proxy/index.ts` 主 wiring | ~100-180 | 三层组装 |
| `http/anthropicProxy.ts` 剩余 (c) 部分 | `http/proxy/core.ts` | ~900 | body schema / SSE pipe / device_id pin 模块 / error helpers |
| `http/anthropicProxy.ts` types | `http/proxy/types.ts` | ~110 | |

**改文件**(纯 import 路径更新):

- `index.ts:98-100`(import)— 改 import path
- `index.ts:788`(mount 构造)— `makeAnthropicProxyHandler({...})` 签名兼容,wiring shape 适度调整
- `index.ts:2483, 2503, 2512`(re-export `_UsageObserver` / `_parseSseEvent` 等用于测试)— 改 re-export 源到新文件
- `billing/codexFinalizer.ts:60-65` — 4 个符号 import 从 `http/anthropicProxy.js` → `billing/proxyBilling.js`
- `ws/userChatBridge.ts:58-60` — **runtime import**(不是类型 import)`startInflightJournal` / `abortInflightJournal` 改源到 `billing/proxyBilling.js`
- `__tests__/anthropicProxy.test.ts`(18 describe / 99 test)— import 拆到对应新文件,**断言全部不动**

**搜索清单**(防漏迁移):

```bash
grep -rn "from.*http/anthropicProxy" packages/commercial/src/
grep -rn "import.*anthropicProxy" packages/commercial/src/
```

任何返回的位置都要审一遍,不止 codexFinalizer.ts 一处。

**新建测试**:

- `__tests__/proxyIdentity.test.ts` — authz fail-closed 路径(现 0 覆盖)
- `__tests__/anthropicProxy.integ.test.ts` — handler 整链 baseline(**必须先于拆分**,§6.1)

---

## 5. 5 个硬骨头的处理决策

### 5.1 DeepSeek 分支 — pick=null 不只是 upstream 差异(L1869-1992, L2116, L2195, L2324)

**事实**:`isDeepseekModel(body.model)` 是 model-driven 路由,但 `pick=null` 蔓延到:
- 跳过 `scheduler.release`(L1241 finalizer 内 `if (ctx.accountId !== null)`)
- 跳过 `rewriteMetadataDeviceId`(L2116)
- 跳过 `maybeUpdateAccountQuota`(L2195)
- 跳过 token zero-fill(L2324)
- 仍正常跑 preCheck + journal + finalize(billing 全套)

**决策**:抽 `PreparedUpstreamSession` 抽象(见 §5.4),两实现 `OAuthPoolUpstream` / `DeepSeekUpstream` 各自封装这些 noop 语义,不让"if pick" 散点判断在新 core 复活。

**testing 不变量**:DeepSeek 路径全套 noop 必须由 integ test 锁定(见 §6.1 不变量 5)。

### 5.2 `loadUserModelAuthz` 的语义归属(L1769-1806)

**事实**:依赖 `uid`(identity)+ `pricing`(body 解析后才有),决策结果只用于"是否放行 model",既不进 finalizer 也不进 fetch。

**决策**:**authz 是 identity 的延伸面**,放 `IdentityStrategy.authorize(identity, pricing, model)`,签名**显式接受 pricing**。

理由:
- 未来 ApiKeyIdentity 也需要 model 授权(API key 可以受限)
- 放 billing 会让每种 billing 策略都自带一份 authz — 错位
- 显式接 pricing 避免隐藏依赖(round 1 Codex 指出)

**调用时机**:body 解析后、preCheck 前,顺序不变(避免 reservation rollback 复杂度)。

### 5.3 流式 abort 时序 — 真正的判别依赖

**事实**(round 1 Codex 关键提醒):客户端 abort 分类**不能仅靠 `ac.signal.aborted`**,因为 `res.end()` 自己也会触发 close listener → 误把"成功结束"判成"客户端 abort"。当前实现靠 `isClientAbort(error)` 看错误形状:`ProxyAbortError` 或带特定 code 的 `AbortError`。

**约束**(写进 `ProxyCore` 契约文档,Phase 0 integ 必须锁定):

1. `finalizer.{commit,fail,failClient}` 必须由 **同一个 core 调用**;wiring 外层不可再包"装饰器"调 finalizer。
2. `accountId` 由 core 在 `pickUpstream` 之后传给 finalizer。
3. `observed` mutable state **留在 core 闭包**;调用时只把**当前 snapshot** 作为值传给 finalizer(对应 §3.3 `commit(obs)` / `fail(obs, err)` / `failClient(obs, err)` 签名)。billing 内部不持有 observation 状态。
4. abort 分类源头是 `isClientAbort(error)` 不是 `ac.signal`,这条 invariant 必须有 negative test(`res.end()` 后 close 不能误判)。

### 5.4 Upstream session 抽象 — 改名 + 删 onRelease

**事实**(round 1 Codex 关键反馈):之前的 `UpstreamHandle.select(body)` 抽得过早,真正的 handle 依赖 `scheduler.pick + dispatcher + refresh 后的新 token + pinned_user_id`,不是仅凭 body 就能确定;且原 `onRelease()` 引入第二个 release 权威源。

**决策**:重新设计为 `PreparedUpstreamSession` — 是 `pickUpstream()` 内部全部副作用完成后的产物,不主动暴露 release。

```ts
interface PreparedUpstreamSession {
  accountId: bigint | null;        // null = deepseek 或其他非 pool 路径
  pinnedUserId: string | null;     // null = deepseek;OAuth = account 的 pinned_user_id
  endpoint: string;                // anthropic api url OR deepseek api url
  dispatcher: ProxyAgent | undefined;
  applyUpstreamAuth(headers: Record<string, string>, body: ParsedBody): void;
    // OAuthPoolUpstream: 注入 Authorization + force `oauth-2025-04-20` beta + rewrite device_id
    // DeepSeekUpstream:  strip beta + 注入 deepseek api key + 跳过 device_id rewrite
  shouldUpdateQuotaFromResponse: boolean;  // OAuth: true; DeepSeek: false
  zeroizeSecrets(): void;
    // OAuthPoolUpstream: 内部持有 token / refresh buffer,zero-fill 后释放
    // DeepSeekUpstream:  noop(deepseek api key 是配置注入,生命周期不归 session)
    // **secret hygiene 闭合**:core 在 finally 调 session.zeroizeSecrets(),不再持有裸 token
}
```

**release 归属(四段铁律,Phase 0 不变量 1 锁定)** — round 3 Codex 修正:转移点是 `createFinalizer` 成功,不是 session 准备好。真实代码顺序 `pick → refresh → startInflightJournal → makeFinalizer`,session 已存在但 finalizer 还没建立的窗口里,release 权仍归 core:

- **(a) pick 自身失败**(`scheduler.pick` 失败/throw)→ 尚未拿到 account,**不调 `scheduler.release`**,直接返回 PickError。
- **(b) pick 成功但 refresh 失败** → **core** 调 `scheduler.release(account, 'transient_network')`,返回 PickError。
- **(c) pickUpstream 已返回成功 session,但 `createFinalizer` 之前任何步骤失败**(目前主要是 `startInflightJournal` 失败)→ **core** 调 `scheduler.release(account, 'failure')`。
- **(d) `createFinalizer` 成功返回之后** → **release 权唯一归 finalizer**,core 主流程绝不再调 `scheduler.release`。

`PreparedUpstreamSession` 本身不拥有 release,也不触发 release 权转移;它只是后续 finalizer 所需的 upstream 结果。这正是 round 1 Codex 反对的"两个 release 权威源"的解法:**通过时间窗口而非接口分割权属**(round 2/3 Codex 已认可)。

**Token 生命周期闭合**(round 2 Codex P0):session 持有 token / refresh 本体,core 通过 `applyUpstreamAuth` 让 session 自己往 headers 写;core finally 只调 `session.zeroizeSecrets()`。这样 core 不再有任何裸 token 句柄。

### 5.5 metric labels + `recordHostRequest`

**事实**:LLM 流量 metric label 只含 `model`/`reason`/`kind`(低 cardinality);`recordHostRequest(hostUuid)` 按 host 5min 计数,落在 `compute-pool/hostReqCounter.ts` 的内存 Map。

**决策**:
- LLM metric 不动(dashboard 兼容)
- `recordHostRequest` 是 `ContainerIdentityStrategy.resolve()` 的**实现细节**,不进 IdentityStrategy 接口。Future ApiKeyIdentity 不调或调不同 metric。

---

## 6. 实施分阶段

### Phase 0:Baseline integ test(BLOCKING,先于任何代码搬运)

`__tests__/anthropicProxy.integ.test.ts` 新建,**目标不是覆盖 case,是锁定不变量**:

**5 个必须锁定的行为不变量**(round 2 Codex 收紧):

1. **release 权四段分割**(对应 §5.4 四段铁律,**转移点是 `createFinalizer` 成功**而非 session 准备好):
   - **(a) pick 自身失败**(scheduler.pick 失败/throw)→ `scheduler.release` **不调用**(尚未拿到 account);`releasePreCheck` 由 `rollbackBeforeFinalizer` 调。
   - **(b) pick 成功但 refresh 失败** → `scheduler.release(account, 'transient_network')` 由 core 调;`releasePreCheck` 由 `rollbackBeforeFinalizer` 调。
   - **(c) session 已成功,但 finalizer 建立前任何步骤失败**(目前主要是 `startInflightJournal` 失败) → `scheduler.release(account, 'failure')` 由 core 调;`releasePreCheck` 由 `rollbackBeforeFinalizer` 调。
   - **(d) `createFinalizer` 成功之后** → `scheduler.release` 唯一由 finalizer 内部调,**core 绝不调**。
   - test 通过 stub `scheduler.release` 计数器 + spy 调用栈锁定。

2. **abort 分类源头是 `isClientAbort(error)` 不是 `ac.signal`**:
   - positive: 客户端 abort during SSE → `failClient` + scheduler.release('client_error')
   - positive: 上游 5xx 中途断流 → `fail` + scheduler.release('failure',健康分扣)
   - **negative**: `res.end()` 触发的 close listener 在 commit 之后,不得把"正常完成"误判成 client abort

3. **post-commit 顺序与 gate**:仅 `committed && debitedCredits > 0` 才 persist/broadcast;`appendCostCredits` durable persist **先于** `broadcastToUser`;broadcast 失败 fire-and-forget,不回滚账务。test 用 spy 锁顺序 + 锁 broadcast 失败时 commit 仍生效。

4. **DeepSeek `pick=null` 全套 noop**:
   - 不调 `scheduler.release`
   - 不调 `rewriteMetadataDeviceId`
   - 不调 `maybeUpdateAccountQuota`
   - `zeroizeSecrets()` noop(deepseek session)
   - 但 preCheck / journal / finalize / persist / broadcast 全跑

5. **model gate fail-closed**(round 2 Codex P0 修正:`pricing.enabled=false` 返回的是 400 不是 403,且在 authz 之前):
   - **`pricing.get(model)` 返回 null 或 `pricing.enabled = false` → 400 `UNKNOWN_MODEL`**,**未进入 authorize / preCheck / pickUpstream**(verify in handler L1761-1766)
   - `authorize()` throws AuthzError(role/grants 无该 model)→ 403,**未进入 preCheck / pickUpstream**

**Stub 清单**:fake SSE upstream server、stub `scheduler.pick/release`、stub `pgPool`(transaction mock)、stub `preCheckRedis`、**stub `identityRepo`**(当前 handler 不把 `verifyContainerIdentity` 作为 dep 注入,而是依赖 `repo`)、stub `pricing.get`。

**预算**:1.5-2 工日(SSE chunk 时序 + transaction stub + spy 计数器 + abort negative test 是主要时间)

**通过标准**:5 个不变量 case 全 pass,代码改动 = 0。

### Phase 1:billing 物理切出

L956-1492 → `billing/proxyBilling.ts`。改 `codexFinalizer.ts` + `userChatBridge.ts` 的 import。跑 Phase 0 + 现有 18 describe + codex billing 测试 + userChatBridge 测试 — 全绿。

**预算**:0.5 工日。

### Phase 2:identity 物理切出

verifyContainerIdentity 包装 + authz + `recordHostRequest` 调用 → `auth/proxyIdentity.ts`。定义 IdentityStrategy 接口,handler 主流程通过 strategy 调用。Authz 显式接 pricing 参数。

**预算**:0.5 工日。

### Phase 3:Upstream session 抽出

L1867-1991(pick + refresh)+ L2056-2135(auth/header/device_id pin)→ `http/proxy/upstream.ts`,实现 `OAuthPoolUpstream` + `DeepSeekUpstream`。Handler 主流程消除 `isDeepseek` 散点判断。**Release ownership 严格按 §5.4 时间窗口分割**。

**预算**:1-1.5 工日(release ownership 是这阶段的难点)。

### Phase 4:Proxy core 模块化 + 主流程瘦身

handler 主流程移到 `http/proxy/index.ts`(~100-180 LoC wiring)。`http/proxy/core.ts` 装 (c) 内部逻辑。`http/anthropicProxy.ts` 保留为 re-export 兼容层或删除,看 index.ts 调用代价。

**预算**:0.5-1 工日。

### Phase 5:验证 + Codex review + merge

跑全套测试。Deploy 到 dev / staging(v3 没本地 dev 实例,看是否有 staging)灰度验证。Codex review 全 diff。Merge → `origin/v3`。

**预算**:0.5 工日。

---

## 7. 总工作量与风险

**总计:4.5-6 工日**(round 1 Codex 调整,前版 3-4.5 工日低估了 Phase 0 + Phase 3 的真实复杂度)

如果跳过 Phase 0(**不推荐**):3-4 工日,但行为偏移检测靠 Codex review 单点把关,风险显著。

### 风险表(round 1 补 5 条)

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| **finalizer 前后两套 release 路径被重构混淆,reservation 泄漏或 scheduler 双 release** | **高** | **高** | §5.4 时间窗口分割契约 + Phase 0 不变量 1 spy 计数 |
| **abort 分类回归:`res.end()` 后 close 把成功误判成 client abort** | 中 | 高 | Phase 0 不变量 2 negative test + 保留 `isClientAbort(error)` 形状检查 |
| **post-commit `persist → broadcast` 顺序被打乱**,UI 与 durable state 不一致 | 中 | 中 | Phase 0 不变量 3 spy 锁顺序 + 契约文档明确 |
| **runtime import 漏迁移**(`userChatBridge.ts` / `index.ts` re-export)→ 启动崩溃 | 中 | 高 | grep `from.*anthropicProxy` 穷举 + import 路径 audit |
| **DeepSeek 路径 noop 语义在 adapter 抽象中被漏掉** | 中 | 中 | Phase 0 不变量 4 全 noop 锁定 |
| **`mutable observed` 闭包跨模块边界丢失 stream 末态 usage** | 低 | 高 | 拆分时保留 closure-passing,不通过参数往返 |
| **index.ts mount 签名变,18791/18443 listener 启动失败** | 低 | 高 | 保 `(deps) => (req, res, ctx) => Promise<void>` 签名 |
| **Codex round 2 反馈"过度抽象 / IdentityStrategy 当前只有一个实现没必要"** | 中 | 低 | doc §1 已论证现实需求驱动(codexFinalizer + userChatBridge 外部 import);按 CLAUDE.md 拒绝 |

---

## 8. 出本拆分范围的事(写明免误解)

- ❌ **不**新增对外 CC 接入端点(`/api/anthropic/v1/messages` for local CC)。那是下个独立任务,依赖本拆分。
- ❌ **不**改任何反风控字段、header 白名单、device_id pin 算法。本拆分纯结构性。
- ❌ **不**改 billing 单价、扣费时机、journal schema、persist/broadcast 顺序。
- ❌ **不**改 metric label cardinality。
- ❌ **不**改 mount 端口 / mTLS / 容器 Bearer 格式。
- ❌ **不**改 release ownership 语义(**两阶段 lifecycle + finalizer 前三分支**是当前代码现状,只是显式建模)。

---

## 9. 评审检查点(Codex round 2 重点)

1. **三层 + Gate + Obs 边界**(§2.1 / §3.5)是否清晰?Gate / Obs 不归 identity 这事是否合理?
2. **Billing lifecycle 两段**(§3.3)契约是否完整?`rollbackBeforeFinalizer` 不碰 scheduler 这件事是否正确归位?
3. **`PreparedUpstreamSession` 时间窗口 release ownership**(§5.4)是否真的能消除"两个 release 权威源"问题?
4. **Phase 0 5 个不变量**(§6.1)够不够锁住关键行为?有没有遗漏的不变量?
5. **`appendCostCredits → broadcastToUser` 顺序**作为 FinalizerHandle.commit 内部串行,而不是独立 hook — 是否会导致未来 broadcast 失败时回滚困难?(决策依据:当前代码 broadcast 失败时 fire-and-forget,不影响账务;若未来要改成 transactional,再升级契约。)
6. **工作量 4.5-6 工日** 是否仍然低估?

---

## 10. 决策需要 boss 拍板

- [ ] 同意整体方向(三层 + Gate + Obs + 后续接入对外 CC 端点)?
- [ ] 同意 Phase 0 baseline integ 是 BLOCKING 前置条件?
- [ ] Phase 1-5 一个 PR 出还是拆 5 个 PR?(我倾向 5 个 commit / 1 个 PR,review 友好但合并原子)
- [ ] 本拆分完成后立即启动"对外 CC 接入端点"任务?
