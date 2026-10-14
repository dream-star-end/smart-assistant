# OCV5-424 FINDINGS：个人版账号池/调度现状盘点（2026-10-14，feat/v5-selfhost @ f9b24bb65）

只读盘点，代码路径相对 `packages/commercial/src`（`ap/` = `account-pool/`）。现网数据只读事务、不选凭证列。

## 1. 各服务现状一览

| 服务 | 订阅账号 | API key | 存储 | 选号 | 429/配额 | 认证失效 | 自动恢复 |
|---|---|---|---|---|---|---|---|
| Claude | `claude_accounts(provider=claude)` OAuth | **无**（无 Anthropic key 池） | DB 加密 | 共享 `AccountScheduler.pick` WRH+权重+粘性+pin | 不看 Retry-After；与 5xx 同算“连续 3 次→cooldown 10min”；配额 ≥95% 从候选剔除（被动读响应头） | refresh 非瞬时 4xx / 解密失败 → **disabled** | 仅 cooldown（5min 半开） |
| Codex | `provider=codex` OAuth，按容器绑定 | `api_relay_credentials`（现网 0 行） | DB 加密 | 绑定 picker（纯 rendezvous，无权重/健康/配额）；relay 凭证按 health 最高 | **无** 429/配额冷却，配额只记录不参与选号；relay 凭证失败只 `fail_count++` | refresh 失败 → disabled → fanout rebind | relay 凭证：**无**（cooldown 只能人工） |
| Grok | `provider=grok` OAuth | 无 | DB 加密 | 共享 `pick` | 401/402/403/429 → health 失败，3 次 cooldown | invalid_grant → **disabled** | 仅 cooldown |
| Cursor/Box | `provider=cursor`（api_key/session）+ `box_claude_profiles` | cursor api_key 凭证 | DB 加密 + host 物化 | **自研**两套：`cursorAccountSelection` 与 `boxProfileScheduler`；CLI 侧 `oc-cursor.sh` 槽轮换 | Box bench：配额→到重置时刻；cursorExternal 401 冷却**仅内存**（重启丢） | session 过期需人工重登 | Box bench 自动过期；cursor 行 disabled 需人工 |
| 静态 key（deepseek/minimax/ark/zai/kimi/moonshot/bailian/opencodego） | — | **每家 1 个 env key** | env | 无选号，无故障切换 | 仅 Moonshot 计费 403 有 quota circuit；provider 健康只影子判定（enforce flag） | 无 | provider 级 forced_* 只能人工 |
| Gemini | 无 | 仅 CCB 独立客户端单 env key（现网未配） | env | 无 | 无 | 无 | 无 |
| Antigravity | — | — | — | 中继未实现（`ANTIGRAVITY_ROUTE_REQUIRED` fail-closed，OCV5-415 P2） | — | — | — |

## 2. 现网数据（`openclaude_v5_selfhost`，只读）

- claude：0 active / 2 disabled（#22 `upstream 401`，#23 `refresh 400`）——**当前没有可用 Claude 订阅账号**，且都卡在需人工状态。
- codex：1 active / 1 disabled；grok：1 active / 4 disabled（2 条带 402/404 错误）；cursor：1 active / 10 disabled（大多 `last_error` 空 = 人工停用，Sand 已退役）。
- `api_relay_credentials` 0 行；`provider_quota_blocks` 0 行；`provider_ops`：zai `forced_healthy` 但观测 degraded。
- env 缺 `ARK_AGENT_PLAN_KEY`、`BAILIAN_TOKEN_PLAN_KEY`（kimi/ark-k3/bailian 不可用）；无任何 Gemini/Google key。

## 3. 问题归纳

1. **调度逻辑分裂成 5 套**：共享 scheduler（claude/grok）、codex 绑定 picker、relay 凭证 picker、cursor/Box 两套自研、静态 key 无调度。健康/冷却/恢复规则各不相同。
2. **429 未被正确对待**：Retry-After 被忽略；限流与故障同等扣分；codex/relay/静态 key 对 429 完全无冷却。
3. **存在需人工处理的终态**：系统自动写入的 `disabled`（refresh 4xx、解密失败、grok invalid_grant、cursor）永不自动恢复；relay 凭证冷却只能人工；配额 ≥95% 且无 reset 时间永久剔除；zai 被人工 forced_healthy。
4. **API key 未纳管**：Anthropic 无 key 池；静态 provider 每家单 key、无多 key 轮换/故障切换；Gemini 无池；Antigravity 无中继。
5. **状态不持久**：cursorExternal 401 冷却在内存，重启即失。
6. **管理后台没有“分服务池”总览**：账号页只列 `claude_accounts`，API key 散在 env 与 relay 弹窗，看不到冷却原因/下次探测时间。

