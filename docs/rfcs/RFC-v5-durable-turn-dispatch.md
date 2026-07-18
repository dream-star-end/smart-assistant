# RFC: v5 Durable Turn Dispatch(根治静默丢 turn)

状态:设计 PASS(Codex 5 轮,thread 019f7320-69c9-7042-b447-5d5b0b449662,2026-07-18)
分支:feat/v5-durable-turn;迁移号 0170(生产 ledger 已核至 0169,apply 时复核)

## 0. 背景与根因

2026-07-18 事故(boss 会话 webmrmw489m2ka6ne,trace a61a2d39):用户消息受理落库后,
master 挂历史 22s 期间手机 WS 断连,userChatBridge 三条异步派发路径的
`if (cleaned) return` 把已受理 turn 静默丢弃;容器 autoResumeFromHello 又按
"上一轮 outcome"推合成 turn_completed reconcile,把前端等待态清空。零痕迹。

根因三条(架构级一类洞):
- R1 turn 执行所有权寄生在瞬态 client WS bridge 生命周期;
- R2 无持久面回答"这条 user 消息是否产出对应 turn"(对称性权威缺失);
- R3 容器合成 reconcile 判据不绑定 turn 身份(拿上一轮 outcome 冒充)。

## 1. 不变量(验收标准)

- I1 受理即拥有:受理成功(单事务)后,turn 在有限时间内要么执行到终态,要么变成
  用户可见失败(error projection + 重试)+ 运维告警。永不静默。
- I2 at-most-once 执行:容器 durable inbox 是执行去重权威;negative proof 只能由
  durable rejected tombstone 提供,绝不由"内存为空/GET 无行/不可达/超时"推断。
- I3 单一权威三对象:master turn_dispatches(逻辑 turn+租约)/ gateway durable
  inbox(执行准入+永久去重)/ lossless tape+retry queue(结果内容)。turn_traces
  降级为纯 per-attempt 观测(记 dispatch_id/request_id 供展示,不参与任何判定)。
- I4 reconcile 绑定身份:一切合成终态帧携带 clientMessageId;未知身份不冒充终态。
- I5 钱安全:已计费内容永不丢(late tape 仍完整 materialize);"未执行未计费"文案
  只在 durable not_accepted 证明下出现;财务歧义一律 manual_reconcile+告警。

## 2. master:turn_dispatches(0170)

```sql
CREATE TABLE turn_dispatches (
  dispatch_id uuid PRIMARY KEY,
  user_id bigint NOT NULL,
  session_id text NOT NULL,
  client_message_id text NOT NULL,
  agent_id text NOT NULL,
  model text,
  request_hash text NOT NULL,           -- sha256(text + sorted media refs)
  billing_request_id text NOT NULL,     -- 受理时铸,attempt 稳定,接管复用
  attempt_no int NOT NULL DEFAULT 1,    -- v1 恒 1,为未来 outbox 铺底
  status text NOT NULL CHECK (status IN ('admitted','accepted','rejecting','terminal','manual_reconcile')),
  outcome text CHECK (outcome IN ('completed','interrupted','crashed','executed_error','not_accepted')),
  failure_code text,
  conflict_reason text,
  resolution text, resolved_at timestamptz,   -- manual_reconcile 人工收敛
  client_notified boolean NOT NULL DEFAULT false,
  owner_id text, lease_epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  anchor_seq bigint,                    -- 受理事务内记录 user 行 _seq(projection 排序)
  admitted_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz, terminal_at timestamptz, last_attempt_at timestamptz,
  UNIQUE (user_id, session_id, client_message_id),
  CHECK (status <> 'terminal' OR outcome IS NOT NULL),
  CHECK (status <> 'rejecting' OR terminal_at IS NULL),
  CHECK (outcome <> 'not_accepted' OR status IN ('terminal')),
  CHECK (status <> 'manual_reconcile' OR conflict_reason IS NOT NULL)
);
CREATE INDEX idx_turn_dispatches_open ON turn_dispatches (admitted_at)
  WHERE status IN ('admitted','accepted','rejecting');

CREATE TABLE turn_dispatch_error_projections (
  dispatch_id uuid PRIMARY KEY REFERENCES turn_dispatches(dispatch_id),
  user_id bigint NOT NULL, session_id text NOT NULL,
  client_message_id text NOT NULL, error_code text NOT NULL,
  anchor_seq bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX idx_tdep_session ON turn_dispatch_error_projections (user_id, session_id)
  WHERE revoked_at IS NULL;

ALTER TABLE request_finalize_journal ADD COLUMN dispatch_id uuid, ADD COLUMN attempt_no int;
ALTER TABLE usage_records ADD COLUMN dispatch_id uuid, ADD COLUMN attempt_no int;  -- 无 FK,永久保留值
ALTER TABLE client_session_turn_tapes ADD COLUMN dispatch_id uuid, ADD COLUMN attempt_no int;
ALTER TABLE turn_traces ADD COLUMN dispatch_id uuid, ADD COLUMN request_id text;   -- 纯展示
```

