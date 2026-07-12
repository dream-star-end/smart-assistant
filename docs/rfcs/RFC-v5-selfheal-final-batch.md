# v5 自愈体系收尾批次设计(H1b/H2-cancel/B1/M1-M5/L1/B3 + 个人版 block C)

> 基线:RFC-v5-selfheal-ops.md(4轮设计审 PASS)+ 两侧已 landed 的 16 commit。
> 本文只写**增量**;所有条目均有取证支撑(file:line 见调研纪要)。
> 原则:v5 未全量=走最优解;检测状态单一权威=write_alert_condition;OS 级不可绕过。

## A. v5 侧

### A1. H1b — manual resolve 风暴 → suppression(压制直至恢复)

问题:probe 类 condition 仍 firing 时 admin resolve,当前实现 writeCondition(firing=false) 关掉 condition,但下轮探测(≤2min)重写 firing=true → reconciler(≤10s)重开 incident → 重新推送。反复 resolve = 风暴。本质:**operator 决定与探测权威打架**——把探测权威改成 false 是"说谎",必然被下一轮真实观测推翻。

根治:**suppression 语义 = "我知道了,压制投影,直到 condition 真实恢复"**,不篡改检测权威。

- 迁移 0135(additive):`admin_alert_rule_state ADD COLUMN suppressed_until_clear BOOLEAN NOT NULL DEFAULT FALSE, suppressed_at TIMESTAMPTZ, suppressed_by TEXT`。
- write_alert_condition(0135 CREATE OR REPLACE,基于 0134 版):firing 真翻转 → false 时**自动清 suppression**(恢复后新一轮故障必须重新告警,tombstone 自动过期)。
- 列域划分:检测列(firing/mode/level/snapshot/observed_at/seq/rev/occurrence)= function 专写;operator 列(ack_*、suppressed_*)= 应用直写。M1 trigger 按此划分放行。
- reconciler:
  - open 循环:`c.firing && !c.suppressed` 才投影(suppressed 不开 incident)。
  - resolve 循环:`cond.firing===true && !cond.suppressed` 才 continue;即 suppressed+firing 的遗留 open incident 会被 resolve(source='admin'),幂等兜底。
- repairDispatcher 守卫 INSERT 加 `AND NOT COALESCE(c.suppressed_until_clear,FALSE)`(压制中不派修)。
- admin 路径(adminResolveIncident 改 mode-aware)。**判定表(R2 定案:以 condition.mode 为准,policy.resolve_mode 不参与分支)**:
  | condition 状态 | 动作 | 响应 |
  |---|---|---|
  | 存在且 firing,mode='probe' | suppressCondition(operator 列)+ resolveIncident('admin') | `suppressed_until_clear` |
  | 存在且 firing,mode∈latched/spike | writeCondition(firing=false) CAS 关 + resolveIncident('admin') | `condition_closed` |
  | 不存在或已 !firing | 仅 resolveIncident('admin') | `condition_already_clear` |
  - 理由:mode 是检测权威属性(能否被探测推翻),resolve_mode 是文案/生命周期语义。交叉组合 `probe+manual policy`(=system.maintenance_on)走 suppress:压制 banner 但维护继续,关维护开关→firing=false→suppression 自动清,语义自洽。补交叉组合测试。
  - 审计 detail 带 resolution 字段。
- 新增 admin 端点:`GET /api/admin/selfheal/conditions?suppressed=1`(列被压制 condition)+ `POST /api/admin/selfheal/conditions/unsuppress {conditionKey}`(误压回滚,audit tx)。admin selfheal 页加"已压制"区块。
- 测试:probe 仍 firing 时 resolve → 不重开(reconciler N 轮零新 incident)/ condition 恢复 → suppression 自动清 / 恢复后再故障 → 正常重开 / unsuppress 后下轮重开 / latched 路径回归不变。

### A2. H2-cancel — incident 恢复时主动取消已派 repair

