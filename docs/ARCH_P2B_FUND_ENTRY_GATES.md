# P2b 资金与入口两道门：设计与证据矩阵（草稿 r1）

> 第三阶段方案 v3.6 §4.2、§4.3、§9.4 P2b。本文件只加文档和测试，不改任何产品行为。
> 源码基准：feat/v5-selfhost@86bb79885（个人版）。下文路径相对 `packages/commercial/src/`，另有说明的除外。
> 状态：**设计草稿，待评审**。P2b 退出标准（设计批准 + 四条资金路径原子性测试全绿 + 全部入口冻结测试全绿）本 PR **未达成**；本 PR 交付设计、证据矩阵、隔离审计和第一批冻结测试，缺口逐条列在 §3、§6。

## 0. 结论先行

- 四条资金路径今天都是**单个 PG 本地事务**（`db/queries.ts:39-58` 的 `tx()` 或自开连接 `BEGIN`），READ COMMITTED，行锁 `FOR UPDATE` + 咨询锁串行化。按 §4.3「不改成 saga、保持原子」，本阶段不改写路径。
- 全局锁序（代码注释 `billing/subscription.ts:327-331`、`billing/refund.ts:265-266`）：**orgs → org_subscriptions → users → user_subscriptions**。各路径实测与之一致（§1 表）。
- 余额非负**只靠应用层**：`users.credits`（`db/migrations/0001_*.sql:22`）、`orgs.credits`（`0111_init_orgs.sql:30`）无 CHECK；只有 `period_credits` 有（`0096:65`、`0115:65`）。
- 入口：商业 300 条 HTTP 路由鉴权全部在处理器内（`Route` 类型无 auth 字段，`http/router.ts:677-689`），唯一路由级门是 `/api/admin/*` 的 `requireAdminVerifyDb`（`router.ts:2278-2282`）；WS 升级路径实为 **8 条**（方案写 6 条，本文更正）；个人 gateway `verifyJwt` 不读头部 alg、exp 可选（`gateway/src/auth.ts:59-77`），已由本 PR 冻结测试钉住。

## 1. 资金四路径证据矩阵