## 4. 需保留的既有约束

- 订阅账号遇 429 **不在同一请求内切号重试**（`http/proxy/core.ts:398-410` 反封号复盘：切号=规避限额）；只冷却该号、后续新请求换号。
- 每账号独立出口代理（`egress_proxy_id` 必填，cursor 除外）、claude 同出口仅一个 active 账号（0253）。
- runtime_channel 对 codex/grok 的分区；session pin 语义；codex 容器绑定 + auth.json。
- 人工 `disabled` / `banned` 是管理员意图，自动恢复**不得**动。

---

# OCV5-424 设计：分服务账号池 + 上层统一调度策略（个人版 feat/v5-selfhost）

用户定调：「不是统一账号池」「上层是实现统一的调度策略，不要每个服务账号池单独一套」。
=> **每个服务一个池**（成员 = 该服务的订阅账号 + API key），**一套共享策略层**负责选号、健康、429/配额冷却、故障切换、自动恢复。各池只实现“存储 + 探测 + 凭证使用”适配器，不再各写调度。

## 1. 结构

```
                ┌──────────────── ap/policy/（共享，唯一一套） ────────────────┐
                │ outcome.ts  classify(signal) → Outcome                        │
                │ decide.ts   decide(state, outcome, now) → Transition（纯函数）│
                │ select.ts   rank(members, {stickyKey, tierOrder}) → 有序候选   │
                │ recovery.ts 单一 leader actor：到期半开 + 认证类自动探测        │
                │ registry.ts PoolAdapter 注册表（服务 → 适配器）                │
                └───────────────────────────────────────────────────────────────┘
   PoolAdapter（每服务一个，薄）：listMembers / applyTransition / probe / useCredential
   claude  | codex | grok | box | deepseek | minimax | ark | zai | kimi | moonshot | bailian | opencodego | gemini
```

### 1.1 Outcome（共享分类）
`success | rate_limited{retryAfterMs?} | quota_exhausted{resetAt?} | auth_invalid | credential_corrupt | upstream_error | network | client_error`
- 429 → rate_limited（读 `retry-after` 秒/HTTP-date、`anthropic-ratelimit-*-reset`）；带配额语义的 429/402/403（Anthropic 5h/7d、Moonshot billing、Codex usage_limit、Box quota）→ quota_exhausted。
- 401/403（请求或 refresh 的非瞬时 4xx、grok invalid_grant、cursor session 过期）→ auth_invalid；AEAD 解密失败 → credential_corrupt。
- 5xx → upstream_error；出口/网络 → network；400 invalid_request、客户端中断 → client_error（不扣分）。

### 1.2 decide（共享状态机，纯函数，全量单测）
| Outcome | 状态变化 | 冷却时长 |
|---|---|---|
| success | active，health+10，backoff_level=0 | — |
| rate_limited | **立即** cooldown(reason=rate_limited) | Retry-After clamp[15s,15min]；无头则 30s·2^level，上限 15min |
| quota_exhausted | cooldown(reason=quota)，不扣 health | 到 resetAt（≤7d）；无则 1h 后探测 |
| auth_invalid | cooldown(reason=auth)，**不再写 disabled** | 5min·2^level，上限 6h；到期由 recovery **探测**（refresh/轻量请求）成功才回 active |
| credential_corrupt | cooldown(reason=credential) | 30min·2^level，上限 24h；到期探测解密 |
| upstream_error/network | health−20；窗口内连续 3 次 → cooldown(reason=upstream) | 10min·2^level，上限 1h（network 不扣分，沿用现状） |
| client_error | 无 | — |

不变量：策略层**永不**产生 `disabled/banned`；`disabled` 只来自管理员（新增 `disabled_by='admin'`），自动恢复不碰。