retention(auditRetention 登记):terminal(resolved)90d;manual_reconcile 永不
自动 GC,resolved_at 落表后才计 90d;open 行永不 GC,open>7d 告警。
projections:revoked 90d;active 随 dispatch。

### 2.1 受理事务 admitUserTurn()(pgSessionsBackend 新方法)

单 PG tx:幂等 append user 行(既有 message id 幂等)→ 取该行 _seq → UPSERT
dispatch(ON CONFLICT 逻辑键)。冲突表:
- 无行 → 插入 admitted + lease(owner=本 bridge,epoch=1)+ billing_request_id 铸造 → 返回 {kind:'admitted', dispatch}
- admitted ∧ lease 活 → {kind:'already_owned'}(bridge 回 busy 帧,不开第二条 IIFE)
- admitted ∧ lease 过期 → CAS epoch++ 接管(同 attempt transport retry)→ {kind:'admitted'}
- accepted → {kind:'in_flight'}(busy 帧)
- terminal ∧ completed → {kind:'deduplicated'}(既有 outbound.ack deduplicated)
- terminal ∧ not_accepted/executed_error/crashed/interrupted → {kind:'previously_failed'}(幂等错误帧;前端重试会铸新 clientMessageId)
- rejecting → {kind:'in_flight'}
- manual_reconcile → {kind:'manual_hold'}(拒绝帧"正在人工核对")
- request_hash 不一致 → {kind:'immutable_conflict'}(错误帧,不动状态)
受理失败(PG 异常)= 拒轮(可重试 error 帧),无半受理(tx 原子)。

### 2.2 bridge 改造(userChatBridge)

- B1:所有关闭 containerWs 的入口收敛唯一 shouldEnterDrain();checkDrainComplete
  统一双 map(inflightCodexTurns + pendingAdmittedDispatches);drain 窗口
  max(readDrainBillingMs(), OC_DISPATCH_DRAIN_MS 默认 60s,硬上限 120s)。
- 受理为帧处理第一个 await(在 attach 之前);持 lease 期间长窗口 attach 中心跳续
  (heartbeat 匹配 owner_id+lease_epoch+status='admitted')。
- ensureRequestIdServerSide → 读 dispatch.billing_request_id;startInflightJournal
  同事务写 journal.dispatch_id/attempt_no;journal 已存在(接管)→ 读行严格比对
  (user/dispatch/attempt/model/billing snapshot),不一致 → manual_reconcile。
- descriptor:master 铸 __oc_dispatch Ed25519 envelope(model authority 同套基建),
  签名覆盖 {uid, containerId, dispatchId, attemptNo, sessionId, clientMessageId,
  payloadHash, connectionChallenge, expiry};浏览器侧同名字段无条件剥离。
- 三条 IIFE 的所有 pre-forward 失败出口 → dispatch CAS terminal(outcome=
  executed_error 或 not_accepted 视阶段)+ failure_code + client_notified(送达即 true)。
- bridge 观测到自己的 dispatch 变 rejecting/terminal → 立即补偿(journal abort/
  slot release/route expire)并停止转发。
- capability 门:容器 attest 无 durable-turn-dispatch-v1 → legacy 路径(不建
  dispatch 行,现状语义);census 100% 后 env 可强制 v2-only。

### 2.3 turnDispatchReconciler(leaderBundle shared + trackScheduler)

