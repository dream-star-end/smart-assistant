# V3 CC External Endpoint — envv2 v2 Refactor Plan (2026-05-21)

## 0. 背景与问题陈述

V3 平台 `ApiKey` 外接路径(用户本机 CC CLI 配 `ANTHROPIC_API_KEY` 直连 v3 后端)
当前通过 `http/proxy/externalEnvelope.ts:normalizeExternalApiKeyEnvelope` 把出站 body 强
制注入 `CC_DEFAULT_PREFIX` 系统块,目的是让 Anthropic 反风控看到的 outbound 形态
保持 "CC 客户端"分桶。

这层防线在 2026-05-19 prod 实测有效(无 CC prefix 的请求被整池 429 蔓延,加了
prefix 之后 200)。但它存在三个**结构性缺陷**,与 boss 已经背书的 invariant
`feedback_one_account_one_human.md` —— **"同一个 ApiKey 装到 3 台不同机器 / 3 个不同
项目里跑,Anthropic 端看到的画像还像一个真人"** —— 不对齐:

1. **池子共享 → 反风控可观测的"形态混杂"**:外接 ApiKey 用户和平台容器 OAuth 用户
   共用 `claude_accounts` 池。同一个 `account_uuid` 既承载容器内 CCB 真实流量
   (sysprompt 含项目特征 / CLAUDE.md / tools full),又承载 BYOK 客户端的
   "光秃秃 prefix-only" 流量,**Anthropic 服务端能在 account 维度做 shape 聚类**,
   只要分桶噪声过门限就整池 429。现在靠 prefix 注入"补"成 CC 形态,但同一 account
   下并行的容器 CCB 流量是真 CC,两类流量在内部计量上仍是两个分布。

2. **L0/L1/L2/L3 稳定性分层缺失**:CCB 的 outbound 在反风控视角里天然分四层 —
   L0(account 强锁 = device_id / `pinned_user_id`)、L1(machine-variable = 机器
   hostname / cpu count)、L2(project-variable = git remote / cwd basename)、L3
   (session-variable = todo set / 当前 turn 时间戳)。现在 v1 helper 只在 L0 注一行
   `CC_DEFAULT_PREFIX`,L1/L2/L3 全部依赖客户端原 body 透传。客户端如果是 `curl -A
   claude-cli/x.y.z` 伪 UA + 空 body,L1/L2/L3 全空 → Anthropic 端看到的
   distribution 单调到不像人。

3. **硬编码 prefix + 无版本化**:三个 CC prefix 是字面字符串硬编码在
   `externalEnvelope.ts:76-87`。CCB 上游升级、Anthropic 反风控锚点变更、未来需要
   不同 SDK 变体配比 —— 都要 deploy 整个 commercial 包。无运行时可调能力。

## 1. 总体目标

**让 "同一 ApiKey 在 3 台机器 3 个项目"** 出站到 Anthropic 看起来跟 "一个真人 CC
用户在 1 台机器 1 个项目用了 3 天" 在统计学上不可区分:

- L0(account-locked):`pinned_user_id` / device_id / `x-stainless-*` 系列(stainless
  在 buildSafeUpstreamHeaders 已剥,outbound 看不到)/ sysprompt 头三个变体的固定配比
  —— **每个 external_api account 注入一个稳定的 fingerprint salt**,保证 3 台机器
  跑同一 key 看到的还是同一个虚拟"人"。
- L1(machine-variable):`metadata.user_id` JSON 内 `os_arch` / `cpu_count` /
  `node_version` / `hostname_prefix` —— **不强锁,客户端送什么用什么**;客户端不送
  时按 account 的 salt 派生一个伪随机但稳定的虚拟机器画像(L1 默认值,而不是空)。
- L2(project-variable):`metadata.user_id` JSON 内 `git_remote_hash` / `cwd_basename
  _hash` / CLAUDE.md SHA —— **客户端送什么用什么**,客户端不送时不补(允许 noise,
  不允许伪造)。
- L3(session/turn-variable):`session_id` / `turn_counter` / 当前 turn timestamp —
  完全透传,每 turn 变,反风控也期望它变。

加上**池子拆分**(`kind='external_api'` 与 `kind='platform'` 物理隔离 OAuth 账号),
保证 Anthropic 端在 account 维度永远只看到一种形态的流量。