| 路径 | 事务归属（谁开 tx） | 锁序（实测） | 幂等键与执行方式 | 回滚测试 (a) | 幂等测试 (b) | 并发测试 (c) | 缺口编号 |
|---|---|---|---|---|---|---|---|
| ① 订单履约 | `markOrderPaid` → `tx()`（`payment/orders.ts:997`），client 传给 `fulfillPaidOrderTx` 及 topup/org/subscription/provision 各 `*Tx`（`orders.ts:917-987`） | orders → users \| orgs \| user_subscriptions \| users→user_subscriptions（`orders.ts:999,801,837`；`subscription.ts:261,343,350,405`；`org/orgProvision.ts:66`） | `orders.order_no` UNIQUE（`0003_init_payment.sql:7`）+ `FOR UPDATE` 下状态 CAS：已 paid 直接返回、非 pending 抛 `InvalidOrderStateError`（`orders.ts:1005-1010`） | 仅“写前校验失败”：`payment.integ.test.ts:444/481/506`、`orgBilling.test.ts:520`、`orgProvisionBilling.test.ts:402` | `orders.integ.test.ts:256`、`payment.integ.test.ts:407`、`orgBilling.test.ts:486`、`orgProvisionBilling.test.ts:242` | `orders.integ.test.ts:321`（同单并发 2 次只加一次） | F5、F7、T1、T2 |
| ② 其它加款（管理员调账、组织调账、免费订阅发放、订阅续期） | `adminAdjust` `tx()`（`billing/ledger.ts:128-201`）；`adjustOrgCredits` `tx()`（`admin/orgs.ts:228-275`）；`ensureFreeSubscription`（`subscription.ts:174+`）；`rolloverExpiredSubscriptions`（`subscription.ts:457-489`） | users 或 orgs `FOR UPDATE`（`ledger.ts:146`、`admin/orgs.ts:234`）；续期 user_subscriptions `FOR UPDATE SKIP LOCKED` | 管理员/组织调账：**无**；免费发放：`user_subscriptions.user_id` UNIQUE（`0096:58`）+ `ON CONFLICT DO NOTHING`；续期：行认领 | `ledger.integ.test.ts:183`（结果为负整事务回滚，无账本/审计行）、`orgBilling.test.ts:583` | 仅 `subscriptionBilling.integ.test.ts:84`（免费发放，串行） | 无 | F1、F2、T3 |
| ③ 退款（回合豁免） | `applyTurnWaiver` 自开连接 `BEGIN`…`COMMIT`（`billing/refund.ts:219-221,539`）；同一事务写账本、余额、收件箱回执、`turn_waivers`、`client_sessions` | 咨询锁 turn-billing（`refund.ts:222`，`billing/turnLock.ts:30`）→ `turn_waivers` FOR UPDATE（`:166-172`）→ lineage 咨询锁（`:242`）→ orgs（按 id 排序，`:285`）→ org_subscriptions → users → user_subscriptions | `turn_waivers` UNIQUE(user_id, turn_key)（`0167:91`）+ `status='applied'` 早返回 + 终态 CAS `WHERE status='pending'`（`:516`）；逐 usage 去重是 `NOT EXISTS`（`:259-263`），**无唯一索引兜底** | `refund_org_bucket.test.ts:447`（**内存假池**，非真 PG） | `refund_org_bucket.test.ts:426`、`turnWaiver.integ.test.ts:193` | `turnWaiver.integ.test.ts:328`、`:438` | F4、T4 |
| ④ 扣费结算（主对话回合） | `settleUsageAndLedger` 自开连接 `BEGIN`…`COMMIT`（`billing/proxyBilling.ts:820-823,1023`）；`spendTwoBucket(client)` 不开事务（`billing/spend.ts:186`） | turn-billing 咨询锁（子、父键排序，`turnLock.ts:27-33`）→ `usage_records` INSERT（唯一约束）→ orgs → org_subscriptions → users → user_subscriptions（`spend.ts:200,216,247,256`）→ `user_api_keys`（`proxyBilling.ts:999`） | `usage_records` `uniq_ur_user_request` UNIQUE(user_id, request_id)（`0009_chat_idempotency.sql:29`）；23505 回滚后回读返回 `existing`（`proxyBilling.ts:933-963`）；COMMIT 报错时回读判定，仍不明抛 `SettlementCommitOutcomeUnknownError`（`:1031-1062`） | `settleUsage.integ.test.ts:549`（locator 冲突时 usage 与扣款一起回滚） | `settleUsage.integ.test.ts:590`、`settleUsageConcurrent.integ.test.ts:176` | 只有同 request 并发；余额截断只有串行（`settleUsage.integ.test.ts:642`、`orgBilling.test.ts:286`、`preCheckCap.integ.test.ts:180` 内存 Redis） | F1、F3、F6、T5 |

其它调用 `settleUsageAndLedger` 的结算变体（同一事务形状，不单列）：`codexFinalizer.ts:303`、`zcodeCatalogSettle.ts:139`、`cursorExternalSettle.ts:337`、`antigravitySettle.ts:139`、`boxBillingRecovery.ts:142`、`plugins/knowledgePlanetAutomationScheduler.ts:849`。自带事务并调用 `spendTwoBucket` 的：`imageBilling.ts:273-318`、`minimax/mediaBilling.ts:44-117`。试点只取主对话回合一条结算路径（§9.4），这些变体留在 P6 逐个对照。

不属于资金的相邻写入（核对后排除）：`dispatch/turnDispatchStore.ts:217-221` 只锁派发行；`http/internalTurnObservation.ts:111-138` 单条 CTE 写 `turn_runtime_observations` + `turn_traces`，单语句原子，不动钱。

