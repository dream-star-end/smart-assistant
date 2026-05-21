# V3 Phase 6 Plan: account_uuid 锚定到 OAuth account 真 UUID

**Author**: claude main agent
**Date**: 2026-05-21
**Status**: DRAFT — pending Codex plan-review

## 1. 背景与目标

### Phase 5 完成的事

外接 ApiKey 路径用 `HMAC(serverSecret, "account_uuid:"+userId)` 派生
`metadata.user_id.account_uuid` 占位,目标是"同 ApiKey 跨机器看着像一个真人"。

### Phase 5 漏掉的事(本 Phase 要修)

容器路径里,CCB 调 Anthropic `/api/oauth/profile` 拿 `profile.account.uuid` 写进
`metadata.user_id.account_uuid`(`claude-code-best/src/services/oauth/client.ts:500`)。
这是 OAuth account 在 Anthropic 端的**真 UUID**。

→ **同一个 OAuth pool 账号** A 上,容器流量带 a-uuid(真),外接流量带 HMAC(secret, userId)
派生值,**两条路 account_uuid 形态不一致**。Anthropic 视角:同一 device_id (pinned_X) 配
两种 account_uuid 形态 → 比单容器路径更可疑。

更进一步,即使容器路径也存在 latent bug:容器启动选号 token 的 OAuth account 跟
master 后续每个请求 pickUpstream 选号的 OAuth account **可能不是同一个**(scheduler.pick
按 sessionId WRH,跨请求会换号)→ 容器 CCB 写的 account_uuid 跟实际跑的 OAuth account
真 uuid 可能也不一致。

### 目标(单一不变量)

**H6**: `metadata.user_id.account_uuid` 等于该请求实际路由到的 OAuth account
(`pick.account_id`)在 Anthropic 端的真 UUID,**跨容器/外接两条路径恒成立**。

满足后 Anthropic 看到的就是 "device_id=pinned_X 永远配 account_uuid=a-uuid",
1:1 双绑定,跟"一个真人长期用一台机器"的真实形态一致。

## 2. 改动清单

### 2.1 Schema (migration 0070)

```sql
-- 0070_claude_accounts_account_uuid.sql
ALTER TABLE claude_accounts ADD COLUMN account_uuid uuid;
CREATE UNIQUE INDEX idx_ca_account_uuid_uq
  ON claude_accounts(account_uuid)
  WHERE account_uuid IS NOT NULL;
```

- 字段类型 `uuid`(PostgreSQL 原生 UUID 类型;36 char canonical format,跟
  Anthropic 返回的 profile.account.uuid 同型)
- 初始可 NULL,允许现存账号渐进回填
- UNIQUE WHERE NOT NULL — 防止同 uuid 在两条 row 上(数据约束)
- **不**做 NOT NULL 约束:fail-open 兼容回填进行中

### 2.2 回填脚本 `scripts/backfill-account-uuid.ts`

```text
SELECT id FROM claude_accounts
WHERE provider = 'claude'              -- 关键:不要把 codex/其他 provider 的 token 推 Anthropic
  AND status = 'active'
  AND account_uuid IS NULL

支持 `--canary <account_id>`:只处理该 id,其它跳过(canary 验证用)

for each account_id:
  - getTokenForUse(account_id) → access_token
  - GET https://api.anthropic.com/api/oauth/profile  Bearer access_token
  - parse profile.account.uuid (校验匹配 isUuidLike,见 §2.4)
  - UPDATE claude_accounts SET account_uuid = $uuid WHERE id = $account_id
  - sleep ≥ 3000ms 后再处理下一个(节流)

report ok=N, fail_token=M, fail_http=K, skipped=J
```