### 1.3 select（共享选号）
- 资格：status=active 且（cooldown 已过 或 半开）；配额 ≥95% 剔除，但 **resets_at 为空且 quota_updated_at > 6h** 视为陈旧数据，降权保留（消除永久剔除）。
- 权重 = health × 配额因子 × 订阅到期因子（沿用 `poolWeight.ts`），粘性 WRH（key=sessionId/userId/容器）。
- **分层**：池内成员按 tier 排（默认 订阅 > API key），前一层全不可用才用下一层。
- **故障切换**：`rank()` 返回有序候选；每池声明 `failover`：
  - 订阅池（claude/codex/grok/box）：`next_request` —— 429/认证失败只冷却该号，**同请求不换号重试**（保留 core.ts 反封号约束）；下一请求自然落到其他成员。
  - API key 池：`before_first_byte` —— 首字节前遇 429/5xx/401 立即换下一把 key 重试（最多 2 次）。
- 并发槽沿用 scheduler 的进程内 slot + reaper。
- **session pin 不被长冷却卡死**：`readAccountRecoveryHint` 把 `cooldown` 且（reason∈{auth,credential} 或剩余 > 30min）视为 `terminal`，走现有 self-heal：仅翻该 (user,session,account) 的 csap 为 unbound → 409 `force_repin` → 前端自动带 `x-force-repin:1` 重发 → 绑定池内其他成员。短冷却（≤30min 的 rate_limited/upstream）维持现状返回 Retry-After，不换号（反封号约束）。

### 1.4 recovery（唯一恢复者，取代 cooldownRecoveryActor 的多套逻辑）
leader 每 60s：对每个注册池
1. reason ∈ {rate_limited, quota, upstream} 且到期 → 半开（active，health=50）。
2. reason ∈ {auth, credential} 且 `next_probe_at` 到期 → `adapter.probe()`（OAuth：走该号出口做 refresh；API key：`GET /v1/models` 类轻量请求；解密：试解密）；成功→active，失败→decide(探测失败)加大退避。每池每 tick 最多 3 个探测，带抖动。
3. 产出 `pool_events`（审计 + 管理后台“最近事件”）。

### 1.5 凭证隔离
- API key 统一 AES-256-GCM（现有 `loadKmsKey`/aead），只在适配器 `useCredential()` 内解密、用完 zeroize；API 与后台只返回指纹（sha256 前 8 + 末 4）。
- 池边界：select 只见本服务成员；每成员独立出口（订阅号沿用必填 egress；API key 可选 egress_proxy_id）。
- env 中的静态 key 启动时按指纹幂等导入为该服务池成员（source='env'），env 不再是唯一来源；gateway host 路径对 env 的读取保持不变（不在本票改）。

## 2. 数据（迁移 0305_pool_policy.sql，个人版独有号段，人工 apply + 登记 schema_migrations）
- `claude_accounts`、`api_relay_credentials` 增：`cooldown_reason text`、`backoff_level smallint default 0`、`next_probe_at timestamptz`、`disabled_by text`（仅 `admin`；NULL=非停用）。
- `box_claude_profiles` 增：`cooldown_reason`、`backoff_level`（已有 cooldown_until/last_reason）。
- 新表 `pool_api_keys(id, service, label, key_enc, key_nonce, fingerprint, base_url, egress_proxy_id, tier, weight, status, health_score, cooldown_until, cooldown_reason, backoff_level, next_probe_at, success_count, fail_count, last_error, last_used_at, source, disabled_by, created_at, updated_at)`，`unique(service, fingerprint)`。
- 新表 `pool_events(id, service, member_kind, member_id, outcome, from_status, to_status, reason, until, at)`，保留 30 天（复用现有 sweeper 框架清理）。
- **停用来源 `disabled_by`（admin|system）**：今后管理员路径（`admin/accounts.ts` PATCH、`health.manualDisable` 的 admin 调用）写 `admin`；策略层不再写 disabled。原 `refresh.ts disableOnFailure`、scheduler AEAD 隔离、`grokOAuth` 终态、`internalGrokRelay` 等系统路径改为 decide(auth_invalid / credential_corrupt) → cooldown。
- **来源写入原子化**：管理员停用在**同一条 UPDATE** 里写 `status='disabled', disabled_by='admin'`（不依赖事后审计写入是否成功）；管理员启用清 `disabled_by`。
- **存量不自动恢复**：现有 `disabled` 行无法可靠证明来源（admin_audit 为事后 best-effort 写入、告警 outbox 已清空），一律回填 `disabled_by='admin'` 保持停用，不转探测（含 claude #23）。是否把 #23 交给自动探测由用户作为管理员在后台一次性决定（后台“交给自动恢复”= 管理员启用后进入策略层，属于管理员意图）。今后系统路径不再写 disabled，因此不会再新增需人工处理的停用。

