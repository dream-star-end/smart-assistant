# V3 商用版整改任务清单 — 2026-04-25

## 范围
基于 2026-04-25 对 claudeai.chat(v3 生产)做的七维度健壮性审计(前端错误/重连、微信、可观测性、反馈、管理界面、运维、告警)结论,共 **28 项**整改任务。

## 目标
1. **好用** — 用户看到的报错更友好、反馈更顺畅、出错有去处
2. **稳定** — 断线能续、降级能做、故障能止血、备份能恢复
3. **维护方便** — 定位更快、数据能导、运维开关生效、运营工具齐备

## 执行原则
1. 每项改动走 CLAUDE.md 强制工作流: Plan → Codex Review Plan → Implement → Codex Review Code → Iterate → Deploy → 生产验证
2. 分批合并部署,每批 2-5 项,按依赖 + 领域聚合,每批一次 `deploy-v3.sh` + smoke
3. "完成"的最低标准: 生产验证通过 + 证据记录在本文对应条目下

## 整体排期(滚动式,不承诺日期)

| Batch | 内容 | 重点 |
|---|---|---|
| **M1** | P0-1, P0-2, P2-17 | 止血 + 日志噪音(scheduler) |
| **M2** | P0-3, P1-1, P1-2 | 订单 + 反馈闭环 |
| **M3** | P1-3, P1-5, P1-6, P1-8, P2-24, P2-28 | UX + 账务观测 |
| **M4** | P1-4 | 第二告警通道 |
| **M5** | P1-7, P1-9 | 多 tab + 账号诊断 |
| **M6** | P1-10, P2-18, P2-19, P2-20, P2-21 | 运维基础能力 |
| **M7** | P2-14, P2-15, P2-16, P2-22, P2-23 | 可观测性深化 |
| **M8** | P2-25, P2-26, P2-27 | 前端细节 |

---

## 一、P0(生产阻塞/重大装饰开关/运营盲区)

### P0-1 微信通道接通 + 禁用时 UI 提示
- **问题**:生产配置 `channels.wechat.enabled=false`,gateway.ts:88 直接跳过 import,worker 从未启动;前端 `GET /api/wechat/binding` 仍返回 `status=active`,用户扫完码永远收不到消息
- **证据**:`/root/.openclaude/openclaude.json`、`packages/cli/src/commands/gateway.ts:88`、DB 一条 `last_event_at=NULL` 的 active 行,近 48h 日志零条 worker 记录
- **方案**:
  1. 生产配置 `channels.wechat.enabled` 置为 `true`,restart gateway
  2. 代码侧增加防御:`/api/wechat/pair/start` 在 `enabled=false` 时直接 409 `WECHAT_DISABLED`;前端 wechat.js 解析该码显示"服务端未启用微信通道,请联系管理员"
  3. `/api/wechat/binding` 返回增加 `worker_running: boolean` 字段;UI"已绑定"文案根据该字段给出 warning 样式
- **验证**:生产扫码绑定 → 从 iLink 发一条 test 消息 → 日志里看到 worker poll → DB `last_event_at` 刷新 → 前端能收到 inbound 帧
- **状态**: `已上线 v3-20260424T2005Z-8399315`
- **实施记录 (2026-04-25)**:
  - gateway `/api/wechat/pair/start` 已接 409 `WECHAT_DISABLED`;`/api/wechat/binding` 在未绑定时也返回 `channel_enabled`
  - `worker_running` = `enabled × manager.isWorkerRunning(uid)`,Codex IMPORTANT#3 后改为 worker 自报 `running` 标志,crash 后 UI 红字不再假绿
  - 前端 `modules/wechat.js` 同时 setError + toast,避免 banner 被遮时用户无感知
  - 最后一轮 Codex: PASS (NITs 已吸纳或记录)
  - **验证**:远端仍为 `channels.wechat.enabled=false`,gateway/modules/wechat.js 中 `WECHAT_DISABLED`/`channel_enabled` 代码均已就位;真实扫码 E2E 待下次有登录 session 时跑(需真实微信号)