注意:
- token refresh 处理(过期则先 refresh,refresh 失败 skip)
- HTTP 401/403 → 账号失效,log 但不当 hard fail
- 不并发(顺序跑 + 1 req/3s 节流避免触发 Anthropic 速率限制)
- 重复跑幂等(已有 account_uuid 的跳过)
- **日志安全**:只输出 `account_id`、HTTP status、错误类别(`token_expired`/`http_4xx`/`http_5xx`/`bad_shape`)、计数。**禁止**输出 token、refresh、profile body、email、uuid 明文 — uuid 写入 DB 是必要持久化,但日志里不复述

### 2.3 Pool select 出口扩展

`packages/commercial/src/account-pool/scheduler.ts:458-465`
SELECT 列表加 `account_uuid::text AS account_uuid`。

`PickResult` 接口(同文件 `:170` 附近)加:
```ts
readonly account_uuid: string | null
```

返回时 `account_uuid: chosen.account_uuid`(`:507`)。

**`fail_closed` 模式下 scheduler 必须过滤掉 `account_uuid IS NULL` 的 active 账号**
(WRH 候选集层面剔除),避免回填漏掉的脏账号被选中导致请求 503。具体改法:
`scheduler.ts:458` 的 WHERE 子句加 `AND (CASE WHEN $enforce_account_uuid THEN account_uuid IS NOT NULL ELSE TRUE END)`,
`$enforce_account_uuid` 由 `PHASE6_ACCOUNT_UUID_ENFORCE === 'fail_closed'` 推导,
透传到 scheduler.pick 调用栈;`off`/`fail_open` 不过滤,兼容渐进回填。

NULL + `fail_open`:hook fail-open 跳过重写(builder HMAC 占位保留,跟当前
Phase 5 行为一致)。
NULL + `fail_closed`:scheduler 不选,不可能走到 hook。若所有候选都 NULL,
scheduler 返 pool_unavailable(已有错误形态,无需新 PickError 变体)。

### 2.4 applyUpstreamAuth hook 扩展

`packages/commercial/src/http/proxy/upstream.ts:262-273` 那块 `(iii) device_id pin`
之后追加 `(iv) account_uuid pin`,**行为按 `PHASE6_ACCOUNT_UUID_ENFORCE` 三态分支**:

```ts
// (iv) account_uuid pin — 锚定到 OAuth account 真 UUID(Phase 6)
// 三态语义:
//   off          → hook 完全不跑(早退,跟 Phase 5 行为一致)
//   fail_open    → pick.account_uuid 存在则重写;NULL 跳过(builder HMAC 占位透出)
//   fail_closed  → scheduler 已过滤掉 NULL 候选,不应到这;万一到了 = 数据竞态,
//                  不重写 + warn(理论上不可能,scheduler 与 hook 同 flag 读取)
const enforce = config.PHASE6_ACCOUNT_UUID_ENFORCE;  // 通过 deps 注入,不 import
if (enforce !== "off") {
  const pinnedAcct = pick.account_uuid;
  if (typeof pinnedAcct === "string" && isUuidLike(pinnedAcct)) {
    body.metadata ??= {};
    body.metadata.user_id = rewriteMetadataAccountUuid(body.metadata.user_id, pinnedAcct);
  } else if (pinnedAcct === null) {
    if (enforce === "fail_closed") {
      // 不应到这(scheduler 应已过滤),仅记录用于排查 race condition
      log.warn("account_uuid_null_in_fail_closed", {
        account_id: pick.account_id.toString(),
      });
    }
    // fail_open + null → 静默跳过,符合预期
  } else {
    // 非 null 非合法 uuid → 脏数据
    log.warn("account_uuid_invariant_breach", {
      account_id: pick.account_id.toString(),
      pinned_type: typeof pinnedAcct,
    });
  }
}
```

`isUuidLike(s)`:`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)`
(任意 UUID 版本,不强制 v4,因为 Anthropic 内部可能用 v1/v5)。回填脚本(§2.2)
校验也复用这条正则,版本统一。