现状:sweeper 已有完整 cancel 驱动(cancel_requested→cancelling→postCancel→cancelled,失联 fail-closed),缺"恢复时触发"。

- `resolveIncident()`(incidents.ts,同事务):
  `UPDATE codex_repairs SET status='cancel_requested', updated_at=NOW() WHERE incident_id=$1 AND status IN ('pending','dispatched','acked','running')` + 逐行 INSERT repair_event(kind='cancel', message='incident resolved — cancel requested')。
  - `verifying` 不取消(那是成功归因路径,verify fence 自会裁决)。
  - `pending` 也走 cancel_requested 而非直接 cancelled:**关闭派单竞态**(dispatcher 可能已 POST 未 markDispatched;个人版可能已接单)。由 sweeper postCancel 统一走远端确认。
- **cancel 端点契约统一(R2 BLOCKER1 修)**:canonical path = `/api/webhooks/v5-selfheal-cancel`(v5 dispatcher 已实际 POST 此路径);个人版**改注册此路径**,走与 dispatch 完全相同的信任链(loopback+size+ts+HMAC+nonce),废弃 `/internal/selfheal/cancel` 旧路由。
- **terminated 语义定案**:以下情形均返回 `terminated=true`——①未知 repair → 原子插 tombstone 成功;②job 在 received/starting(session 未起)被 CAS 成 cancelled;③已存在 cancelled 墓碑(幂等);④live session teardown 确认完成。仅"终止状态不确定"(session 存在但 kill 未确认)才 false。消除 pending/无会话取消永久占槽。
- tombstone 行 NOT NULL 列取值:incident_id=cancel body 携带的 incidentId、attempt=0、payload_hash='tombstone'、status='cancelled'。迟到 dispatch 撞 `ON CONFLICT(repair_id) DO NOTHING` 不执行。
- **执行侧原子 fence(R3 BLOCKER1 + R4 BLOCKER 修,闭合"取消后迟到 submit"全窗口)**:
  - **per-repair 临界区**(keyed async mutex,key=repair_id,selfheal 运行时持有):
    - worker 路径:持锁内完成——job 状态终检(fresh read ∈ starting/running)→ `starting→running` CAS(**必检返回值**,失败=cancel 抢先→销毁 session、禁 submit、按 cancelled 收尾)→ `claimQueuedTurn` → **engine submit(turn 注册为可 interrupt)**→ 释放锁。
    - cancel 路径(R5 修,durable 确认态):持同一锁内——
      - 未知 repair → tombstone `cancelled`;job 在 received/starting 无 session → 直接 CAS `cancelled`;
      - **live session → 先写 durable 中间态 `cancelling`**,teardown(interrupt 已注册 turn/销毁 session)**确认成功后才 CAS `cancelling→cancelled`**;teardown 不确定 → 持久停留 `cancelling`,后续 cancel 重试继续 teardown;
      - **`terminated=true` 当且仅当 durable 状态=cancelled**(崩溃/重启后依然可裁决,绝不把"曾 teardown 失败"误报为已终止而错误释放 v5 singleflight 槽)。
    - selfheal_jobs status CHECK 枚举加 `cancelling`(个人版 selfheal.db 尚未在生产落盘,DDL 直接改;store 启动时对旧 schema 做幂等重建守卫)。
    - worker 状态 fence 同时拒绝 `cancelling`/`cancelled`。
    - 序化结果:cancel 先赢 → worker 锁内终检见 cancelling/cancelled,零 submit;worker 先赢 → cancel 锁内必见已注册 turn,teardown 确认后才 terminated=true。
  - SQLite 事务守卫保留(入队/消费均查 job.status IN starting/running)作为第二道防线。
  - **单进程前提显式登记**:个人版 gateway=单 node 进程(better-sqlite3 进程内嵌,多进程本就非受支持部署形态);此临界区为进程内 mutex,若未来多进程化须升级 flock 跨进程 fence(登记 playbook 约束)。
  - 确定性时序测试:cancel-first / worker-first 两种交错 + "claim 后 cancel"原 case。