## 2. 五阶段实施计划

每个 phase **独立 worktree + 独立分支 + 独立 PR + 独立 deploy**(遵循 CLAUDE.md
worktree isolation rule)。每个 phase 末尾必须:Codex PASS + integ test 全绿 + prod
metric 观测窗 ≥ 24h 无异常,才能开始下一 phase。

### Phase 0 — Baseline 行为锁(已完成 2026-05-21 bd2a994f)

8 个 invariant test 锁住当前 v1 helper outbound 结构,任何 v2 改造引发的 outbound 形
态漂移立即在 CI 失败。详见 `packages/commercial/src/__tests__/ccExternalEndpoint.integ.
test.ts:"Phase 0 baseline"` describe block。

**验收**:已 push 至 `origin/v3 = bd2a994f`,29/29 PASS。

### Phase 1 — Schema:`kind` 列 + `envelope_version` 列(本 PR)

**目标**:在 `claude_accounts` 加两列,改 `scheduler.pick()` 签名让 handler 能按
`kind` 物理隔离两池。**handler 调用点本 phase 不切换** —— 所有路径继续传 default
`kind='platform'`(实际上 PickInput 不传 kind 字段),prod 行为完全不变。

**Phase 1 与 handler cut-over 严格解耦**:
- Phase 1 deploy 后,boss 通过 admin SQL 把指定账号 `UPDATE ... SET kind='external_api'`,
  把外接池"先填上"。
- 单独的小 PR(暂称 Phase 1.5)在外接池非空且观测稳定后再把 handler 外接 ApiKey 路径
  切到 `pick({kind:'external_api'})`。
- 这样 Phase 1 deploy 不会因为外接池空而把外接 ApiKey 流量从可用变 503。
- Phase 1 集成测试验证 default 行为(default kind=platform,与历史等价)+ 显式传
  `kind='external_api'` 池空抛 `AccountPoolUnavailableError`(只测能力,不在 handler
  调用)。

#### 1.1 SQL migration `0070_claude_accounts_kind_envv2.sql`

```sql
-- 添加 kind 列(账号用途分区)
ALTER TABLE claude_accounts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'platform'
  CHECK (kind IN ('platform', 'external_api'));

-- 添加 envelope_version 列(出站归一化版本号 — Phase 4 灰度用)
ALTER TABLE claude_accounts
  ADD COLUMN envelope_version SMALLINT NOT NULL DEFAULT 1
  CHECK (envelope_version IN (1, 2));

-- 调度器主索引扩展:在 status='active' partial index 上加 kind 区分
-- 现有 idx_ca_schedulable(0004) 不动 — 它是 claude provider 全量索引
-- 新加 (kind, provider, health_score DESC) WHERE status='active' 覆盖 Phase 1
-- pick({kind, provider}) 的双键过滤路径
CREATE INDEX idx_ca_kind_provider_schedulable
  ON claude_accounts(kind, provider, health_score DESC)
  WHERE status = 'active';

COMMENT ON COLUMN claude_accounts.kind IS
  'V3 envv2: platform = 平台容器 OAuth 池;external_api = 外接 ApiKey 专属 OAuth 池。'
  ' 物理隔离保证 Anthropic 反风控看到的 account_uuid 维度形态一致。'
  ' 默认 platform 与 v3 历史行为兼容。Phase 1+(2026-05-21)。';

COMMENT ON COLUMN claude_accounts.envelope_version IS
  'V3 envv2: 出站 envelope 归一化版本号。1 = v1 externalEnvelope.ts 硬编码 prefix;'
  ' 2 = v2 externalEnvelopeV2.ts 模板表 + L0 强锁 + L1/L2 漂移保留。'
  ' Phase 4 灰度切换,Phase 5 删除 v1 后此列保留(降级开关)。';
```

#### 1.2 TS 类型与 store 改造

- `account-pool/store.ts` 加 `export const ACCOUNT_KINDS = ['platform', 'external_api'] as const`
  + `AccountKind` 类型导出。`AccountRow` 加 `kind: AccountKind` + `envelope_version: 1|2`。
- `createAccount` 入参可选 `kind?: AccountKind`(default `'platform'`)与
  `envelope_version?: 1|2`(default `1`)。SELECT 列加这两列。