## 2. 不变量（每条路径的验收口径）

对四条路径统一要求，测试按这几条写：

1. **全有或全无**：同一工作单元内的余额列、`credit_ledger` 行、业务行（orders / usage_records / turn_waivers）要么一起提交，要么一起不存在。
2. **账实相符**：每条账本行的 `balance_after` 等于写这条流水时该桶的余额，同一桶在本工作单元内的流水 `delta` 之和等于该桶的净变化，最后一条的 `balance_after` 等于提交后的余额。一个桶可能有多条流水，例如订阅发放在旧余额和新额度都大于零时，先写一条清零、再写一条发放（`billing/subscription.ts:275,288`）。
3. **幂等**：同一幂等键重复请求（顺序或并发）只产生一次余额变化与一组账本行，第二次返回与第一次一致的结果。
4. **余额非负**：扣费路径任何并发交错下 `users.credits`、`orgs.credits`、`period_credits` 不为负（今天靠 `spend.ts:277-291` 截断 + 行锁；截断差额记 `clamped`，不追收）。
5. **锁序**：按 orgs → org_subscriptions → users → user_subscriptions；订单路径以 orders 行打头，退款/结算以咨询锁打头。
6. **事务内无外部副作用**：HTTP、WebSocket 推送、Redis 释放都在 COMMIT 之后（今天满足：`http/payment.ts:228` 下单在 INSERT 提交后；`internalTurnWaive.ts:238-247` 推送在提交后且只在 `newlyApplied`；`proxyBilling.ts:646,662` 释放在事务返回后）。例外见 F5。

## 3. 已发现缺口（只登记，本阶段不改行为）

每条都有可触发的具体场景；是否修、怎么修由评审定，修复走单独的行为 PR（带红绿证明）。