- redispatchPending 只选 pending → cancel_requested 自然被跳过,无需改。
- 测试:resolve 后 active repair 全部进 cancel_requested / verifying 不动 / sweeper 驱动 postCancel(mock)到 cancelled / pending 竞态(cancel 先于 markDispatched)不复活。

### A3. B1 — 检测桥 wiring

1. **condition-key 常量注册表** `selfheal/conditionKeys.ts`:`opsMonitorKey(check)`、`providerDegradedKey(providerId)`='health.provider_degraded:<id>'、`SYSTEM_SESSION_OVERSIZED`、`SYSTEM_MAINTENANCE_ON` 等;policy/检测器/测试统一 import。
2. **v5-monitor.sh 写 condition**:每轮对 11 项 check 生成 `SELECT write_alert_condition('ops.monitor:<name>','probe',<firing>,'<sev>','<snapshot json>'::jsonb, now())` 语句,**聚一次 psql -f 批量执行**(复用 DBURL,失败 `|| true` 不破坏 monitor 主流程,并 syslog 记录);计划维护窗口内被压制的 check(svc_v5/http_v5/public_route)同样跳过 condition 写(部署窗口不误开 incident)。文件头登记 bash⇄TS 契约(key 派生规则 ↔ conditionKeys.ts)。
   **激活门(R2 HIGH4 修)**:condition 写入整体 gate 在 `V5MON_CONDITIONS=1`(从 ENV_FILE grep,同 DATABASE_URL 手法),**默认关**;monitor.sh 随 release 上线后不会自动开始投影,部署 smoke 通过后显式在 commercial-v5.env 置 1 激活(激活即时生效,oneshot 每轮重读)。部署 smoke 加一步:激活前核对 `SELECT rule_id FROM admin_alert_rule_state WHERE firing` 无 stale firing 行(防新 reconciler 首启用旧 legacy condition 误开 incident)。
3. **provider key 对齐**:providerHealthScheduler ruleId 改 `health.provider_degraded:<providerId>`(conditionKeys 构造);0135 UPDATE seed:`health.provider_degraded` exact → prefix `health.provider_degraded:`。旧 `provider_health:*` 行成为无 policy 死行(良性,部署后可清)。
4. **session_oversized → latched,per-user key(R2 HIGH3 修)**:condition key 改 `system.session_oversized:<uid>`(conditionKeys 构造);0135 UPDATE seed:exact → prefix `system.session_oversized:`。snapshot={kind,bytes,user_id},incidents.ts 既有物化(识别 snapshot.user_id)直接命中;每用户独立 incident 生命周期,recipient 快照天然闭合。基数受控(oversized 在热尾巴 spill 根治后是罕见护栏事件)。
5. **maintenance_on 写点**:systemSettings emitSystemSettingChangeAlert maintenance 分支挂 `writeCondition(SYSTEM_MAINTENANCE_ON,{mode:'probe',firing:on,...})`;开维护=全站 banner incident,关维护=firing false → reconciler 自动 resolve(与 seed resolve_mode='manual' 不冲突:reconciler 本就只看 firing)。
6. **补 seed policy**(0135,ON CONFLICT DO NOTHING):`ops.monitor:mem`(prefix,warning,probe,auto_repair TRUE)、`ops.monitor:image`(prefix,critical,probe,auto_repair FALSE)。
7. **E2E integ 测试**:octest PG 全链路——SELECT write_alert_condition('ops.monitor:svc_v5',bad)→reconcileOnce→incident open(文案来自 policy)→write ok→reconcileOnce→resolved;provider degraded→incident;oversized 两次 occurrence→单 incident occurrence_count=2;policy 覆盖断言:对每个生产 producer key 用 matchPolicyIn 断言命中(契约测试,防 key 域再漂移)。