### P0-2 `maintenance_mode` / `allow_registration` 中间件接线
- **问题**:`systemSettings.ts` allowlist 里两个 key 都在,admin 能写、能 audit,但全仓 grep 在 `src/http` 和 `src/middleware` 里 **0 命中**,开了等于装饰
- **证据**:`packages/commercial/src/admin/systemSettings.ts` KEY_SCHEMAS
- **方案**:
  1. 新 `src/middleware/maintenanceMode.ts`:读 `systemSettings` 的 `maintenance_mode`(60s 缓存),true 时对非 admin 请求返 503 JSON `{code:'MAINTENANCE'}`;admin 放行
  2. `/api/auth/register` 处理函数入口读 `allow_registration`,false 时 403 `REGISTRATION_DISABLED`
  3. 单元测试覆盖 on/off 两态 + admin 豁免;前端在全局 error handler 渲染友好文案
- **验证**:登录 admin → 开 maintenance_mode → curl 普通用户 API 得 503 → admin 请求仍通;关闭后恢复
- **状态**: `已上线 v3-20260424T2005Z-8399315,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - 新 `src/middleware/maintenanceMode.ts`:`isInMaintenance()` 60s 缓存 + fail-open;`isActiveAdmin()` JWT+DB 双查,任何异常 swallow→false
  - Codex IMPORTANT#1 后 gate 上提到 `commercialHandler` 顶部(先于 file proxy + BLOCKED),避免付费用户在维护期仍能拉文件
  - WS `userChatBridge` 也挡住普通用户(close code 4504),admin 走 claim-only bypass(JWT 24h TTL + 非破坏性操作的权衡)
  - `/api/auth/register` 在 rate-limit 之前读 `allow_registration`,false 时直接 403 `REGISTRATION_DISABLED`
  - 6 个单元测试覆盖 fail-open/cache/_clear/空 token/乱写 token/非法签名,全部通过
  - **生产验证 2026-04-25**:
    - `UPDATE system_settings SET value='true' WHERE key='maintenance_mode'` → 62s 后 anon `POST /api/auth/session` 返回 `503 MAINTENANCE` (含 `Retry-After: 60`、`X-Request-Id`);`GET /api/public/config` 仍 200(allowlist 正确)
    - `maintenance_mode=false` + `allow_registration=false` → anon `POST /api/auth/register` 返回 `403 REGISTRATION_DISABLED`
    - 关闭所有开关后正常 401 恢复

### P0-3 Admin 订单管理页面
- **问题**:`orders` 表完整,`idx_orders_status` partial index 就位,但 `admin/` 下无 `orders.ts`、无对应路由;运营查 "24h 失败 / pending 超时 / callback 冲突" 只能直连 PG
- **证据**:`packages/commercial/src/db/migrations/0003_init_payment.sql:5`、`src/admin/` 无 orders
- **方案**:
  1. 新 `src/admin/orders.ts`:`listOrders({ status?, user_id?, from?, to?, before?, limit }) → { rows, next_before }`,`getOrderDetail(order_no)` 返回含 callback_payload JSON
  2. 新路由 `GET /api/admin/orders`、`GET /api/admin/orders/:order_no`,接入 `requireAdmin`
  3. 前端 `modules/admin.js` 加 "订单" tab,列 order_no/用户/金额/状态/paid_at,异常状态(expired/refunded/conflict)红色,明细 modal 显示 callback_payload
  4. Dashboard 顶部加 "24h pending 超时" / "24h callback 冲突" 两个 KPI 卡片,点击跳转 orders tab 预过滤
- **验证**:列表分页 + 过滤生效、明细展示 payload、KPI 数值与手工 SQL 一致
- **状态**: `已上线 v3-20260425T0020Z-d325d42,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - 新 `src/admin/orders.ts`:`listOrders` 复合游标 (created_at, id) 分页 / `getOrdersKpi` (24h 卡单/累计卡单/24h 回调冲突/24h 已付) / `getOrderById` 详情(含 callback_payload + ledger 关联)
  - 新 5 路由(读 `requireAdmin`,无写操作),前端 `admin.js` 加"订单"tab(50/页 + 加载更多)+ KPI 条 + 详情 modal
  - Dashboard 加 2 个 KPI 卡(24h pending 超时 / 24h 回调冲突),点击跳转预过滤
  - Codex 1 轮 NEEDS_FIX → 加分页 + 索引补 idx_feedback_created/带 id DESC + parseBigintIdParam BIGINT 范围校验 → SHIP
  - **生产 hotfix**:`u.username` 列不存在 → `COALESCE(u.display_name, u.email) AS username`(users 表实际只有 email/display_name)
  - **生产验证 2026-04-25**:8 单订单列表正确显示 user.email、KPI 显示累计卡单 6 单(与手工 SQL 一致)