- `updateAccount` 入参允许改 `kind`(admin 操作 — Phase 2 后才暴露 UI)。

#### 1.3 Scheduler 改造

- `PickInput` 加可选字段 `kind?: AccountKind`(default `'platform'`,跟 store 同源)。
- `pick()` 内部 SELECT 改:
  ```sql
  SELECT id::text AS id, plan, health_score,
         quota_5h_pct, quota_7d_pct, subscription_end_at,
         pinned_user_id, envelope_version
  FROM claude_accounts
  WHERE status = 'active' AND provider = $1 AND kind = $2
  ORDER BY id
  ```
- `CandidateRow` 加 `envelope_version: 1|2`(Phase 4 路由依赖)。
- `PickResult` 加 `envelope_version: 1|2`(handler 拿来分发 v1/v2 normalizer)。

#### 1.4 upstream.pickUpstream 透传

`PickUpstreamDeps` 加可选 `accountKind?: AccountKind`(default `'platform'`),透传到
`pick()`。**本 phase handler 不传该字段**,所有路径走 default。Phase 1.5(单独 PR)
在外接池就绪后,在 handler 外接 ApiKey 分支显式传 `accountKind: 'external_api'`。

**关键决策:外接池空不 fallback 到 platform 池**。当 Phase 1.5 切换后,外接池空直接
抛 `AccountPoolUnavailableError`(503 + `pool_unavailable`)。理由:fallback 会破坏
"account 维度形态一致"硬约束(整个 v2 设计的反风控前提)。boss 操作 admin 把账号
划进 external_api 是显式动作,空池是配置不全的明确信号,不该用 fallback 隐藏。

#### 1.5 Bootstrap / admin

- **本 phase 不**改 admin UI / API。
- **本 phase 不**改 handler。
- 划账号 SOP(Phase 1 deploy 后 boss 手动操作):
  ```sql
  -- 把 id ∈ {…} 的账号划进外接池
  UPDATE claude_accounts SET kind='external_api' WHERE id IN (…);
  -- 校验:外接池非空
  SELECT COUNT(*) FROM claude_accounts WHERE status='active' AND kind='external_api';
  -- 必须 > 0 才能开 Phase 1.5
  ```
- Phase 1.5 切 handler 的 PR 上线前,boss 手动跑上面 SOP 并在 PR 描述里贴 SELECT 结果作为
  pre-flight。0 行则禁止合并(reviewer 拦截)。

#### 1.6 测试 (integ + unit)

- **新增 integ**:`packages/commercial/src/__tests__/accountKindPool.integ.test.ts`
  - case A:platform 池 1 个 active + external_api 池空 → `pick({kind:'external_api'})`
    抛 `AccountPoolUnavailableError`,**不** fallback。
  - case B:两池都有 active → `pick({kind:'platform'})` 永不选到 external_api 账号,
    反之亦然(各跑 100 次,id 集合不相交)。
  - case C:default kind = `'platform'`(不传 kind 参数,行为与历史一致)。
- **既有 29 个 case 全绿**(no regression — handler 本 phase 未改,所有 ccExternal
  集成断言保持成立)。
- handler integ 验证 `kind: 'external_api'` 透传到 scheduler.pick 是 **Phase 1.5** 的
  测试,不在本 phase。

### Phase 2 — Prefix 模板表 + admin bootstrap

**目标**:把 `externalEnvelope.ts:76-87` 硬编码的三个 CC sysprompt prefix 迁到 DB 表,
变成运行时可调。

#### 2.1 SQL migration `0071_envelope_prefix_templates.sql`

```sql
CREATE TABLE envelope_prefix_templates (
  id              SMALLSERIAL PRIMARY KEY,
  variant         TEXT NOT NULL CHECK (variant IN
                    ('default', 'agent_sdk_claude_code_preset', 'agent_sdk')),
  text            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每个 variant 同时只有一行 active(允许保留 inactive 历史)
CREATE UNIQUE INDEX uq_envelope_prefix_active
  ON envelope_prefix_templates(variant)
  WHERE active = TRUE;

-- bootstrap 三行:与 externalEnvelope.ts:76-87 字面一致,作为初始化锚点
INSERT INTO envelope_prefix_templates (variant, text) VALUES
  ('default',
   $$You are Claude Code, Anthropic's official CLI for Claude.$$),
  ('agent_sdk_claude_code_preset',
   $$You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.$$),
  ('agent_sdk',
   $$You are a Claude agent, built on Anthropic's Claude Agent SDK.$$);
```