### A4. M1 — 单写权威 DB 强制(独立迁移 0136,**cutover 后 apply**)

- trigger `guard_alert_condition_write` BEFORE INSERT OR UPDATE ON admin_alert_rule_state:
  - `current_setting('oc.selfheal_condition_writer',true)='1'` → 放行;
  - 否则(R3 HIGH2 修,**反向白名单**):UPDATE 时要求 `to_jsonb(OLD) - {operator 列}` IS NOT DISTINCT FROM `to_jsonb(NEW) - {operator 列}`——即**除 operator 白名单(ack_* + suppressed_*)外任何列(含 rule_id 主键、未来新增列)都不可直写**,新列默认受保护(fail-closed)。
  - 否则 RAISE EXCEPTION。INSERT 一律须 function 上下文。
- write_alert_condition 函数体首行 `set_config('oc.selfheal_condition_writer','1',true)`,RETURN 前复位 ''。
- **0136 apply 时机(R2 HIGH1 修,双重门)**:①新 master(function 写路径)已上线;②**回滚池内不再有直写检测列的旧 release**——hotcfg 回滚目标=最近 N 个 release,须等 selfheal 之后的 release 把直写版全部挤出回滚窗口(或显式核对 `deploy-v5.sh --rollback` 候选全部 ≥ selfheal 合并点)才 apply。在此之前 0136 只进仓不 apply,登记 playbook §5 债表(触发条件=回滚池核对通过)。requiredMigrations 记账:0133/0134_selfheal/0135 随首个 cutover release 登记;**0136 在 apply 之后的下一版 metadata 才登记**(先登记会挡部署)。

### A5. M2 — capability 防重放

- token 加 jti(16B hex):sig=HMAC(secret,`repair-callback.${repairId}.${attempt}.${exp}.${jti}`),token=`${attempt}.${exp}.${jti}.${sig}`。
- 0135 新表 `selfheal_capability_uses(repair_id BIGINT, jti TEXT, action TEXT, used_at, PRIMARY KEY(repair_id,jti,action))`:done/failed 回调 INSERT ON CONFLICT DO NOTHING,冲突=重放 → 409。progress/ack 天然可重复不记账。**JTI 消费与 repair 状态 CAS + repair_event 写入同一 PG 事务(R2 MED2 修):事务失败 JTI 一并回滚,合法重试不会被误 409**。
- verify 窗口固定:`verify_after`/`verify_deadline` 改 set-once CAS(`WHERE verify_after IS NULL`),重复 verify 不再延窗(消"重复 verify 续命")。

### A6. M3 — webhook HMAC 绑路由 + nonce 落库

- 签名串两侧统一改 `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`(dispatcher signWebhook / master claim-capability 校验 / 个人版 receiver 校验 / 个人版 jobWorker 签名,四点同改;未部署无兼容包袱)。
- master 侧 nonce 落 PG:0135 `selfheal_webhook_nonces(nonce TEXT PK, seen_at TIMESTAMPTZ)`,INSERT ON CONFLICT DO NOTHING 原子判重,sweeper tick 顺手 DELETE seen_at < now()-10min。个人版 SQLite 已持久化 ✓ 不动。

### A7. M4 — 脱敏自由文本清洗

- 新 `selfheal/redact.ts`:`redactOpsPayload(value)` = auditRedact.redactSensitive + 深度字符串清洗(保守模式:`sk-\w{8,}`、`Bearer \S+`、`ghp_/gho_/xox[bap]-`、`AKIA[0-9A-Z]{16}`、URL userinfo 凭据、`password=/secret=/token=` 尾随值)。**不改全局 auditRedact**(长 hex 在 admin 审计里是合法 request id,全局清洗误伤)。
- 应用点:repairContext 输出、selfhealRepairs safeDetail、selfhealOps admin detail。

### A8. M5 — 派单 URL SSRF 钉死