周期 30s+jitter,LIMIT 50,全 CAS:
- admitted ∧ lease 过期 ∧ age>max(120s,5min):
  CAS(epoch 匹配)→ rejecting → POST 容器 reject-if-absent →
  - 回执 rejected tombstone → terminal(not_accepted)→ fail-visible 流程
  - 回执已有行(queued/running/…)→ CAS accepted(转下分支)
  - 容器不可达/404/无 capability → 保持 rejecting 重试;>30min 运维告警,不碰用户面
- accepted ∧ age>stuck 阈值(resolveStuckThresholdMs 同款向上夹,≥max(codexMax*2,90min)):
  查容器 inbox 状态:sink_staged/terminal → 等 sink(无 TTL 必达;>24h 告警);
  running → 等;sink_stage_failed / 行消失 → manual_reconcile+告警。
- terminal(not_accepted/executed_error)∧ client_notified=false:
  联查 journal(按 dispatch_id 直查+锁行,单 tx snapshot)+ usage_records:
  无 journal 或 aborted 零 usage → INSERT error projection(幂等 PK)文案免单 tone;
  存在非 aborted journal / usage → manual_reconcile,绝不写"未计费"。
  告警 outbox dedupe_key=dispatch_id。成功后 client_notified=true。

### 2.4 tape finalize 收敛(pgSessionsBackend finalizeLosslessTurnTape 同事务)

- tape header 列读 dispatch_id/attempt_no(幂等 replay 分支同样可用,不依赖 parts);
- dispatch 非终态 → CAS terminal + outcome=tape.status 映射(completed→completed,
  interrupted→interrupted,crashed→crashed);
- dispatch 已 terminal(not_accepted)→ 完整 materialize(钱安全 I5)+ UPDATE
  projection revoked_at + dispatch→manual_reconcile(conflict_reason='late_tape')+告警;
- dedup-ACK 只认 terminal∧completed。

### 2.5 error projection 读侧

单一投影 helper:full get / sync 增量 / archive 分页三边界共用;虚拟行
id=`oc-dispatch-err:<dispatch_id>`,排序键 (anchor_seq, 1, dispatch_id);
引擎历史注入(_masterHistoricalMessages)用不含 projection 的原始读取,失败提示
永不进模型上下文。

## 3. gateway/容器:turn_dispatch_inbox(sqlite,storage 包)

```sql
CREATE TABLE turn_dispatch_inbox (
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','recovery_pending','sink_staged','sink_stage_failed','terminal','rejected')),
  outcome TEXT CHECK (outcome IN ('completed','interrupted','crashed','not_accepted')),
  agent_id TEXT, turn_index INTEGER, turn_key TEXT, request_id TEXT, created_at INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, client_message_id),
  UNIQUE (dispatch_id, attempt_no)
);
```
- 无 payload BLOB(boot 不重放签名帧);identity 行永久保留(dedup 权威),
  session 硬删级联清;healthz 曝 open-job 数+字节;
- INSERT 仅不存在才插(严禁 OR REPLACE);accepted/running/terminal 永不被
  higher attempt 覆盖;重复到达只返回现有行状态(bridge 由此 CAS accepted);
- fsync 成功才 beginClientTurn;INSERT queued 成功后一切 enqueue/beginClientTurn
  异常必须 CAS rejected(not_accepted),不留给 boot;
- 进入 running 与 finalize 元数据(agent_id/turn_index/turn_key/request_id/
  created_at)同 sqlite 事务提交,先于模型调用;
- 模型终态 → retryQueue.stageDurable(entry 带 dispatchId/attemptNo)fsync 成功
  → sink_staged;master ACK → terminal;stage 失败 → sink_stage_failed+告警;