---

## 二、P1(运营体验 + 稳定性核心)

### P1-1 前端反馈表单自动附带上下文
- **问题**:`submitFeedback` 只传 category/description/sessionId/userAgent,无 requestId/version/最近 API error,运维反查要人肉对时间
- **证据**:`packages/web/public/modules/main.js:1671`
- **方案**:提交时组装 `{ version, last_api_error: _diagBuffer 最近 5 条, request_ids: 最近 10 条, current_route, sw_version }` 附加到 body;后端新增字段落库或写入 meta JSON
- **验证**:触发一次假错误 → 打开反馈表单 → 提交 → 在 admin 反馈面板看到完整上下文
- **状态**: `已上线 v3-20260425T0020Z-d325d42,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - `main.js` 改 `submitFeedback` 装 `{ last_api_errors[5], request_ids[10], current_route, sw_active, sw_state, ts }` 进 meta
  - 后端 P1-2 表的 meta JSONB 列直接持久化,admin 详情 modal JSON pretty 显示
  - **生产验证**:用户提交后 admin "反馈" tab 详情能看到完整上下文,journalctl grep 命令模板可一键复制

### P1-2 反馈入库 + Admin 面板
- **问题**:当前 `gateway/src/server.ts:1325-1372` 把反馈落盘 `~/.openclaude/feedback/fb-*.json`,超管只能 `ssh ls`
- **方案**:
  1. Migration:新表 `feedback(id bigserial, user_id text, category text, description text, request_id text, version text, session_id text, meta jsonb, status text DEFAULT 'open', created_at timestamptz, handled_by bigint NULL, handled_at timestamptz NULL)`
  2. 商用 gateway 的 `/api/feedback` 改为写 PG(保留文件落盘作 fallback,便于 PG 挂掉时仍能收反馈)
  3. 新 admin 路由 `GET /api/admin/feedback?status&user_id&from&to&before&limit`;新 `POST /api/admin/feedback/:id/ack` 改 status=acked
  4. 前端 admin.js 新 "反馈" tab,列表 + 明细 modal(含 meta 和对应日志 grep 建议命令)
- **验证**:前端提交反馈 → admin 面板秒级看到 → ack 后 status 持久化
- **状态**: `已上线 v3-20260425T0020Z-d325d42,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - migration 0033:新表 `feedback` (含 status open/acked/closed + handled_by/handled_at) + 3 索引(status_created / created / user_created 全部带 id DESC tie-break)
  - `POST /api/feedback`:Bearer-only auth(避免 CSRF 误绑用户)+ 15-10000 字符 + meta ≤ 8KB + rate-limit 5/min/IP
  - 文件 fallback 决策放弃(Codex 同意:admin 只读 PG,文件 fallback 是 unreconciled shadow data,运维价值低)
  - `ackFeedback` 用 `FOR UPDATE` + 写 admin_audit;已 acked/closed 不重复写 audit(幂等)
  - **生产验证 2026-04-25**:POST 反馈 id=1 写入 → ack 1 次 status=acked + 1 行 admin_audit → ack 第 2 次依然 acked,handled_at 不变,**audit 仍仅 1 行**(idempotent ✓)。rate-limit 第 5 次返回 429 ✓