- selfheal/config.ts 启动校验(dispatch 启用时):OC_SELFHEAL_DISPATCH_URL 必须 `http://` + host∈{127.0.0.1,localhost,[::1]} + 显式端口,否则 fail-fast。
- dispatch/cancel fetch 全部 `redirect:'manual'`,3xx 按失败处理。

### A9. L1 — inbox 幂等键带 rev

- sweeper inbox 写入 source_phase:`updated` 相位改 `updated:${incident_rev}`(opened/resolved 每 incident 语义唯一,保持不变)。零 DDL。测试:rev 2/3 两条 updated 各落一条 inbox;同 rev 重放仍一条。

### A10. B3 — 配置收口

- `selfheal/config.ts`:`assertSelfhealConfig()` 启动时调(index.ts 装配处):
  - DISPATCH 启用(=0/false)时:MASTER_SECRET≥32、WEBHOOK_HMAC≥32、两者互异、DISPATCH_URL 过 M5 校验,缺一即 throw(fail-fast 拒启);
  - 禁用时仅 warn 摘要;数值 env 解析归一(tick/cooldown/budget)。
- env 落点:kl-mirror `/etc/openclaude/commercial-v5.env` 增 OC_SELFHEAL_{MASTER_SECRET,WEBHOOK_HMAC,DISPATCH_URL,DISPATCH_DISABLED=1,AUTO nothing};/root/.secrets 双机留底(部署步骤,非代码)。

## B. v5 admin/前端增量

- admin selfheal 页:已压制 conditions 区块(list+unsuppress);repair 详情加"待放行"状态展示 + **一键放行按钮**(POST /api/admin/selfheal/repairs/:id/release,audit tx)→ master 经隧道 POST 个人版 `/api/webhooks/v5-selfheal-release {repairId}`(HMAC 同 dispatch)。
- resolve 响应文案区分 suppressed/closed 两种结果(toast)。

## C. 个人版 block C

### C1. broker/verifier 接进运行时
- server.ts:selfheal 启用且 `OC_SELFHEAL_BROKER_SOCK` 设置时(命名对齐 /root/.secrets/v5-selfheal/env-reference.txt 既有参考) `new SelfhealBroker({socketPath, ochealGid, canonicalDir(默认 /opt/openclaude/openclaude-v5-aurora), autoDeployTier2, deployDriver, notifyPendingRelease}).start()`;stop() 挂关停链。
- `notifyPendingRelease` 生产实现:企微 webhook 直发(qyapi 国内直连,禁代理),内容=repairId+sha+摘要+"到 admin 页一键放行"。
- `deployDriver` 生产实现(R2 BLOCKER3 + R3 BLOCKER2 修,两层):
  1. **部署工具链不可变守卫(执行前置硬门)**:driver 在 ff-merge 前核 `git diff --name-only <canonical_head>..<sha>` 不得触碰 denylist(`scripts/**`、`deploy/**`、`.github/**`、**整个根 `package.json`**——不解析 scripts 段,整文件拒;`*.sh` 任意路径);触碰 → 强制 pending_release + 告警标注"改动部署工具链,须人工线下审",**永不自动部署**(AUTO_DEPLOY_TIER2=1 也不例外),release 通路对这类 repair 也拒绝(只能 boss 线下走标准 deploy)。
  2. **守卫通过后直接执行 merge 后 canonical 的 deploy-v5.sh**:因 denylist 覆盖脚本及其全部控制依赖,merge 后脚本字节≡pre-merge 受信版本(diff 已证),`BASH_SOURCE→REPO_ROOT` 语义天然正确;不再做临时副本(R3 指出副本会把临时目录认作 REPO_ROOT,不可行)。
  3. **诚实边界(不可消除,显式登记)**:部署本身(远端 build/运行)必然执行候选代码——由 verification(降权四层测试)+ ancestry + 放行门(默认人工)控制;这是"部署"的固有语义,非绕过面。
  失败回报 broker → repair 进 failed 路径 + 企微告警。