- boot recovery(开放新 ingress 前单飞完成):
  queued → CAS rejected(not_accepted);
  running → recovery_pending → ①本地 retry queue 有同 dispatch/attempt entry →
  sink_staged;②否则查 master tape/dispatch 终态(none/partial/finalized 三态):
  finalized → terminal;partial → sink_stage_failed+manual(不生成异 hash tape);
  不可达 → 保持 recovery_pending 重试,禁止推断;master 的 tape state 与同租户
  dispatch lease 由**单条 PG statement 同快照**返回;none+活 lease → 保持
  recovery_pending(周期 sweep 在 lease 失活后重试),none+失活 lease → 构造确定性 synthetic
  crashed tape(用 inbox 持久化的 turn_key/request_id/created_at/turn_index,
  多次恢复同 tapeId/hash;最小诚实错误记录 {status:'crashed', text:'',
  errorCode:'SERVICE_RESTART', errorDetail:'任务因服务重启中断,未能恢复已生成内容'})
  → stage → sink_staged。
- 端点(inboundDispatcher 同款 transport/HMAC,含 tunnel 路由):
  POST /internal/v3/turn-reject-if-absent {dispatchId, attemptNo, 逻辑键} →
  事务:有行返状态;无行插 rejected tombstone;
  GET /internal/v3/turn-dispatch-state?…(reconciler accepted 分支查询)。
- descriptor:gateway 验签 __oc_dispatch(Ed25519,校验 connectionChallenge/expiry/
  containerId)→ private map → strip wire 字段;一切非验签入口(HTTP/cron/
  delegate/本地)无条件 strip;非 webchat-DM channel 即使带字段走 legacy;
- runtime capability `durable-turn-dispatch-v1`(release metadata + attest)。
- planned runtime recycle:host 先 arm gateway ingress + SessionManager submit 双内存闸,
  再查 SQLite 是否仍有 `running` 行;任一活跃/读失败/查询期间 gate TTL 到期均非 200
  延后回收。重叠握手串行化,后请求不触碰先请求保留的闸;只有双闸仍 armed
  且 durable running=0 才允许 stale runtime replacement。
- CCB 引擎:dispatch 身份并入 model-authority envelope 转发至 egress,
  modelAuthorityGate 验签核对(uid/containerId/billingRequestId/dispatchId/
  attemptNo/expiry),proxyBilling settlement 与 usage INSERT 写 dispatch_id/attempt_no。

## 4. reconcile 身份对称(Layer 3)

- 容器 per-session recent-terminal ring(cap 8:clientMessageId→outcome);
- hello.peers[] 可选 inFlightClientMessageId(前端带 _activeClientMessageId);
- autoResumeFromHello 决策表:
  running 匹配 → status 重播;ring 命中 completed → turn_completed reconcile
  (帧携带 clientMessageId);ring 命中中断类 → interrupted reconcile(带 id);
  未知 → meta:{reconcile:'turn_state_unknown', clientMessageId} 非 final 帧
  (前端立即 forceSync+缩短 safety 定时);字段缺失(legacy)→ 旧行为;
- 合成帧一律携带 clientMessageId;reducer 按 exact clientMessageId 归属。

## 5. 前端(web-react)

- hello 带 inFlightClientMessageId;
- turn_state_unknown → 立即 reconcileSession + safety 定时降至 60s;
- sync/merge:同 _clientMessageId 的服务端终态行(含 error projection 虚拟行)
  到达 → 清 _sendingInFlight + user 行错态(显式收敛,vitest 锁);
- projection 虚拟行渲染为既有 error 卡(errorPresentation 加 dispatch_lost/
  SERVICE_RESTART 映射,免单 tone);同 _clientMessageId 存在非 error 终态行时
  抑制 error 行(双保险);
- 重试:user 行带 dispatch 失败标记 → retry 铸新 clientMessageId;
  resend-uncertain 继续复用旧 id(dedup 保护)。

## 6. 上线序(v5-commercial-deploy 矩阵)

1. 0170 人工 apply+记账(先复核生产 ledger)+ release-metadata requiredMigrations;
2. gateway runtime release(inbox+端点+capability+ring;老 master 无感)+
   runtimeStale 滚动 → capability census;
3. master+web 同批一次 --with-dist(admission 按容器 capability 分流,census
   100% 前混跑安全);
4. smoke:真 turn canary + 故障注入演练脚本。
回滚:任一面独立回滚安全(新字段全可选;无 capability → legacy;negative proof
只在 capability 确认后启用)。

## 7. 故障注入测试清单(全部行为断言)

