# RFC — v5 全链路自愈运维体系(Self-Healing Ops)

> 状态:**设计审通过**(Codex 4 轮对抗审 R1→R4,BLOCKER 6→0)。地基迁移 0133 已实现并隔离验证(apply + PG function 语义 + 约束全通过)。
> 分支:feat/v5-selfheal。完整方案 = 下列四章(v2 主体 + v3/v4/v5 增量定案)。

---

## 第一章:主体方案(v2)

# v5 全链路自愈运维体系 — 设计方案 v2(吸收 Codex R1 后)

日期:2026-07-11 · 分支:feat/v5-selfheal(基 feat/v5-aurora-rewrite @32fe8c7a)· worktree:/opt/openclaude/openclaude-v5-selfheal
本文取代 v1(v5-selfheal-design.md)。R1 结论 NEEDS-CHANGES(6 BLOCKER + 12 MAJOR + 2 MINOR),下方每处标注 [解 Bn]/[解 Mn]。

## 0. 需求(不变)
1 所有影响用户的异常都要告警 + 表述人话化;2 实时推送在线受影响用户 + 恢复通知;3 商业版检测异常→通知个人版 codex 自动修复→修完发恢复通知;4 admin 新页记录 codex 修复(可回溯可审计);5 个人版 codex 完整修复 skill;6 个人版代理主备切换对齐商业版。终极:把 boss 从运维中解放。

## 1. 架构基石变更(相对 v1 的根本纠偏)

**v1 错误**:让 incident 生命周期挂在 `enqueueAlert()` 上(从"通知投递"反推"事故状态")。
**v2 纠正 [解 B1]**:引入独立权威 **`alert_conditions`(检测状态单一真理源)**,incident 是它的**派生投影**,通知(outbox)与 incident 都是它的**消费者**,互不反推。

```
检测层(写 alert_conditions,level-triggered 当前值,不只翻转沿)
  ├ 系统A v5-monitor.sh    ──psql upsert──┐
  ├ 系统B alertRules 恢复/触发 ───────────┤
  ├ providerHealth degraded/recovered ────┼──►  alert_conditions(condition_key, phase, level, snapshot, rev)
  ├ 被动事件 payment/oversized/... ───────┘         │ (单一权威;每次评估写当前值)
  │                                                  ▼
  │                                    incidentReconciler(v5-owned, 10s tick)
  │                                    读 alert_conditions 当前值 × incident_policies
  │                                          ├ firing 无对应 open incident → openIncident(materialize 文案)
  │                                          ├ resolved/probe-ok 且 incident open → resolveIncident(source=probe)
  │                                          └ 对账(level-triggered,不依赖 edge)
  ▼                                                  ▼
enqueueAlert(不变,继续投递企微/inbox)        incidents(open/repairing/resolved, rev 单调)
                                                     │
                                    ┌────────────────┼───────────────────────────┐
                          incident_deliveries       codex_repairs           ops.incident_* 告警
                          (durable outbox,          (pending→...→succeeded)  (复用 enqueueAlert)
                           唯一键 incident_id+phase+channel)
                                    │                     │
                          sweeper claim/投递        repairDispatcher(隧道)
                          ├ WS broadcastAll/ToUsers(at-least-once)
                          └ inbox(去重键)
```

### condition_key 命名空间统一 [解 B2]
- monitor check → `ops.monitor:<check>`(如 `ops.monitor:svc_v5`);shell 发的 event_type 恒为 `ops.monitor_check_failed`/`ops.monitor_recovered`(v5-monitor.sh:268/287 实证),**check 名在 detail**,故 condition_key 用 check 派生。
- provider → `health.provider:<id>`(区分 degraded/recovered 双 event,alertEvents.ts:79)。
- maintenance → `system.maintenance:<mode>`(同 event 双方向,alertEvents.ts:72,用 mode 拆 firing/resolved)。
- rule → `<event_type>:<scope>`。
- policy 表用 condition_key **精确或前缀** pattern 匹配。dedupe_key = condition_key(open incident 对某 condition_key 至多一条,partial unique index WHERE status!='resolved')。
- `incidents.event_type` 语义修正:不再"对齐 EVENTS",而是"对齐 condition_key 派生的 policy 键"。

### incident_policies 数据表(消灭文案双源)[解 M1/MINOR1]
migration seed 一张 `incident_policies(condition_pattern, surface, audience, user_title, user_message_tpl, resolve_mode, auto_repair, severity_floor)`。TS incidentPolicy.ts 从表加载(内存缓存 + NOTIFY 刷新);**shell 完全不碰文案**(只 upsert alert_conditions 当前值),incident 文案由 master reconciler 从表 materialize。单一权威=表。

### resolve_mode(闭合 resolve 语义)[解 B6/M3]
policy.resolve_mode ∈ `probe | manual`:
- `probe`:靠 alert_conditions 当前快照 resolve(level-triggered)。**reconciler 每 tick 用当前值对账**,即使 monitor state 文件丢失(v5-monitor.sh:218 默认旧态 ok),下轮 check 仍 upsert 当前 ok → reconciler resolve。根治"永不 resolve"。
- `manual`:无探测语义的被动事件(payment/oversized 等),只能 codex done(探测确认后)或 admin 手动 resolve。