### C2. 修复工作流闭环(codex 侧能力)
- **prepareClone 时机**:jobWorker.processJob 在 submit 前(root 进程内直调 verifier.prepareClone)建 `/home/ocheal/selfheal/<repairId>` 独立 clone,clone 路径进 buildRepairPrompt。
- **`oc-selfheal` CLI**(新,包内 bin,ocheal PATH 可用):子命令 `context|verify|cutover|done|failed|progress`,全部**只连 broker socket**(结构化请求),不持任何长期凭据。
- **broker 新增 kinds**(在 allowlist 框架内):
  - `context {repairId}`:broker 用 root 持有的 capability 经隧道 GET master context,透传结构化结果;
  - `verify {repairId, sha}`:broker 调 verifier.verify(降权四层测试)→ 签名落盘,返回摘要;
  - `report {repairId, outcome(done|failed|progress), detail}`:broker 用 capability 经隧道回调 master(脱敏+长度上限);
  - **release 不是 socket action(R2 BLOCKER2 修,结构隔离)**:broker socket allowlist 显式拒绝 `release` kind(ocheal 可连 socket,不可信其自称来源)。release 仅两个入口,都终结到 broker 实例的**进程内方法** `releaseApproved(repairId)`(gateway root 进程持有 broker 实例):①receiver 的签名 release webhook(HMAC 验过=来自 v5 master=boss admin 点击);②本机 break-glass:root-only 内部端点(loopback + 个人版全局 token,token 属 root)。`releaseApproved` 重验 broker_actions 里的 pending_release 记录 + 重跑 ancestry → deployDriver。
  - 以上均走既有 broker_actions durable 幂等 claim。
- capability 全程只在 root 侧(jobWorker 取得后存 selfheal_jobs.capability 列,broker 读),**绝不进 codex prompt/env**(M-capability 落实)。

### C3. release 通路(boss 一键放行)
- receiver 新端点 `/api/webhooks/v5-selfheal-release`(同 dispatch 信任链:loopback+size+ts+HMAC+nonce)→ broker 进程内 `releaseApproved(repairId)`(**非 socket action**)。
- 效果:v5 admin 页按钮 → master 隧道 POST → 个人版 receiver → `releaseApproved` 重验(pending_release 记录 + ancestry + denylist)→ 部署。全链审计(v5 audit tx + broker_actions + repair_events)。

### C4. cancel 端点(与 A2 同一契约,此处只留索引)
- 全部语义定案见 A2:canonical path=`/api/webhooks/v5-selfheal-cancel`(dispatch 同信任链),旧 `/internal/selfheal/cancel` 路由**删除**;tombstone/terminated 四情形/执行侧 fence 均以 A2 为准。

### C5. MED16 + 代理主备收尾
- `/api/egress-proxy/refresh` 改调 `resyncEgressSelector`(selector 已迁移时;未迁移 fallback refreshEgressNodes)。
- 首次迁移入口:`scripts/egress-selector-migrate.ts`(root CLI,调 migrateEgressToSelector,部署窗口一次性执行)。
- watchdog systemd 两单元 + `/etc/openclaude/egress-watchdog.env`(EGW_WECOM_KEY_FILE)provision 步骤入清单。

