# V3 对外 Claude Code 接入端点 实施计划 (2026-05-18)

> Status: **APPROVED v4** — Codex 四轮 review 已 PASS(2026-05-18);v4 内补一条无尾斜杠根路径边界说明(Codex 标 MINOR 非 blocker,顺手收口)
> Branch: `feat/cc-external-endpoint`(worktree `/opt/openclaude/openclaude-v3-cc-endpoint`)
> Base: `feat/anthropic-proxy-strategy-split`(三层拆分分支,本任务依赖它)
> Scope: 在 v3 commercial 上新增一个公网可达的 Anthropic-compatible `/v1/messages` 端点,用户在本地 Claude Code 配置 URL + API key 即可使用。**复用** 三层拆分之后的全套 billing / authz / pool / SSE pipe。

---

## 1. 动机

三层拆分(`docs/V3_ANTHROPIC_PROXY_SPLIT_PLAN_2026-05-18.md`)就是为这一步铺路 — `IdentityStrategy` 接口已经在位,只需要再实现一个 `ApiKeyIdentityStrategy`,以及为它配套的 API key 签发/管理面 + listener 接入。

业务收益:用户的本地 Claude Code 不再需要部署 OpenClaude 容器栈 / 容器双因子识别,就能消费 v3 后端的账号池 + 健康分调度 + 反风控字段 + 用户积分。

## 2. 现状(2026-05-18 调研结果)

### 2.1 数据模型

- **未找到**用户级 API key / personal token 表(`db/migrations/0001-0067` 全量 grep)。
- Web JWT(`auth/jwt.ts`):HS256, 15min TTL — **太短,不适合 CC 长期使用**。
- 容器 Bearer 格式:`oc-v3.<containerId>.<64hex>`,SHA-256 比对(`auth/containerIdentity.ts`)— 跟"用户级 API key"是两套独立模型。

### 2.2 Listener 与反代

- anthropicProxy 当前两个 listener(均**非公网**):
  - `172.30.0.1:18791` plain HTTP(self-host,容器内 docker bridge)
  - `0.0.0.0:18443` mTLS HTTPS(可选,远程容器走 node-agent L7 反代)
- 公网入口走 gateway 18789(CF → Caddy → `127.0.0.1:18789`),当前**只跑 web API,JWT 认证**。
- handler 装配点唯一:`packages/commercial/src/index.ts:820`。

### 2.3 IdentityStrategy 接入面

- 接口位置 `auth/proxyIdentity.ts:57-78`,**已经为多策略设计**。
- `ProxyIdentity = { uid: bigint, containerId: bigint }` — `containerId` 当前**非空约束**(TS),但 SQL `request_finalize_journal.container_id BIGINT NULL`(`0015` migration)允许 NULL。`usage_records` / `credit_ledger` 根本无 container_id 列。
- Rate-limit + concurrency 100% keyed on `uid:${bigint}`,新身份策略无需扩展。

### 2.4 三层拆分新基线

`auth/proxyIdentity.ts` 已落地 `ContainerIdentityStrategy`,`http/proxy/index.ts` 通过 `deps.identity.resolve / authorize` 间接调用。新增 `ApiKeyIdentityStrategy` 只需实现两个方法 + 在装配处按 listener 维度选择策略,不改 handler 主流程。

---

## 3. 目标架构

### 3.1 控制流

```
公网请求 → cloudflared → Caddy:443 → gateway:127.0.0.1:18789
                                       │
                                       ├─ /api/anthropic/v1/messages → 新 path: 走 ApiKey strategy + anthropicProxy handler
                                       └─ /api/...(其它 web API) → 走 web JWT 认证(原有)
```

### 3.2 三个独立模块

#### 3.2.1 数据模型 — `user_api_keys` 表

```sql
CREATE TABLE user_api_keys (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,                       -- 用户给的备注(如 "我的 MacBook")
  key_prefix      TEXT NOT NULL,                       -- 前 8 字符明文(查表索引 + 展示)
  key_hash        BYTEA NOT NULL,                      -- SHA-256(secret hex→raw 24 字节) — 输出 32 字节
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  UNIQUE (key_prefix),                                 -- 防 prefix 碰撞,O(1) 定位
  CHECK (length(btrim(label)) BETWEEN 1 AND 80)        -- 强制非空可读 label(Codex v1 MAJOR #2)
);
CREATE INDEX idx_uak_user_active ON user_api_keys(user_id) WHERE revoked_at IS NULL;
```

**关键设计**:
- **Hash-only 存储** — 服务端永远不存明文 secret,只存 SHA-256(同容器 Bearer 模式)。撤销靠 `revoked_at` 软删除(保留审计)。
- **hash 输入 = `Buffer.from(secretHex, "hex")` 的 24 字节原始字节**(等价 `containerIdentity.ts:111` 容器 token 实现:`createHash("sha256").update(Buffer.from(secretHex, "hex")).digest()`)。**绝不** hash UTF-8 字符串形式的 hex,否则跟容器实现长出第二套不一致行为。
- **prefix 单独列 + UNIQUE** — 验证时按 prefix O(1) 查表,再 timing-safe compare hash,不必全表扫描。
- **`label` 必填 + CHECK** — DB 层 `CHECK (length(btrim(label)) BETWEEN 1 AND 80)` 强制非空 1..80 字符;API 层 POST 时 trim 后校验,空/超长返 400。原 v1 只用 `NOT NULL` 允许 `''` / 全空格,无法兑现"强制有意义命名"承诺。