### P1-3 402 INSUFFICIENT_CREDITS 流式错误专属 UX
- **问题**:流中途余额不足,anthropicProxy 返 402,前端 `websocket.js` 的 `handleOutbound` 只认 text/thinking/tool_use/tool_result,错误被吞或串进 text
- **证据**:`packages/web/public/modules/websocket.js:1289-1410`、`src/http/anthropicProxy.ts:1359-1365`
- **方案**:
  1. 后端 finalize 阶段若 `reject.kind==='insufficient'` / 上游 402,额外发一帧 `outbound.error { code, message, hint, cta_url }`
  2. 前端 handleOutbound 新增 `error` case,渲染红色卡片 + "去充值" CTA 按钮 + 隐藏 typing indicator
  3. 顺便支持 `code: 'UPSTREAM_FAILED'` / `'RATE_LIMITED'` 几个常见类型,各自文案
- **验证**:把测试账号余额调到不够,发一条消息 → 看到红色卡片 + 正确文案
- **状态**: `pending`

### P1-4 第二条告警通道(Telegram)
- **问题**:`ChannelType = "ilink_wechat"` 单条,iLink 挂了 critical 告警就没地儿发
- **方案**:
  1. `alertChannels.ts` `ChannelType` 加 `"telegram"` branch;配置存 bot_token + chat_id(加密入库,与 ilink_wechat 同样 AES-GCM KMS 套路)
  2. dispatcher worker 的 send 路径 switch 分发;error 处理 + 指数退避沿用现有 outbox 机制
  3. Admin alerts tab 增加通道类型下拉 + 配置 form
- **验证**:配一条 telegram 通道 → 触发 test alert → Telegram 收到;断网模拟失败 → outbox 指数退避
- **状态**: `pending`

### P1-5 Ledger 分页 + 时间范围 + CSV
- **问题**:`admin.js:2018` 硬 limit=100,前端不接后端已有的 `before` cursor 和 `LEDGER_MAX_LIMIT=500`
- **方案**:
  1. 前端 ledger tab 加时间范围选择 + "加载更早"按钮(复用 USERS_STATE cursor 模式)
  2. 加 "导出 CSV" 按钮,后端 `GET /api/admin/ledger.csv?user_id&from&to` 流式返回
- **验证**:翻到第 200 条以后仍能加载、CSV 能在 Excel 打开
- **状态**: `pending`

### P1-6 营收按 Asia/Shanghai 时区聚合
- **问题**:`admin/stats.ts:118` `date_trunc('day', paid_at)` 走 PG UTC,国内晚 8 点后订单归次日
- **方案**:改为 `date_trunc('day', paid_at AT TIME ZONE 'Asia/Shanghai')`,其他按日聚合的 stats 同步修正
- **验证**:构造一个晚 9 点的 paid order → 统计显示在当日而不是次日
- **状态**: `pending`

### P1-7 多 tab 协同(BroadcastChannel)
- **问题**:两 tab 独立 WS + 独立 state,tab A logout 不通知 tab B;refresh 并发 race
- **方案**:
  1. 新 `modules/broadcast.js`:封装 `BroadcastChannel('oc-auth')` + `BroadcastChannel('oc-session')`
  2. auth.js 在 login/logout/refresh commit 三处广播;其它 tab 收 logout 立即清 state + tear down WS
  3. refresh 成功广播新 access token,兄弟 tab 复用,避免并发 refresh race
- **验证**:打开 2 个 tab → A 登出 → B 立即跳登录页;A refresh → B 控制台看到 "reused refresh"
- **状态**: `pending`