## 3. 各池适配器接入点（只改“上报 outcome + 调 select”，不改业务）
| 池 | 选号接入 | outcome 上报 |
|---|---|---|
| claude | `AccountScheduler.pick` 内部改用 policy.select；新增 API-key tier（`makeAnthropicKeyUpstream`，x-api-key） | `core.ts` 非 2xx 分支带 status/headers 给 `release`；`refresh.ts` 失败→auth_invalid；AEAD→credential_corrupt |
| codex | 绑定 picker 用 policy.select（带健康/配额/冷却）；relay 凭证用同一 select | `internalCodexRelay.ts` 上游状态→outcome；usage_limit→quota |
| grok | 已走 pick | `internalGrokRelay.ts` 401/402/403/429 改走 classify |
| box | `boxProfileScheduler` 排序改用 policy.select（保留 default-first、利用率阈值作为资格过滤）；`cursorAccountSelection` 同 | `boxProfileHealth` bench → decide；`cursorExternal` 401 内存冷却改为持久 decide |
| 静态 provider | `pickUpstream` static 分支改为 `pool.select(service)`，多 key + before_first_byte 切换；**配置权威同步改为池**：`validateUpstreamConfig()` 与启动 `assertPlatformDefaultModelConfigured()` 改问 `poolConfigured(service)`（env key 或池内存在非 admin 停用成员；池快照 30s 缓存，启动时先导入 env 成员再校验）；`staticProviderKeys` 仅作 env 导入源 | core.ts 非 2xx → outcome；Moonshot quota circuit 归并为 quota_exhausted |
| gemini | 见 §6 待定 | — |

`ReleaseResult` 扩展为携带 `outcome`（向后兼容：旧 kind 映射为 outcome）。

## 4. 管理后台
新页「服务池」（`admin/pages/pools/`）：每服务一张卡（池），成员表列：类型（订阅/API key）、标签、状态、冷却原因+剩余、下次探测、health、配额、最近错误；操作：添加 API key、管理员停用/启用、立即探测。现有「账号」「账号分组」页保留不改。API：`GET /api/admin/pools`、`POST /api/admin/pools/:service/keys`、`PATCH /api/admin/pools/keys/:id`、`POST /api/admin/pools/:service/members/:kind/:id/probe`（全部 admin 鉴权、审计）。

## 5. 计费
不改定价与扣费口径；claude API-key tier 与订阅号走同一 finalize/billing。canary 后对账：usage_records 与余额流水一致。

## 6. Gemini / Antigravity（用户 2026-10-14 决定：本票先建池，中继另开票）
本票建 `gemini` 池（`pool_api_keys(service=gemini)`：后台可添加 key、健康/探测走共享策略，探测用 `GET /v1beta/models`）。Antigravity 中继 `/internal/v5/antigravity-relay` 另开票实现，届时其选 key 直接调用 `pool.select('gemini')`；本票不改 antigravity adapter（保持 fail-closed）。

## 7. 分期与验证
- A：policy 层（outcome/decide/select/recovery/registry）+ 迁移 0305 + claude/grok/codex 订阅接入 + 消除系统 disabled。单测：decide 全表、select 分层/粘性/陈旧配额、recovery 探测退避；integ：0305 迁移、health 兼容。
- B：pool_api_keys + 静态 provider 多 key + claude API-key tier + codex relay + box/cursor 接入。
- C：管理后台「服务池」页 + API；浏览器用例。
- D：Gemini 池（中继另开票）。
- 发布前：Codex 审查（≤3 轮）、托管 CI 绿、迁移人工 apply；发布后 cc2+Haiku 真聊 4 轮 + 扣费对账 + 后台前后截图。