## 2. incident/repair 状态机(DB 级约束)[解 M2]

**incidents**:`open → repairing → resolved`(+ rev BIGINT 单调,updated_at)。CHECK(status IN ...);resolve 走 CAS(WHERE status!='resolved')。
**codex_repairs**:`pending → dispatched → acked → running → verifying → (succeeded | verification_failed | failed | timeout | cancelled)` [解 M3 新增 verifying]。
- DB 约束:CHECK 枚举;FK incident_id ON DELETE RESTRICT;`UNIQUE(incident_id, attempt)`;**全局并发1** = `CREATE UNIQUE INDEX ux_repair_singleflight ON codex_repairs((1)) WHERE status IN ('pending','dispatched','acked','running','verifying')`(表达式常量索引保证全表至多一行活跃)[解 B5]。
- 合法迁移矩阵 + CAS 条件落 DB(每次状态迁移 `UPDATE ... WHERE id=? AND status=?`,受影响 0 行=竞态丢弃,幂等)。
**codex_repair_events**:append-only 进度流(dispatched/ack/progress/verify/done/failed/timeout/note),admin 页时间线 + "正在做啥"=最新 progress。

### 崩溃安全派单 [解 B5]
- dispatcher:事务内 `INSERT codex_repairs(pending)`(受 singleflight 唯一索引保护,重叠 tick 第二个 INSERT 冲突丢弃)→ 提交 → 隧道 POST → 成功才 CAS `pending→dispatched`。
- POST 后置位前崩溃:重启 reconciler 见 pending,**重发幂等**(个人版按 repair_id 去重挡重复建会话,见 §4.3)。
- 稳定 delivery id = repair_id。

## 3. 安全通道:SSH 双向隧道(取代 v1 公网明文)[解 B4]

**根治**:不暴露公网 inbound。本机(持 kl-mirror SSH key,已实证)用 autossh 主动建立**双向隧道**:
- 反向 `-R 127.0.0.1:<PORT_DISPATCH>:127.0.0.1:18789`:kl-mirror dispatcher POST 本机 gateway(派单)。
- 正向 `-L 127.0.0.1:<PORT_CALLBACK>:127.0.0.1:<master_cb>`:本机 codex POST kl-mirror master(回调/拉上下文/取消)。
- systemd `openclaude-selfheal-tunnel.service`(autossh,Restart=always,ServerAliveInterval)。断连=派单 POST 失败→dispatcher 重试队列;autossh 自动重连。