### C6. provision 脚本(幂等,root)
- `scripts/selfheal-provision.sh`:建 ocheal 用户组/home、`/home/ocheal/selfheal`、`/var/lib/openclaude-selfheal/verifications`(0700);校验 setpriv;安装 oc-selfheal 到 ocheal PATH;agents.yaml 注册 codex-v5ops(runAsUser:ocheal,provider:codex-native,runnerKind:app-server)提示或自动补;env 模板注入 service env;广播 socket 目录权限。
- 隧道:`deploy/openclaude-selfheal-tunnel.service`(autossh——**本机未装,provision 先 apt install autossh**;key=/root/.secrets/v5-selfheal/tunnel_key 已 stage;-R 127.0.0.1:18795:127.0.0.1:18789(kl-mirror 上监听 18795→本机个人版 gateway)/ -L 127.0.0.1:18796:127.0.0.1:18790(本机 18796→kl-mirror v5 master healthz 同端口 18790),StrictHostKeyChecking=yes,ExitOnForwardFailure=yes);kl-mirror authorized_keys 限权行(restrict,no-pty,permitopen="127.0.0.1:18790",permitlisten="127.0.0.1:18795")——部署步骤。
- env 值:kl-mirror OC_SELFHEAL_DISPATCH_URL=http://127.0.0.1:18795;本机 OC_SELFHEAL_CALLBACK_URL=http://127.0.0.1:18796。密钥用 /root/.secrets/v5-selfheal/{master-secret,webhook-hmac,verification-hmac} 既有 stage 值(双机同步 master/webhook 两个)。

## D. 部署顺序(两侧,严格序;R2 BLOCKER4 修:每步显式重启点+生效核对)
1. **个人版代码面**:合并→safe-restart(selfheal env 未设=dormant,零行为变化)→常规 smoke。
2. **v5 面**:PG apply 0133→0134→0135(additive,在线;kl-mirror schema_migrations 记账,文件名去 .sql)→ 合并 canonical(迁移登记 release-metadata.json requiredMigrations;**0136 不登记不 apply**)→ env 先写 OC_SELFHEAL_*(**OC_SELFHEAL_DISABLED=1** + DISPATCH_DISABLED=1 双关,R3 HIGH1:reconciler/sweeper 整体不启,杜绝部署后 10s 内投影 stale condition)→ deploy(hotcfg 链路,master+dist+monitor.sh 随 release,部署自带重启)→ smoke + **核对 effective config**(healthz/日志确认 selfheal 未装配;V5MON_CONDITIONS 未设)。
3. **观察层激活**:stale inventory——`SELECT rule_id,firing FROM admin_alert_rule_state WHERE firing` 逐行处置(legacy 死 key 如 provider_health:* 关闭)→ commercial-v5.env 置 V5MON_CONDITIONS=1 + 删 OC_SELFHEAL_DISABLED → **restart openclaude-v5** → 全链 smoke:monitor 写 condition→incident→WS banner/inbox→admin 页(无派单,DISPATCH_DISABLED=1 仍在)。
4. **执行侧激活**:本机 provision 脚本(ocheal 目录/oc-selfheal/agents.yaml/broker env 含 OC_SELFHEAL_BROKER_SOCK/回调 env)→ **safe-restart 个人版** → 核对 broker socket 就位+receiver 200(签名探测)→ apt install autossh + 隧道单元启动(受限 key)→ kl-mirror 侧 DISPATCH_DISABLED=0 + **systemctl restart openclaude-v5** → 核对 dispatch enabled → 合成 incident E2E:派单→ack→context→修复→verify→pending_release→企微→admin 一键放行→done→探测 fence→resolved→恢复推送。
5. **0136 writer-guard**:等回滚池核对通过(全部候选 ≥ selfheal 合并点)→ apply 0136 → 下一版 metadata 登记。未通过前登记债表。
6. watchdog + selector 迁移(独立小窗口,release-checklist)。
7. 记忆+playbook 固化(0136 顺序铁律/监控激活门/release 通路)。

## E. 测试矩阵增量
- v5 unit:suppression 全场景/H2-cancel 状态迁移/capability jti 重放 409/HMAC 路由绑定负例/SSRF 校验/redactOpsPayload/config fail-fast。
- v5 integ(octest PG):B1 E2E×3 类 + policy 覆盖契约 + nonce 落库重放拒 + 0136 trigger(直写检测列被拒/operator 列放行/function 路径放行)。
- 个人版:broker context/verify/report/release kinds/cancel tombstone/CLI 参数面/MED16 resync 路由。
- 基线法:commercial unit 与 aurora tip 基线 diff;web-react 全绿;typecheck 0。
