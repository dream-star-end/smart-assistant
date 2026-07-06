# v5 企业/团队版(P3.1)开工骨架 —— 新会话开局读这份

> 状态:**方案未启动,本文是交接骨架**(2026-07-06,前一会话在收官 P2+P3.2+告警通道后转交)。
> 新会话开局动作:读本文 + `V5_ROADMAP_2026H2.md` P3.1 + `V5_DEV_PLAYBOOK.md`(工作流/发版纪律/债表)→ 进调研+方案(方案先落 `docs/plans/v5-enterprise-edition-<日期>.md`)。
> 铁律沿用:不猜先取证 / 改前找权威源 / 完成=测试实跑+生效面部署+smoke;任何优化不得降低用户体验;架构妥协显式登记债表。子 agent 优先 opus,主 agent 规划+验收。

## 目标(roadmap P3.1)
组织账号、成员管理、组织维度的共享技能/知识库、用量报表、发票。双钱包模型天然可扩展到组织钱包。
—— 这是**多批次 epic**(数据模型→角色授权→计费→隔离→自助后台→报表),不是单批;设计先行,分批交付。

## 现状锚点(已取证,2026-07-06,行号基于 canonical tip 附近,以实际为准)
四条主干全部以**单 uid 为租户单元**,仓内**零 org/tenant 既有骨架**(grep org/tenant/company/team 无企业实体;team=agent 委派、tenant=per-user 隔离语义,均非企业团队)。

1. **计费(唯一收口)**:`packages/commercial/src/billing/spend.ts:109` spendTwoBucket——期内桶(user_subscriptions.period_credits)+持久钱包(users.credits),锁序 users→user_subscriptions,两桶均硬编码 WHERE user_id。套餐权威=`db/migrations/0096_subscription_billing.sql`(subscription_plans/user_subscriptions UNIQUE user_id/orders)。**扩组织钱包=在此收口加第三桶(org 钱包/org 订阅)+扩锁序;硬约束 user_subscriptions.UNIQUE user_id、credit_ledger.user_id 需重设归属维度**。注意 agent/subscriptions.ts(agent_subscriptions)是"订阅 agent"另一概念,勿混。
2. **身份**:users 表 `0001_init_users_auth.sql`(role CHECK IN user/admin 二元、status、email_verified、credits 持久钱包);JWT claims `auth/jwt.ts:30` AccessPayload{sub,role}——**无 org/tenant 维度**。需从零加 org/membership 表 + 介于 platform-admin 与 user 之间的 org-owner/org-member 角色。
3. **授权**:平台 admin `admin/requireAdmin.ts`(requireAdmin/requireAdminVerifyDb);普通用户 `http/requireUser.ts`;模型 `billing/authzModels.ts:50 canUseModel`+`auth/userModelAuthz.ts`(per-user grants,model_visibility_grants/0049 是现有唯一更细粒度)。本质=admin vs user 二元,无资源级 RBAC。P3.1 要加 org 角色层。
4. **多租户隔离(uid 单元,五处冲突面)**:容器 `v3supervisor.ts:933 oc-v5-u<uid>`;卷 `oc-v5-<role>-u<uid>`(v3supervisor.ts:942-993,生命周期绑定单值 uid>0);会话 `c:<uid>`(wechat/userIds.ts:7 MASTER_USER_PREFIX);IDOR 防线(index.ts:485/router.ts:248,假设"path 含别人 uid=越权")。**引入 org 共享资源时:①容器/卷单人独占无 org 工作区承载单元;②会话/sessions.db 单 uid 归属无 org 可见性模型;③IDOR 防线需从"跨 uid=越权"改为 org-membership 判定**。
5. **技能/知识用户维度**:SkillStore overlay 四层(`storage/skillStore.ts`:platform-baseline>agent-seed>shared(用户级 rw ~/.openclaude/skills)>legacy);USER.md 用户级共享(`storage/memoryStore.ts` sharedUserMd),MEMORY.md per-agent;均物理落单用户卷根。**org 共享恰好缺一层:在 shared(单用户)与 platform-baseline(全平台)之间插 org-shared 层 + org-scoped 存储根**。市场是 platform 维度(marketplace/*,submitter by user_id)。
6. **admin 后台**:`web/public/modules/admin.js`(vanilla,平台超管视角:users/accounts/containers/ledger/pricing/plans/audit)。**无企业自助管理雏形**;P3.1 需新建 org-scoped 自助后台(数据面按 org_id 过滤+org-admin 角色),不能复用平台 admin。设计参考 `web/design-system-reference/`。

## 核心改造点(取证小结,供方案切分)
① 新增 org/membership 数据模型 + org-owner/org-member 角色(介于 platform-admin 与 user);
② spendTwoBucket 收口加 org 钱包维度(组织钱包/组织订阅);
③ 容器/卷/会话/skill-overlay/memory 五处 `-u<uid>` 单人假设改为可选 org-scoped;
④ IDOR 防线从"跨 uid=越权"升级为 org-membership 判定;
⑤ org-scoped 自助后台 + 用量报表 + 发票。
建议方案阶段先做**决策题**:组织资源共享的粒度(共享钱包?共享技能库?共享工作区/会话?还是仅共享额度+成员管理),不同粒度改造量差一个量级——先和 boss 对齐范围再设计。

## 上下文指针(新会话 recall 用)
- 记忆索引 MEMORY.md;关键:[[v5-workflow-system-handoff]](单一权威手册入口)、[[v5-subscription-billing-two-bucket]](双钱包)、[[v5-p2-remaining-batches]](P2/P3.2/告警通道收官)、[[ux-no-regression-rule]]、[[subagent-model-opus-preference]]、[[codex-audit-before-done]](Codex 不强制)。
- 线上:master v5-46b53737,镜像 v5-ccb-33f078ba,canonical feat/v5-aurora-rewrite。
- 暂缓件(不阻塞企业版,boss 决策触发):异 DC 热备(候选机 64.90.20.189 香港不合格,等独立机 ≥32G/≥200G/独占)、codex 账号池扩容、v3 退役收尾(回滚窗 07-09 后:停 v3 master→轮询告警规则挪 v5→Caddy 去 v3 路径→共享库 v3-only 清理)、企业微信双向对话通道(告警通道已上线,对话通道仍缓;智能机器人长连接是最佳形态,归档见 [[v5-wecom-channel-deferred]])。