| 编号 | 缺口 | 证据 | 触发场景 | 建议 |
|---|---|---|---|---|
| F1 | 余额列无 DB 级非负约束 | `0001:22`、`0111:30` | 任一新写入点绕过 `spend.ts:278` / `ledger.ts:154` / `admin/orgs.ts:236` 的应用层检查 | 先加 `NOT VALID` CHECK 观测，单独 PR；不在 P2b |
| F2 | 管理员/组织调账无幂等键 | `ledger.ts:128-201`、`admin/orgs.ts:228` | 管理端提交超时后重试，同一笔调账记两次 | 管理端请求带 `Idempotency-Key`，账本加部分唯一索引；单独 PR |
| F3 | 账本请求唯一索引对现行扣费不生效 | `0009:18-20` 只覆盖 `ref_type='request'`；现行扣费写 `ref_type='usage_record'`（`proxyBilling.ts:973`） | 结算幂等完全依赖 `uniq_ur_user_request`；若将来有路径只写账本不写 usage_records，就没有兜底 | 登记为事实；P6 搬 billing 时把索引条件与现行形态对齐 |
| F4 | 退款逐 usage 去重无唯一索引 | `refund.ts:256-263`（`turn_key=$2 OR parent_turn_key=$2` + `NOT EXISTS`）；咨询锁按 `input.turnKey`（`:222`），另有 lineage 锁（`:242`） | **已由 T4 证实（2026-10-26）**：按豁免路由的真实顺序（先提交 pending 围栏 `http/internalTurnWaive.ts:231`，再 `applyTurnWaiver`），父键与子键两个豁免并发时，同一条 100 积分的 usage 被退了 200。两边都已有 pending 行，不再 INSERT，所以不会触发 F8 的死锁；后到的一方等 users 行锁，拿到锁后用的是锁前读到的旧 debit 列表。路由只校验 turnKey 格式和容器身份，所以子键能进来；**gateway 实际会不会提交子键豁免未核实** | **已修（个人版，2026-10-26 管家批准）**：`applyTurnWaiver` 在 BEGIN 后先拿按用户的豁免咨询锁 `oc_waiver_user:<uid>`，再取 turn 锁、读 debit；同一用户的豁免串行，后到的一方在前一方提交之后才读 debit，`NOT EXISTS` 能看到已写的退款行。T4 去掉 todo 后转绿。**没有加 `credit_ledger` 退款唯一索引**，原因：退款行一笔源 debit 写一行，过期期内桶会退回钱包，所以同一 usage 可以合法地有两条 wallet 退款行（例如 period 和 wallet 各扣一次、且 period 已过期），按 `(ref_id, bucket)` 建唯一索引会拒掉这种合法退款；而 `usage_record` 退款行只有 `refund.ts` 一处写入，按用户的锁已覆盖全部写入方。若仍要库级兜底，可另建“usage 退款认领表”（usage_id 主键）。商业版另走同步批 |
| F5 | 持锁期间另取连接池连接 | `getPlan()` 走根池（`subscription.ts:109-115`），在事务内调用于 `orders.ts:956,969`、`subscription.ts:362,414`；`enqueueAlert` 走池（`org/orgProvision.ts:80,117`） | 高并发履约时池耗尽而行锁不放；外层事务回滚但告警已提交 | 改为传 `client`；单独 PR |
| F6 | 请求日志（journal）不在结算事务内 | `proxyBilling.ts:475`→`:305-319` 认领、`:555`→`:328-361` 终结，各自 autocommit；终结失败只记日志（`:563`） | 结算已提交、终结失败 → journal 停在 `finalizing`，靠对账器回收（本次未核对账器） | P2b 补核对账器覆盖；不改 |
| F7 | 过期/取消订单的支付回调回“success”且不加款 | `http/payment.ts:~470-486`、`orders.ts:1010` | 用户在订单过期后完成支付：钱到账、积分未到，靠告警人工处理 | 产品决策项，登记不改 |
| F8 | 同一用户并发扣费/豁免会死锁（40P01） | `usage_records.user_id`（`db/migrations/0002_init_billing.sql:56`）和 `turn_waivers.user_id`（`0167:78`）都外键引用 users：INSERT 先拿 users 行 `FOR KEY SHARE`，之后 `spend.ts:247` / `refund.ts:321` 要同一行 `FOR UPDATE`，两笔并发都卡在升级上 | T5 复现：同一用户 8 笔不同 request 并发结算，2026-10-26 一次运行里 7 笔被 PG 判死锁中止、只提交 1 笔。中止的那笔整体回滚，余额和流水仍一致，但这一笔没扣上费、没留 usage 行。个人版近 15 天日志里结算死锁 0 次（只有 2 次 tapeJobScheduler 的）；商业版没查（本线不碰 kl-mirror） | **已修（个人版，2026-10-26 管家批准）**：新增 `billing/spend.ts` `lockSpendRows`，作为 orgs → org_subscriptions → users 三步取锁的唯一实现；`spendTwoBucket` 改为调用它，`settleUsageAndLedger` 在 INSERT usage_records 之前（仅在要扣费时）先调一次。登记的锁序不变，INSERT 时已持有更强的 users 锁。T5 收紧为 8 笔全部成功。没有加 40P01 重试，因为根因已消除。豁免侧由 F4 的按用户锁串行；`imageBilling`、`minimax/mediaBilling` 自带事务的变体没改（不在试点链路），P6 时对照。商业版另批 |

## 4. 目标规则（§4.3 落地，到试点/P6 才执行）

- 工作单元由 L4 持有：`app/settlement`、`app/payment` 用 `withTx` 开事务，把同一个 `tx` 传给各领域 store；store 不得自开事务或取池连接（F5 是现存反例，进违规清单）。
- 列级归属：`users.credits`、`orgs.credits`、`*.period_credits` 归 `billing`，只有 `billing/store` 写（`arch/modules.json` 已有 `R3-billing-sql` 规则，基线见 `arch/violations-baseline.json`）。
- 锁序登记：每个工作单元在 `arch/` 下登记 §1 表的锁序；护栏先报告。
- 不改成 saga；不拆钱包表（另案）。