**503 契约 — 不走 hook throw**(Codex round-2 BLOCKER):`fail_closed` 的"找不到
有 uuid 的账号"信号通过 §2.3 scheduler 候选过滤实现 → `scheduler.pick` 抛
`AccountPoolUnavailableError` → `pickUpstream` 已有 `pool_unavailable` PickError 分支
→ handler 已映射 503 `POOL_UNAVAILABLE`。不引入新 PickError 变体、不改 core.ts
catch 链路。为了运维区分"池真空" vs "池有账号但无 uuid",在 `scheduler.pick`
内部 throw 前 log `account_pool_empty_reason: 'no_uuid' | 'no_active' | ...`,
metrics 用现有 `pool_unavailable` 计数即可。

### 2.5 `rewriteMetadataAccountUuid` 工具函数

`packages/commercial/src/http/proxy/shared.ts` 加,对照 `rewriteMetadataDeviceId`
(同文件 `:324`):

```ts
export function rewriteMetadataAccountUuid(
  userIdStr: string | undefined,
  pinnedAccountUuid: string,
): string {
  if (!userIdStr) {
    return JSON.stringify({ account_uuid: pinnedAccountUuid });
  }
  try {
    const parsed: unknown = JSON.parse(userIdStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        account_uuid: pinnedAccountUuid,
      });
    }
    return userIdStr; // 非 plain object 不动
  } catch {
    return userIdStr; // 非 JSON 不动
  }
}
```

fail-open 语义对齐 `rewriteMetadataDeviceId`,避免诡异输入推到 Anthropic 触发新风控。

### 2.6 Phase 5 builder rewriteMetadata 注释更新

`packages/commercial/src/platform/platformEnvelopeBuilder.ts:340-369`
`rewriteMetadata` 当前用 HMAC 派生 account_uuid 占位。Phase 6 后会被 applyUpstreamAuth 覆盖。
更新注释明示这是占位:

```diff
- * - account_uuid:HMAC 派生,稳定 + 多机一致
+ * - account_uuid:HMAC 派生占位(Phase 5 语义,过 schema 校验);applyUpstreamAuth
+ *   → rewriteMetadataAccountUuid 后续阶段会覆盖为 pick.account_uuid(Phase 6,
+ *   对齐 device_id pin 模式)
```

**HMAC 派生代码本身保留**(`deriveAccountUuid` 函数),原因:
- 占位需要稳定 UUID 形态过 metadata.user_id 校验
- Phase 5 H1 invariant 测试还在用,改语义牵扯太广,这次只把它降级为"占位",
  不删函数

### 2.7 HMAC fp3(USER.md 文本)继续保留

`deriveFingerprint(userId, secret) → fp3` 用于 USER.md attribution 文本,**不变**。
这是给 Claude 模型在 system block 里看的"对话方身份",跟 metadata.account_uuid
解耦,两个不变量服务于不同目的。

### 2.8 不变量测试

#### 新增

`packages/commercial/src/__tests__/ccExternalEndpoint.integ.test.ts` 加 H6 case
(测试矩阵**按 flag 拆开**,每个 flag 一组 case):

```
H6.A — enforce=off
  H6.A.1: pick.account_uuid 非空 → hook 不跑,metadata.account_uuid = builder HMAC 占位

H6.B — enforce=fail_open
  H6.B.1: pick.account_uuid = "aaaa-...-aaaa" → 上游 capture 到的 user_id 解析
          后 account_uuid === "aaaa-...-aaaa";device_id === pinned_X 不变
  H6.B.2: pick.account_uuid = null(回填未跑完场景)→ 200 不 503;
          metadata.account_uuid = builder HMAC 占位;log.warn 不触发
  H6.B.3: pick.account_uuid = "not-a-uuid" → 不重写 + log.warn
          `account_uuid_invariant_breach`;请求仍 200 fail-open

H6.C — enforce=fail_closed
  H6.C.1: scheduler 池里全是 account_uuid 非空账号 → pick 正常 → hook 正常重写
  H6.C.2: scheduler 池里**仅有** account_uuid=NULL 账号 → scheduler.pick throw
          AccountPoolUnavailableError → handler 返 503 POOL_UNAVAILABLE +
          log `account_pool_empty_reason: 'no_uuid'`
  H6.C.3: scheduler 池里混合 NULL + 非空 → 只选非空,200 OK

H6.D — refresh rebind 不丢字段(覆盖 upstream.ts:386-395)
  - 构造 pickUpstream 触发 refresh(expires_at 已近)
  - mock refreshAccountTokenImpl 返回新 token
  - rebind 后 pick.account_uuid 必须等于 rebind 前(显式 assert,
    防止类型签名漂移但实现漏字段)
```

