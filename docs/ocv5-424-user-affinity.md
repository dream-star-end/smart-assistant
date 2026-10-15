# OCV5-424 设计：用户级账号亲和（个人版 feat/v5-selfhost）

用户原话：「为什么是轮换着用账号，同一账号的请求不应该聚合到单一账号下吗？」「不只是同一对话吧，应该是同一用户的所有会话吧？调度策略要考虑缓存利用策略和风控」。

## 1. 现状（feat/v5-selfhost @ eaac727fb）

| 服务池 | 选号依据 | 持久绑定 | 结论 |
|---|---|---|---|
| gemini（Antigravity 订阅账号） | `pickAntigravityAccount`：active → 健康 → **最久未用** | 无（只有单轮 route token） | **逐轮轮换**（本次问题） |
| claude（订阅账号） | 会话钉住 `chat_session_account_pin`（enforce）；新会话 WRH，偏好该用户用过的账号 | 按会话，持久 | 会话内不换号；同一用户的新会话可能换号 |
| codex（OAuth） | `agent_containers.codex_account_id` | 按容器（个人版一用户一容器） | 已是按用户 |
| codex（中转 key） | `relay-group:<id>` 固定排序 | — | 全组固定首选，不轮换 |
| grok | WRH(sessionId) | 无 | 只靠哈希，候选或权重变化就漂移 |
| cursor | 内存 15 分钟按用户 | 无（重启丢） | 过期或重启后随机 |
| box（Claude 登录） | 内存 24h 按 CLI 会话；新会话 `pickBoxProfile(affinityKey=uid)` | 无 | 重启丢 |
| API key 池 | WRH(sessionId 或 u:userId) | 无 | 只靠哈希 |

现网规模：近 7 天 2 个活跃用户；每个池 1–2 个可用成员。设计按可扩展的规模写，默认值按现网取。

## 2. 目标

1. **粘性键 = (服务池, 用户)**：同一用户在一个服务池里的所有会话固定到同一成员（订阅账号或 API key），每个服务池各自一个绑定。
2. 只有**没有绑定**（新用户、绑定过期）时才选新成员；选法是**按负载分配**，不是逐轮按最久未用。
3. 只有绑定成员**持续不可用**时才迁移；迁移后新成员成为新的粘性目标；原成员恢复后不自动迁回。
4. 暂时不可用（短冷却、并发槽满、单个模型冷却）时**本次溢出**到其他成员，**不改绑定**，冷却过去自动回到原成员。

## 3. 为什么按用户而不只按会话

- **缓存**：上游前缀缓存按账号（组织）隔离。同一用户跨会话重复大量相同前缀（系统提示、工具定义、项目上下文、记忆），落在同一账号才能命中；按会话轮换每次新会话都冷启动缓存。
- **风控**：一个用户的流量表现为一个账号的连贯使用，最接近正常个人使用；账号上的「不同用户数」可控（§6）。逐轮轮换会让每个账号都出现所有用户的交错请求。
- **Antigravity**：CLI 的对话轨迹与部分服务端状态可能绑定在 Google 账号上（OCV5-415 推测，未验证），中途换号有丢上下文风险。
- **会话层不废弃**：Claude 现有会话钉住保留「会话中途不换号」的防封语义；新会话改为从用户绑定取号。

## 4. 存储

新表 `pool_user_affinity`（迁移 0308，个人版）：

| 列 | 说明 |
|---|---|
| `service` TEXT, `user_id` BIGINT | 主键 |
| `member_kind` TEXT, `member_id` TEXT | 绑定目标（与 pool_events 同一套标识，无外键：成员分属多张表） |
| `bound_at`, `last_used_at`, `expires_at` | `expires_at = last_used_at + TTL`，每次成功使用续期 |
| `prev_member_id`, `migrated_at`, `migrate_reason`, `migrations_recent`, `migrations_window_start` | 迁移记录与防抖计数 |

- **TTL = 7 天无使用**。上游前缀缓存只有分钟到 1 小时级；绑定更长是为了跨天保持「同一用户 = 同一账号」（风控）并让会话间缓存在活跃期内命中。过期后下次按负载重新分配，借此自然再均衡。
- 续期写入节流：同一绑定 5 分钟内最多更新一次 `last_used_at`，避免每次请求写库。
- 不存任何凭据。成员被删除时读到悬空绑定按「持续不可用」迁移。

## 5. 选号流程（共享：`policy/affinity.ts`）