#### 3.2.2 API key 格式

`oc-cc.<keyPrefix>.<secret>` — 同容器 Bearer 同型,正则 `^oc-cc\.([0-9a-z]{8})\.([0-9a-f]{48})$`:
- 前缀 `oc-cc` 明示用途(对外 cc 接入),跟容器 `oc-v3` 区分(防误用)
- `keyPrefix` **8 字符 lowercase base36**(字符集 `[0-9a-z]`,即生成/正则/熵计算四者完全一致)。熵 `36^8 ≈ 2.82 × 10^12`(2.82T),单用户预期 < 10 key,碰撞概率工程上为零
- `secret` 48 hex(24 字节随机,熵 192-bit,远超 NIST 推荐 128-bit)

> **v1 Codex MAJOR #1 修正**:v1 原写"8 字符 base32"但正则用 `[a-z0-9]`(36 字符表),这既不是 RFC4648 也不是 Crockford base32,熵计算 `32^8` 不成立。v2 统一为 lowercase base36 — 生成器、parser、正则、熵计算、文档四者锁定。

**为什么不用 `sk-...` anthropic 同型?** 区分自家 key 与上游 key,避免日志/泄漏时混淆。

#### 3.2.3 ApiKeyIdentityStrategy

```ts
class ApiKeyIdentityStrategy implements IdentityStrategy {
  constructor(private repo: ApiKeyRepo) {}

  async resolve(req, ctx): Promise<ProxyIdentity> {
    const auth = req.headers.authorization;
    const m = auth?.match(/^Bearer (oc-cc\.[a-z0-9]{8}\.[a-f0-9]{48})$/);
    if (!m) throw new IdentityError("MISSING_OR_INVALID_API_KEY");

    const [, prefix, secret] = m[1].split(".");
    const row = await this.repo.findByPrefix(prefix);
    if (!row || row.revoked_at) throw new IdentityError("API_KEY_REVOKED");

    const hash = sha256(Buffer.from(secret, "hex"));   // ← v3 Codex MINOR 修:对 raw 24 字节做 hash,跟 containerIdentity.ts:111 一致
    if (!timingSafeEqual(hash, row.key_hash)) {
      throw new IdentityError("API_KEY_INVALID");
    }
    // fire-and-forget: bump last_used_at,失败仅 log
    this.repo.touchLastUsed(row.id).catch(...);

    return { uid: row.user_id, containerId: null };   // ← containerId=null 关键变化
  }

  async authorize(identity, pricing, model): Promise<void> {
    // 复用 ContainerIdentityStrategy 同等逻辑:loadUserModelAuthz + canUseModel
  }
}
```

#### 3.2.4 Gateway commercial router 接管 + exact route + adapter