#### 更新

Phase 5 现有 H1 跨机器测试:加一条 sub-case "若 pick 返回相同 account_uuid → 两机 metadata
account_uuid 也一致";原 case "secret 一致跨机器 HMAC 一致" 保留,但加注释说明
applyUpstreamAuth 之后(`enforce !== 'off'` 时)会被覆盖,这条只断 builder 内部输出。

#### 单元测试

`shared.unit.test.ts` 加 `rewriteMetadataAccountUuid` 4 case:
- userIdStr 空 → 写新 JSON
- plain object → spread + 覆盖
- 非 JSON 字符串 → 不动
- 数组 / primitive → 不动

`scheduler.unit.test.ts` 加 `pickWRH` 候选过滤 case:
- enforce=fail_closed + 池里 NULL 账号 → SELECT 排除,候选集不含
- enforce=off / fail_open + 池里 NULL 账号 → SELECT 不排除,候选集含

`upstream.unit.test.ts` 加 refresh rebind 字段保全 case(对应 H6.D 但独立单测,
不依赖 integ harness)。

### 2.9 容器路径自动收益

容器请求经过 `internalProxyHandler` → 同样的 `pickUpstream` → 同样的
`makeOAuthPoolUpstream` → 同样的 `applyUpstreamAuth` hook。
**Phase 6 hook 同时作用于容器路径**:

- 若 client (CCB) 写的 account_uuid 跟 master 选号一致(理想)→ 重写前后值相同,无副作用
- 若 client 写错或 ApiKey 模式空串 → master 用 pick.account_uuid 兜底,Anthropic 收到正确值
- 若 latent bug(容器启 token 跟运行时 pick token 不同 OAuth account)→ master 强制对齐
  到当前选号账号,Anthropic 看到的永远是 token ↔ account_uuid 一致

这是 Phase 6 设计上的好处:**两条路单点改一处 hook,统一不变量**。

## 3. 部署计划(分两次 deploy + hook env flag,采纳 Codex round-1 MAJOR 1/2/3)

### 3.0 env flag

`config.ts` 加:
```ts
PHASE6_ACCOUNT_UUID_ENFORCE: z.enum(["off", "fail_open", "fail_closed"]).default("off")
```

- `off`:hook 完全早退(Phase 5 行为,builder HMAC 占位透出);默认值,deploy 1 用;
  scheduler 不过滤候选(回填脏数据正常被选中,仅 outbound metadata 不变)
- `fail_open`:hook 跑,pick.account_uuid 存在则重写,NULL 时跳过(HMAC 占位透出);
  回填进行中过渡态;scheduler 不过滤候选
- `fail_closed`:hook 跑 + scheduler 过滤掉 `account_uuid IS NULL` 的 active 账号
  (§2.3)。若过滤后池空,scheduler.pick → AccountPoolUnavailableError → handler
  返 503 POOL_UNAVAILABLE(已有契约,见 §2.4)。回填完后稳态。

**flag 注入路径**:配置在 `/etc/openclaude/commercial.env`,改完 `systemctl restart
openclaude` 生效。同一 flag 值传两处:
1. `scheduler.pick({ ..., enforceAccountUuid: enforce === 'fail_closed' })`,
   scheduler 内部根据此值组装 SELECT WHERE
2. `pickUpstream` 通过 deps.config 把 enforce 传给 `makeOAuthPoolUpstream`,
   闭包持有给 `applyUpstreamAuth`