各池先算出**本次候选**（该池已有规则：可调度状态、组、模型、并发槽），再交给共享函数：

```
resolve(service, userId, candidates, memberState) →
  1. 读绑定 B（未过期）
  2. B ∈ 候选                         → 用 B，续期                                   [stay]
  3. B 暂时不可用（短冷却 ≤30min / 并发满 / 本模型冷却）
       → 本次从候选按负载选 X，绑定不变                                          [spill]
  4. B 持续不可用（长冷却 >30min、配额耗尽、认证/凭证冷却、停用/封禁、成员不存在）
       → 迁移：按负载选 X，写绑定 X（prev=B, reason），记 pool_events affinity_migrate  [migrate]
       → 若该用户近 10 分钟已迁移 ≥2 次：本次溢出，不改绑定（防抖）                    [spill]
  5. 无绑定 / 已过期 → 按负载选 X，写绑定，记 affinity_bind                           [bind]
  6. 候选为空 → 交还各池原有的「无可用成员」处理（不变）
```

**按负载选**：在候选里选「当前有效绑定用户数 ÷ 容量权重」最小者；容量权重沿用共享策略的健康/额度权重（`select.healthWeight`、额度余量），订阅成员可按计划加权；并列再按最久未用。效果：新用户均匀铺到各账号，而不是每轮换号。

「暂时 / 持续」的分界与会话钉住一致（`isLongCooldownForPin`：认证/凭证冷却或冷却 >30 分钟视为持续）。

## 6. 风控

| 风险 | 措施 |
|---|---|
| 单账号上出现大量不同用户 | 每成员**绑定用户上限**（`pool.affinity.max_users_per_member`，订阅账号默认 8，API key 不限）。达上限的成员不接新绑定（已有不动）；全部达上限时仍选最少者（不拒绝服务）并记一条 `affinity_over_cap` 事件 |
| 单账号并发 / 速率 | 沿用各池已有并发槽与 429 冷却；粘性不突破：槽满 → 本次溢出（不迁移） |
| 迁移抖动 | 只有「持续不可用」才迁移；迁移后不迁回；每用户每服务 10 分钟内最多迁移 2 次，超过则只溢出 |
| 冷却 / 额度耗尽 | 短冷却溢出、冷却过后回到原账号（保缓存）；额度耗尽、长冷却 → 平滑迁移到最空的账号 |
| 负载不均 | 新绑定按「最少绑定用户」分配；绑定 7 天无使用过期后重新分配；不做为均衡而打断缓存的强制迁移 |
| 订阅账号同请求换号（防封） | 不变：订阅池遇 429 不在同一请求内换号 |

## 7. 各池接入（只在「选号」处接入，不改业务）

| 服务池 | 接入点 | 说明 |
|---|---|---|
| gemini（Antigravity） | `admitAntigravityTurn` → `pickAntigravityAccount` | 本模型冷却 = 暂时不可用（溢出）；userId 已有 |
| claude | 会话钉住**缺失**时（新会话 / force_repin） | 用用户绑定作为首选，替代「偏好用过的账号」启发式；会话内仍由钉住保证不换号 |
| grok | `allocateGrokRelayRoute` | WRH(sessionId) → 用户绑定 |
| API key 池 | `selectApiKey` | WRH(session/user) → 用户绑定；provider 5xx 不计 key 罚分的规则不变 |
| cursor | `selectCursorAccount` | 内存 15 分钟 → 持久用户绑定（内存缓存只做读加速） |
| box（Claude 登录） | 新会话 `pickBoxProfile` | 会话内仍按 CLI 会话粘；新会话从用户绑定取 |
| codex OAuth | 不改 | 已按容器（= 用户）持久绑定 |
| codex 中转 key | 不改 | 全组固定首选 |

## 8. 观测

- `pool_events`：`affinity_bind` / `affinity_migrate`（reason）/ `affinity_over_cap`；溢出只计数不逐条写（量大），在服务池页显示。
- 服务池页每个成员显示「绑定用户数」。

## 9. 验证

- 单测：resolve 的 stay / spill / migrate / bind / 防抖 / 上限 / 过期续期。
- 集成（真 PG）：各池接入点的绑定写入与迁移。
- 现网：uid 3 Antigravity 多轮真聊（同一会话多轮 + 新开会话），全部落在同一账号；`antigravity_relay_usage.cached_tokens` 在第 2 轮起明显命中；对账 relay = usage = ledger。