### P1-8 Audit 过滤前缀/文案对齐
- **问题**:UI placeholder 写"action 前缀(如 user.)",后端是精确 `action=$N`,输 `user.` 直接 400
- **证据**:`packages/web/public/modules/admin.js:2357`、`src/admin/audit.ts:120`
- **方案**:后端改 ILIKE `$N || '%'`(ACTION_RE 已限字符集安全);前端 placeholder 保持"前缀"文案不变;同时 audit diff 从 `slice(0,60)` 改成 modal 展开 + key-by-key 对比
- **验证**:输 `user.` 能查出所有 user.* 记录;diff modal 清晰可读
- **状态**: `pending`

### P1-9 账号 refresh 失败历史表
- **问题**:`store.ts:48` 只存最新 `last_error` 单字段,看不到"被封的原因链"
- **方案**:
  1. Migration 新表 `account_refresh_events(id bigserial, account_id bigint, ts timestamptz, ok bool, err_code text, err_msg text)`(28 天 retention)
  2. `refresh.ts` 成功/失败都写一行
  3. Admin 账号详情抽屉新增"刷新历史"tab,展示最近 N 条
- **验证**:故意让一个账号 4xx 连续 3 次 → 抽屉显示 3 条失败 + 对应 err_code
- **状态**: `pending`

### P1-10 PG 备份异地化 + 恢复演练脚本
- **问题**:本地 `/var/backups/postgres/` 单点,盘损全丢,无恢复演练
- **方案**:
  1. `pg-backup-openclaude.timer` 之后追加 `gsutil rsync` 到 `gs://openclaude-backup/pg/`(或用 GCE disk snapshot resource policy)
  2. 新 `scripts/pg-restore-test.sh`:拉最新 dump → 临时 schema `restore_test_<date>` → `pg_restore` → 跑 3 条断言查询 → 成功清理 schema,失败告警
  3. 加 systemd timer 每周日凌晨跑一次
- **验证**:手工触发一次 restore-test 成功;模拟删库 → 从 GCS 拉最新 dump 恢复
- **状态**: `pending`

---

## 三、P2(工程质量、可观测性、运维增强)

### P2-14 WS 链路注入 requestId
- **问题**:WS 用 `connId = randomUUID()`(`ws/userChatBridge.ts:433`)与 HTTP 侧 requestId 两套 schema,跨 http/ws 断链
- **方案**:WS 握手时生成 requestId 挂到 ctx,每条 inbound/outbound event log 行都带;心跳和 outbound.error 帧都带 request_id 字段给前端
- **验证**:reconnect 场景下,前端 toast 能显示 ws-side req id

### P2-15 捕获上游 Anthropic request-id
- **方案**:`anthropicProxy.ts` 读上游响应 `anthropic-request-id` 头,塞 reqLog 和 journal;502 错误 body 也带回去
- **验证**:构造一个 500 上游错误,看 log 和前端能拿到 anthropic req id

### P2-16 Gateway 原生路由日志接入 commercial logger
- **问题**:生产 `/var/log/openclaude.log` 有两种 schema,`/api/sessions/*` 等 naked 行不带 requestId
- **方案**:gateway server.ts 的 http handler 统一用 `rootLogger.child` 注入 requestId;删掉裸 console.log

