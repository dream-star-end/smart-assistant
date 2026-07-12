# RFC: master 侧会话权威从 SQLite 迁 PG（P2）

状态:**设计审 PASS**(Codex 4 轮:R1 三 BLOCKER→R2 开关矛盾→R3 权威状态机→R4 prepared 栅栏→PASS)
实现提醒(Codex 随 PASS 附带):①终态推进到新一代 prepared 时显式清 source_digest/completed_at 为 NULL;②"单调推进"=generation 单调+authority 只走允许转换(灾难恢复环 pg_authoritative→sqlite_disaster_recovered→prepared→pg_authoritative 合法)
分支:feat/v5-sessions-pg
日期:2026-07-11

## 1. 动机(三合一)

1. **双 master 并发前提(P3 分批部署)**:蓝绿交接窗口内两个 master 进程并存。SQLite 单写者模型下两进程写同一 .db 文件靠 busy_timeout 碰运气;PG MVCC+行锁是并发权威的正确工具。
2. **灾备覆盖**:sessions.db(172MB,会话正文)当前只有小时级快照(RPO≤1h);PG 流复制已上线(kl-hk,replay lag 45ms)。迁入 PG 后会话正文 RPO 降到秒级。
3. **多机前置债**:playbook 已登记"cronWake rescan 是 self-host 假设";会话权威落 PG 是未来任何多机形态的先决条件。

v5 未上线 = 重构窗口,本迁移一次做对,不留双轨。

## 2. 范围

**迁(master 进程独有的表)**:
- client_sessions(热尾巴+水位列)
- client_session_archive_chunks / client_session_archived_ids(归档)
- server_authored_request_map / pending_usage_patches(usage 聚合)
- wechat_bindings(活跃,生产 5 行)
- ~~team_runs / team_delegations~~(已裁决:旧重量级团队模式整套废弃,schema 已不声明——不迁)

**不迁(容器内 gateway / 个人版语义)**:
- sessions_meta / sessions_fts*(session_search MCP,容器内)
- event_log / usage_log(容器内计费/事件 ground truth)
- client_sessions_archive(单数,旧运维脚本一次性备份表,运行时零引用——已裁决不迁,SQLite 留档)

## 3. 架构设计

### D1 分层与注入(单一权威,零双轨,调用点零改动)
- 取证:gateway/server.ts 与 commercial 各处均按**函数名直接 import** storage 的 sessionsDb(server.ts:82-86 等)。改所有调用点=大面积无谓 churn。
- 设计:**swap 点内置于 storage/sessionsDb.ts**——master 表的每个导出函数保持签名,内部改为委托 `backend.xxx(...)`;模块内默认 backend=现有 SQLite 实现(代码原地抽为 sqliteBackend 对象)。新增 `setClientSessionsBackend(b: ClientSessionsBackend)` 一次性注入口(重复注入 throw,防双跑)。
- `ClientSessionsBackend` 接口=master 表全部操作(TypeScript 强制 PG 实现完整覆盖,漏一个方法=编译错)。
- **PG backend 实现在 packages/commercial**(pg 依赖已在);storage 侧接口用最小结构类型 `{ query(sql, params): Promise<{rows}> }` 描述连接,**storage 不新增任何依赖**。
- registerCommercial 的 master 形态(channel=v5 且非容器)调用 setClientSessionsBackend(pgBackend);容器内 gateway/个人版不加载 commercial → 天然 SQLite,行为零变化。
- 驱动选择权威 = composition root 一处;禁止函数内 if(pg) 分支。
- 开关与**权威状态机**联动(R2/R3 BLOCKER 消歧,启动规则矩阵):
  | sessions_store_migration_state | env OC_SESSIONS_STORE | 行为 |
  |---|---|---|
  | 无行(基建先行期) | 未设 / sqlite | SQLite 启动 |
  | 无行 | pg | fail-closed 拒起(未割接) |
  | authority=pg_authoritative | pg | PG 启动(先自检关键列+类型+generation) |
  | authority=pg_authoritative | 未设 / sqlite | **fail-closed 拒起**——env 同步遗漏不得静默退回 SQLite 重造双权威 |
  | authority=prepared | **任意** env/manifest 组合 | **fail-closed 拒起**(迁移进行中,master 不许起) |
  | authority=sqlite_disaster_recovered | sqlite + 本地灾难 nonce 匹配 | SQLite 启动(灾难过渡态) |
  | authority=sqlite_disaster_recovered | 未设 / pg / nonce 不匹配 | fail-closed 拒起 |
  | **所有未列出组合** | — | **默认 fail-closed** |
  非法 env 值一律拒起。正常代码回滚**不能**通过删 env 回到 SQLite;只有灾难反灌流程(持有效 cutover nonce)能推进状态到 sqlite_disaster_recovered。**状态行首次建立后永不删除,只单调推进 generation 与 authority**——"无状态行"从而永久只表示首次基建期,不会与"迁移进行中"混淆(R4 BLOCKER)。PG 不可用时读不到 PG marker→**本地权威 manifest 文件**($OPENCLAUDE_HOME/sessions-store-authority.json,{authority, generation, cutoverId})与 PG 状态行双写,正常启动要求两者一致,灾难态按本地 manifest+nonce 裁决。**双写故障恢复协议(R4 MAJOR)**:manifest 写入=临时文件+fsync+原子 rename;顺序固定=PG 事务 commit 成功后才 rename manifest(崩在中间→两者不一致→启动拒起=安全态);提供 `repair-manifest` 子命令(带 cutoverId/nonce)——**只能把 manifest 收敛到已验证的 PG generation,永远不能自行提升 authority**;对"双写前/rename 后/PG commit 前后"逐点 fault-injection 测试(§9)。
  删除触发条件:P3 上线且生产稳定 2 周后删 sqlite 选项(登记 playbook 债表)。