## 5. 测试隔离审计（资金写路径测试先审隔离）

v5-dev 实测（2026-10-26 08:15Z，`ss -ltnp` 只读）：

| 资源 | 测试默认 | 实际占用 | 生产 | 隔离判断 |
|---|---|---|---|---|
| PostgreSQL | `TEST_DATABASE_URL` 默认 `postgres://test:test@127.0.0.1:55432/openclaude_test`（各测试文件、`__tests__/helpers/db.ts:95-96`、`.github/scripts/commercial-integ-gate.sh:121`） | 55432 = `postgresql@16-octest.service`（独立测试集群） | 5432（另一集群） | 清库 `resetTestSchemaForTest` 只在库名以 `_test` 结尾时执行（`helpers/db.ts:79-81`）；内联清库同样有守卫（`settleUsageConcurrent.integ.test.ts:52-64`、`turnWaiver.integ.test.ts:17-28`）。**隔离成立** |
| Redis | `TEST_REDIS_URL` 默认 `redis://127.0.0.1:56379/0`（`payment.integ.test.ts:39`、`commercial-integ-gate.sh:122`） | 56379 = 容器 `octest-redis` | 127.0.0.1:6379 = 系统 `redis-server.service` | `payment.integ.test.ts:119,142` **无守卫地 `flushdb`**：只要有人把 `TEST_REDIS_URL` 指到 6379 就会清生产 Redis。本 PR 加守卫（§6 B3） |
| 其它 | `preCheckCap.integ.test.ts:22` 用内存 Redis；`refund_org_bucket.test.ts:83` 用内存假池 | — | — | 不触外部资源 |

集成测试串行跑在测试锁下（根 `package.json:44` `--test-concurrency=1` + `scripts/test-mutex.sh`）。

## 6. 入口策略登记（§4.2 第 1 条）与冻结测试（第 2 条）

### 6.1 鉴权机制目录

| 校验器 | alg | exp | 必需 claims | 实时查库 | 用途隔离 | 撤权 | 失败 |
|---|---|---|---|---|---|---|---|
| `verifyAccess`（`auth/jwt.ts:118-165`，经 `requireAuth` `http/auth.ts:31-49`） | jose 限 HS256（`jwt.ts:129-130`） | 必需（`:152`） | sub、role∈{user,admin}、iat、jti | 无 | 无 aud/iss/typ | access 无（TTL 15 分钟，`jwt.ts:20`）；只撤 refresh | 401 |
| `verifyCommercialJwtSync`（`auth/jwtSync.ts:29-74,117-180`）及 gateway 副本（`gateway/src/gatewayHttp.ts:642-680`） | 头部 `alg!=='HS256'` 拒（`jwtSync.ts:43-48`、`gatewayHttp.ts:658`） | 必需 | sub、role | 无 | 无 | 无 | null，调用方决定 |
| **gateway 个人版 `verifyJwt`**（`gateway/src/auth.ts:59-77`） | **不读头部** | **可选**（`:72` 真值判断：缺失、0 均跳过） | 无（不查 userId） | 无 | 无；HMAC 密钥即原始 bearer `accessToken`（`checkToken` `:7-15`） | 无；TTL 30 天（`gateway/src/server.ts:364`） | 401 |
| `requireAdmin`（`admin/requireAdmin.ts:31-40`） | 同 requireAuth | 同 | role=admin | **无** | — | — | 403 |
| `requireAdminVerifyDb`（`requireAdmin.ts:55-76`） | 同 | 同 | role=admin | 有（role+status；DB 错误抛出 → 500，fail-closed） | — | 实时 | 403 |
| `requireUserVerifyDb` / `requireActiveAccountVerifyDb`（`http/requireUser.ts:27-79`） | — | — | — | 有 | — | 实时 | 403 |
| 容器身份（`auth/containerIdentity.ts:202-240`） | 不透明 `oc-v3.<cid>.<secret>` | 无 | (host_uuid, bound_ip) 活跃行 + cid 相等 + secret 哈希定时比较 | 容器行 `state='active'`；**不查 users.status** | 独立格式 | 容器非 active / 轮换 secret | 401 |
| 桌面身份（`auth/desktopIdentity.ts:90-150`） | mTLS + oc-v3 | `session_secret_expires_at` | 多因子 | 有 | 独立 | 设备撤销、kill switch | 401 |
| API key（`auth/apiKeyIdentity.ts:165-280`） | `oc-cc.` | 无 | UA、前缀行未撤销、哈希、未禁用；仅管理员 | 有 | 独立 | revoked_at / disabled_at | 401 `API_KEY_INVALID` |
| egress 共享密钥 `x-oc-egress-secret`（`http/internalCostEvent.ts:92-99`、`index.ts:3139-3149`） | — | — | 定时比较 | — | — | — | 401 / 503 |
| 其它自带方案 | 虎皮椒 MD5 签名（`payment/hupijiao/sign.ts:89-104`）；selfheal capability/webhook HMAC（`http/internal/selfhealRepairs.ts:6-26`）；Muse bridge token（`muse/bridgeHttp.ts:105-137`）；gateway local-bridge token（仅回环，`gateway/src/localBridgeAuth.ts:46-62`）；gateway 可信 bridge IP 旁路（`gateway/src/server.ts:1113-1125`） | | | | | | |