#### 2.2 Admin GET / PUT 端点

- `GET /api/admin/envelope-prefix-templates` → 列出三行 + active 状态。
- `PUT /api/admin/envelope-prefix-templates/:variant` → 改 text(active 切换是另一个
  PATCH endpoint;同时只能有一行 active per variant,UNIQUE 约束保证)。
- 端点放在 `http/admin/envelopePrefixTemplates.ts`,鉴权走既有 admin middleware。

#### 2.3 In-memory cache 与失效

- 加 `envelope/prefixTemplateCache.ts` 单例 + 30s TTL。所有 v1/v2 helper 通过
  `getActivePrefix(variant)` 读取,**不**直接 DB 查每次。
- admin PUT 后 invalidate 进程内 cache(单 master 节点足够;多节点 hot standby 通过
  TTL 自然收敛 — 30s 容差对反风控锚点变更可接受)。

#### 2.4 v1 helper 改造(只是把硬编码换成 cache 查询)

`externalEnvelope.ts` 的三个 const **删除**,改为运行时
`await getActivePrefix('default' | 'agent_sdk' | 'agent_sdk_claude_code_preset')`。
函数签名从同步变 async — handler 调用点改 await(已在 async 函数内,改动小)。

**本 phase 不上 v2 helper**,只迁配置存储。

#### 2.5 测试

- DB integ:CRUD 三行 + UNIQUE 约束触发 conflict。
- cache integ:TTL 内复用 + PUT 后立即可见。
- v1 helper baseline 行为不变(Phase 0 的 29 个 case 全绿)。

### Phase 3 — v2 Normalizer 纯函数 + golden tests

**目标**:实现 `externalEnvelopeV2.ts`,把 L0/L1/L2/L3 完整分层落到代码。**不接路由,
所有现有调用方仍走 v1**。

#### 3.1 `externalEnvelopeV2.ts` 主要职责

入参:`(body: ProxyBody, account: {id, pinned_user_id, fingerprint_salt}, log: Logger)`

行为:
1. **L0 强锁**:
   - 注入 sysprompt prefix(从 templates cache 拿 default,与 v1 兼容)。
   - 注入 `attribution block`:在 system array 第 2 位塞一行
     `<external-api-account fingerprint="<hash>" />` 风格的 text block。`hash` =
     `SHA256(account.fingerprint_salt + account.id).slice(0, 12)` —— 同一 account 跨
     机器跨项目永远同一个 fingerprint,Anthropic 端 cluster 会自然归到同一虚拟
     "人"。**此 block 走 `cache_control: ephemeral`,不污染上游 prefix cache key。**
3. **L1 派生默认值**(客户端不送时):
   - `os_arch` / `cpu_count` / `node_version` / `hostname_prefix` —— 用 account.salt
     派生 PRNG,挑虚拟值。同 account 永远同一组虚拟机器画像。
   - 客户端如果送了 L1 字段(`metadata.user_id` JSON 内),**保留客户端的**,不覆盖
     —— L1 允许在 account 内漂移(就像一个人换了机器)。
4. **L2 透传**:`git_remote_hash` / `cwd_basename_hash` —— 客户端送什么用什么,不送
   不补。L2 可空,允许 noise(就像一个人开新项目)。
5. **L3 透传**:`session_id` / `turn_counter` / 当前 turn timestamp —— 完全不动。

#### 3.2 `fingerprint_salt` 列

新 migration `0072_claude_accounts_fingerprint_salt.sql`:

```sql
ALTER TABLE claude_accounts
  ADD COLUMN fingerprint_salt BYTEA NOT NULL
  DEFAULT gen_random_bytes(16);
-- 存量行 backfill 完后改 NOT NULL — 由 migration 一步搞定(PG 接受 DEFAULT 立即用于
-- 现存行)。CHECK 限制长度:
ALTER TABLE claude_accounts
  ADD CONSTRAINT ca_fingerprint_salt_len CHECK (octet_length(fingerprint_salt) = 16);
```

#### 3.3 Golden tests

