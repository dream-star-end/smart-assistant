# OpenClaude v3 — 02-DEVELOPMENT-PLAN 变更日志

> 本文件从 `02-DEVELOPMENT-PLAN.md` 头部抽离(2026-05-23),原 1200+ 字符长行
> 嵌头部已挪走,只在主文档保留版本号 + 状态摘要。
> 内容守恒抽离:文本(措辞、标点、圆圈数字、§ 段落引用、`代码标识符`、**加粗标记**)
> 完全保留原文;仅做结构化重排——加 section 标题、在 FAIL/WARN 项之间加空行、把
> 长串 ①②③ 列表拆成独立行,便于阅读。倒序排列(最新在上)。

---

## R6.11.y (codex 第二十三轮 NIT 闭合)

R6.11.y 闭合第二十三轮 NIT:`tickIdleSweep` 注释 whitelist 口径与 §9 3M 对齐。

## R6.11.x (codex 第二十二轮 FAIL 闭合)

R6.11.x 小补丁闭合第二十二轮 FAIL:§13.3 `tickIdleSweep` + `tickPersistentHealth`
显式 `state='active'` + `NOT EXISTS open migration`。

---

## R6.11 (从 R6.10 起,codex 第二十一轮 2 FAIL + 2 WARN 闭合)

R6.10 → R6.11:闭合 codex 第二十一轮 2 FAIL + 2 WARN —

**FAIL1** §4.2/§4.4 ws bridge / lifecycle 仍把"notExist/stopped/running"分支写在桥接层、直接 `supervisor.provision` / `supervisor.startAndWait`,与 §13.3 reader 唯一闸门冲突,实施时极易再次绕开 ledger 检查 → R6.11 把 §4.2/§4.4 全改为"桥接层唯一入口 = `await supervisor.ensureRunning(uid)`",分支下沉到 `ensureRunning` 内部子路径;

**FAIL2** §9 3M CI lint 规则只是"5 行内出现 state 字符串",`SELECT ... FROM agent_containers WHERE state='active'` 不带 migration predicate 仍可通过 → R6.11 把 lint 升语义级"二选一"硬规则:reader 类调用栈要么调 `ensureRunning(uid)`(函数级 `// @oc-reader-entry` 标注白名单),要么 SQL 必须含 `NOT EXISTS (... agent_migrations ... phase NOT IN ('committed','rolled_back'))` predicate;新增 `scripts/lint-agent-containers-sql.test.ts` 三 fixture 负例验证(漏 predicate fail / 加 predicate pass / 白名单 pass);

**WARN1** §13.3 仍含 `if (c.status==='stopped') return await this.start(c)` 旁路 docker start,与 R6.10 "docker start 单点 invariant" 写过头冲突 → R6.11 收窄不变量到 "**open migration 期间** docker start 单点由 reconciler 持有",非迁移期 reader 通过 `supervisor.startStoppedContainer(tx, c)` 合法触发(idle sweep / host restart 后拉起 stopped 容器,行状态本就 active 在 host-agent routable set,无需再 ACK);两条路径正交;

**WARN2** 0019 schema 只有 `(phase, updated_at)` 服务 reconciler 扫描,新加的高频 `ensureRunning` 按 `agent_container_id` 点查会前缀失配 → R6.11 在 0019 加部分索引 `(agent_container_id) WHERE phase NOT IN ('committed','rolled_back')`,§2.5 + §6 + §14.2.6 CREATE 同步;新增 metric `reader_blocked_by_open_migration_total{phase}` 落入 §9 4L 健康面板"compute fabric"区块(持续 > 0/min 黄、> 5/min 红)。

---

## R6.10 (从 R6.9 起,codex 第二十轮 1 FAIL + 0 WARN + 0 NIT 闭合)

**原 R6.9 → R6.10 闭合内容(已稳定,保留)**: 闭合 codex 第二十轮 1 FAIL + 0 WARN + 0 NIT —

FAIL R6.9 `attached_route` Option A 留下的 reader 旁路:`§14.2.4` 把 `attached_route` 定义为 `state='active' + host_id=new`,⑥f 超时后 reconciler 必须重发 routing ACK + docker start 才算收敛;但 `§13.3 supervisor.ensureRunning` 老伪代码只看 `agent_containers.state IN ('active','pending_apply')` + `c.status='stopped'` 时直接 `docker start`,完全不查 `agent_migrations` 表,意味着用户在 ⑥f timeout 后立刻重连,`ensureRunning` 会把"`state='active' + phase='attached_route' + new host_id`"的行直接当成可复用容器返回 `{host:new, port}`,或当 stopped 时绕过 reconciler 路径直接 `docker start` —— 都打穿"docker start 必须在 routing ACK 通过后才能发"的主契约,等价 R6.9 才修好的"创建未应用就不放流量"约束被 reader 旁路漏出来。