### 6.2 入口类别登记

| 入口类别 | 数量 | 校验器 | 实时查库 | Origin/CSRF | 已有冻结测试 | 缺口 |
|---|---|---|---|---|---|---|
| 商业 `/api/admin/*` | 171 | 路由级 `requireAdminVerifyDb`（`router.ts:2278`；`GET /api/admin/metrics` 自鉴权，`:663`） | 有 | Bearer，无 cookie | `adminRouteGate.integ.test.ts`（401/403/降权 `:199`/封禁 `:207`） | DB 读失败无测试 |
| 商业用户路由，仅 JWT | 73 | `requireAuth`→`verifyAccess` | **无**：封禁/降权后旧令牌最长 15 分钟有效 | Bearer | `http.integ.test.ts:326`（过期） | 封禁、降权无测试 |
| 商业路由带查库 | 6 + 2 + 11 | requireAuth + 活跃查库，或同步 JWT + 查库 | 有 | media 签名 URL | `mediaSignAuth.test.ts` | — |
| `/api/me/api-keys*` | 7 | `requireAuth` + `http/apiKeyAdmin.ts:108-116` 本地 `requireAdmin`（仅 JWT 角色，路由 `router.ts:786-795`） | **无** | Bearer | 无 | 降权管理员 15 分钟内仍可管理 API key |
| 公开/自鉴权（注册登录、OAuth、桌面引导、支付回调、selfheal、Muse） | 24 + 6 | 无，或签名/HMAC/capability/bridge token | 支付回调核对订单与金额（`http/payment.ts:381-389`） | OAuth state cookie | `login.integ.test.ts`（封禁 `:543`、封禁后 refresh `:673`） | 公开路由未登记负责人/理由/到期日（§4.1 要求） |
| WebSocket 升级 | **8** | 见 6.3 | 部分 | 仅 container-preview 校验 | `containerPreviewBridge.test.ts:126`、`voiceTranscribe` 缺令牌 `:125` | 见 6.3 |
| 容器内部 RPC（`INTERNAL_ROUTES`） | 71 | 各处理器自调 `verifyContainerIdentity`；cost-event、lease-callback 用共享密钥 | 容器 active；**不查属主用户状态** | — | `containerIdentity.test.ts:399,410,421`（跨用途双向） | 无中心登记“哪个校验器”；split 模式信任回环客户端给的 `x-v5-egress-peer-ip`（secret 仍是第二因子） |
| gateway HTTP（个人） | `gateway/src/routes/*` | `checkHttpAuth`：`verifyJwt` / 商业同步 JWT / 原始 token；bridge 旁路；local-bridge token | 无 | cookie `SameSite=Strict; Path=/api/`（`gatewayHttp.ts:544`） | 本 PR `authJwtFreeze.test.ts` | 见 6.1 |
| egress 与其它监听 | ~10 | 见下 | — | — | `egressSplit.test.ts` | `egress-health`/`egress-stats` 无鉴权（`egress/main.ts:819-860`，只读）；ChatGPT 代理默认绑 0.0.0.0（Basic，查库，`chatgptProxy/server.ts:94,162-170`） |

