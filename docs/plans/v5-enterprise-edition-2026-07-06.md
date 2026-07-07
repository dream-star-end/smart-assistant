# v5 企业版(P3.1)方案定稿 — 2026-07-06

> 承接 `v5-enterprise-edition-kickoff.md`(开工骨架)。本文=四路取证(计费/身份/技能知识/隔离报表)后的架构定案+分批实施计划。
> 范围权威源 = `V5_ROADMAP_2026H2.md` P3.1:组织账号、成员管理、组织维度共享技能/知识库、用量报表、发票、组织钱包。
> **明确不含**:共享工作区/会话/容器(容器/卷/会话保持 per-user 零改动;kickoff"共享粒度决策题"的最重档不在本期)。

## 0. 粒度定案(kickoff 决策题的答案)

| 维度 | 本期做法 | 依据 |
|---|---|---|
| 共享额度 | ✅ org 钱包(第一优先桶)+ org 充值 | roadmap"组织钱包";spendTwoBucket 单点收口改造量可控 |
| 成员管理 | ✅ org/membership + 邀请 + 角色 | roadmap"成员管理" |
| 共享技能 | ✅ marketplace 单机制扩 org(listing org 可见性 + org-install → hub 层) | 零新增挂载、不动 runtime image、自带审核/撤回 |
| 共享知识库 | ⏸ **本期不做**(research_documents 租户主键 `(user_id,doc_id)` + 引用权威链要跨 user 重构,量级大) | 登记债,见 §8 |
| 共享记忆 | ❌ **永久不做** USER.md/MEMORY.md org 共享(隐私越界+横向 prompt-injection 放大面);组织背景走显式 org 技能 | 取证判断,写死 |
| 共享工作区/会话 | ❌ 不做(五处 -u\<uid\> 单人假设全部不动) | roadmap 未列 |
| org 订阅(期内桶) | ⏸ 本期只做 org **钱包**;org 订阅/企业套餐等 boss 定企业定价后再做(schema 预留扩展点,不建死表) | 无定价=不可测死代码;诚实登记 |
| 用量报表 | ✅ org 维度聚合(写时 org_id 戳为权威) | roadmap"用量报表" |
| 发票 | ✅ 抬头 profile + 按已付订单申请 + 平台人工处理 V1(不接电子发票 API) | roadmap"发票";全仓零雏形,V1 走运营闭环 |

## 1. 核心架构决策(冲突面统一裁决)

1. **org 角色独立存 `org_memberships.org_role`('owner'/'admin'/'member'),不动 `users.role` 二元 CHECK,不动 JWT**。
   - users.role='admin' 是平台超管,有 20+ 消费点,塞 org 角色=污染整个 admin 判定面。
   - JWT 保持 `{sub, role}` 不变:调研两路对 JWT 有分歧(optional claim vs 每请求查库),裁决=**不进 JWT**。`/api/org/*` 全是低 QPS 管理面,每请求一次 `org_memberships` 索引点查换来撤权即时生效(与 requireAdminVerifyDb 复核哲学一致),且完全避开 AccessPayload 兼容性问题。
2. **单一权威源纪律**:
   - owner 唯一权威 = `org_memberships.org_role='owner'` + UNIQUE partial index(org_id) — **orgs 表不设 owner_user_id**(避免双权威);orgs.created_by 仅审计。
   - 每用户**至多一个 active org**(UNIQUE partial index on org_memberships(user_id) WHERE status='active')= V1 显式简化,让"谁付钱/看谁的报表"无歧义;放开多 org 时删索引+加 payer 选择,登记为扩展点。
   - org 归属对计费/报表的权威 = **写时打戳**(usage_records.org_id / credit_ledger.org_id 在 settle 时落),不按"当前成员集"事后推导——成员来去不改历史归属。