1. inbox fsync 后 enqueue 前 kill → boot rejected(not_accepted)→ fail-visible;
2. running 后模型返回前 kill → recovery 协议三态;
3. retry entry fsync 后 sink_staged 前 kill → boot ①路径不生成重复 tape;
4. master ACK 后 local terminal 前 kill → boot ②路径 finalized→terminal;
5. lease 过期 heartbeat/takeover/rejecting 三方竞态(epoch fence);
6. duplicate frame 跨双 master → inbox 单执行;
7. journal 已存在的 takeover → 严格比对复用/不一致 manual;
8. partial tape + 本地 queue entry 丢失 → sink_stage_failed+manual,无异 hash tape;
9. late true tape → projection 撤销+完整 materialize+manual_reconcile 单事务;
10. CCB/Codex usage_records 均带 dispatch identity。
11. planned recycle 在 running/SQLite 失败/gate 查询中到期时均延后,无在飞行才 200;
12. 真实 1s periodic tick 与首达+重复帧重叠:重复 unmark 不拆首达 live 引用,
    首 tick 跳过、settle 后次 tick 才收敛;none+活 lease 同样延后 synthetic。
13. 两个 recycle handshake 重叠:后请求返回 busy 且不释放先请求已受理双闸;
    双闸 TTL 真到期后才允许新一轮评估。

## 8. 登记债(诚实权衡)

- master 自动重派 outbox(v1 不做):planned recycle 已由 drain+短 lease 双闸保护,
  但真容器/宿主崩溃时已经生成而未 stage 的内容仍只能落确定性 SERVICE_RESTART
  诚实失败。触发条件=dispatch_lost 告警月频>3 或 boss 要求零触达恢复;
  receipt/attempt/billing_request_id 已铺底。
- sink outbox 并入容器 sqlite 单事务(消除跨 durable 面消歧协议):简化债,
  触发条件=boot recovery 消歧协议出现实际误判事故。
- attach 22-31s 性能(独立批次);codex relay PATH_NOT_ALLOWED(独立批次)。
- 范围=webchat DM 带 clientMessageId 双引擎;wechat/research/delegate 不并入。
- **reconciler 求证 tunnel transport(remote-host)**(M3,v1 不做):v1 为 self-host 范围。
  reconciler 的 resolveRunningEndpoint 对 remote-host 容器(compute_hosts.name≠'self')打 tunnel
  标记 → containerDispatchClient(supportsTunnel=false)归 unreachable → 保持 rejecting 重试 +
  30min 告警,**绝不 false-dial bound_ip**(可能误命中同网段无关主机 = 伪 negative proof)。触发
  条件=有 remote-host 容器进入生产 + dispatch 需跨 host 求证;届时注入 tunnel-aware transport
  (复用 inboundDispatcher slice 4c 的 tunnel impl)。
- **前端 SERVICE_RESTART(crashed 不可变 tape)重试判据(M5)**:crashed synthetic tape 由 gateway
  写、内容不可变,无法回填 master 的 `_dispatchTerminal` 标记。故前端对这类行仍按稳定协议码
  (service_restart)识别(DISPATCH_LOST_ERROR_CODES)。projection 路径已完全去枚举化(id 前缀 +
  `_dispatchTerminal` 标记)。若未来要对 crashed tape 也走纯标记,需读侧 materialize 时按
  tape.dispatch_id+status 注入标记(非 immutable payload)——债,触发条件=新增 crashed 类终态码
  需前端识别时。

## 9. 会话读物化投影(併批治理:20s 白屏 / 挂历史 22-31s;设计 v2,Codex 4 BLOCKING 修订)

事故面:boss 会话 42 卷 tape 共 192MB,chat/exact 全量水合一次 19.7-20.1s。既有事实:
引擎历史下游本就截到 48 行/18k 字符(bridge)+ 40 行/14k(gateway)——为此水合 192MB
是纯读放大。

### 9.1 机制(物化投影为主,窗口折叠仅作罕见兜底)