### 6.3 WebSocket 升级路径（8 条；方案 §4.2 写 6 条，更正）

| # | 路径 | 令牌 → 校验器 | 查库 | Origin | 失败 |
|---|---|---|---|---|---|
| 1 | `/ws/user-chat-bridge`（`ws/userChatBridge.ts:2511-2625`） | 子协议 `bearer,<jwt>` 或 Authorization → `verifyAccess` | `SELECT status`；**DB 错误 fail-open**（`:2620-2624`，注释 `:2606-2608` 写明是可用性取舍），**行不存在放行**（`:2616`） | 无 | 升级后 error 帧 + close 1008 |
| 2 | `/ws/voice-transcribe`（`ws/voiceTranscribe.ts:852-893`） | 同上 → `verifyAccess` | **无** | 无 | error 帧 + close |
| 3 | `/ws/container-preview` 公网（`ws/containerPreviewBridge.ts:96-140`） | 一次性 ticket（由查库路由签发，`router.ts:851`） | 间接 | **有**（`:102`） | 升级前 403/401/409/503 |
| 4 | Quick Tunnel 主机任意路径（`ws/directContainerPreview.ts:353-389`） | 预览 cookie 哈希 | 内存记录 | 无（Host 作用域 cookie） | 升级前 401/429/400 |
| 5 | `/ws/desktop-container-register`（`http/desktopTlsListener.ts:120-133`、`ws/desktopRegister.ts:95-110`） | mTLS + 桌面身份 | 有 | n/a | 401/404 |
| 6 | gateway `/ws/container-preview` 内部（`gateway/src/containerPreview.ts:345-380`） | 源 IP = bridge IP + master 签名断言 + 防重放 | — | 无 | 401/409/503 |
| 7 | gateway `/__oc_preview_proxy`（`containerPreview.ts:327-343`） | 同 #6 | — | 无 | 401/503 |
| 8 | gateway `/ws`（`gateway/src/gatewayLifecycle.ts:467-470`、`wsConnection.ts:139-146`） | bridge IP / local-bridge token / `checkHttpAuth` | 无 | 无（cookie Path=/api/ 不随 /ws 发送） | close 1008 |

### 6.4 §4.2 冻结用例覆盖