3. **`/api/org/*` 独立前缀**,与 /api/me(自己)、/api/admin(平台超管)三层分立;新增 `requireOrgRole(minRole)` 谓词:JWT → `org_memberships` DB 复核 fail-closed;**org 由服务端从 caller 的 membership 推导,任何 org API 不接受客户端传 org_id/user_id 列表**(防新增 IDOR 面)。router.ts 加 `/api/org/*` 结构性 gate(照抄 /api/admin/* gate 先例,router.ts:1575)。
4. **计费扩展**:spendTwoBucket 加 org 钱包为**第 0 优先桶**(org_wallet → user_period → user_wallet;企业买单优先、个人兜底)。全局锁序单向扩展:**orgs → users → user_subscriptions**;兄弟路径(refund.ts:92 / subscription.ts:324,331)凡触 org 层一律先锁 orgs。org 桶不足照常 clamp 落个人桶,零输出免单等上游语义不变。org 锁串行化同 org 并发扣费=已知性能边界,登记观察。
5. **技能分发单机制**:不新增 SkillStore overlay 层、不新增容器挂载(platform-baseline ro-bind 路线否决,因其要动 storage+supervisor+runtime image+远端 host 分发)。走 **marketplace 扩 org**:listings 加 org 可见性(NULL=公开,org_id=仅该 org 成员可见可装,发布仍过 AI 审核链)+ 新 `org_installs` 表 + `/internal/v3/marketplace/sync` 把 org-install 并入成员 sync 结果 → 落现有 **hub 只读层**,容器侧零改动。
6. **org 生命周期 = 平台超管创建/停用/调额**(admin.js 新 org tab,抄 renderPlansTab 模板);用户自助建 org 不在 V1(企业销售驱动)。org suspended → spend 跳过 org 桶 + sync 排除 org 技能 + /api/org/* 403。

## 2. 数据模型(迁移 0111-0114,遵循仓内风格:TEXT+CHECK 禁 ENUM、BIGINT 分、additive 才 IF NOT EXISTS)

**0111_init_orgs.sql** — org 骨架:
```sql
CREATE TABLE orgs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleting','deleted')),
  credits BIGINT NOT NULL DEFAULT 0,               -- org 钱包(对齐 users.credits 语义)
  max_members INTEGER NOT NULL DEFAULT 100 CHECK (max_members > 0),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE org_memberships (
  org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role TEXT NOT NULL DEFAULT 'member' CHECK (org_role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,   -- 该成员是否花 org 钱包(默认宽松,UX 铁律)
  invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX uq_org_owner ON org_memberships(org_id) WHERE org_role='owner';        -- owner 单一权威
CREATE UNIQUE INDEX uq_user_active_org ON org_memberships(user_id) WHERE status='active';  -- V1 单 org 简化
CREATE TABLE org_invitations (…token_hash 模式,仿 email_verifications;org_role 只允许 admin/member;expires_at 7d;accepted_at/revoked_at…);
```
**0112_org_billing.sql** — 计费打戳:`credit_ledger` 加 `org_id BIGINT REFERENCES orgs(id)`(nullable)+ bucket CHECK 重建扩 `'org_wallet'`;`usage_records` 加 `org_id`(nullable)+ partial index `(org_id, created_at DESC) WHERE org_id IS NOT NULL`;`orders` 加 `org_id`(nullable,org 充值单)。append-only RULE 不碰(只加列)。
**0113_org_marketplace.sql** — `marketplace_listings` 加 `org_id BIGINT REFERENCES orgs(id)`(NULL=公开);`org_installs`(org_id, slug, version_id, artifact_hash, agent_ids, installed_by, uninstalled_at,唯一活跃安装 partial unique,结构镜像 marketplace_installs)。
**0114_org_invoices.sql** — `org_invoice_profiles`(org_id PK,title/tax_id/address/email)+ `org_invoice_requests`(org_id, order_ids BIGINT[], amount_cents, profile snapshot JSONB, status CHECK ('pending','issued','rejected'), admin_note, processed_by/processed_at)。

## 3. 计费链改造(生效面:master + **egress**)

- `spend.ts`:`SpendTwoBucketInput` 加可选 `orgId`;org 桶参与时 `SELECT credits FROM orgs WHERE id=$1 AND status='active' FOR UPDATE`(**先于 users 锁**),扣减+写 `credit_ledger(bucket='org_wallet', org_id, user_id=消费成员)`;`SpendTwoBucketResult` 加 fromOrg/orgAfter。
- org 解析收口在 `settleUsageAndLedger` / `mediaBilling` 内(settle 开头一次索引点查:active membership + billing_enabled + org active),**不改 proxy/codex 上游 ctx 管线**;解析结果同时用于 usage_records.org_id 打戳(成员在 org 语境下的用量,无论哪个桶付钱)与 spend orgId。
- 充值:`/api/org/topup`(owner/admin)→ createPendingOrder(org_id)→ 虎皮椒回调 markOrderPaid → fulfill 分支 org_id 非空 → orgs.credits 入账 + ledger(org_id, bucket='org_wallet', reason='topup')。金额校验/状态机零改动。
- 平台 admin 调 org 余额:`POST /api/admin/orgs/:id/credits`(镜像 handleAdminAdjustCredits,含 cap+audit)。
- 兄弟路径锁序核查:refund/upgrade 本期不触 org 桶(org 只有 wallet+topup,无订阅退款面),但在 spend.ts 锁序注释登记全局序 orgs→users→user_subscriptions,后续任何触 org 层的事务必须遵守。

## 4. 技能 org 共享(生效面:仅 master;**不动 runtime image**)

- 发布:现有发布表单加可见范围选择(公开 / 仅本组织,后者要求发布者是 org 成员);AI 审核链(deepseek-v4-pro)不变。
- 枚举收口:marketplaceDb 所有 listing 查询点(browse/search/detail/install 校验)统一加可见性谓词:`org_id IS NULL OR org_id = caller 的 active org`;实现时逐点核对防泄露 oracle(对齐 includePlatform:false 的收口哲学,收口在 DB 查询层单函数)。
- org 安装:`POST /api/org/skills/install`(owner/admin)写 `org_installs`(pin version+hash,同 installApprovedVersion 事务校验);卸载软删。
- sync 并入:`internalMarketplaceSync.listActiveInstalledArtifacts` UNION caller 所属 active org 的 org_installs(org active 前提);成员个人 install 与 org install 同 slug 冲突时**个人优先**(语义:用户自留地不被组织覆盖)。容器侧 marketplaceSync/hub 层零改动。

## 5. 报表与发票(生效面:master + web-react dist)

- `GET /api/org/usage`:主口径 `WHERE org_id=$org`(写时戳);窗口 24h/7d/30d;三组聚合=按成员(JOIN 显示 email/display_name)/按模型/趋势按天;SQL 直接复用 modelOps.ts:232 FILTER 窗口 + users.ts:305 ANY() + handlers.ts:1257 delegate 归组先例。委派成本已归队长成员名下,零特殊处理。明确边界:**无实时并发下钻**(inflight 无 user 维度),只做历史聚合。
- `GET /api/org/ledger`:org 桶流水 keyset 分页(充值/消耗/调整)。
- 发票:OrgCenter 维护抬头 → 对 paid 订单发起申请(金额=所选订单合计,快照抬头)→ 平台 admin 发票 tab 处理(issued/rejected+备注);V1 不存发票文件,线下寄送/邮箱送达记备注。

## 6. 前端(web-react + admin.js)

- **OrgCenter 第四中心**:`?panel=org` 深链(useAppRoute PanelParam 加 'org'),懒加载 Dialog+Tabs 骨架抄 SettingsCenter;tabs=成员/技能/报表/发票/设置。入口门控 `user.org.role∈{owner,admin}`(成员无管理面但可见"我属于某组织"于 SettingsCenter 账户页)。
- `/api/me` 注入 org:handleMe SQL 再 LEFT JOIN org_memberships+orgs,返回 `org:{id,name,role,billing_enabled}|null`;adaptUser 映射;App 派生 isOrgAdmin(与 isAdmin→MarketplaceCenter review tab 逐点同构)。
- admin.js 新 `org` tab(TABS+ADMIN_TAB_META 注册,抄 renderPlansTab):org 列表/新建(名称+owner 邮箱)/停用/调 max_members/调余额;发票处理并入该 tab 或独立 tab(实现时按信息密度定)。

## 7. 实施批次与文件所有权(多 agent 并行,互不交叉)

| 批次 | 内容 | 主要文件 |
|---|---|---|
| A 模型+身份 | 0111 迁移;org.ts(CRUD/membership/invitation);requireOrgRole;/api/org 成员管理路由+gate;/api/me org 注入;/api/admin/orgs | commercial/src/org/*(新)、http/router.ts、http/handlers.ts、http/admin/* |
| B 计费 | 0112;spend.ts org 桶;settle 解析+打戳;org topup/fulfill;admin 调额 | billing/spend.ts、proxyBilling.ts、mediaBilling.ts、payment/orders.ts、http/payment.ts |
| C 技能 | 0113;listing org 可见性收口;org_installs;sync 并入 | marketplace/*、http/internalMarketplaceSync.ts |
| D 前端+报表+发票 | 0114;/api/org/usage|ledger|invoices;OrgCenter;admin.js org tab | web-react/*、web/public/modules/admin.js、http/org 报表 handler |

依赖:B/C/D 依赖 A 的表与 requireOrgRole;A 先行,B/C/D 并行。测试:四层实跑 + commercial 基线失败集 diff 法;org authz/spend/邀请/可见性收口必须行为断言(真 DB round-trip)。

## 8. 登记债与后续触发

| 项 | 内容 | 触发 |
|---|---|---|
| org 订阅/企业套餐 | 期内桶第四桶(org_period→org_wallet→user_period→user_wallet)+ org rollover;spend.ts 扩展点已预留 | boss 定企业定价 |
| 知识库 org 化 | research_documents/artifacts 租户主键 (user_id,doc_id)→org 维度 + 引用权威链跨 user | P3.1 上线后单独立项 |
| 多 org 归属 | 删 uq_user_active_org + payer 选择 + /api/org 显式 org_id | 真实客户需求出现 |
| org 桶锁竞争 | 同 org 高并发扣费串行化于 orgs 行锁 | 大客户并发报表异常时改 UPDATE…RETURNING 乐观扣减 |
| 自助建 org | 用户自助创建+付费开通流 | 商业化策略定 |
| 发票文件/电子发票 API | V1 人工处理无文件存储 | 开票量上来 |

## 9. 部署生效面预分类(v5-commercial-deploy 矩阵)

master(A/B/C/D 全部)+ **egress(B 计费必 --egress)** + web-react dist(D)+ 迁移 0111-0114 人工 apply(0096+ 惯例)。**无 runtime image 重建**(方案 5 已把容器面挡在外)。admin.js 属 master 静态树,随 deploy-v5.sh rsync 生效。

---

# 二期(P3.1 第二波,2026-07-07)—— 席位订阅 + 自助开通(boss 授权:按 Claude/GPT 范式,计费参照个人版套餐)

## 10. 行业范式对齐(取证:OpenAI/Anthropic 官方文档,2026-07)
两家共同范式:统一账号+org 维度(我们一期已对齐)/**开通全面自助化**(连 Anthropic Enterprise 都自助)/成员进入三级递进(邀请→domain capture→SCIM)/角色 owner-admin-member 且 **billing 默认只归 owner**/计费以席位为锚(Claude=seat 费+用量另计,与我们"org 订阅+org 钱包"天然同构)。
本期做:席位订阅+自助开通+billing 权限收紧。**不做**(登记):domain capture(中期最划算,验 DNS TXT 同域自动入组)、SSO/SCIM(大客户触发)、自定义 RBAC。

## 11. 企业套餐定价(裁决:参照个人版,席位制+积分池化)
个人版锚点(0096):pro ¥88/1万分、max ¥298/3.5万、ultra ¥498/6万,30 天期。
企业档 = **每席位价与个人档完全一致(boss 07-07 裁决,原 9 折作废),每席积分与个人档同量,全部入 org 期内池(池化=闲置席位积分不浪费 + 成员管理/报表/发票,即企业版核心增值;不打价格差)**;org 钱包(一期已上线)承接超额与非订阅用量:

| plan_code | 名称 | 每席/月 | 每席积分入池 | 最低席位 |
|---|---|---|---|---|
| org-pro | 企业标准 | ¥88(8800 分) | 10000 | 2 |
| org-max | 企业专业 | ¥298(29800 分) | 35000 | 2 |
| org-ultra | 企业旗舰 | ¥498(49800 分) | 60000 | 2 |

> 定价沿革:二期以 9 折上线(0115 seed);07-07 boss 裁决与个人版对齐,0117 迁移改价(已 apply 的 0115 不改历史)。

期 30 天;**期中加席**=按整席全价购,整份积分即时入池,period 不变(宽松,UX 铁律);续费=手动再购(与个人版一致);到期=sweeper 清零期内池(写 subscription_expire 负流水),org 无 free 档,状态置 expired,**不踢成员**(席位闸只拦新进,不清存量——宽松)。

## 12. 数据与计费扩展
- **单一 plans 权威**:subscription_plans 加 `scope TEXT CHECK ('user','org') DEFAULT 'user'` + `min_seats INTEGER`(org 档专用),不建第二张 plans 表;seed 三个 org 档。
- **org_subscriptions**(0115):org_id UNIQUE、plan_code、seats、period_start/end、period_credits(池)、status(active/expired),结构镜像 user_subscriptions。
- **四桶扣费**:org_period → org_wallet → user_period → user_wallet;**锁序全局单向扩展:orgs → org_subscriptions → users → user_subscriptions**;ledger bucket 扩 'org_period',完整性 CHECK 扩为"org 桶必须带 org_id"。预检口径同步(getOrgSpendableForUser 加期内池,与扣费参与条件成对改)。
- 订单:kind CHECK 扩 'org_provision'(自助开通)+ 复用 'subscription'(org_id 非空=org 订阅/续费/加席,plan_code+seats 落单)。

## 13. 自助开通(Claude/GPT 式)
无 active org 的用户 → "创建组织"向导(组织名+选档+席位数)→ 支付 → **fulfill 时一个事务建 org+owner membership+org 订阅**(org 不提前建,无 pending 僵尸;fulfill 时若用户已入他 org(uq_user_active_org 冲突)→ 订单置 paid+发 critical 告警人工处置,极小概率窗口显式接受);组织名等参数落订单新列。平台超管代建通道(一期)保留=销售路径,与自助并行(对齐 Claude 双通道)。

## 14. 席位闸与权限收紧
- 席位闸:有 active 订阅 → 生效成员上限 = min(seats, max_members);无订阅(钱包型/超管代建)→ 沿用 max_members。**只拦新进**(createInvitation/acceptInvitation),不清存量、不拦续费降席(降席后超编=只读警示)。
- **billing 收紧 owner-only**(对齐两家默认):topup/subscribe/加席/invoice-profile 写/发票申请 → minRole 'owner';读面(balance/ledger/orders/usage)与成员/技能管理保持 admin。自定义 billing 委派(Claude 式 Finance 角色)登记为后续。

## 15. 二期批次与所有权
- E 计费核心:0115 + spend.ts 四桶 + org/orgSubscriptions.ts(grant/加席/轮转)+ org 到期 sweeper + 预检同步
- F 购买开通链:orders fulfill 分支 + /api/org/subscribe|seats + 自助开通订单 + 席位闸(invitations)+ billingRoutes/invoicesRoutes 权限收紧
- G 前端:OrgCenter 订阅面板 + 创建组织向导 + AccountTab CTA + owner 门 + admin.js
E 先行,F/G 并行;生效面 = master + egress + dist + 0115(零 runtime image)。

## 16. 二期登记债
domain capture / SSO+SCIM / 自定义 RBAC(billing 委派)/ 降席超编的软处置策略 / org 订阅自动续费(扣钱包)——均待真实客户信号。

---

# 三期(P3.1 商业化收尾,2026-07-07)—— 落地页外显 + 低水位预警 + billing 委派 + 成员限额

## 17. 范围与裁决(boss 拍板"做吧")
1. **落地页企业版外显**:叙事区块(共享池/成员管理/报表发票卖点)+ CTA「创建组织」(深链 /?panel=org,AuthGate 自然门);**不加大定价表**(尊重 boss 前一轮"删套餐区"的落地页裁决,档位定价在创建向导内看);公开档位数据经 GET /api/subscription/plans 加 scope=org 参数(定价本就是公开信息)。
2. **组织余额预警**:master 侧 sweeper(并入 subscriptionRolloverSweeper 第三域,不造新 timer)5min 扫:org 总可用(期内池+钱包)< max(2000, 10%×本期池) → owner 站内信+邮件(best-effort);orgs.low_balance_notified_at 去重,充值/续费/调额 fulfill 时清标记允许再触发。**不走 wecom 运维告警通道**(那是 ops 面,这是用户通知)。
3. **billing 委派**:org_memberships.billing_delegate BOOLEAN DEFAULT FALSE;授予/回收 **owner-only**(数据层事务内判,同 org_role 纪律);路由表新增伪角色 minRole:'billing' = owner ∥ billing_delegate,覆盖全部计费写面(topup/subscribe/seats/invoice-profile 写/发票申请);/api/me org 字段与成员列表暴露该标志。
4. **成员级用量限额**:org_memberships.monthly_org_budget BIGINT NULL(NULL=不限,默认宽松);口径=**自然月(Asia/Shanghai)内该成员花掉的 org 资金**(ledger org 两桶负 delta 求和,0116 加 (org_id,user_id,created_at) partial 索引);spendTwoBucket org 桶可用额 = min(org 资金, 剩余预算),超限静默落个人桶(打戳不变,无报错);设置权限=admin 可改(支出策略,非动钱);成员列表展示预算与本月已用。

## 18. 批次与所有权
- H 后端:0116 迁移;requireOrgRole/routes 'billing' 伪角色;membersRoutes PATCH 两新字段;spend.ts 预算钳制;resolveOrgBillingContext 带 budget;低水位 sweeper+inbox/邮件;fulfill/调额清标记;plans scope 参数;/api/me;测试
- I 前端:landing 企业区块+CTA;MembersTab 委派开关(owner)+预算编辑(admin)+本月已用;OrgCenter 计费 UI 门从 owner 扩为 owner∥delegate;api/types;vitest
生效面 = master + egress(spend/settle)+ dist + 0116;零 runtime image。

## 19. 显式边界
成员自视预算余量(账户页)、预算到限的主动通知、按 agent/技能维度限额、落地页 A/B——均不做,登记候补。