`externalEnvelopeV2.test.ts`:
- 同 account + 同客户端 body 跑两次 → outbound 字节级一致(determinism)。
- 同 account + 3 个不同客户端 body(模拟 3 台机器):L0 一致,L1 客户端送的被保留,
  L2 各自不同。
- 不同 account + 同客户端 body:L0 fingerprint 不同(account 维度区分)。
- 客户端送空 metadata → L1 派生值非空且 deterministic。
- 客户端送 fingerprint 字段(企图伪造)→ 被剥除,服务端注入版本生效(`assert no
  client-supplied fingerprint reaches outbound`)。

#### 3.4 不接路由

handler 不调 v2,所有外接 ApiKey 流量仍走 v1。Phase 3 deploy 后 prod 行为完全不变,
只是新代码与 fingerprint_salt 字段静态存在。

### Phase 4 — 灰度路由(envelope_version 派发)

**目标**:`pickUpstream` 返回的 `PickResult.envelope_version` 在 handler 决定调 v1 还
是 v2。**默认 envelope_version=1,prod 行为不变;boss 手动 UPDATE 一个 account 到
envelope_version=2 做 canary**。

#### 4.1 handler 改造

`http/proxy/index.ts:325` 现在的:

```ts
if (identity.containerId === null && route.kind === "oauth") {
  normalizeExternalApiKeyEnvelope(body, userLog);
}
```

改为:**在 `pickUpstream` 之后** 拿 `session.envelope_version` 决定 helper(注意调用
顺序变化 —— 见下 4.2)。

#### 4.2 顺序调整(关键 + 生命周期补偿)

v1 在 `pick` 之前调(token 估算前)。v2 需要 account.fingerprint_salt,只能在
`pick` 之后调。所以 envv2 的调用顺序是:

```
selectUpstreamRoute(5c)
  → pickUpstream(7)    // 拿到 account_id / envelope_version / fingerprint_salt
  → if external_api: normalizeEnvelope(body, account)     [v1 or v2 by envelope_version]
  → estimateInputTokens(body)
  → preCheckWithCost
  ...
```

**这破坏了两条 v1 不变量**,本 phase 必须显式处理:

**I3 (mutate-before-estimate)**:`normalizeEnvelope` 之后才做 `estimateInputTokens`,
保证 prefix / attribution block 计入 reservation。新顺序仍满足 — 只是 mutate 时机
后移到 pick 后,估算仍在 mutate 后。