R6.10 闭合:
① §13.3 重写 `ensureRunning` 必须 LEFT JOIN `agent_migrations` 上 `phase NOT IN ('committed','rolled_back')` 联合判定;
② phase ∈ {`planned`,`created`,`detached`,`attached_pre`,`attached_route`,`started`} 任一未结束的迁移行 → 直接 throw HttpError(503, 'migration_in_progress', Retry-After=2),**绝不**返回 `{host,port}` 也**绝不** `docker start`,所有 docker start / route 决策由 §14.2.6 reconciler 单点驱动(单点 invariant);
③ §9 3M reader matrix 把 `supervisor.ensureRunning` 行从 `state IN ('active','pending_apply')` 改为 `state IN ('active','pending_apply') AND NOT EXISTS (open migration)`,加 CI lint 规则锁死;
④ §9.6 6G 新增 ⑭hex reconnect-during-attached_route e2e:在 ⑥f 超时后 100ms 内立刻重连,断言 (a) `ensureRunning` 在 reconciler 重发 routing ACK 成功前**必须**返回 503 `migration_in_progress`,(b) 整段时间 `docker start` spy 计数 == 0(只允许 reconciler 路径触发),(c) reconciler 周期跑完后下一次重连才返回新 host/port + 容器进程才 docker start;
⑤ §14.2.6 contract bullets 加 R6.10 一条 "ledger 是 reader 的硬约束:任何 reader 路径(ensureRunning / chat 复用 / cold-start fallback)看到 open migration 必须返 503,docker start 单点 invariant 由 reconciler 持有";
⑥ §14.2.4 (phase,state,host_id,next-action) 表加一列 "reader (ensureRunning) 行为" 显式标 `attached_pre/attached_route/started` 三行 = `503 migration_in_progress`,`planned/created/detached` 三行 = `503 migration_in_progress`(虽然 host_id=old + state=active/draining 看似可用,但 ledger 在锁,统一 503 让重试)。

---

## R6.9 (从 R6.8 起,codex 第十九轮 2 FAIL 闭合)

**原 R6.8 → R6.9 闭合内容(已稳定,保留)**: 闭合 codex 第十九轮 2 FAIL —

FAIL1 R6.8 `agent_migrations` ledger INSERT 落点过晚 + schema 跨节漏同步:R6.8 把 INSERT 放在 §14.2.4 ⑤bis(`docker create` **之后**),意味着 ③ pause + ⑤ docker create 与 ⑤bis 之间任一秒崩(pause-then-crash / create-then-crash)留下"旧 paused 容器 + 可能的新 created-not-started 孤儿 + PG `agent_containers.state` 仍 'active' + 无 ledger 行"的死区,§14.2.6 reconciler 既找不到 `pending_apply/draining` 也找不到 ledger 完全无信号可救;且 0019 schema 仅在 §14.2.6 局部叙述出现,从未进 §2.5 迁移表 + §6 schema 总览,落地时极易漏掉。

R6.9 闭合:
① §14.2.4 把 INSERT 提前到 ① pickHost 之后立即跑(`§14.2.4 ①bis`,在所有 rsync/freeze/create 之前),并新增 `planned` 作为最早 phase(7 改 8 phase);
② `agent_migrations.new_container_internal_id` 列改 NULLABLE(planned 阶段尚未 docker create,无 cid 可填);
③ `paused_at` 也改 NULLABLE 并在 ③ 实际 pause 时同事务 UPDATE 写入(reconciler 据 paused_at IS NULL/NOT NULL 决定是否需 unpause);
④ §14.2.6 reconciler 加 `case 'planned'`(paused_at NOT NULL → unpause old;new_cid NULL → 新容器残留交给 §3H 1h orphan 兜底,因为没有 cid 反查不出来,但崩窗 < 5s 之内最多漏一个未 start 的新容器,可接受);
⑤ §2.5 加 0019_v3_agent_migrations 行;
⑥ §6 schema 列表加 `agent_migrations` 一行;
⑦ §9.6 6G 加 ⑭quad / ⑭quint 两个 e2e 注入测试覆盖 pause-then-crash / create-then-crash;

FAIL2 §9.6 ⑭bis/⑭ter 与 §14.2.4 / §14.2.6 phase/state/ACK 契约三处口径不一致:
(i) ⑭bis(a) 写 phase='created' 但实际 ⑥a 同事务推进到 'detached',测试断言定义本身就错;
(ii) ⑭ter 老版说 ⑥f 超时回滚到 `pending_apply` + ledger 'attached_route',但 §14.2.6 attached_route 恢复路径直接 docker start + commit,不经过 routing ACK 屏障 → "创建未应用就不放流量"主契约被打穿;
(iii) §14.2.4 generic rollback 写"⑥d 之后 host_id 切回旧",但 §14.2.6 attached_pre/route 恢复策略是"以新 host 为准推前",两条路线互斥。

R6.9 选 Option A(以新 host 为准推前)统一全篇:
① 在 §14.2.4 开篇引入 **(phase, state, host_id, next-action)** 唯一对照表;
② 修 ⑭bis(a) phase='detached';
③ 重写 ⑥f 超时分支:**不**回退 state、**不**切 host_id,只 force-rm 旧 paused 容器 + 留 phase='attached_route' 等 §14.2.6 推前;
④ 重写 §14.2.6 attached_route 恢复路径:**必须重发 routing ACK**(`tickHostAgentReconcile` 已确保 hot map 同步,但要主动 INCREMENT host_state_version + NOTIFY + ACK pollHostAgentApplyVersion 通过)再 docker start 再 commit;
⑤ §14.2.4 generic rollback 措辞改为"⑥c 之后(host_id 已切到新)走 attached_pre/route 恢复路径,不再回滚 host_id";
⑥ ⑭ter 测试断言改为"docker start 必须在 reconciler 重发 routing ACK 通过后才被调用"补 R6.9 主契约

---

## 历史状态摘要

- codex 十轮 APPROVE(R5f)
- R6.11 第二十四轮 APPROVE
- R6.11.x 小补丁闭合第二十二轮 FAIL
- R6.11.y 闭合第二十三轮 NIT