### D2 PG schema(0134_sessions_master_pg.sql)
- **权威状态机表**(R3 BLOCKER#2,随 0134 建):`sessions_store_migration_state(singleton PK, authority CHECK IN ('prepared','pg_authoritative','sqlite_disaster_recovered'), generation BIGINT, cutover_id TEXT, source_digest TEXT, completed_at BIGINT)`。**backfill/re-cutover 起手事务**(R4):写 `prepared`+分配新 generation/cutoverId+(需要时)同事务清六表→commit——此后任何 master 启动尝试都被 prepared 态拒起;全量灌+全量校验通过后才推进 `prepared→pg_authoritative`(同事务写 source_digest/completed_at)。状态行只推进不删除;backfill 脚本不执行任何未登记 DDL。
- 表名与列名保持一致;TEXT 毫秒时间戳→BIGINT;messages/chunk JSON→**TEXT**(整存整取语义不变,TOAST 自动压缩行外存储;不用 JSONB——无查询需求,拒付 parse/serialize 双份转换税)。
- 复合主键照搬(session_id,first_seq)/(session_id,msg_id)/(request_id,user_id)。
- 4MB 上限/软阈值搬移逻辑不变(应用层机制,与存储无关)。

### D3 事务与并发(本迁移的正确性核心;Codex R1 修订)
- 接口方法=事务粒度(现状即如此,8 处 db.transaction 全部函数内自含)。
- PG driver:`withTx(pool, fn)` 包 BEGIN/COMMIT,fn 收 client。
- **读-改-写必须行锁**:先 `SELECT ... FOR UPDATE` 锁 client_sessions 行再 merge/分配 _seq。
- **request 键串行点(R1 BLOCKER#1)**:`FOR UPDATE` 锁不住不存在的行——appendServerAuthoredMessageForRequest 与 appendCostCredits 对同一 (user_id,request_id) 的"双 miss 交错"会产出 map 与 pending 并存、成本永不 patch。修:**所有 request-keyed 路径事务开头先取 `pg_advisory_xact_lock(hashtextextended('oc_sarm:'||user_id||':'||request_id, 0))`**,构成事务级串行点。
- **统一锁序**:request advisory → client_sessions 行 → server_authored_request_map → pending_usage_patches → archive 表(单向,防死锁);与既有 PG 锁序(users→subs)无交集。
- **map 不可重映射(R1)**:request_map 已存在时必须校验 (session_id,msg_id) 与本次一致,不一致=fail-closed 抛错(禁 ON CONFLICT DO NOTHING 静默吞)——防同用户错误复用 requestId 时成本错挂。
- **appendCostCredits 可实现锁序(R2 MAJOR#4,防实现者先 FOR UPDATE map 破坏锁序)**:①取 request advisory lock ②**非锁定读** map 仅用于定位 session_id ③hit→锁 client_sessions 行 ④再 `SELECT map FOR UPDATE` 复核 locator 未变/未被 GC 删,消失则按 miss 重新决策(禁用陈旧 locator)⑤锁 pending ⑥执行 mutation。
- **逐事务要求(R1 MAJOR#2 表)**:drainByUser/drainDelegateCost 先锁 session 行、再按确定顺序 `FOR UPDATE` 锁本批 pending 行(SELECT 后新插入的行留给下一轮=正确语义);sweepGc 分表短事务且按 map→pending 同序,**只由 fencing 持有者执行**——机制=PG advisory lease:`pool.connect()` 取**专用连接**独占持锁(绝不用 pool.query 取锁、持锁期间绝不归还池,连接 error/end 立即停 sweepGc/WechatManager、新连接重新竞锁成功才恢复,unlock 失败销毁连接;专用连接纪律复用 db/migrate.ts:118 既有范式,R2 MAJOR#3+R3 MAJOR#1);delete 需处理 late-cost——目标会话已软删时 appendCostCredits 返回 noop 不再 park,且 delete 级联清 parent_session_id 指向该会话的 delegate pending(防永不 drain 的孤儿)。

### D3b updated_at=DB 计算的逻辑版本(R1 BLOCKER#3)
- 现状 stale-write 检测比较 `existing.updated_at > baseSyncedAt` 且写回客户端提供的 updatedAt——双 master 下同毫秒双写/时钟偏差/客户端回传旧值都能击穿,造成静默覆盖 title/pinned/客户端消息。
- 修:updated_at 语义升级为**逻辑版本**,一切写路径(upsert/append/cost-patch/rename/claim/delete)由 DB 计算推进:`GREATEST(current.updated_at + 1, floor(epoch_ms(clock_timestamp())), requested)`——严格单调、时钟偏差被 cur+1 兜底、对客户端向后兼容(数值仍是 ms 时间戳量级,协议零改动)。
- SQLite backend 同步采用同一公式(单进程下行为等价,双 backend 语义一致)。

### D4 数据割接(R1 BLOCKER#2 重写:权威链永不分叉)
- 部署解耦为两步,消除"回滚无 PG 代码可用"问题:
  1. **合并基建 release**(backend+委托+0134,OC_SESSIONS_STORE 未设=SQLite):生产先跑一段,行为零变化(回滚安全的真正保证=capability gate,见下,不依赖"目录里都是新 release"的假设)。
  2. **割接窗**(停机 ~1-2min):stop master → backfill(见下)→ env 加 OC_SESSIONS_STORE=pg → start → smoke。
- **backfill 不是"DO NOTHING 幂等"(R1/R2)**:要求目标 6 表为空 → 全量灌 → **全量校验**后才写 backfill-complete marker:六表按 PK 排序逐行全列确定性 digest 对比(所有 TEXT payload——messages/chunk/pending/map/wechat token+cursor+whitelist——全量 hash,非抽样;抽样仅作人工 smoke)+count+PK 集合+next_seq>max(_seq)+归档水位不变量。任何不一致 fail-closed。
- **清表栅栏(R2)**:清非空目标不是裸 --wipe——须同时满足:master 已停(systemd is-active 检查)+显式迁移方向子命令(`retry-initial` / `re-cutover-from-sqlite`)+cutover nonce 文件核对+打印清理前 count/digest 并要求交互确认+六表同一事务内清。首灌重试与灾难重割接是**两个不同子命令**,不共用开关。
- **回滚语义(单向权威链)**:割接后 PG 即唯一权威。回滚=翻回**声明 `sessions-store-pg-v1` capability 的前序 release**——release-metadata.json 加 capabilities 字段,**deploy-v5.sh 在割接后拒绝激活无此 capability 的 release**(旧蓝绿目录里的老 release 不会被一次普通 rollback 误启,R2 MAJOR#5)。业务代码回退,会话权威不动,零分叉。**禁止**回退到 SQLite 权威;灾难场景(PG 不可用)反灌的数据源必须明确=已 promote 的 kl-hk replica 或最新 verified pg_dump(按其 RPO 恢复并停流/只读过渡,不存在可读副本时不假装无损),之后重割接=SQLite 全量覆盖 PG(re-cutover 子命令),不做双向合并。
- 旧 sessions.db:**六张迁移表逻辑冻结**(权威已在 PG,任何写=bug);SQLite 文件本身仍可写——继续承载副产物表(fts/meta/event/usage)。
- 生产执行前在 kl-hk 预发环境全流程演练(P1d 现成,含真容器)+ 性能准入(§8)。

### D5 healthz/监控
- master 形态 deps.sessionsDb 改探 PG store(SELECT 1 + 六表关键列与类型校验 + authority=pg_authoritative 且 generation 与启动时一致——防 marker 漂移;非仅 to_regclass);字段名不变,smoke 断言不变。
- 归档/搬移的既有日志与 oversized 告警路径不变。

## 4. 明确不做

- 不做 SQLite/PG 在线双写对账(数据量小,停机窗全量割接更简单可靠)。
- 不做 messages 拆行(逐消息一行)。热尾巴+归档 chunk 的整存整取模型刚上线且已解决 4MB 事故类,拆行是另一个 RFC 的事,本迁移保持存储模型同构,只换引擎。
- 不动容器内 sessions.db 与个人版。

## 5. 调研闭环(Explore 测绘完成,全部裁决)

- ✅ 个人版/legacy(sink==null)走 sessionManager directWrite→本地 SQLite 权威 → **SQLite backend 全量保留,行为零变化**。v5 容器 server-authored 走 sink 转发 master,不写本地 client_sessions。
- ✅ master 库 event_log 125 行=gateway eventPersist.ts 无条件订阅 eventBus 写入(fire-and-forget,.catch 吞错,与 client_sessions 无事务耦合)→ **event_log/usage_log/sessions_meta/sessions_fts 不迁**,master 本地 sessions.db 继续承载这四张副产物表(权威在容器侧;master 上是审计/召回旁路)。
- ✅ team_runs/team_delegations 已废弃(schema 已不声明,teamRunStore 整套删除)→ 不迁。
- ✅ client_sessions_archive(单数)=旧运维脚本 sessions-fix-oversized.ts 的一次性备份表,运行时零引用 → 不迁,SQLite 留档。
- ✅ 事务原子集 8 个已枚举(测绘 §5):upsert / append / appendForRequest(四表) / drainByUser / appendCostCredits(四表) / drainDelegateCost / sweepGc / delete(级联)。PG 实现按此逐个对齐,RMW 全部 SELECT...FOR UPDATE。
- ✅ backend 接口范围:client_sessions 读写 18 函数(纯 helper 不进接口,直接复用)+ readArchivedMessages + sweepUsageAggregationGc + wechatBindings 模块 8 函数 + probe。_spillOverflowCore 的决策逻辑按 D6b 抽为 mutation-plan 纯函数,backend 不复制业务逻辑。
- ✅ healthz:probeSessionsDb 改为委托 active backend(master=PG,探"会话 list/save/落库"真实权威);master 本地 SQLite 的副产物表不进探活(与现状语义一致——它们 fire-and-forget)。
- ✅ msgOutbox:master 恒空 no-op(commercial 走 plain append),不动。

### D6b 分层防漂移(R1 MAJOR#1)
- 把 merge/seq/spill/usage-patch/delegate 累加的**决策逻辑抽为 engine-neutral 纯函数**(mutation plan:输入=当前行快照+增量,输出=待执行变更集 {tailUpdate, chunksToInsert, idsToInsert, watermarks, pendingOps}),两个 backend 只做:取锁→读行→调 plan→执行变更集。业务语义单一权威,双 backend 不各养一份。
- PG backend 独立文件(不进 3095 行的 sessionsDb.ts)。
- **contract tests**:同一套行为测试参数化跑双 backend;PG 侧另加双连接 barrier 并发套件(见 §9)。
- **架构测试**:禁 backend/迁移工具以外代码对 6 张权威表直接 SQL(grep 断言)。

### D7 BIGINT codec(R1 MAJOR#3)
- node-postgres 默认把 BIGINT 返回 string——PG backend 行 mapper 显式 Number() 转换+`Number.MAX_SAFE_INTEGER` 越界断言;**不改全局 type parser**(不影响 commercial 其他模块)。

### D8 wechat 补强(R1 MAJOR#4)
- upsertWechatBinding 本身是 RMW(读 owner→继承字段→UPSERT):PG 侧单事务+锁 user/account 行;23505 唯一冲突转专用 WechatAccountAlreadyBoundError(不依赖 SQLite 错误文本)。
- 双 master 双跑 long-poll worker 重复消费:WechatManager 与 sweepGc 同用 **PG advisory lease fencing**(session 级 advisory lock,持有者掉线锁自动释放、备者接管;不依赖 env 布尔)。P3 交接清单登记。

## 5b. 旁路调用面裁决(R1 MAJOR#5)
- storage/sessionsMigrate.ts(v3→v5 历史迁移工具):列清单已过期(缺水位列)——标注 deprecated + 拒跑 master 形态(README 注明只适用 SQLite 形态历史场景)。
- scripts/v5-daily-check.sh 会话统计:割接后改查 PG(割接 checklist 项)。
- scripts/v5-sessions-spill-archive.ts / sessions-fix-oversized.ts:SQLite-only 工具,头注标注"master 割接 PG 后不再适用于生产,仅个人版/留档库"。
- openclaude-v5-backup.service / DR runbook(/opt/v5-dr/README.md):更新"会话正文权威=PG(流复制+夜间 pg_dump),sessions.db 快照降级为副产物表兜底"。
- getSessionsDb() 仍公开(副产物表合法使用)——旁路写权威表由架构测试拦。

## 8. 性能准入(R1 MAJOR#6,预发演练必测)
- 热尾巴整存整取在 PG 的写放大是本设计已知代价:每次 append 重写 ≤2MB TEXT 行进 WAL+流复制。
- kl-hk 演练量化:每 turn WAL bytes(pg_stat_wal 差分)/replica lag/TOAST 膨胀/autovacuum 频次/同会话并发锁等待/2MB 行 append p95、p99。
- **准入线**:p95 append < 150ms、复制 lag < 5s(24Mbps 链路)、单 turn WAL < 6MB。超线→先降热尾巴软阈值(2.5MB→1MB)重测;仍超→逐消息存储另立 RFC,本迁移不带病上线。

## 9. 并发测试清单(R1,双连接 barrier 控制交错)
- N 并发 append:零丢消息、_seq 唯一且严格递增
- upsert(stale baseSyncedAt) vs append/rename/delete:逻辑版本单调、旧快照 PUT 被拒
- appendForRequest vs appendCostCredits 双 miss 两种提交顺序:advisory lock 下恒收敛(map 有则 patch、无则 pending,绝无并存)
- cost patch vs by-user/delegate drain 交错;同 requestId 重放+错误重映射 fail-closed
- spill vs delete 交错:无孤儿 chunk
- 割接演练:backfill 校验全绿;灾难反灌路径全量校验
- PG backend 全套 contract tests 与 SQLite 结果逐字段一致
- 权威状态机穷举测试(矩阵全组合含未列出组合默认拒起)/prepared 中途崩溃(master 拒起)/manifest-PG mismatch 修复(repair 只收敛不提升)/advisory lease 持锁连接掉线交接

## 6. 实施切分

1. storage:接口+backend registry+sessionsDb/wechatBindings 委托化(SQLite 实现原地重组,零行为变化)
2. commercial:pgSessionsBackend(8 事务+读路径+wechat+probe,复用纯函数)+registerCommercial 注入(OC_SESSIONS_STORE=pg 显式开关,生产 env 加)
3. 迁移与割接:0134(已写)+scripts/v5-sessions-backfill-pg.ts(**只做空目标全量+全量校验 fail-closed**;首灌失败重试与灾难反灌后重割接是两个显式子命令,无 --since/无静默幂等)
4. 测试:现有 storage 测试守 SQLite 不回归;**同一套行为测试参数化双 backend 跑**(PG 侧走真 PG,commercial integ 模式);commercial unit 基线对照法
5. 预发全流程演练(kl-hk):apply 0134→backfill→OC_SESSIONS_STORE=pg 重启→smoke(list/读/写/归档分页/成本回填)