两处必须读同一 config 实例(已有 deps.config 注入模式),避免热改时一边读到新值
一边读到旧值导致竞态。

### 3.1 Deploy 1: migration + backfill 基础设施(hook=off)

1. `feat/phase6-account-uuid-anchor` 分支实现:migration 0070 + PickResult 字段 + backfill 脚本
2. **hook 默认 off,代码 deploy 后不产生 outbound 行为变化**
3. `deploy-v3.sh` 上线
4. 在 commercial-v3 上跑 **canary backfill**(只跑 1 个账号):
   ```
   npx tsx scripts/backfill-account-uuid.ts --canary <account_id>
   ```
   验证:HTTP 200、JSON shape 含 `account.uuid`、uuid 跟对应容器内 CCB 写的本地值一致(从容器 `cat ~/.claude.json` 取对比)
5. canary 通过后批量回填:`npx tsx scripts/backfill-account-uuid.ts`
6. 核验所有 `provider='claude' AND status='active'` 账号已有非空 account_uuid:
   ```sql
   SELECT COUNT(*) FROM claude_accounts WHERE provider='claude' AND status='active' AND account_uuid IS NULL
   ```
   应返回 0

### 3.2 Deploy 2: 启 hook (hook=fail_closed)

**前置条件**:Deploy 1 后 SQL 校验 `SELECT COUNT(*) FROM claude_accounts WHERE
provider='claude' AND status='active' AND account_uuid IS NULL` = 0。若非 0
**禁止**进入 Deploy 2,先用 `fail_open` 临时过渡跑回填,清干净再切 `fail_closed`。

1. 改 commercial-v3 `/etc/openclaude/commercial.env`:`PHASE6_ACCOUNT_UUID_ENFORCE=fail_closed`
2. `systemctl restart openclaude`(单 master 重启 ≈ 5s WS 中断)
3. KL hot standby 同步改 env(deploy-v3.sh sync-kl 不会带 env 文件,要手动)
4. smoke:发一个外接 ApiKey 请求 → 200 + log 显示 hook 触发改写
5. 监控 24h:
   - `account_uuid_invariant_breach` warn 计数(应该 0;非 0 = 脏数据,人查)
   - `account_uuid_null_in_fail_closed` warn 计数(应该 0;非 0 = scheduler/hook
     flag 读不一致或 race condition)
   - `account_pool_empty_reason: 'no_uuid'` log 计数(应该 0;非 0 = 新账号入池
     没走 OAuth login flow 自动写 uuid 的路径)
   - 503 POOL_UNAVAILABLE 总量(对比 deploy 前 baseline,新增量 = 新加但没回填的账号)
   - Anthropic 端 412/429 量(对比 deploy 前 baseline)
6. 24h 后无异常 = Phase 6 稳态。

**新建 claude account 的写 uuid 流程**:本次仅靠**人工 SOP** + scheduler `fail_closed`
过滤兜底(新账号 status=active 但 account_uuid=NULL → scheduler 不选 + log 报警 →
运维介入回填)。OAuth login flow 自动写 uuid 留到 Phase 6.5(§3.3),作为 cleanup 项;
Phase 6 稳态期间任何新加的 claude account 必须**显式跑** `backfill-account-uuid.ts
--canary <id>` 才能让 scheduler 选中。

### 3.3 长期 cleanup (Phase 6.5,non-blocking)

回填完后做 0071 migration 加 provider-specific NOT NULL:
```sql
ALTER TABLE claude_accounts
  ADD CONSTRAINT account_uuid_required_for_claude
  CHECK (provider <> 'claude' OR account_uuid IS NOT NULL) NOT VALID;
ALTER TABLE claude_accounts VALIDATE CONSTRAINT account_uuid_required_for_claude;
```
不强求本次完成。新建 claude account 的 OAuth login flow 中也要保证写入 account_uuid 字段(不在 Phase 6 范围,留作后续工程任务)。