| 用例 | 现状 | 本 PR |
|---|---|---|
| 降权后旧令牌 | 仅 `/api/admin/*` 有（`adminRouteGate.integ.test.ts:199`、`blockedForUser.integ.test.ts:382`） | B4 已补（`p2bEntryFreeze.test.ts`）：共享的 `requireAdmin` 只信 JWT、不读库（冻结为已知缺口）。`/api/me/api-keys*` 用的不是它，而是 `http/apiKeyAdmin.ts:108-116` 里的本地 `requireAdmin`：`requireAuth` 之后只看 JWT 角色，同样不读库，本批未单独冻结；`requireAdminVerifyDb` 降权、封禁、删号拒绝，活跃放行。73 条仅 JWT 用户路由的“封禁后 15 分钟内仍有效”属于同一机制（`verifyAccess` 不查库），不逐条复制 |
| 封禁账户 | admin、login、refresh 有；WS bridge 无（桩永远返回 active，`userChatBridge.test.ts:919,2851`） | B5 已补（`userChatBridge.test.ts` “P2b entry freeze”）：banned → close 1008 `account inactive` 且不连容器；缺行放行（已知缺口） |
| 跨用途令牌 | 容器 token ↔ 用户 JWT 双向有（`containerIdentity.test.ts:399-421`） | B6 已补：个人 gateway JWT（`{userId,exp}`，同密钥）被 `verifyAccess` 拒；API key 被容器 token 解析器和 `verifyAccess` 拒 |
| 过期令牌 | `jwt.test.ts:42`、`jwtSync.test.ts:144`、`http.integ.test.ts:326` | gateway `verifyJwt` 已补（B1） |
| DB 读失败 | 无（`requireAdminVerifyDb` fail-closed、bridge fail-open，均无测试） | B7 已补：`requireAdminVerifyDb` DB 报错 → 拒绝（fail-closed）；bridge 状态查询报错 → 放行（fail-open，冻结为已知缺口） |
| 错误 Origin | 仅 `containerPreviewBridge.test.ts:126` | B8 已补（按 2026-10-26 管家口径“冻结不查”）：`userChatBridge.test.ts` 用外站 Origin 加有效 bearer 子协议，照样连通，冻结为已知缺口。其余不查 Origin 的路径中，voice 与 bridge 同一机制（子协议 bearer），#4–#8 靠 cookie 作用域、mTLS 或源 IP 断言；改成强制校验 Origin 另开票 |
| gateway：无 exp 接受 / `exp:0` 接受 / `alg:none` 头 + 有效 HMAC 接受 / 标准空签名 `alg:none` 拒绝 | 无 | **已补**（B1，前三条标“P4b flips”） |

## 7. 交付批次与退出

| 批 | 内容 | 状态 |
|---|---|---|
| B1 | `packages/gateway/src/__tests__/authJwtFreeze.test.ts`：gateway `verifyJwt` 10 条冻结用例 | 本 PR，本地 10/10 |
| B2 | 本文件：资金证据矩阵、缺口、隔离审计、入口登记 | 本 PR，待评审 |
| B3 | `payment.integ.test.ts` 清 Redis 前拒绝 6379（§5 隔离缺口） | 本 PR |
| T1–T5 | 资金原子性测试：T1 订单写到 orders→paid 时注入故障，整体回滚（`orders.integ.test.ts`）；T2 过期器与回调并发，两种结局都观察到（同上）；T3 管理员调账并发正/负，以及冻结 F2“重复提交记两次”（`ledger.integ.test.ts`）；T4 父子键并发豁免（`turnWaiver.integ.test.ts`，证实 F4；F4 修复后绿）；T5 同一用户不同 request 并发扣费（`settleUsageConcurrent.integ.test.ts`；F8 修复后要求全部成功） | T1/T2/T3/T5 绿；T4 在 F4 修复后转绿 |
| B4–B7 | 入口冻结测试补缺（见 6.4） | `p2bEntryFreeze.test.ts` 7 条 + `userChatBridge.test.ts` 3 条 |
| B8 | Origin“冻结不查”（bridge） | `userChatBridge.test.ts` 1 条 |
| 登记表入库 | 把 6.2/6.3 落成机器可读的 `arch/entry-registry.json`（每条路由：校验器、查库、Origin、失败行为、负责人），配生成与 `--check` | 后续 PR（护栏变更单独 PR） |

P2b 退出 = 本设计评审批准 + T1–T5 全绿 + B1/B4–B8 全绿。F4 修复后 T4 已绿。在此之前试点计费部分只读观测（§9.4）。