复用 gateway 18789 公网入口,需要在 commercial **router** 上同时改两个地方(**v3 Codex MAJOR #1 修正:仅声明 "exact route" 不够,router 的 prefix 接管闸门会先把 path 踢出去**):

**(a) router prefixes 数组扩展 — 接管整个 `/api/anthropic/` namespace**(`packages/commercial/src/http/router.ts:757-774`):
- 新增 `'/api/anthropic/'` 进 prefixes(注意**带尾斜杠**,语义是产品 namespace 而非单条 path)
- 这一步让 commercial router 把整个 `/api/anthropic/*` namespace **接管**(`isOurs=true`),不再 fall through 到下层 gateway 自身 handler。
- **为什么是 namespace 而非单条 exact**(v3 Codex MAJOR #1 修正,v4 采纳"namespace 接管"方案):
  - sibling path(如 `/api/anthropic/v1/some-other`)统一在 commercial router 内 404,跟 invariant #5 测试承诺一致(unsupported path 返 404 不进 handler)
  - 跟 §10 URL 决定一致:`/api/anthropic` 是产品 namespace,未来加 `/api/anthropic/v1/count_tokens` 等扩展无需再改 prefix
  - 旧 v3 方案(prefix=单条 exact `'/api/anthropic/v1/messages'`)会让 `sibling/some-other` fall through,与 #5 测试承诺冲突 — 是补丁不是根治
- 维护期闸门(`isOursForMaintenance`)会自动覆盖到本 namespace,无需额外改。
- **边界**:无尾斜杠根路径 `/api/anthropic`(没有斜杠后跟任何字符)不在 `startsWith('/api/anthropic/')` 范围内,**自然 fall through** 到下层 gateway 默认 handler(最终 404)。Phase 3 单测顺手加一条断言锁定本边界(Codex v3 MINOR 完整性补充)。

**(b) router 内部 exact-match 业务派发**:
- exact match `path === '/api/anthropic/v1/messages'`(**不**用 `startsWith`)→ adapter:`req.url = "/v1/messages"`,合成 ctx,调 `apiKeyProxyHandler(req, res, syntheticCtx)`
- `/api/anthropic/` namespace 下其他任何 path(`/v1/messages/foo`、`/v1/messages/`、`/v1/some-other`、`/`、`/foo`)→ router 兜底返 404 **不进** anthropicProxy handler。
- handler 内部 path 白名单 `/v1/messages` 不动 — adapter 先做 path rewrite 再传给 handler。
- `syntheticCtx = { hostUuid: "external-api-key", boundIp: "external-api-key" }`(两字段均为 sentinel string;`hostUuid` 用于 log/metric 区分流量来源,`boundIp` 改 sentinel 而非 clientIp —— ApiKey 路径无容器双因子绑定 IP 概念,sentinel 显式表明"无 IP 安全语义",避免误读;ApiKey 路径**不调** `recordHostRequest`,见 invariant #6 / Codex Phase 3 plan-review MINOR 2 采纳)

**为什么不直接让 handler 白名单加 `/api/anthropic/v1/messages`?**
- 加白名单意味着 anthropicProxy handler 知道自己暴露在 `/api` 前缀下,但实际它只在乎"是不是 messages 请求"
- adapter 在 router 层处理是 wiring 职责,跟 mTLS listener 注入合成 hostUuid 是同一思路(consistency)

> v2 措辞 "router 层 exact route" 被 Codex 继续收口为 "prefix 数组接管 + 内部 exact-match 派发"(v3) — 漏掉前半步会让新 route 直接被 router 的 `isOurs` 闸门踢出去。

### 3.3 API key 管理面(Web API,JWT 认证)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/me/api-keys` | GET | 列出当前用户所有未撤销 key(只返 prefix + label + last_used_at + created_at,**不返 secret**)|
| `/api/me/api-keys` | POST `{label}` | 创建新 key,**返完整明文 secret 一次**(后续无法再查) |
| `/api/me/api-keys/:id` | DELETE | 软删除(set `revoked_at`)|

签发面在 `commercial/src/http/` 下新增 `apiKeyAdmin.ts`,挂在 web router(JWT 认证)。

### 3.4 上线门控 — admin-only rollout(Phase 6,临时)

**决策**(2026-05-18 boss 上线确认):首期 CC 外接 endpoint **只对 admin role 开放**,普通用户暂不允许创建/使用 API key。等内部 dogfood 一段时间、扣费 / claude_accounts pool 消费、`request_finalize_journal.container_id IS NULL` 路径稳定后,再开放给普通用户。

**两层防御**(defense-in-depth):

| Layer | 位置 | 行为 | 错误码 |
|---|---|---|---|
| Layer 1 | `http/apiKeyAdmin.ts` 三个 handler | `requireAuth` 之后立刻 `requireAdmin(user)` — 非 admin JWT 进 GET/POST/DELETE 一律 reject | HTTP 403 `ADMIN_ONLY` |
| Layer 2 | `auth/apiKeyIdentity.ts` `resolve` | secret 验对 + `bumpLastUsedThrottled` 完成后,`loadUserModelAuthz(uid).role !== "admin"` → throw `IdentityError("API_KEY_INVALID")`,proxy/index.ts 统一映成 401 UNAUTHORIZED | HTTP 401(反枚举:与 unknown / revoked / secret-mismatch 同码)|

**两层都要**的理由(消除"一类问题"而非单点补丁):
- Layer 1 拦"创建/列表/撤销"入口 — 防止普通用户的 JWT 创建出可能被 staff/SQL 直插的 row。
- Layer 2 拦"消费 quota"入口 — 即使 DB 残留 user-role 的 key(staff 协助创建 / SQL 直插 / 历史数据),仍兜底 reject,**保护 claude_accounts pool 不被普通用户消耗**。
- Layer 1 在 path regex **之前**:非 admin 撞 malformed path 也返 403 而非 404(rollout 期不区分 path 是否合法,避免"探 path 合法性"侧信道)。

**Layer 2 顺序锁**(写进 strategy 注释 + unit/integ test 锁住):
1. `findByPrefix` → 不存在 / 已撤销 → throw,**不**bump
2. secret 比对 → mismatch → throw,**不**bump
3. **secret 验对 → bumpLastUsedThrottled fire**(ops 可见 last_used_at,知道有非 admin 在试用合法 key)
4. `loadUserModelAuthz` → role 非 admin → throw API_KEY_INVALID

**反枚举一致性**(plan §4 invariant #7 已锁):Layer 2 用同一 `API_KEY_INVALID` 码,攻击者拿 user-role 的 key 试探时无法靠错误码区分 "不存在 / 已撤销 / 非 admin"。

**fail-closed**:`loadUserModelAuthz` 自身 throw 直接透传 → proxy/index.ts catch-all 映成 500 INTERNAL(不静默放行),Phase 2 strategy unit test 锁。

**未来去 gate**(改回普通用户开放):
1. 删 `apiKeyAdmin.ts` 中 `requireAdmin` 函数 + 3 处调用(Layer 1)
2. 删 `apiKeyIdentity.ts` `resolve` 内 `Phase 6 admin-only rollout gate` 注释块内代码(Layer 2)
3. 测试中默认 role 改回 `user`、删除 Phase 6 describe blocks
4. 同步删/改文档:本节(§3.4)、§4 invariant #9、§7 Phase 6 行、§8 Phase 6 临时性标注,以及代码内 `Phase 6` 注释块(`apiKeyAdmin.ts` / `apiKeyIdentity.ts` 文件头与 inline 注释)
5. **无外部 API 变化**(错误码、URL、token 形态、SQL schema 均不变)

---

## 4. 9 个硬不变量(测试必须锁定)

复用 anthropicProxy split plan §6.1 的 5 个 handler baseline invariants(release 4-stage / abort err.shape / commit→broadcast 顺序 / DeepSeek noop / model gate fail-closed —— 本任务**不重复列也不再写测试**,只引用)。

本任务新增 9 条(原 v1 6 条 + Codex v1 MAJOR #3 新增 #7 #8 + Phase 6 临时门控 #9):

1. **API key 无明文存储** — repo.create 返完整 secret,**之后任何查询都不能返 secret**(只返 prefix + hash 比对的接口)。test: `findByPrefix(prefix)` 返回的 row 没有 secret 字段。
2. **撤销立即生效** — `revoked_at IS NOT NULL` 的 key 在下一次 `resolve` 即 401。test: revoke 后第二次 request 拿到 401。
3. **prefix 碰撞防御** — `UNIQUE(key_prefix)` 强约束 + 创建时如果碰撞自动重试 ≤ 3 次。test: mock 前两次返冲突 prefix,第三次成功;mock 三次都冲突,抛 5xx。
4. **timing-safe compare** — `verifyApiKey` 必须用 `crypto.timingSafeEqual`,不用 `===` / `Buffer.compare`。test: code path inspection(grep guard)+ negative case 1 字节差异。
5. **path whitelist 不放水** — `/api/anthropic/` namespace 被 commercial router 接管(prefix=`'/api/anthropic/'`),内部只有 `path === '/api/anthropic/v1/messages'` 才进 adapter;其他任何 `/api/anthropic/**` path(`/v1/messages/foo`、`/v1/messages/`、`/v1/some-other`、namespace 根 `/api/anthropic/` 等)统一在 router 内 404,**不进** anthropicProxy handler。test: 4-5 个 negative path → 404 且 anthropicProxy handler spy 调用次数为 0。
6. **API-key 路径不调用 `recordHostRequest`** — synthetic `hostUuid = "external-api-key"` 仅用于 log/metric 区分,**API-key 路径绝不调用 `recordHostRequest`**(防外部流量被并入某真实 host 统计)。test: `recordHostRequest` spy 调用次数为 0 + hostUuid value 断言为 `"external-api-key"`。
7. **【Codex v1 MAJOR #3】invalid / revoked API key → 401 且账务零副作用** — 当 `resolve` 抛 `IdentityError`,**绝不**调用 `preCheckWithCost` / `startInflightJournal` / `settleUsageAndLedger` 中任意一个。test(commercial integ): 发送 invalid key + revoked key,handler 返 401,reservation/journal/ledger 三类副作用 spy 调用次数均为 0。
8. **【Codex v1 MAJOR #3 / v2 收口】valid API key + known enabled model 但 role/grants 不满足 → 403 且账务零副作用** — `authorize` 失败时**不**写 journal / ledger。test: mock `loadUserModelAuthz` 返用户**无 grant** 的普通用户 + 请求带 admin/hidden 受限 model(model 自身 enabled,只是该 uid 无权用),handler 返 403,reservation/journal/ledger 三类副作用 spy 调用次数均为 0。
9. **【Phase 6 admin-only rollout】两层 admin gate 闭合 + 顺序锁 + 反枚举一致 + 零账务**(plan §3.4 临时门控):
   - Layer 1(管理面 HTTP):非 admin JWT 进 GET/POST/DELETE `/api/me/api-keys*` 一律 403 ADMIN_ONLY,user_api_keys 表**完全不被触达**(repo spy 调用次数为 0)。Admin gate 在 path regex **之前**,malformed path 也得 403 而非 404。
   - Layer 2(strategy.resolve):**顺序锁** — unknown prefix / revoked / secret-mismatch 三种 secret 未验对的情况下 `touchLastUsed` spy 必须为 0;**secret 验对 + role 非 admin** 时 `touchLastUsed` spy 必须 = 1(让 ops 通过 last_used_at 看到非 admin 试用),随后 throw `API_KEY_INVALID` → handler 401 UNAUTHORIZED + **preCheck / scheduler / journal / usage_records / credit_ledger 任意 SQL 都不能触达**。
   - 反枚举:Layer 2 的 `API_KEY_INVALID` 与 unknown/revoked/mismatch 同码,客户端无法靠错误码区分。
   - fail-closed:`loadUserModelAuthz` 自身 throw 不被这里 catch,透传给 proxy/index.ts identity 阶段(非 `IdentityError` 继续抛出)→ 由 commercial router 的统一 `handleError` 映成 500 INTERNAL(不静默放行)。

> **注意 400 vs 403 边界**(Codex v2 修正):未知 model / `pricing.get(model)==null` / `enabled=false` 走 **400 `UNKNOWN_MODEL`** 在 `authorize` 之前,属 split plan §6.1 baseline #5 覆盖范围,本任务**不重复**测,只 reference;invariant #8 严格限定在"model 存在且 enabled,只是当前 uid 无 role/grants"的 authz 真路径。
>
> #7 #8 是本任务为新公网入口建立的信任边界。拆分 plan §6.1 baseline 锁的是 existing handler authorize 失败不进 preCheck 的容器入口语境;新增 `resolve` 路径 + 新 public route + `containerId=null` 这三个变化点没有被原 baseline 覆盖,必须本任务独立锁。
>
> #9 是本任务上线**首期临时**的 admin-only rollout 闭锁。未来去 gate 时整段 #9 invariant 同步下线(plan §3.4 末)。Layer 2 的 "secret OK 后才 bump" 顺序锁需要单独在 unit/integ 测试里写,**对比**未通过 secret 的路径(unknown / revoked / mismatch)的 bump=0,锁住 strategy 实现顺序不会被未来改动悄悄打乱。

---

## 5. ProxyIdentity.containerId 放宽 — 根治还是补丁?

**根治方案**:`ProxyIdentity.containerId: bigint | null`,全链路 TS 类型放宽,SQL 已允许 NULL。

**影响面**(grep):
- `auth/proxyIdentity.ts:39` — 接口字段(`containerId: bigint | null`)
- `auth/proxyIdentity.ts:39` 注释 `(future API key strategy 这里放 api_key_id)` 同步清理为 `containerId 为 null 表示非容器 strategy(如 ApiKeyIdentityStrategy)`(原注释跟本决策互斥,Codex MINOR #1 命中)
- `billing/proxyBilling.ts:54` — `FinalizeContext.containerId`
- `billing/proxyBilling.ts:140` — `startInflightJournal` SQL bind:`ctx.containerId === null ? null : ctx.containerId.toString()`
- `http/proxy/index.ts` — handler 透传 + userLog 标签直接保留真 `null`(`containerId === null ? null : containerId.toString()`);**不**用 `"<api-key>"` sentinel string 替换 —— 让结构化日志字段类型保持"ID 或 null",不漂成"ID 或 label",未来若需区分路径走独立 `identityKind` 字段(最终实现采纳此型,与 plan 早期草稿"<api-key>" 不同)

**为什么不是补丁**:
- 走"哨兵容器 ID" 是把 SQL FK 假数据塞进核心表,语义混乱,未来增删 strategy 都会绊倒人。
- 放宽 type 是单纯让 TS 类型对齐 SQL 已有的真实约束 — 这是修一类问题(任何未来的非容器身份都能走通),不是单点补丁。
- 影响面 4 个文件,Codex review 一遍即可。

**plan §8 "不改 release ownership 语义"是否被违反?** 否 — 这里不涉及 release 路径,只是 type 表达。

---

## 6. Per-key rate-limit:MVP 范围决策

**问题**:当前 rate-limit / concurrency keyed on uid。一个用户多个 API key 共享 cap;一把 key 泄漏会让该用户其他 key 受牵连(被限速)。

**最佳实践**:per-key cap + per-uid cap 双层(per-key 兜底单 key 滥用,per-uid 兜底账户总配额)。

**MVP 决策**:**只保留 per-uid cap**,per-key cap 标为已知限制。
- 理由 1:per-key cap 需要给 key id 加 Redis 维度,扩大战线
- 理由 2:撤销立即生效(invariant #2)是更强的兜底 — 用户发现 key 滥用直接撤销即可
- 理由 3:本任务以"打通"为目标,精细化限速作为后续优化

**触发偿还条件**:出现任一以下情况就升级到双层 cap:
- 用户反馈 "一个 key 泄漏导致整个账户被限"
- prod 观测到单 key 在 15min 短窗占该 uid 总请求量 ≥ 80% **且**触发 uid cap / credits 异常消耗(单 uid 24h 扣费 ≥ 历史 P95 × 3)
- 安全事件:某个 key 被滥用导致账户高额扣费

未来真要上 per-key cap,需要在 `ProxyIdentity` 上多带 `apiKeyId: bigint | null` 字段(rate-limit / concurrency gate key 才能精到 key 粒度;当前 `ProxyIdentity = { uid, containerId | null }` 信息量不够)。届时连带新增 ctx 字段贯穿至 journal,以支持按 key 归因审计 — **当前 MVP 不做**。

明确写入 plan §8.

---

## 7. 实施分阶段

### Phase 0:type 放宽 + 全链路基线 测试(BLOCKING)

- `ProxyIdentity.containerId: bigint | null`
- `FinalizeContext.containerId: bigint | null`
- `startInflightJournal` SQL bind 支持 NULL
- handler / userLog 透传适配
- 同步清理 `proxyIdentity.ts:39` 旧注释(Codex MINOR #1)
- **必须先于业务开发**:加 2-3 个测试锁住 "containerId=null → journal.container_id 写 NULL,后续 finalize 仍正常 commit",作为后续重构的回归基线。

预算:0.3 工日。

### Phase 1:DB schema + repo

- `0068_user_api_keys.sql` migration
- `auth/apiKeyRepo.ts`:`create / findByPrefix / list / revoke / touchLastUsed`
- repo unit test:invariants #1 (no plaintext)、#3 (prefix collision retry)

预算:0.5 工日。

### Phase 2:ApiKeyIdentityStrategy

- `auth/apiKeyIdentity.ts`:`resolve / authorize`(复用 authz 逻辑)
- **`last_used_at` 节流**:fire-and-forget 写 DB,但带 in-process per-key 5 分钟 cache(轻量 `Map<keyId, lastBumpMs>`,~1k 条上限 LRU 淘汰),避免高频 SSE 请求把这张原本很安静的表打成热写点
- strategy unit test:invariants #2 (revoke takes effect)、#4 (timing-safe)、错误码映射、last_used_at 节流(第 1 次 bump,第 2 次同 key 5min 内不再写 DB)

预算:0.5 工日。

### Phase 3:Router namespace 接管 + exact route + adapter

- **router prefixes 数组扩展**(`http/router.ts:757-774`):新增 `'/api/anthropic/'`(注意**带尾斜杠**,namespace 而非单条 path)— **不加这一步,后续 exact route 永远走不到**(Codex v2 MAJOR #1);**namespace 而非单条 exact**,让 sibling path 也由本 router 兜底 404(Codex v3 MAJOR #1)
- commercial router 内部 exact-match `path === '/api/anthropic/v1/messages'` → adapter(**非**前缀,invariant #5)
- adapter:`req.url = "/v1/messages"` + 合成 ctx 注入(`hostUuid="external-api-key"`, `boundIp="external-api-key"` — 两字段均 sentinel,见 §3.2 / Codex Phase 3 plan-review MINOR 2)
- 第二个 handler instance(deps.identity = ApiKeyIdentityStrategy)
- integ test 模拟整链:
  - 正例:发送 valid API key → 走完 handler → 验 journal 写入(`container_id IS NULL`)+ SSE 返回
  - 负例 #7:invalid / revoked key → 401 + reservation/journal/ledger 三类副作用 spy 调用次数为 0
  - 负例 #8:valid key + 无 grant 用户 + 受限 model → 403 + 三类副作用 spy 调用次数为 0
  - 负例 path(invariant #5):`/api/anthropic/v1/messages/foo`、`/api/anthropic/v1/messages/`、`/api/anthropic/v1/some-other`、`/api/anthropic/`(namespace 根) → 全部 router 内 404,**不调** anthropicProxy handler spy

预算:0.5-1 工日(namespace 接管 + exact route + rewrite + 合成 ctx + 4-5 个 integ 负例,都是新代码,需小心边界)。

### Phase 4:管理面 API

- `http/apiKeyAdmin.ts`:GET/POST/DELETE 三个端点
- JWT 认证 + 用户隔离(只能改自己的 key)
- 单元 + integ 测试

预算:0.5 工日。

### Phase 5:验证 + Codex review + merge

- 跑全套 commercial 测试
- Codex review 全 diff
- 合 v3 与三层拆分一起部署

预算:0.5 工日。

### Phase 6:上线门控 — admin-only rollout(临时,见 §3.4)

> 本 Phase 在 Phase 0-5 已落地、PR 已开、Codex code review PASS、boss 确认"上线吧,确保不影响已有功能,先只给管理员用"之后追加。**目的:把首期试用面缩到 admin,等 dogfood 过 + claude_accounts pool 消费稳定再去 gate。**

- **Layer 1**(`http/apiKeyAdmin.ts`):`requireAdmin(user)` helper + 三个 handler 入口检查 → 非 admin JWT 一律 403 ADMIN_ONLY。
- **Layer 2**(`auth/apiKeyIdentity.ts` `resolve`):secret 验对 + `bumpLastUsedThrottled` fire 后,`loadUserModelAuthz(uid).role !== "admin"` → throw `API_KEY_INVALID`(反枚举一致)。
- **测试改造**:
  - Phase 2 strategy unit test:默认 `loadUserModelAuthz` mock 改 `role: "admin"`(replace_all 12 处),新增 `apiKeyIdentity.resolve — Phase 6 admin-only rollout gate(Layer 2)` describe(4 个用例:admin happy 锁 authzCalls=1 + bump=1 / non-admin → API_KEY_INVALID + bump=1 / loadUserModelAuthz throw passthrough + bump=1 / 对比性 bump 顺序锁:unknown=0 + mismatch=0 + non-admin=1)。
  - Phase 4 admin handler unit test:默认 `makeAuthHeader` 改 `role: "admin"`,新增 `makeUserAuthHeader` + Phase 6 admin-only describe(4 个用例:GET/POST/DELETE 非 admin → 403 ADMIN_ONLY + repo 0 调 + DELETE 非 admin + malformed path 也得 403 不是 404)。
  - Phase 4 admin handler integ test:harness 默认 admin(JWT + authzMock),新增 `Phase 6 admin-only rollout — Layer 1 管理面 403 闭环`(端到端真路由跑 GET/POST/DELETE 三条 + malformed → user_api_keys 0 触达)+ `Layer 2 strategy 兜底 401 + 零副作用`(admin 创建 key → authz 降级 user harness → 真 plaintext 跑 proxy → 401 + bump=1 + preCheck/scheduler/journal/usage/ledger 全 0 SQL)。
  - Phase 3 endpoint integ test:默认 authz role → admin;原 authz-deny test 改 visibility=`hidden` + role=`admin` + 空 grants 保留 canUseModel→false 闭环;新增 Phase 6 Layer 2 admin gate 负面用例。
- **plan doc 同步**:§3.4 新增完整段、§4 invariant #9、§7 本 Phase。
- **去 gate 路径**:在 §3.4 末尾固化,等触发条件满足(dogfood 稳定、扣费正确、boss 决定开放)时按步操作即可,**外部 API 形态不变**。

预算:0.3 工日(代码两点 admin gate + 测试 ~14 用例新增/改造 + plan doc 三段同步;借用既有 fakePool harness)。

**总计:3-4 工日 + Phase 6 临时 0.3 工日**。

**前提**:split baseline 测试夹具与 commercial router 挂载点(`packages/commercial/src/index.ts:820` 附近)已稳定。若 split 在 review 期间再次重构 `IdentityStrategy` / handler 装配 / billing lifecycle 签名,实际预算 4-5 工日(rebase 重写 ApiKeyIdentityStrategy + 修测试)。

---

## 8. 出本任务范围(明确划走,避免范围蠕变)

- ❌ **不**做 per-key rate-limit / concurrency cap(理由见 §6,触发条件已标注)
- ❌ **不**做 API key 过期 / 自动轮转(MVP:永久有效直到主动撤销)
- ❌ **不**做 web UI 来管理 API key(MVP:只暴露 REST API,前端 UI 是下一个迭代)
- ❌ **不**做 IP allowlist 绑定(同上,后续可选)
- ❌ **不**做 model-level 访问限制(已有 `loadUserModelAuthz` 的 model role + grants 模型,直接复用)
- ❌ **不**改 anthropicProxy handler 内部任何行为(只在 wiring 层接入新 strategy 与新 router path)
- ❌ **不**改 web JWT / refresh_token 模型
- ❌ **不**为 key create / revoke / 异常使用单独推送 security event / 邮件 / Telegram 通知(MVP 复用现有 request log;如需独立 audit trail,后续单独迭代)
- ❌ **不**做 key 重命名 / label PATCH 端点(MVP 用户可 revoke 旧 key + create 新 key 完成同样目的)
- ❌ **不**把 `api_key_id` 进 journal / ctx(MVP 按 uid 计费/审计;未来上 per-key cap 时再扩 ctx)
- ⏳ **临时门控** Phase 6 admin-only rollout(plan §3.4)— **非范围蠕变**,是上线节奏决策:首期 admin 才能用 CC 外接 endpoint。去 gate 时把 Layer 1+Layer 2 两段注释包裹的代码删除即可,无外部 API / SQL schema 变化(详见 §3.4 末"未来去 gate")。

---

## 9. 风险表

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `containerId=null` 全链路放宽时漏改某处 → 启动崩溃 | 中 | 高 | grep `containerId` 全仓 + Phase 0 测试基线 + tsc strict 必过 |
| API key prefix 碰撞 → 第二个用户拿到第一个用户的 key | 极低(36^8 ≈ 2.82T) | 致命 | UNIQUE 约束 + 创建时 ≤ 3 次重试 + 抛 5xx 触发告警 |
| API key 泄漏 → 用户被高额扣费 | 中 | 高 | 撤销立即生效 + 用户面板可看 last_used_at + 后续加 IP allowlist(已划出范围)|
| 新 path `/api/anthropic/v1/messages` 与 web API path 冲突 | 低 | 中 | 上线前 grep 现有 prefixes 表 + router ownership(`/api/anthropic/` namespace) + exact-match 业务派发的 unit/integ test 覆盖 |
| `recordHostRequest` 把 API key 流量并入某真实 host 统计 | 低 | 中 | invariant #6 — hostUuid 固定为 `"external-api-key"`,strategy 层判断不调 recordHostRequest |
| 客户端用 base URL 写错(末尾少 `/v1/messages` 路径)→ 404 体验差 | 低 | 低 | doc 给出标准配置范例;监控 404 速率作为运维指标 |
| 三层拆分还没合 v3 → 本任务依赖那条分支 | 100% | 关键 | 本任务 PR 在三层拆分 PR 之后顺序合;部署一起做 |
| split PR 在 review 期间继续改 `IdentityStrategy` / billing lifecycle 签名 → 本任务被迫 rebase 重做 ApiKeyIdentityStrategy 与 strategy unit test | 中 | 中 | 先冻结 split contract(boss 在 split PR 上明示 "签名已稳定再 merge")再开本任务 coding;或本任务 PR 只在 split final approve 后进入实现期 |
| `last_used_at` 高频 SSE 请求将本来很安静的表打成热写点 | 中 | 中 | Phase 2 加 in-process per-key 5min 节流(见 §7 Phase 2),strategy unit test 覆盖 |

---

## 10. v3 → v4 变更摘要(Codex v3 review 反馈应用)

### 已采纳(MAJOR)

| Codex v3 反馈 | v4 改动 |
|---|---|
| MAJOR #1 v3 prefix 单条 exact 让 sibling path `/v1/some-other` fall through,与 #5 测试承诺冲突 | §3.2.4 (a) prefix 改 `'/api/anthropic/'` namespace(尾斜杠);§3.2.4 (b) sibling 全部 router 内 404;§4 #5 重写负例集为 namespace 内所有 non-messages 路径;§7 Phase 3 同步;§9 措辞更新 |

### 已采纳(MINOR)

| Codex v3 反馈 | v4 改动 |
|---|---|
| MINOR #1 `/v1/messages?` 例子误导(URL.pathname 去 query) | 删掉 query-string 例子;§3.2.4 (b) 负例改用 `/v1/messages/foo` 等真 pathname 不同的例子 |
| MINOR #2 §9 残留 "listener path 白名单" 旧词 | 改成 "router ownership(`/api/anthropic/` namespace) + exact-match 业务派发的 unit/integ test" |

---

## 11. v2 → v3 变更摘要(Codex v2 review 反馈应用)

### 已采纳(MAJOR)

| Codex v2 反馈 | v3 改动 |
|---|---|
| MAJOR #1 router prefixes 不接管 `/api/anthropic` → exact route 走不到 | §3.2.4 拆成 (a) prefixes 数组扩展 + (b) 内部 exact-match;§7 Phase 3 第一步显式列入 prefix 接管 + 负例测试改成"router 已接管 prefix 但 exact 不命中→ 404 不进 handler" |
| MAJOR #2 invariant #8 把"未知 model"塞进 403 分支,与 split baseline 400/403 边界冲突 | §4 #8 改成 "valid API key + **known enabled model 但 role/grants 不满足** → 403";加注释明示 400 vs 403 边界,400 路径属 split §6.1 #5 baseline 不重复 |

### 已采纳(MINOR)

| Codex v2 反馈 | v3 改动 |
|---|---|
| MINOR #1 §3.2.3 伪代码 `sha256(secret)` 跟 §3.2.1 文字定义不一致 | 伪代码改成 `sha256(Buffer.from(secret, "hex"))` |
| MINOR #2 spy 名称对齐真实代码 | §4 #7 #8 spy 改 `preCheckWithCost / startInflightJournal / settleUsageAndLedger` |
| MINOR #3 §9 风险表残留旧数字 `2^40 = 1T` | 改成 `36^8 ≈ 2.82T` |
| MINOR #4 invariant #6 主语应硬到"不调用 `recordHostRequest`" | §4 #6 主语重写为 "API-key 路径不调用 `recordHostRequest`",hostUuid 固定值仅作 log/metric 标签 |

### v1 review 我拒绝的 3 条 minor — v2 review 全部认账,无保留

- discriminated union 替 `bigint | null`(过早抽象)— Codex v2 认账
- `created_by_ip`(MVP 过度防御)— Codex v2 认账
- 耗时分布 benchmark 测试(脆弱)— Codex v2 认账

---

## 12. v1 → v2 变更摘要(Codex v1 review 反馈应用)

### 已采纳(MAJOR — 必改)

| Codex 反馈 | v2 改动 |
|---|---|
| MAJOR #1 base32 alphabet 自相矛盾 | §3.2.2 改 lowercase base36 `[0-9a-z]{8}`,熵 `36^8 ≈ 2.82T`,生成/正则/熵/文档四者锁定 |
| MAJOR #2 `label TEXT NOT NULL` 允许 `''` | §3.2.1 SQL 加 `CHECK (length(btrim(label)) BETWEEN 1 AND 80)`;§3.3 POST 校验 trim 后 1..80 否则 400 |
| MAJOR #3 新入口失败不计费无独立测试 | §4 新增 invariant #7 (invalid/revoked key→401 billing 零副作用) + #8 (unauth model→403 billing 零副作用);§7 Phase 3 显式列入 integ 负例 |

### 已采纳(MINOR)

| Codex 反馈 | v2 改动 |
|---|---|
| MINOR #1 旧注释 `api_key_id` 与本决策互斥 | §5 加 Phase 0 顺手清理 `proxyIdentity.ts:39` |
| MINOR #2 措辞 "listener rewrite" → "router exact route + adapter" | §3.2.4 标题与正文改写,明确不挪 Caddy/cloudflared,exact-match 而非前缀 |
| MINOR #4 hash 输入语义写死 | §3.2.1 明示 `SHA-256(Buffer.from(hex,'hex'))` 等价 containerIdentity:111 |
| MINOR #5 标题与措辞收口 | §4 标题 "5 个" → "8 个";"继承 §6.1 5 个不变量" → "复用 anthropicProxy split plan §6.1 的 5 个 handler baseline invariants" |
| MINOR #6 per-key cap 触发条件更可观察 | §6 第三条改成 "单 key 15min 窗占 uid 总请求 ≥ 80% 且触发 uid cap";加未来 cap 需要 `apiKeyId` 入 ctx 的说明 |
| MINOR #7 范围划走显式列出 | §8 新增三行(security event / key rename / api_key_id 入 journal) |
| MINOR #8 风险表加 split 签名漂移 | §9 新增 "split contract 在 review 中改签名" 风险行 |
| MINOR #9 预算前提写清 | §7 末尾加前提:split baseline 稳定;否则 4-5 工日 |
| 澄清 #1 `last_used_at` 节流 | §7 Phase 2 显式加 in-process 5min 节流策略 |
| 澄清 #3 公网 URL 形状 | 见下方"URL 形状决定" |

### 显式拒绝(Codex 自己也说"不必采纳")

| Codex 反馈 | 拒绝理由 |
|---|---|
| MINOR #1 改用 discriminated union `{ kind:'container' }|{ kind:'apiKey' }` 替代 `containerId: bigint | null` | 现在下游真正需要的是"有无容器 FK",SQL 已表达为 nullable;union 属于提前抽象,仅在下游开始按身份种类分支时才值得引入。**Codex 也明确说"这条建议不必采纳"**。 |
| MINOR #7 加 `created_by_ip` 字段 | 对 MVP 是过度防御。Codex 也说"这条建议不必采纳"。 |
| MINOR #4 加 secret 1 字节差异 vs 全错耗时分布检查测试 | Codex 自己说"这比再加一个耗时分布检查更值钱;后者可选,别把测试预算花在脆弱 benchmark 上"。timing-safe 用 code path inspection + negative case 一条即可。 |

### URL 形状决定(澄清 #3)

- 用户配置 `ANTHROPIC_BASE_URL=https://<domain>/api/anthropic`,Claude Code 自动加 `/v1/messages` 后缀
- 沿用 `/api/...` 命名空间(跟 web API、容器入口一致);未来 `/api/anthropic/v1/count_tokens` 等扩展空间已留
- 若未来需要"真 Anthropic-compat 公网根路径 `/v1/...`",另起任务(影响网关全局路由,非本任务范围)

### 仍待 boss 拍板(v2 没动)

1. **总预算 3-4 工日** 是否合理?(Codex 说 OK,前提 split 稳定)
2. **管理面 API**:GET/POST/DELETE 三个端点是否足够,不要 PATCH 改 label?(Codex 说可后置,已划入 §8)