**新的 lifecycle 约束(Codex plan review 2026-05-21 blocker #1)**:`pickUpstream`
成功后已经持有 token + inflight slot;`preCheckWithCost` 抛 `InsufficientCreditsError`
/ 其他错误时,handler **必须** release。具体补偿:

- 在 handler 的 preCheck try 块的 catch 分支(以及任何"pick 后 / runUpstreamRoundTrip
  前"的失败路径)显式调既有 session lifecycle API(对齐现有
  `upstream.ts:makeOAuthPoolUpstream` 返回的 `PreparedUpstreamSession` 实际字段名,
  伪代码示意 — 实现时按当前文件真名为准):
  ```ts
  // PreparedUpstreamSession 已有 release()/zeroizeSecrets() 等收敛入口,
  // handler 直接调,不要绕 scheduler API。
  await session.release({ kind: 'client_error', error: String(err) })
    .catch(() => { /* swallow */ });
  session.zeroizeSecrets();
  ```
  - `result.kind = 'client_error'`:释放 inflight slot 但**不扣健康分**(余额不足不是
    账号的错,见 release.kind 注释)。
  - zeroize 兜底:pickUpstream 内部对 b₁/b₂ 失败已做零化,此处补的是 pick 成功后
    handler 域内失败的零化路径。

- handler 直接 inline 调用现有 session API,**不抽** helper(违反 KISS);在
  Phase 4 PR 实现时按 `upstream.ts` 当前对外契约为准。

- Phase 4 integ test 覆盖:
  - case D:pick 成功 → preCheck 402 失败 → scheduler.release 调用计数 = 1 + token
    零化(spy 验证 .fill(0) 调用次数);
  - case E:pick 成功 → normalize 抛 → release + zeroize 同样发生;
  - case F:pick 成功 → preCheck 通过 → runUpstreamRoundTrip 内 release(原 path 已
    有,handler 不重复)。

为了让 v1 也复用同一调用点(简化代码),Phase 4 把 v1 调用点一起后移 — Phase 0
baseline 测试需要更新,因为 outbound 形态没变(prefix 还是在 system[0]),但 helper
log 时机变。Phase 0 baseline 改为"outbound 结构等价",log 时机不锁。

#### 4.3 测试

- canary integ:account A 配 v1 + account B 配 v2,handler 命中 A 走 v1 outbound,
  命中 B 走 v2 outbound。
- envelope_version=2 default safety:assert prod default 行为 = v1(没有人手动改
  account.envelope_version 之前)。

#### 4.4 Prod 灰度操作手册

1. Phase 4 deploy 后,boss `UPDATE claude_accounts SET envelope_version=2 WHERE id=<某个 external_api 账号>`。
2. 观察 ≥ 7 天:该账号 429 率 / quota 消耗速度 / Anthropic 反风控告警。
3. 无异常 → 批量 `UPDATE ... WHERE kind='external_api'` 切全量。
4. 有异常 → 改回 `envelope_version=1`,即时回滚(无需 deploy)。

### Phase 5 — 观测期 + 删 v1 helper(分两个 release)

**门槛**:Phase 4 全量 v2 ≥ 30 天 **且最近 14 天无 rollback / envelope_version=1
回切**(Codex plan review 2026-05-21 MINOR 采纳)。

**两步收紧**(不一次性激进):

**Release N**:删 handler v1 分支 + 删 `externalEnvelope.ts:normalizeExternalApiKeyEnvelope`
+ 删硬编码常量。`envelope_version` CHECK 仍允许 `(1, 2)`,DB 层留出降级开关 —
如果 v2 上线后突发问题,boss 可以 `UPDATE ... SET envelope_version=1` 让 handler
... 等一下,handler 已经删 v1 分支,这条降级无效。所以 Release N 实质上**封死**降级。

**Release N+1**(N 之后再观测 14 天):收紧 DB CHECK 为 `envelope_version = 2`
(单值 NOT NULL,留列为未来 v3 预留)。

**Phase 0 / Phase 4 baseline 测试**改写为 v2 baseline(用 v2 的 outbound 形态当新
基线)在 Release N 一起做。

## 3. 全局不变量(任何 phase 必须保持)

- **I1**:容器路径 (`identity.containerId !== null`) 永远不调任何 envelope normalizer
  —— CCB 自己构造的 body 在 cache key 维度对 prefix 敏感,helper 注入会破坏命中。
- **I2**:DeepSeek 路径 (`route.kind === 'deepseek'`) 永远不调 normalizer —— 不同
  上游、独立 API key。
- **I3**:任何 mutate body 的步骤必须在 `estimateInputTokens` 之前(Phase 4 改 v1
  顺序后仍成立,因 helper 后移但还在估算前)。
- **I4**:`buildSafeUpstreamHeaders` 的 allowlist 不放宽 —— 客户端 `x-stainless-*`
  / 自定义 header 全部剥除(L0 头维度的反风控锚点由服务端决定,不允许客户端污染)。
- **I5**:client-supplied `metadata.user_id.fingerprint` 字段在 v2 中**必剥**(防伪造)。
- **I6**:同一 account 跨 turn 跨机器跨项目,v2 outbound 的 L0 fingerprint **必定相同**
  (golden test 锁)。

## 4. Codex 评审范围

Codex 仅审 plan 层面的:
- 五 phase 划分是否消除一类风险(account 维度形态混杂)而不是补单点症状;
- L0/L1/L2/L3 分层是否覆盖 boss `feedback_one_account_one_human.md` 的 PASS/FAIL 测试;
- Phase 4 顺序调整是否破坏 token 估算账务边界;
- Phase 5 删除时机是否过早(给灰度留足时间)。

风格/防御建议默认拒收,理由附 CLAUDE.md "不过度工程" / "三行直白代码胜过过早抽象"。

## 5. 不在本 plan 范围

- Codex / DeepSeek 池子的 kind 拆分(只 claude provider 暴露在外接 ApiKey 路径)。
- Anthropic OAuth 申请 / 账号导入工具链(沿用现有 admin)。
- Per-key rate limit / IP allowlist(`user_api_keys` 表的迭代,正交于 envelope 归一)。
- 反风控量化指标 dashboard(独立 plan,本 plan 只保证 prod metric 不变差)。