- **新表 tape_chat_projection**(0170 并入):PK(session_id,user_id,tape_id),
  rows JSONB(该卷的 chat 投影行,**逐记录 64KB 截断**,截断处 `_truncated:true`
  + `_fullBytes`;行字段与今日水合产物同构:clientMessageId/status/usage 等判定字段
  完整保真),total_bytes,created_at。**finalize 同事务写入**(不碰原 tape)。
  **总量硬上限**(Codex v2-B1):per-tape 投影 ≤ 512KB / ≤ 512 行(超限尾部截断
  + `_projectionTruncated` 卷级标记);chat 单次响应投影总量 ≤ 8MB / ≤ 2000 行,
  超限从最老卷起折叠——record 数与卷数无上限的会话仍恒有界。
- **chat 读**:两阶段——先读 anchor + 投影表(header-only,不触 tape BYTEA);有投影
  → 直接用(恒小);无投影(存量卷)→ **惰性自愈回填**:本次读最多水合
  OC_BACKFILL_BYTES(默认 16MB)的卷并同步写投影;**单卷 > 预算的按 part 分段回填,
  配投影构建状态机**(Codex v3-B1):投影行持久化
  `state(building|complete|truncated)` + `next_part` + `tape_sha256`;分段写按
  next_part CAS 推进(WHERE state='building' AND next_part=$n,防并发 lost-update;
  tape hash 漂移 → 作废重建);**读侧只有 complete/truncated 可展开,building 一律
  返回折叠**——半成品永不冒充完整投影。不可收敛的畸形卷 → 终态 truncated(卷级
  标记)+ 分页端点查看,不承诺必然展开。其余卷本次返回**折叠 anchor 行**
  (显式携带 clientMessageId + outcome,从 tape header/dispatch join 取,不假定
  现有 anchor 字段),下次读继续回填直至收敛。**任何异常降级=有界折叠,严禁回退
  全量水合**。
- **折叠行谓词拆分**(Codex §9-B1):finalized 折叠 anchor = 终态存在证据(前端按
  exact clientMessageId 清 in-flight、抑制同轮 projection),≠ 内容已展开;省略/截断
  标记两种证据都不是。前端展开替换按 (_turnTapeId, tapeSha, anchor id) 定位,不按
  共享 _seq 批量替换;maxSeq/totalMessageCount/同步游标按 anchor 计,展开不推游标。
- **引擎上下文**:新增独立 `engine-context` 读(不动 exact 口径与其完整性校验):
  **按 `_seq` 合并** client_sessions.messages 里的 canonical user 行 与 投影表的
  assistant 生成行(Codex v2-B2:投影只有生成记录,user 问题在热行/归档),合并后
  执行与 bridge sanitizer 同构的 48 行/18k 截断——产物与今日等价,不丢用户问题。
  无投影卷同惰性回填。exact(durable/admin 面)保持全量语义不变。
- **超大内容查看**:`GET /api/sessions/:id/tape/:tapeId/records` 游标分页(byte/
  record 双上限 + 单记录解析上限 + 限频),鉴权走既有 session 分租
  ((session_id,user_id,tape_id) 复合条件,越权/不存在统一 404),返回 chat-safe
  投影形态,绝不吐 exact 原始 payload。截断的工具卡显示"已截断,查看完整"。

### 9.2 不变量

- 投影 = 只读缓存派生面,唯一权威仍是 tape 本体;投影行绝不参与 tape 完整性校验、
  usage 结算、dedup/完成证据的**写侧**判定(读侧终态证据字段来自与今日相同的行字段);
- 回填幂等(PK 冲突即已有),回填写失败只影响下次读性能,不影响正确性;
- 降级永远有界:预算异常 → 折叠,引擎 → bounded history + warn,无一路径回到无界水合;
- 「引擎上下文质量」承诺口径 = 与今日 sanitizer 产物等价(48 行文本),不承诺更多。

### 9.3 测试

- finalize 写投影(截断/保真字段)/ 惰性回填(预算内收敛+折叠余量)/ 折叠行显式
  终态字段 / engine-context 与 sanitizer 产物等价断言 / 展开端点分页上限+分租 404 /
  降级路径全有界(注入投影表故障断言不回退全量);
- 集成:192MB 形态复刻——首读部分回填+折叠,二读全投影,chat 读不触 tape BYTEA
  (SQL 层断言);前端折叠卡终态判定/评分卡/projection 抑制不受影响。