### P2-17 消灭非 JSON 日志噪音
- **问题**:`[v3/idleSweep] scan {...}` 每分钟一条,jq parse fail
- **方案**:改走 logger.debug,prod level info 不输出;或 grep 找所有这类 console.log 统一改
- **状态**: `已上线 v3-20260424T2005Z-8399315,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - `src/index.ts` 中 idleSweep / volumeGc / orphanReconcile 三个 scheduler inline console shim 改用 `rootLogger.child({ subsys: 'v3/idleSweep' | 'v3/volumeGc' | 'v3/orphanReconcile' })`
  - 现在 journalctl 可 `jq 'select(.subsys=="v3/idleSweep")'` 过滤
  - **生产验证 2026-04-25**:`/var/log/openclaude.log` 20:05 重启后 `[v3/idleSweep] scan` 噪音 0 条,`scheduler started` 以 JSON 格式写入(带 `subsys`/`tickSec`/`idleCutoffMin` 字段)。per-tick scan log 现在走 `logger.debug`,prod info 级别下正常沉默

### P2-18 Deploy 多代 snapshot
- **问题**:只 1 代 .prev,连做两次就失去前版回滚
- **方案**:`.prev/` → `.prev.1/`、`.prev.2/`、…、`.prev.5/` rotate(ctime-ordered)
- **验证**:做 3 次 deploy,能 `--rollback 2` 回到倒数第二版
- **状态**: `已上线 v3-20260425T0351Z-77f038a,生产验证 PASS`
- **实施记录 (2026-04-25)**:
  - `scripts/deploy-v3.sh` 单文件改动 (+96 / -30)
  - snapshot 阶段:rsync → `.prev.new/`,通过 mv 链 rotate(.5 删 → .4→.5 → ... → .1→.2 → .new→.1)。每个 mv 守护 destination 不存在,corrupt mixed state 不会嵌套
  - legacy single-gen `.prev/` 自动迁移成 `.prev.1/`(一次性,幂等);混合状态仅 WARN 不删
  - `--rollback=N`(N=1..5)指定代恢复;`--rollback` 默认=1 向后兼容
  - `ROLLBACK_REQUESTED` + `ROLLBACK_N` 双变量分离,杜绝 `--rollback=0` / `--rollback=` silent 落主 deploy 流程
  - 边界 case 全本地验证:`--rollback=6/abc/empty/1.5/0` → exit 2 + 友好错误
  - **生产验证 2026-04-25 02:51 UTC**:首次 deploy 触发 legacy migration(`.prev/` → `.prev.1/`);第二次 deploy(本次)`.prev.1/` shift 到 `.prev.2/`,新 snapshot 落 `.prev.1/`,无 `.prev/` / `.prev.new/` 残留。两代各 114M,smoke 5/5 PASS

### P2-19 独立 cron 跑 smoke ✅ DONE
- **方案**:systemd timer 每 5 分钟调一个**全新的最小 smoke** (`scripts/health-smoke-v3.sh`,只做 curl /healthz + curl /),wrapper 失败时**直接 INSERT admin_alert_outbox** (SQL fan-out 复刻 listDispatchableChannels)。完全不依赖 openclaude.service,解决 "service 死掉时所有内部告警通道都哑了" 的盲点
- **关键设计**:
  - 全新 smoke 脚本 (≠ deploy 用的 `smoke-v3.sh`,后者绑 EXPECTED_TAG)
  - Marker file (`/var/lib/openclaude/health-smoke-v3.failed`) 实现 outage 级 dedup,只在 dispatch INSERT 成功后才 touch(避免 DB 一次抖动永久压制)
  - silence **故意不在 SQL 里复刻** — matcherMatches() 的 jsonb DSL 复杂度高,double-impl 必 drift。maintenance suppression 走 `systemctl stop health-smoke-v3.timer`
  - `CASE WHEN jsonb_typeof(c.event_types) <> 'array'` 防御 schema 脏数据(避免 planner 对非 array 预求值 jsonb_array_length 报错)
  - payload 用 `jsonb_build_object` 在 SQL 端拼,避免 bash 拼 JSON 转义陷阱
  - smoke 脚本 grep 用 heredoc 不用 pipe,避 `set -o pipefail` + SIGPIPE 陷阱(64KB body grep -q 命中后 echo 收 SIGPIPE 让 pipefail 翻译成 fail)
- **生产验证 2026-04-25 04:18 UTC** (`v3-20260425T0418Z-d21c148`):
  - OK→FAIL: marker 创建,INSERT 0 0(唯一 channel id=1 状态 error,被 activation_status filter 排除 — 正确)
  - 用 BEGIN/ROLLBACK 把 channel 临时置 active 验证 SQL fan-out: INSERT 0 1 出来 payload `{"url","host","checked_at"}` 合法 JSON,severity=critical, title 正确
  - 2nd FAIL with marker present → 静默不重复 INSERT
  - FAIL→OK: marker 清除,日志 RECOVERED
  - Critical guard: 第一次跑用错路径 `/root/.openclaude/.env` (从 45.32 personal 抄错),dispatch 失败但 marker NOT touched — 完美符合设计,下个 tick 自动重试。后续 fix 改成 `/etc/openclaude/commercial.env`
- **Codex review (3 轮)**:1 BLOCKING (ProtectHome=true 让 /root 不可读) + 2 IMPORTANT (jsonb_typeof 防御、payload JSON 转义) + 1 NIT (RuntimeDirectoryMode 显式 0700) 全部修复。最终 PASS

### P2-20 Admin CSV 导出 + 诊断端点
- **方案**:
  1. `/api/admin/users.csv` `/api/admin/orders.csv` `/api/admin/ledger.csv` 流式导出
  2. `/api/admin/diagnostics` 返 `{ outbox_pending, outbox_failed, inflight_by_uid, accounts_healthy_pct, last_deploy_tag }`
- **验证**:CSV 能用 Excel 打开;diagnostics 数值和手工 SQL 一致

### P2-21 Alert outbox "重发失败项"按钮 + ack 三态
- **方案**:
  1. `POST /api/admin/alerts/outbox/:id/retry` 把 status=failed 行重置 pending + next_attempt_at=NOW
  2. Rule state 加 `acked` 中间态,admin UI 支持 open/ack/resolved 流转

### P2-22 Containers 列表加 host 列 + 按 host 过滤
- **方案**:admin.js 列表新增 host_name 列(关联 containers.compute_host_id → compute_hosts.name);hosts tab 加 "per-host 用户分布 top 5"

### P2-23 用户 ban_reason 字段
- **方案**:Migration 加 `users.ban_reason text`;ban 操作强制填写;UI 展示

### P2-24 offlineQueue soft cap
- **方案**:`state.offlineQueue` 满 200 条 toast "离线缓冲已满,请恢复网络后再试"

### P2-25 WS safety timer 缩到 12s + 恢复角标
- **方案**:`websocket.js:806-843` timeout 30s→12s;reconnect 后对 inFlight session 显示"正在恢复会话…"小 badge

### P2-26 全局 error toast 带 requestId
- **方案**:`main.js:396-448 _showErrorToastOnce` 改走 `toast(..., 'error', toastOptsFromError(errLike))`

### P2-27 WS close code 分类处理
- **方案**:4001-4099 app-level close code 独立 label,留可拓展空间;至少不同 log

### P2-28 Audit diff modal 展开
- **方案**:admin.js 2377 的 slice(0,60) 改成 modal 弹窗 key-by-key diff 视图

### P2-29 containerEventsWorker inline console logger 改走 rootLogger
- **问题**:`packages/commercial/src/index.ts:998` 的 containerEventsWorker 和 P2-17 同源,也用 inline `console.log` 适配器,运行期会有非 JSON 日志残留
- **来源**:Codex Plan review (2026-04-25 M1) 的合理提醒 — M1 按 surgical 原则不纳入,保留给下次触达该区域的 batch
- **方案**:下次修改 index.ts 时一并替换为 `rootLogger.child({ subsys: 'v3/containerEvents' })`

---

## 执行跟踪

每完成一个 batch,在对应任务下追加:
```
- **Deployed**: <tag> <commit>
- **验证结果**: <ok/fail + 证据>
- **状态**: `done`
```

Codex review 记录单独存 `docs/codex-review-<batch>.md`。