隧道内再叠加(纵深):
- **webhook 专用凭证**:不用个人版全局 access token(server.ts:2425 全 /api/* 用它,泄露面过大)。个人版给 selfheal webhook 路由做**HMAC-only 鉴权**(豁免全局 Bearer,需改个人版 gateway webhooks 鉴权,走 release-checklist)。
- **防重放** [解 B4]:请求头带 `X-Selfheal-Ts`(issued_at)+ `X-Selfheal-Nonce` + `X-Selfheal-Sig`(HMAC over ts+nonce+repair_id+body)。个人版校验:expires(±120s)+ **原子 nonce 缓存**(SQLite 唯一表,重复 nonce 拒);消除 webhooks.ts:85 只签 body 可无限重放 + server.ts:1874 每次 Date.now() 新 session 绕过并发1 的洞。
- **callback 短期 capability** [解 B4]:回调不用永久全局 token。dispatcher 派单时**下发逐 repair 短期 token**(HMAC(master_secret, repair_id+attempt+exp),90min 过期),codex 回调带此 token;master 校验绑定 repair_id(改一个 repair 只能用它自己的 token,不能动别的)。走隧道(TLS 等价)。

## 4. 修复联动与执行边界

### 4.1 动作分层(skill 文字红线→确定性边界)[解 M6]
- **Tier 1 确定性运维**(服务重启/磁盘清理/systemd 拉起/节点·provider 切换/env 键回灌):不经 LLM 自由执行。个人版 **action broker**:allowlisted 端点,每动作参数 schema 校验 + 审计。**dispatcher 对 Tier1 类 incident 直接触发 broker 动作**(可完全不唤 codex),最小爆炸半径。
- **Tier 2 代码修复**(未知 bug):必须 codex 自由能力。控制四重:
  1 worktree 隔离;2 **独立验证门**=四层测试必绿 + 部署 smoke 必过才允许生产 cutover(测试红→禁止部署);3 **红线禁区**(数据库数据/计费积分/用户数据/迁移回滚/Caddy·证书/凭据轮转 → 只取证 + failed 回报待 boss,绝不自动动手);4 全程 append-only 审计。
  - **生产部署自动化档位** [架构决策]:`OC_SELFHEAL_AUTO_DEPLOY_TIER2` env,**默认 0**=codex 自动定位+修复+测试+准备就绪后停在"待放行",发企微给 boss 一键放行(broker 端点);=1=测试全绿则自动 cutover。默认安全档:Tier1 全自动 + Tier2 自动修到"测试绿待放行",把 boss 从"定位+动手"解放,只保留最危险一步(生产 cutover)的一键确认。诚实标注:这是安全与"完全解放"的权衡点,env 可放开。

### 4.2 防 prompt 注入(payload 只给 id)[解 M6]
- webhook payload **只含 `{repair_id}`(allowlisted)**,绝不塞自由文本 ops_detail(webhooks.ts:67 是裸字符串替换,注入面)。
- codex 经隧道 `GET /internal/selfheal/context/:repair_id` 拉**结构化、脱敏、只读**上下文(event_type/surface/probe snapshot,master schema 化输出)。注入面收敛到 master 控制的结构化字段。

### 4.3 回调端点(master)+ 个人版去重
- master `POST /internal/v5/repairs/:id/{ack,progress,verify,done,failed}`:短期 capability token 校验(constant-time,绑 repair_id)+ **zod schema + 字段长度上限 + secret redaction(复用 auditRedact)** [解 M9];状态机 CAS 校验;done→置 `verifying`(不直接 succeeded)。
- **verifying → succeeded 仅探测确认后** [解 M3/B6]:probe 类由 reconciler 下轮探测过 resolve incident + repair succeeded;probe 未过 → verification_failed。manual 类 codex done 直接 succeeded + resolve。**消除"admin 显示成功但事故未恢复"**。
- 个人版去重:SQLite `selfheal_processed(repair_id PK)`,webhook 建 session 前查,重复 repair_id 不重建。
- **真正中止** [解 B5]:timeout/cancel → dispatcher 经隧道 `POST /internal/selfheal/cancel {repair_id}` → 个人版查 repair_id→sessionKey 映射(建会话时记)→ WS stop/kill session → 确认终止回调 → dispatcher 才释放 singleflight 槽置 timeout/cancelled。timeout 不再"只告警不杀"。

## 5. 用户推送(WS + 前端)

- **protocol** frames.ts 新增 `SysIncident`(照 SysContextRebuilt 范式进 AnyFrame):payload `{incidentId, rev, status:'open'|'resolved', severity, surface, title, message, ts}`,**带 rev** [解 M4]。
- **bridge**:新增 `broadcastAll(payload)` + `broadcastToUsers(uids,payload)`(遍历 uidToUserWs)入 handler 接口 + index.ts 装配。**补发位置在 JWT + 封号复核 + WS 注册之后**(userChatBridge.ts:1004 之后,**不在** frontend_build:974 认证前)[解 M4];activeIncidents 快照经 master 注入 bridge 的 provider 闭包(不让 bridge 直连 PG)。
- **web-react**:frames.ts 加 IncidentWire;socket.ts dispatch → `lib/incidentStore.ts`(useSyncExternalStore,**按 incidentId 存最高 rev,旧 rev 丢弃**,防迟到 open 把已 resolved 重新挂起)[解 M4];App.tsx 连接横幅槽上方 `<Alert tone={severity}>`,resolved→useToast success + 清横幅。inbox 轮询兜底离线用户。
- **audience 首版即支持定向** [解 M5]:policy.audience ∈ `all | surface_cohort | user_ids`。broadcastAll / broadcastToUsers 两入口就位;surface_cohort=按 surface 关联在线用户(如 image→近期用图在线用户,能力就位,归因精度可迭代);无法可靠归因才诚实降级 all。
- **durable delivery** [解 M1]:`incident_deliveries(incident_id, phase, channel, status, claimed_at, UNIQUE(incident_id,phase,channel))`;sweeper claim/lease/retry;WS at-least-once(前端 rev 幂等),inbox 写入前查 delivery 去重(createInboxMessage 无幂等键,inbox.ts:352,靠 delivery 表挡重复)。

## 6. admin 修复审计页

- registry.tsx 加 `selfheal` 页(系统运营组,icon Wrench);registry.test.ts 21→22 [硬断言];路由基线 UPDATE_BASELINE=1 重钉。
- `pages/selfheal/index.tsx`:上半 incidents DataTable(status/severity/surface 过滤,useAdminPoll 15s);点行开 Modal:incident 全字段 + repairs + repair_events 时间线(照 audit/AdminAuditTab Modal);进行中 repair 顶部"正在修复"卡(最新 progress event)。行内 retry/cancel/resolve(useConfirm)。**admin detail 不原样吐任意 JSON**,经 redaction [解 M9]。
- 后端 admin/selfhealOps.ts(keyset 分页)+ http/admin/selfheal.ts 薄壳 + router 注册。
- **审计动作 tx fail-closed** [解 M8]:resolve/cancel 单库事务内 writeAdminAudit(mode:'tx',审计失败回滚);retry 原子登记"管理员请求重试"+ INSERT pending repair,dispatcher 异步派。auditActions.ts 登记 `incident.resolve/codex_repair.retry/codex_repair.cancel`(tx)。

## 7. 审计分层与 retention [解 M7]

- incident/repair **是独立运维业务账本,不冒充 admin_audit,不进 PERMANENT_AUDIT_TABLES**(那是合规 admin audit 专用,auditRetention.ts:61)。
- 三表全登记 auditRetention `AUDIT_RETENTION_POLICIES`(清理权威,playbook:366);**为满足"永久可回溯":incidents / codex_repairs / codex_repair_events 三表 retention 设为 permanent 语义**(不删)。若 auditRetention 不支持非 admin_audit 永久表,则扩其模型加 `class:'ops-ledger'` 永久档(不与 compliance-audit 混淆)。诚实:核心账本 + 进度时间线均永久(repair 量级小,无存储压力)。

## 8. 检测面补盲 [解 M10 调整]

- **首批 incident 覆盖已有明确 firing/resolved 语义的检测**:monitor 11 项(svc/http/public_route/egress/disk/mem/pool/image/mail)+ account_pool.all_down/low_capacity + provider degraded/recovered + mail + system.session_oversized(manual)+ maintenance。足够覆盖服务级用户可感故障。
- **turn 失败率飙升降级为 P1 债** [解 M10]:turn_traces(0126)无 outcome 列(实证),数据源不成立。需先定失败 outcome 权威落点(turn_traces 加 outcome 列 or usage_records error 聚合)+ 最小样本/阈值/滞回/分模型维度。登记 playbook §5 债表,触发:turn outcome 落点就绪。不在首版硬塞免单率替代(误报)。
- WS 断连率、5xx/TTFT(依赖 Prometheus)→ 债表,触发:接入 Prometheus。

## 9. 部署顺序 [解 M11]
1 向后兼容迁移 0133 人工 apply(标准 SOP:显式列名 + BEGIN/COMMIT + ON CONFLICT DO NOTHING,playbook:291 [解 MINOR2])。
2 secrets/env 双机:kl-mirror commercial-v5.env 加 OC_SELFHEAL_*(隧道端口/webhook HMAC/master secret/AUTO_DEPLOY_TIER2=0/DISPATCH_DISABLED 初始=1);本机 /root/.secrets/v5-selfheal/*;隧道 service + 个人版 webhook/agent/skill/broker 就位(接收端 ready 先于派单)。
3 `deploy-v5.sh --with-dist`(code+dist 单次重启,禁成对重启,playbook:214)。
4 monitor.sh 随 rsync 生效,开写 alert_conditions。
5 **分阶段启用 dispatch**:先 DISPATCH_DISABLED=1 观察 incident/推送/审计链路;确认后置 0 灰度开派单。

## 10. 测试矩阵 [解 M12]
- 全状态迁移矩阵 + 非法/重复 callback(CAS 幂等);
- 双 sweeper / 重叠 tick / POST 前后崩溃(singleflight + 去重);
- webhook replay / 过期 nonce / 伪造 callback / 限流;
- monitor state 文件丢失后 level reconciliation resolve;
- WS 认证前不发 incident + 重连乱序 rev 去重;
- incident open→resolve 与 inbox/outbox delivery 唯一性;
- timeout/cancel 后个人版 session 实际终止 + 槽释放;
- dispatch 总闸(DISABLED)+ 回滚演练;
- 隧道断连 dispatcher 重试。
断言=行为(帧序列/mock WS/真 DB round-trip),非源码 regex。commercial:unit 基线 diff 法。

## 11. 个人版代理主备切换(个人版仓 master + ops)[与自愈链路解耦,独立切片]
- egressSubscription.ts buildConfig 重构:selector(主备成员,cache_file 持久选中)+ experimental.clash_api(127.0.0.1:19096)+ **ROUTE_RULES 常量**(downloads.claude.ai/storage.googleapis.com→direct 补回并防"刷新抹规则"根治);切换=clash_api PUT 不重启;测速走 clash_api delay。走 release-checklist。
- watchdog(/opt/openclaude/ops/openclaude-personal-egress-watchdog.py):以商业版脚本(scratchpad 84a008f2 397 行)整段复用状态机(10s/3败切换/3成滞回/30min×3 震荡静默/外部切换检测/双挂/state 持久化),参数化 config 路径/clash_api/NODES/service/state。
- **alert() 重写**:个人版无 PG → 直 curl 企微机器人 webhook(qyapi 国内直连,`--noproxy '*'` 不依赖 18991);可选加一路经隧道 POST v5,把"个人版代理故障"也登记进 v5 incidents(boss 单一视图,登记为增强)。
- systemd Restart=always + OnFailure 企微通知。旧 Python 切换器保持退役。

## 12. 实施切片
① v5 树:alert_conditions + incident_policies(seed)+ incidents/repairs/events + deliveries 迁移 0133;selfheal/(reconciler/sweeper/dispatcher/policy/broker-client);protocol 帧;bridge broadcastAll/ToUsers + 认证后补发;回调端点 + 短期 token;admin 页 + 审计/retention/alertEvents 登记;monitor.sh 写 alert_conditions;测试。
② 本机:autossh 隧道 service;个人版 webhook HMAC-only 鉴权 + nonce 缓存;codex-v5ops agent(cwd=v3 canonical)+ webhooks.yaml;action broker 端点(Tier1 allowlist);repair_id→session 映射 + cancel 端点;去重表;修复 skill。
③ 个人版仓:egressSubscription selector + watchdog + systemd。
④ 部署(§9)。⑤ 收尾:playbook 自愈章 + §5 债表(turn_fail_spike/WS断连/5xx/surface_cohort 精度/个人版故障入 v5 视图)+ 记忆。

## 13. 未决重大取舍(架构师已定,汇报 boss 知会,非阻塞)
- 安全通道=SSH 双向隧道(非公网 mTLS):复用既有信任、免证书运维,根治明文 inbound。
- Tier2 生产 cutover 默认需一键放行(OC_SELFHEAL_AUTO_DEPLOY_TIER2=0):安全与"完全解放"的平衡,env 可放开全自动。
- 运维账本永久保留(不进 admin_audit 合规域,自成 ops-ledger)。
- turn 失败率首版不做(数据源需独立改造),登记债。

---

## 第二章:R1 吸收定案(v3)

# v5 自愈体系 — v3 delta(吸收 Codex R2)

配合 v2(v5-selfheal-design-v2.md)阅读。**v2 中未被 R2 点到的部分不变**;下方是 R2 每条 BLOCKER/MAJOR 的最终落地解法,取代 v2 对应段落。

## B1(新)— 消除 alert_conditions vs admin_alert_rule_state 双权威
**决定:原地演进 `admin_alert_rule_state` → `alert_conditions`,不新建表**(v5 未上线,放开重构;现表仅 rule_id PK/firing/dedupe_key/last_*+ack,0025:86 / 0036)。
- 迁移 0133:`ALTER TABLE admin_alert_rule_state RENAME TO alert_conditions`;PK 由 `rule_id` 泛化为 `condition_key TEXT`(现有 polled rule 的 rule_id 即其 condition_key);新增列 `discriminator TEXT`、`mode TEXT CHECK(mode IN('probe','latched','spike'))`、`level TEXT`、`snapshot JSONB`、`observed_at TIMESTAMPTZ`、`rev BIGINT NOT NULL DEFAULT 0`、`occurrence_count BIGINT DEFAULT 0`、`last_seen_at TIMESTAMPTZ`;保留 `firing`(=phase firing 的布尔投影)、ack 字段。
- **唯一权威**:所有检测器(alertRules.ts:468 / providerHealthScheduler.ts:131 / shell / 被动事件)统一经**一个** `writeCondition(conditionKey, {phase, level, snapshot, observedAt}, tx)` 写它;禁止任何检测器再直接写旧表字段。polled rules 的翻转判定改读 `alert_conditions.firing`(语义等价,零回归)。
- incident 是 `alert_conditions` 的**只读派生投影**(reconciler 单向),不反向写 condition。

## B2(新)— fire-once 事件建模 + manual resolve 收紧
condition.mode 三分:
- `probe`:可重复求值 level(monitor/provider/账号池)。writeCondition 每次评估 upsert 当前值。
- `latched`:可聚合成持续故障的 occurrence(oversized 按 kind/build)。首次 occurrence→firing + occurrence_count++/last_seen;**resolve 必须先 CAS condition firing→resolved**(由 admin 或探测),incident 只由 reconciler 跟随 condition;之后再来 occurrence 才重新 firing→重开。
- `spike`:窗口聚合(payment 单笔失败**不进 incident**,降级纯 outbox 告警;需要时聚合成 `payment.failure_spike` condition,带窗口/阈值/滞回,归 probe 类可重复求值)。
- **manual resolve 语义**:`resolve_mode` 收紧为——incident 的 resolve **永远先关 condition**(CAS firing→resolved),reconciler 再据此 resolve incident。**codex done 不是 manual 恢复权威**;codex 若能确定性验证,给它正式 probe 归 `probe` 类走 verifying。admin 手动 resolve = CAS 关 condition。杜绝"resolve 后 reconciler 立即重开"。
- payment 单笔失败:不做平台 incident(纯告警),消除噪音。

## B3(新)— 个人版 receiver durable job 状态机(消除吞单窗口)
不复用现成 webhook(webhooks.ts:142 emit 内存事件即返回=非 durable)。新建 durable 接收:
- SQLite `selfheal_jobs(repair_id TEXT PK, payload_hash TEXT, capability_ref TEXT, status TEXT CHECK(received/starting/running/succeeded/failed/cancelled), lease_owner, lease_until, attempt, created_at, updated_at)`。
- 接收端点:事务 `INSERT ... ON CONFLICT(repair_id) DO NOTHING` **先落库成功才返回 202**;`repair_id 相同但 payload_hash 不同 → 拒绝`(防串单)。
- 后台 worker:`lease claim`(CAS received→starting,带 lease_until)→ **确定性 session key `selfheal:<repair_id>`**(getOrCreate 幂等,starting 崩溃重启对账恢复不重复建会话)→ starting→running。
- 网络在 POST 中途断/响应丢:dispatcher 重发同 repair_id → receiver ON CONFLICT 幂等;**若 receiver 从未收到,重发是正确且唯一正解**(确定性 key + ON CONFLICT 保证至多一次执行)。

## B4(新)— Tier2 codex OS 级降权(env/broker 只约束编排器的漏洞)
拆权限,不让 root codex 自由部署:
- **codex-v5ops agent 跑在专用非 root Unix 用户 `ocheal`**(非 root):仅能在其可写的 v5 worktree 内 `git worktree/编辑/npm test`;**无生产 SSH key、无 systemd/docker 权限、不可读 selfheal/master secrets**(secrets 属 root/broker,0600)。agents.yaml 该 agent 配 `runAsUser`(个人版 runner 支持按用户降权 spawn,实现期核实 codexAppServerRunner 是否支持 uid/gid drop,不支持则用 systemd-run --uid 或 sudo -u 包裹)。
- **cutover broker = 独立进程/用户(持部署权限)**:root 或专用 deploy 用户运行的 loopback 服务;只接受**结构化输入**(commit SHA / 目标分支 / 验证记录 id),自行核验:canonical ancestry(是 feat/v5-aurora-rewrite 后代)+ 测试凭据(四层测试产出的签名结果)+ 部署全局锁(flock)。codex **不能直接调 deploy-v5.sh**,只能 `POST broker /cutover {sha, verification_ref}`。
- Tier1 确定性动作同理经 broker allowlist 端点(参数 schema 校验 + 审计)。
- 效果:M6 的"确定性边界"从 prompt 纪律升级为**OS 级不可绕过**。boss 的"完整修复能力"= 能力覆盖面(定位+改代码+测试全保留),不等于 root;高危一步经 broker 核验。

## MAJOR 落地(采纳 R2 具体做法)
- **M-SSH**:autossh 用**专用非 shell 受限 key**;kl-mirror `authorized_keys` 前缀 `restrict,no-pty,no-agent-forwarding,no-X11-forwarding,permitopen="127.0.0.1:<master_cb>",permitlisten="127.0.0.1:<dispatch>"`;systemd 固定 known_hosts + `StrictHostKeyChecking=yes` + `ExitOnForwardFailure=yes`。不复用可登录 root 的宽 key。
- **M-HMAC-route**:个人版豁免仅精确 `POST /api/webhooks/v5-selfheal`(其余 method/path 不豁免);handler 首行校验 `remoteAddress 为 loopback`(只能经反向隧道到);raw body 大小上限**先于**验签;验签成功**才**写 nonce;公网 listener 到不了 broker/cancel/job API(这些绑 loopback + 独立鉴权)。
- **M-capability**:短期 token **由个人 gateway/受限 callback tool 托管**,不进 prompt/模型 env/tool 输出;token 载 `purpose/audience(repair_id)/attempt/exp`;codex 只能调本机受限 callback tool,tool 查 job 附 token 且限操作自身 repair。
- **M-verify-fence**:verifying 记 `verify_after=done_at` + 观测时的 condition rev;**只 `observed_at>done_at` 的新观测有裁决资格**;新观测 resolved→succeeded;仍 firing→等到 `verify_deadline`(按 mode:monitor≈2×120s,provider≈2×60s);deadline 内无新观测→`verification_inconclusive`(≠失败,不 resolve 不重罚);deadline 后仍 firing→`verification_failed`。
- **M-cancel**:codex_repairs 加中间态 `cancel_requested→cancelling→(cancelled|cancel_failed|orphaned)`,均占 singleflight 槽;隧道/个人机永久失联→**fail-closed 不释放槽**(旧 root 进程可能仍跑),提供显式 break-glass fencing 流程;cancel/terminal confirmation 用**独立 capability**(避免与 90min repair token 同时过期导致确认无法回调)。
- **M-inbox-atomic**:inbox INSERT 与 delivery 标 sent **同 PG 事务**;或 inbox 加 `(source_type,source_id,source_phase)` 唯一键。WS 外发保持 at-least-once。
- **M-recipients**:incident open 时 materialize `incident_recipients(incident_id,user_id)` 快照;`user_ids` 直接快照,`surface_cohort` 由明确 usage SQL 权威 + 固定 lookback 生成;open/resolved **用同一快照**(恢复通知不发给另一批);新登录按快照或明确动态规则补发。
- **M-delivery-rev**:delivery 唯一键改 `(incident_id, incident_rev, channel)`,kind `opened|updated|resolved`;condition level 变化(如 disk warning→critical)→incident rev++→再次推送;前端最高 rev 逻辑消费 update。
- **M-retention**:新增 `PERMANENT_OPS_LEDGER_TABLES`(incidents/codex_repairs/codex_repair_events),与 TTL policies、PERMANENT_AUDIT_TABLES **三者互斥 + fail-fast 断言**;永久表不进会 DELETE 的 policy 数组(auditRetention.ts:30/114 现只支持数值 days)。
- **M-policy-match**:incident_policies 拆显式 `match_kind('exact'|'prefix') + match_key`;裁决 exact 优先、否则 longest-prefix、同长度 fail-fast;禁止单字符串通配约定。

## 测试补充(R2 新增场景)
- receiver 并发双穿 / starting 崩溃对账 / payload_hash 冲突拒绝;
- verify freshness:done 后旧快照不误判、inconclusive 不等于 failed;
- manual/latched condition:resolve 后不被 reconciler 重开、再 occurrence 才重开;
- cancel 中间态 + 失联 fail-closed 不释放槽;
- inbox 崩溃后不重复(唯一键/同事务);
- delivery rev 递增触发 update 推送;
- SSH key 受限(permitopen/permitlisten 生效,越权端口被拒)。

---

## 第三章:R2 吸收定案(v4)

# v5 自愈体系 — v4 delta(吸收 Codex R3,定案)

配合 v2 + v3-delta 读。R3 剩 4 BLOCKER + 3 MAJOR 的最终定案,取代对应段落。

## B1-final — 0133 additive-only(部署窗口新旧 master 共存,禁 rename)
迁移不改名、不改主键,纯 ADD:
- **物理表名保持 `admin_alert_rule_state`,主键列保持 `rule_id`**(其值即 condition_key;旧 polled rule 的 rule_id 天然是自己的 condition_key)。旧 master 在部署窗口仍能查(列只增,不减不改名),满足 playbook:235 在线 apply 向后兼容。
- 0133 只 `ADD COLUMN`:mode/level/snapshot/observed_at/observation_seq/condition_rev/occurrence_count/last_seen_at + 新建 incidents/codex_repairs/codex_repair_events/incident_deliveries/incident_recipients/incident_policies 表。
- 代码层把 admin_alert_rule_state 当 condition table 用(TS 类型/命名泛化,物理名不动)。表名美观留到旧二进制全退役后单独清理迁移(可选)。

## B2-final — 单写权威下沉为 PG function(消除 TS/shell 双实现)
新建 `write_alert_condition(p_key, p_mode, p_firing, p_level, p_snapshot, p_observed_at, p_occurrence_delta) RETURNS (previous_firing BOOL, transitioned BOOL, condition_rev BIGINT)`:
- UPSERT admin_alert_rule_state WHERE rule_id=p_key;
- **同 phase**(firing 不变):刷新 snapshot/observed_at + observation_seq++,**不清 ack、不动 last_transition_at、condition_rev 不变**;
- **firing 真翻转**:更新 firing + last_transition_at=now + **清 ack** + condition_rev++(严格对齐现语义 alertOutbox.ts:757/770);
- **level 变化但同 phase**:condition_rev++(触发 incident update),observation_seq++;
- latched:occurrence_count += p_occurrence_delta,last_seen_at=now;
- 原子返回 previous/transitioned/rev。
TS `writeCondition` 与 shell(`psql -c "SELECT write_alert_condition(...)"`)**都只调此 function**;alertRules/providerHealth 翻转判定改**消费 function 的 transitioned 返回**(不再自比 firing)。彻底消除双源(优于 v5-alert-fanout.sql 双源同改的历史债)。

## B3-final — execution ledger 保 at-most-once execution
durable job(selfheal_jobs)保"至多一 session";再加 execution ledger 保"至多一次 submit":
- 个人版 SQLite `selfheal_executions(execution_id TEXT PK, status TEXT CHECK(accepted|running|done|failed), session_key TEXT, created_at, updated_at)`,`execution_id = repair_id`。
- worker claim job → 事务 `INSERT selfheal_executions(execution_id, 'accepted') ON CONFLICT DO NOTHING`;**仅当本次 INSERT 首次成功才 `sessions.submit`**;已存在(accepted/running)→ 重新 attach/观察,**禁止再 submit**(确定性 session key 只幂等建会话,submit 幂等靠 ledger)。
- execution_id 穿进 session executor(server.ts:1897 submit 入口带 execution_id 去重)。
- Tier1/cutover broker 按 `repair_id + action_kind` 幂等(broker 侧同款 ledger)。
- 结果:at-most-once execution(非仅 at-least-once receipt)。

## B4-final — codex OS 降权定案(Node uid/gid drop + broker 可信驱动)
- 个人版 gateway spawn codex app-server 用 **Node 原生 `spawn(cmd, args, {uid: OCHEAL_UID, gid: OCHEAL_GID})`** privilege drop(codexAppServerRunner.ts:1389 spawn options 加 uid/gid)。
- AgentDef 加 `runAsUser`,但**白名单**:仅 selfheal agent 允许,值域=固定映射表(预注册 uid),非自由字符串;其他 agent 填 runAsUser 报错(config.ts 校验)。
- gateway 启动 **fail-fast** 验证 OCHEAL_UID/GID 存在且非 0。
- **隔离 worktree 由 broker(root/deploy 用户)创建 + chown ocheal**;ocheal **无权写主仓 .git**(只写自己 worktree)。
- **独立 verifier**(broker 侧进程)跑四层测试,产出 **HMAC 签名的 verification result**(签名密钥对 ocheal 不可读);broker cutover 只信任签名 verification + 自核 canonical ancestry(是 feat/v5-aurora-rewrite 后代)。
- broker = **ACL 保护的 Unix socket**(非 TCP);ocheal 可连但只能提交结构化请求(`{sha, verification_ref, action_kind, params}`)。
- broker 执行 **自持的可信部署驱动**(broker 内置/锁定的部署流程),**绝不 source 候选工作树里可被 codex 改的 deploy-v5.sh**。
- 行为测试:读 `/proc/<pid>/status` 断言 codex 及其工具子进程 uid=ocheal;越权写 .git/读 secrets 被拒。
- 效果:"codex 不可绕过 broker" = OS 级证明,非 prompt 纪律。

## MAJOR-final
1. **0133 backfill + NOT NULL + admin 兼容**:存量行 `mode='probe'`、`snapshot=COALESCE(last_payload,'{}'::jsonb)`、`observed_at=COALESCE(last_evaluated_at,last_transition_at,now())`、`observation_seq=0`、`condition_rev=0`;回填后 mode/snapshot/observed_at/observation_seq/condition_rev SET NOT NULL(ADD DEFAULT→backfill→SET NOT NULL,在线安全)。level 枚举=info|warning|critical,存量从 last_payload.severity 映射,缺省 warning。**condition key 含冒号**(ops.monitor:svc_v5)与 ack route 现校验 `[a-z0-9_.]`(adminAlerts.ts:956)冲突:**首版 alerts 页 ack 只作用 legacy polled conditions(无冒号 rule_id)**,新 condition 管理走新 selfheal 页;不动 ack route 校验(零风险)。
2. **三级 seq/rev 分离**:`observation_seq`(每 probe 刷新,仅 freshness fence 用,不推送)/ `condition_rev`(仅 phase|level|用户可见 policy 输入语义变化 ++)/ `incident.rev`(仅用户可见 status|severity|message|audience 变化 ++)。snapshot 里延迟/计数轻微波动**不触发 updated 推送**(消除 update 风暴)。
3. **inbox 幂等定案(两者都要)**:inbox 加 `(source_type, source_id, source_phase)` 唯一键(最终防线)**且**同 PG 事务内 `INSERT inbox + mark delivery sent`(消除正常崩溃窗口)。WS 外发保持 at-least-once(前端 rev 幂等)。

## 收敛说明
R1→R3 BLOCKER 6→4→4(内容逐层加深,方向已稳);R3 全部给出明确正确做法,v4 为定案誊清。所有 BLOCKER 解法均落到具体 DB function / 迁移 DDL / spawn 参数 / socket 机制,无遗留"实现期二选一"。

---

## 第四章:R3/R4 吸收定案(v5,设计审通过)

# v5 自愈体系 — v5 定案(吸收 Codex R4,设计审通过)

R4 剩 2 BLOCKER 定案;Codex 明示"这两处修正后其余七项达可实现闭环,可进入实现"。

## B1-final — 幂等 submit(execution_id) 收口 ledger+queue(消除"accepted 却没 submit")
- worker 反复调**幂等 `submit(execution_id)`**;submit 内部**单事务原子** `INSERT selfheal_executions(accepted) + INSERT durable_turn_queue(execution_id)`;
- 已 accepted → 返回现有执行状态,**不建第二 turn**;
- 后台 executor **只消费 durable_turn_queue**(不由 worker 预插 accepted 再决定是否 submit);
- `accepted` 语义 = "executor 已持久接单",非"worker 准备调 executor"。
- 崩溃恢复:见 queue 未消费项 → executor 拉起;绝无"accepted 但 queue 空"永久吞单。

## B2-final — 独立 clone 隔离(取代 worktree,canonical .git 对 ocheal 零写权)
- broker(root/deploy 用户)从 canonical commit 建 `/home/ocheal/selfheal/<repair_id>` **独立 clone**,整仓归 ocheal;
- clone **不含生产凭据、无可写 canonical remote**;
- codex 在独立 clone 内提交(自己的 .git,可正常 git add/commit);
- broker 经 **bundle/对象导入**取候选 SHA,**不执行候选仓 hooks/config**;
- verifier 从该 SHA 重构干净树跑测试;
- cutover broker 验证候选 SHA 是 canonical(feat/v5-aurora-rewrite)后代后才部署;
- **canonical `.git` 始终不对 ocheal 开放任何写权限**。

## ✅ 设计审结论
Codex 4 轮对抗审(R1 6BLOCKER+12MAJOR → R4 全闭合)。架构 BLOCKER 清零,可进入实现。完整方案 = v2 + v3-delta + v4-delta + 本文件。

## 实施切片(最终)
- **切片① v5 地基**(自包含,不碰生产 OS/个人版):迁移 0133(additive:admin_alert_rule_state 加列 + write_alert_condition PG function + incidents/codex_repairs/codex_repair_events/incident_deliveries/incident_recipients/incident_policies + seed)→ selfheal/ 模块(policy/conditions/incidents/reconciler/sweeper)→ 检测器接入 write_alert_condition → protocol SysIncident → bridge broadcastAll/ToUsers+认证后补发 → web-react 横幅+恢复 toast → admin selfheal 页 → 审计/retention/alertEvents 登记 → index.ts scheduler。**本轮实现目标**,四层测试跑通,不自动部署。
- **切片② codex 联动**(风险高,改个人版生产 OS/鉴权):autossh 隧道+受限 key、个人版 durable job/execution ledger/幂等 submit、uid/gid drop、action+cutover broker、独立 clone verifier、修复 skill。**代码+测试就绪后,部署需 boss 确认**(建 ocheal 用户/改 spawn 权限/改 webhook 鉴权是生产敏感改动)。
- **切片③ 个人版代理主备**(独立):egressSubscription selector+clash_api+ROUTE_RULES、watchdog 移植、systemd。走 release-checklist。