## 4. 回滚

- 代码:`deploy-v3.sh --rollback`
- 数据:不回滚 migration 0070(只加字段不删数据,fail-safe)
- 回填脚本:幂等,无需回滚

## 5. 不在本 Phase 范围

- **Sticky userId↔OAuth account binding**:即每个我们家用户尽量固定路由到 ≤N 个 OAuth
  账号(让单账号上的 user 数收敛到"小团队共用"形态)。这是 Phase 7 的事。
- **删除 builder HMAC account_uuid 派生**:涉及 Phase 5 测试改造,暂保留作"占位"。
- **`/api/oauth/profile` endpoint 在 OpenClaude master 持续监控 token 是否仍能拉到
  profile**:健康检查的事,这次先不加。

## 5.5 实现 notes(Codex round 3 PASS 后追加)

1. **scheduler 无 logger 依赖** → 区分 `no_uuid` vs `no_active` 通过
   `AccountPoolUnavailableError(reason)` constructor 携带 reason 字符串,
   handler 已 log `pickRes.error.err.message`,运维从 master log 即可定位。
   不给 SchedulerDeps 加 logger(避免半套依赖注入)。

2. **--canary 仍受 provider+status 约束** — `--canary <id>` 只是把
   `WHERE id=$1` 拼到现有 `WHERE provider='claude' AND status='active' AND
   account_uuid IS NULL` **之上**,不替换。指定一个错 provider 或 inactive 的 id
   要返 `skipped`,不发 HTTP。

3. **fail_closed 下区分 no_active / no_uuid**:**JS-side filter,SQL 仅多查
   一列**。SQL 不变(只在 SELECT 列表增加 `account_uuid::text AS account_uuid`),
   现有 `pool = res.rows` 拿到所有 status='active' candidates;紧跟一行:
   ```ts
   const allActive = pool
   if (enforceAccountUuid) pool = pool.filter((c) => c.account_uuid !== null)
   ```
   后续 pool drain 后区分原因:
   ```ts
   if (allActive.length === 0)
     throw new AccountPoolUnavailableError('no_active')
   if (pool.length === 0)  // enforceAccountUuid && allActive > 0 但 eligible 0
     throw new AccountPoolUnavailableError('no_uuid')
   // 其他原因(vanish/AEAD)走原 throw 路径
   ```
   理由:JS filter 单行成本低、不破坏 CTE-free 的 SELECT 形态、reason 直接进
   error message 由 handler log,跟 §5.5.1 "塞 message 不加 logger" 一致。

4. **flag 读一次**:`pickUpstream` 入口 `const enforce =
   deps.config.PHASE6_ACCOUNT_UUID_ENFORCE`,同值传 `scheduler.pick({...,
   enforceAccountUuid: enforce === 'fail_closed'})` 和闭包给
   `makeOAuthPoolUpstream(pick, dispatcher, endpoint, enforce)`。
   `applyUpstreamAuth` 内部不再读 `deps.config`,只读 closure 里的 `enforce`。

5. **backfill HTTP 走账号 egress**:复用 `getDispatcherForAccount(pick.account_id,
   egress_proxy, egress_target)`(同 chat 路径)调 `/api/oauth/profile`,保持
   "账号出口稳定"的现有设计。脚本里 ad-hoc 用 fetch + dispatcher。

## 6. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 回填脚本调 Anthropic 速率过快被风控 | 顺序跑,1 req/3s 节流 |
| 现存账号 token 过期/refresh 失败拿不到 uuid | log + skip,fail-open 继续走旧路径 |
| pool select 多查一个字段性能影响 | 单 row 多一个 16-byte UUID,可忽略 |
| Phase 5 H1 测试需要更新 | 已列入测试清单 2.8 |
| 回填期间外接请求 metadata 还是 HMAC 占位 | 跟 Phase 5 行为一致,不更糟;回填完所有请求自动收敛到真 uuid |
