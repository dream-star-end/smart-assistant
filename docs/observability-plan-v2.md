# v3 商业版 Observability 改进计划 v2.3

**上下文**: 2026-04-23 boss 报告 claudeai.chat (34.146.172.239) 发带图消息后容器静默,UI 显示"已发送"但无 assistant 回复。当前容器内链路 (`ws.on('message')` → `dispatchInbound` → `sessions.getOrCreate` → `sessionManager.submit` → ccb stdin) 多处 early-return / 吞错,无法从日志反推卡点。v3 尚未正式商用,可以承受为诊断能力做侵入性改动。

本计划响应 Codex 前三轮评审全部 Findings,并在 v2.3 主动收敛过度防御。

**v2.2 → v2.3 改动**(裁剪):
- **F1 删除 ingress registry**(`ws.on('message')` 直接 `await dispatchInbound`,无 await 间隙,`received_no_dispatch` 不会触发)
- **F2 5 phase → 4 phase**(删除 `runner_called` phase;冷启动异步窗口借 F3 `ccb.spawn` 日志反推)
- **F4 删除 rate-limit**(v3 admin 个位数,只 audit log 即可)
- **F6 5 分类 → 3 分类**(删 `received_no_dispatch`、`tool_pending_no_activity`,后者与现有 `IDLE_TIMEOUT_TOOL 15min` 重复)
- **F7 4 hook → 2 hook**(本轮只上 `turn.willCallApi`、`turn.skipped`;tool.preUse / turn.apiResponse 留作后续)
- **R-F 测试策略收敛**(F7 telemetry 单测保留;F1–F5 打点/日志跳过单测,smoke + 生产日志验证)
- **删除仪式性 killswitch**(`OC_STUCK_DETECTOR_DISABLED`、`BRIDGE_DEBUG_FRAMES`)
- **R-I 删除 ingress registry 条款**(本轮不再有需要 bounded 的新 Map)

---

## 核心约束(R 系列,贯穿所有模块)

- **R-A 诊断而非行为**: 所有新加代码只产生日志/metrics/telemetry,**不改变控制流**。所有 emit 点用 `try/catch` 包住,异常吞掉。**任何新增 EventEmitter channel / session state field 都必须标注"diagnostic-only: 没有任何生产代码 read/branch-on 它"**。
- **R-B 脱敏**(v2.1 升级): 统一用 `hash(x) = sha256(x).hex[0:16]` 做 logger/metrics 标签。**禁止**原文出现在 log / metric label / admin response:
  - `uid` → `uid_hash`
  - `sessionKey`(含 peer.id)→ `sessionKeyHash`
  - `peer.id` → `peerIdHash`
  - `idempotencyKey` → `msgId = hash(idempotencyKey)`
  - 用户 text → 只记 `textHash + textLen`
  - 图片/文件 → 只记 `count + totalBytes`(禁止 filename)
  - token/URL/cookie → `redact()`
  
  原值只保留在进程内存的 lookup Map(如 gateway `sessions.get(sessionKey)`)中,不对外发出。
- **R-C 日志级别**: 默认 `info` 加摘要,详细 frame/payload 走 `debug`,由 env (`OC_GATEWAY_DEBUG_FRAMES=1`) 开关。production 默认关。
- **R-D Label cardinality**: Prometheus 标签只用有限集 (`phase`, `reason`, `result`, `cause`, `category`),禁止任何 hash / userId / sessionKey / messageId 入标签。
- **R-E 向后兼容**: 不破坏既有日志字段名,只加不删。
- **R-F 测试**(v2.3 收敛): 只对**核心正确性模块**写单测 — 即 F7 CCB telemetry 模块(sanitize / killswitch / sink 注入有真实复杂度)。F1/F2/F3/F5 的打点日志 + counter 靠 smoke + 生产日志验证,**不写 "log 被调用一次" 这种回归实现细节的测试**。F4 admin endpoint 走 integration test(HTTP 200 + audit 写入)。bun test 全绿为硬要求。
- **R-G Telemetry sub-rules R1–R9**: 沿用 `docs/ccb-telemetry-refactor-plan.md`(CCB 行为不变、stdout 通道、仅 stream-json+verbose、gateway 侧分流、失败回退 heuristic、`OC_TELEMETRY_DISABLED=1` killswitch)。
- **R-H Metrics 复用**: **不引入 prom-client**。两条 registry 按进程分离(见 F8):gateway 侧 `packages/gateway/src/metrics.ts`(handwritten `Counter` / `Histogram`,容器 `/metrics`);commercial 侧 `packages/commercial/src/admin/metrics.ts`(host `/api/admin/metrics`)。
- **R-I 诊断 state bounded**: 新增任何 in-memory Map 必须有 TTL + 上限条目数 + 溢出时 LRU 淘汰。v2.3 本轮**无新增需要 bounded 的 Map**(ingress registry 已删;stuck detector 只读现有 state)。

---

## Finding-by-Finding 映射

### F1. Gateway entry logs + dispatchInbound early-return 全覆盖

**Codex 原话**: 只在 `submit()` 打 log 不够,上游静默拒绝也会静默。

**精确位置**:
- `packages/gateway/src/server.ts:2999` — `ws.on('message', async (raw) => {`
- `packages/gateway/src/server.ts:3698` — `dispatchInbound(frame, adapter)`
- `packages/gateway/src/server.ts:3701` — `_shuttingDown` early-return
- `packages/gateway/src/server.ts:3709` — idempotency dup(已有 `log.debug`,**升级到 `info` 且加 `messageId` hash**)
- `packages/gateway/src/server.ts:3730` — rate-limit 拒(已 return 一条用户可见的文本,**加 `log.warn` 带 peerId hash + reason=rate_limit**)
- `packages/gateway/src/server.ts:3801` — `sessions.getOrCreate` 前后各一条(now/queued)

**改动**(字段严格遵循 R-B 脱敏):
1. ws.on('message') 顶部加 `log.info('ws.frame.recv', { bytes: raw.length, uid_hash })`(info 级,不含 frame 内容;`uid_hash = hash(ws._userId)`)。
2. dispatchInbound 第一行加 `log.info('dispatch.begin', { msgId, channel: frame.channel, peerIdHash, textLen, textHash, mediaCount, mediaBytesTotal })`(`msgId = hash(frame.idempotencyKey)`)。
3. 每条 early-return 出口加 `log.info('dispatch.reject', { reason: 'shutting_down'|'duplicate'|'rate_limit', msgId })` 然后 return。
4. 媒体校验失败路径 (`server.ts:3840-3910`) 加 `log.warn('dispatch.reject', { reason: 'media_too_big'|'media_total_too_big', actualBytes, limit, msgId })`。
5. `getOrCreate` 返回后加 `log.info('dispatch.session_ready', { sessionKeyHash, msgId })`;`submit` 调用前加 `log.info('dispatch.submit_enter', { sessionKeyHash, msgId })`。

**验证手段**: 跑 smoke — 容器收到图片后日志序列必须是:
```
ws.frame.recv → dispatch.begin → dispatch.session_ready → dispatch.submit_enter → submit.phase=queued ...
```
缺任何一条即为诊断点。

**v2.3 说明**: v2.2 计划里为 F6 `received_no_dispatch` 分类加的 `_ingressRegistry` LRU Map **已删除**。原因:server.ts:3051 里 `ws.on('message')` 同步 `await this.dispatchInbound(frame)`,dispatch.begin 是 dispatchInbound 第一行,中间无 await,10s 窗口不可能触发。相关 state 全部去掉。

---

### F2. SessionManager.submit 阶段 tracking

**Codex 原话**: submit 的 lock 链可能长时间阻塞,当前看不出卡在 `prev` 还是卡在 runner。

**精确位置**: `packages/gateway/src/sessionManager.ts:535` — `submit()`

**4 个阶段**(v2.3 删除 `runner_called` phase):

**删除理由**(Codex v5 修正): 不再写"两者同步邻接"。实际 `SubprocessRunner.submit()` 在 `!this.proc` 时会 `await this.start()`(冷启动 / effort 切档重启场景),中间有 `buildLearningContext()` 等 **真实异步窗口**。但这类卡点的诊断我们借助 F3 新加的 `ccb.spawn` / `ccb.exit` 日志已经覆盖:`lock_acquired` 之后长时间无 `stdin_written` + 无 `ccb.spawn` = 卡在 runner start 前置;有 `ccb.spawn` 但 60s 无 `stdin_written` = 卡在 pre-stdin(例如 buildLearningContext)。单独的 `runner_called` phase log 不新增信息,所以删。

| phase | 打点位置 | 记录字段 | 阻塞 submit? |
|-------|---------|---------|-------------|
| `queued` | 555 行 `const prev = session.lock` 之前 | msgId, queuedAt | 否 |
| `lock_acquired` | 559 行 `await prev` 之后 | waitedMs = now - queuedAt | 否 |
| `stdin_written` | `runner.submit(userContent)` 返回后(runner 真实入口是 `subprocessRunner.ts:submit`,**非** `sendMessage`)。`subprocessRunner.submit` 内部 `stdin.write(...)` 完成后挂 `lastStdinWrite = { ts, bytes, backpressure }` 诊断字段;sessionManager 读取。`stdin.write` 的返回 bool 是 backpressure 信号不是 bytes-written,**不误当成功标志**。 | userMsgLineBytes, backpressure | 否 |
| `first_stdout` | `handleStdout` 首帧触发(stdin_written 后)记录 `firstStdoutLatencyMs`;仅 log,**不在 submit 的 await 链上**。直接借 runner 已有 `lastActivityAt` + 一个 `_firstStdoutAfterStdin` 标志位,不新增 EventEmitter channel。 | firstStdoutLatencyMs | **否**(诊断字段) |

每条 `log.info('submit.phase', { sessionKeyHash, msgId, phase, ... })`。

**诊断字段边界(R-A)**: `lastStdinWrite` 和 `_firstStdoutAfterStdin` **仅用于** F4 admin diag 输出 + F6 stuck detector 读取。生产代码(retry/onEvent/lock release/interrupt/lifecycle)**不**读、不 branch、不决策。PR 里用 `// DIAGNOSTIC-ONLY: no production code branches on this` 注释标记。

**Metric**: histogram `oc_gateway_submit_phase_latency_ms{phase}`(label 仅 phase,buckets = 既有 gateway Histogram 约定)。

---

### F3. ccb subprocess 生命周期日志

**Codex 原话**: 子进程 spawn/exit/error 现只在 `log.warn` 被动出现,pid、启动耗时、首次 stdout 延迟都拿不到。

**精确位置**: `packages/gateway/src/subprocessRunner.ts`(实施前用 `rg "stdin\.write"` 重新定位,避免 patch 期间行号漂移)
- `start()` ~line 260 — spawn 前后
- spawn error handler(existing)
- stdin.write sites(当前快照 line **667 user_msg**, **846 control_response**, **867 interrupt**)
- `handleStdout`(~line 505)— 首帧打标
- exit handler — 退出码、signal、uptime

**改动**:
1. spawn 成功后 `log.info('ccb.spawn', { pid: this.proc.pid, sessionKeyHash, cwd })`。
2. 三处 `stdin.write` 全部:
   - 外层 `try/catch` 保持,捕到异常时 `log.error('ccb.stdin.write_failed', { pid, sessionKeyHash, phase: 'user_msg'|'control_response'|'interrupt', errno: err.code })`。
   - `oc_ccb_stdin_errors_total{phase}` ++。
   - **不**新建 EventEmitter `stdin_error` channel、**不**把 turn 标记为 `stdin_failed`、**不**释放 lock、**不**向 user 发错误帧 —— 现有的用户可见语义(下一次 await 时 ccb 死 / handleExit 触发 / liveness timeout)**一律不动**。R-A 合规说明:本 PR 除 log + counter 外,对这条路径的行为全部保留 pre-patch 状态。
3. 首次 handleStdout 里如果 `this._firstStdoutAt === 0` 则记录 `firstStdoutLatencyMs = now - this._lastStartAt` 并 `log.info('ccb.first_stdout', { pid, firstStdoutLatencyMs })`。**同时**在 `handleStdout` 里检测"stdin_written 之后首次产出":如果 `this.lastStdinWrite && !this._firstStdoutAfterStdin` 则 `this._firstStdoutAfterStdin = now` 并 `log.info('submit.phase', { sessionKeyHash, msgId: this.lastStdinWrite.msgId, phase: 'first_stdout', firstStdoutLatencyMs: now - this.lastStdinWrite.ts })`(供 F2 `first_stdout` phase;**不用 EventEmitter channel**,直接 log)。
4. exit handler 加 `log.info('ccb.exit', { pid, code, signal, uptimeMs, consecutiveCrashes })`。

**Metric**:
- counter `oc_ccb_spawn_total{result}` (result ∈ success|failed)
- histogram `oc_ccb_first_stdout_latency_ms`
- counter `oc_ccb_stdin_errors_total{phase}` (phase ∈ user_msg|control_response|interrupt)

---

### F4. Admin `/api/admin/diag/subprocess` 端点

**Codex 原话**: 运维时需要查"当前这个 uid 的容器里 runner 是什么状态,卡在哪个 turn,last activity"。

**精确位置**: 新增文件 `packages/commercial/src/http/adminDiag.ts`,挂到现有 admin router(参照 `packages/commercial/src/http/admin.ts:22` 的 `requireAdmin`/`requireAdminVerifyDb` 模式)。

**端点**:
- `GET /api/admin/diag/subprocess?uid=<uid>&sessionKey=<key>` — 只读,用 `requireAdmin`(JWT role=admin,24h TTL)。
- 返回字段(全部脱敏):
```ts
{
  uid_hash,               // sha256(uid)[0:16] —— log correlation 用,原 uid 不回显
  container: { id, host, port, up_for_ms, last_ws_activity_ms_ago },
  sessions: [{
    sessionKeyHash,
    turns,
    inFlight,             // 是否有 turn 未完成
    currentPhase,         // queued|lock_acquired|stdin_written|first_stdout|api_streaming|idle (v2.3 4-phase)
    lastActivityMsAgo,
    ccb: {
      pid, uptimeMs, consecutiveCrashes,
      firstStdoutLatencyMs,
      telemetryDiagnostics: { missingSessionIdCount }, // 现有 getTelemetryDiagnostics()
    },
  }]
}
```
- 无原文 text、无 token、无文件内容。image/file 只出 count+hash。

**审计**: 每次调用写 audit log(参照 `adminAudit.ts` 现有模式),字段 `action='diag.subprocess', target_uid_hash, admin_id`。

**Rate-limit**(v2.3 删除): v3 admin 是内部个位数群体,连点刷新 30 次/60s 很正常。本轮**不加** rate-limit,只靠 audit log 留痕 + `requireAdmin` auth。后续若真出现滥用再加。

**uid-scope**: `requireAdmin` 仅认证,**端点内**额外校验查询的 uid 在 admin 授权范围内(若 v3 已有 role=support 之类分级则走现有;否则只允 role=admin)。

---

### F5. Bridge observability(userChatBridge)

**Codex 原话**: bridge 现在只在 close 打 bytes,中间的 container_ws_open、首帧 round-trip、backpressure 迁移全看不到。

**精确位置**: `packages/commercial/src/ws/userChatBridge.ts`
- `startBridge` line 424
- `createContainerSocket` 返回点(暂不知行号,需 grep 定位)
- `onUserMessage` line 495(user → container)
- container `on('message')`(user ← container,要找)
- `cleanup` 现有 close 日志 line 736

**改动**(全部字段走 R-B 脱敏):
1. `log.info('bridge.start', { connId, uid_hash, container_endpoint })`(`uid_hash` 而非 `uid`)。**审计现有日志中所有 `uid: uid.toString()` 字段**(`userChatBridge.ts:460`, `482` 等),统一改为 `uid_hash` —— 这是 R-B 迁移的一部分,不是 net-new log。
2. container ws `on('open')` 触发后 `log.info('bridge.container_opened', { connId, connectMs = now - startedAt })`。
3. 首次 user → container 转发成功后 `log.info('bridge.first_uc', { connId, bytes, preopenQueued })`。
4. 首次 container → user 转发成功后 `log.info('bridge.first_cu', { connId, latencyMs = now - firstUCAt })` —— 这是 **请求无响应**的最关键信号。
5. backpressure 触发改为 `log.warn`(现有是内部 return)。
6. 逐帧 debug 日志(dir/bytes/opcode)本轮**不加**。已有 bytesUC/bytesCU 累计 + close 日志 + 新增的 first_uc/first_cu 已足够诊断 v3 现阶段问题。

**Metric**:
- counter `oc_bridge_opened_total`
- histogram `oc_bridge_container_connect_ms`
- histogram `oc_bridge_first_cu_latency_ms`(核心 SLI)
- counter `oc_bridge_closed_total{cause}`(cause ∈ normal|frame_too_big|backpressure|container_error|…)

---

### F6. Stuck detector — 诊断-only

**Codex 原话**: 需要主动检测"turn 卡住",否则还得等用户骂才知道。

**精确位置**: 新增 `packages/gateway/src/stuckDetector.ts`,在 `Gateway` 构造时 `setInterval(scan, 30_000)`。

**3 类卡点**(v2.3 从 5 类收敛):

| 分类 | 触发条件 |
|-----|---------|
| `queued_on_lock` | phase=queued 持续 >60s 未进 lock_acquired |
| `stdin_written_no_first_output` | stdin_written 之后 30s 未见 first_stdout(**这正是 boss 今天的症状**) |
| `api_called_no_response` | telemetry `turn.willCallApi` 之后 90s 未见任何 stdout content block |

**v2.3 删除的分类**:
- `received_no_dispatch` — ws.on('message') 同步 await dispatchInbound,不会触发
- `tool_pending_no_activity` — 现有 `IDLE_TIMEOUT_TOOL = 15 * 60_000`(sessionManager.ts:609)+ 30 min 硬 idle 兜底(sessionManager.ts:791)已覆盖,重复造轮子

**行为**: **只 log warn + inc counter,不 kill、不强制重启**。
```
log.warn('stuck.detected', { sessionKeyHash, msgId, category, stuckForMs, phase, ccbPid })
oc_stuck_detected_total{category} ++
```
(R-B:字段一律 hash。v2.3 只有 3 分类,全部发生在 in-flight session 上,`sessionKeyHash` 始终存在。)

**In-flight gate**: 3 分类全部只扫描 `session.lock` 未 resolve 的 session,避免对 idle session 误报。

**Bounded state**: stuck detector 自身不维护 Map — 所有状态都从现有 `sessions` / F3 runner 诊断字段(`lastStdinWrite` / `_firstStdoutAfterStdin`) / F7 TelemetryChannel 状态**读取**,扫描结束立即丢弃。

**不做的事**: 不重启子进程、不 interrupt、不给用户发自动"失败"消息 —— v3 还没商用,先只诊断。

**v2.3 说明**: 不设 killswitch(setInterval 30s 只读现有 state + log,无性能顾虑,killswitch 属仪式性防御,删)。

---

### F7. CCB 端 `_oc_telemetry` emitter(完成已设计架构)

**Codex 原话**: Gateway 侧 TelemetryChannel 已 ready,CCB 侧空转,不补发 emitter 整个 telemetry 链路是死的。

**当前状态查勘**(2026-04-23):
- Gateway 侧 **完整实现**: `telemetryChannel.ts`(160 lines), `subprocessRunner.ts:578` 分流 `_oc_telemetry`,`ccbMessageParser.ts:489` 已读 `stop_reason`,测试齐全。
- CCB 侧 **零实现**: grep 全源码无任何 `_oc_telemetry` emit 调用。

**改动**:

**1) 新增 `claude-code-best/src/_openclaude/telemetry.ts`** —— **直接沿用 `docs/ccb-telemetry-refactor-plan.md §4.1` 已敲定的 ~120 行 `configureTelemetry` 设计**,不另起炉灶。具体包含:
- `DISABLED = process.env.OC_TELEMETRY_DISABLED === '1'`(R9 killswitch)
- `SCHEMA_VERSION=1`, `MAX_FIELD_BYTES=1024`, `MAX_ARRAY_LEN=50`, `MAX_EVENT_BYTES=8192`
- `type Sink = (line: string) => void`,默认 sink = `process.stdout.write`;**测试可注入**
- `configureTelemetry({ outputFormat, verbose, sink?, sessionIdProvider? })` —— 在 `src/cli/print.ts:~583` `getStructuredIO` 之后调用(按设计文档 §4.2)
- `getDiagnostics()` 返回 `{ droppedCount, emittedCount, sinkErrorCount, configured }`
- `emit(event, data)`:R8/R5 前置门闸 → `sanitizeData` 截断 → `ndjsonSafeStringify`(真实路径 `src/cli/ndjsonSafeStringify.ts:30`)→ `MAX_EVENT_BYTES` 超则 droppedCount++ → sink 独立 try/catch,成功 `emittedCount++`、失败 `sinkErrorCount++`
- `sanitizeData`:depth 上限 4、field > 1024B 截断、array > 50 项标记 `_truncatedFromN`、function/symbol 丢弃

**2) 在 CCB 打 2 个 hook**(v2.3 从 4 个收敛;事件名与 gateway `TelemetryChannel.ingest` 严格一致):

| 事件 | 位置 | `data` 白名单(禁止 user text / tool input raw) |
|------|------|-----------------------------------------|
| `turn.willCallApi` | `claude-code-best/src/services/api/claude.ts:~1786`(API 调用前)| `{ model, systemPromptLen, toolCount, messageCount, betasCount }` |
| `turn.skipped` | `claude-code-best/src/QueryEngine.ts:~559`(slash / 短路)| `{ reason }` |

**v2.3 暂不上的 hook**:
- `tool.preUse` — 对 boss 今天"stdin 写了 ccb 不产出"的 case 无用(还没到调 tool 阶段),留待后续补。
- `turn.apiResponse` — CCB 的 stream-json `result` 行已由 `ccbMessageParser.ts:489` 读 `stop_reason`+usage,重复。留待后续按需补。

这 2 个 hook 足够区分 F6 的 `stdin_written_no_first_output`(无任何 telemetry)vs `api_called_no_response`(有 willCallApi 但无 content)vs 合法短路(skipped)三种情况 — 本次 boss 的 case 恰好就靠 `stdin_written_no_first_output` + 无 `turn.willCallApi` 两信号联合判定。

**3) Gateway parser 侧无需动**(stop_reason 已读;`TelemetryChannel` 已 ingest 这些 event 名)。

**4) Killswitch**: `OC_TELEMETRY_DISABLED=1` (R9) + `--output-format=stream-json --verbose` 门闸,不符合任何一条 emit 就静默关闭。

**5) 测试**(遵循 R-F 收敛策略):
- `claude-code-best/src/_openclaude/__tests__/telemetry.test.ts`(**保留**,这是核心正确性模块):
  - env 关 → emit 后 sink 未被调用
  - 非 stream-json → emit 后 sink 未被调用
  - MAX_EVENT_BYTES 超 → droppedCount++,sink 未被调用
  - sink throw → sinkErrorCount++,不冒泡
  - sanitizeData:超长 string 截断、深 object 截断、function 丢弃
- gateway 现有 `subprocessRunnerTelemetry.test.ts` 保持绿
- **不**新增"端到端 mock 子进程"测试 — 本轮 2 个 hook 在 smoke 就能直接观察到

---

### F8. Metrics 复用 — 两条 registry 分明,不跨进程合并

**Codex 原话**: log 查 case 可以,看趋势得有聚合。**Codex v2/v3 修正**: v3 有**两条独立 registry**,分属不同进程,不会自动合并:

| Registry | 文件 | 暴露端点 | 进程 | 现有内容 |
|----------|------|---------|------|---------|
| Gateway | `packages/gateway/src/metrics.ts`(`serializeMetrics()`)| `/metrics`(`server.ts:1046`)| **容器内** gateway | `http_requests_total`, `ws_connections_total`, `sessions_active` 等 |
| Commercial Admin | `packages/commercial/src/admin/metrics.ts`(`renderPrometheus()`)| `/api/admin/metrics`(`router.ts:419`, `admin.ts:1269`)| **host** commercial gateway | 含 `ws_bridge_buffered_bytes`, `ws_bridge_session_duration_seconds` |

**不引入 prom-client**;**不新增 `/api/admin/diag/metrics`**;**不跨进程合并 registry**。按所属进程分配新 metric:

**Container 内 gateway(`packages/gateway/src/metrics.ts`,暴露于容器 `/metrics`)**:
- histogram `oc_gateway_submit_phase_latency_ms{phase}` (F2)
- counter `oc_ccb_spawn_total{result}` (F3)
- histogram `oc_ccb_first_stdout_latency_ms` (F3)
- counter `oc_ccb_stdin_errors_total{phase}` (F3)
- counter `oc_stuck_detected_total{category}` (F6)

**Host commercial(`packages/commercial/src/admin/metrics.ts`,暴露于 host `/api/admin/metrics`)**:
- counter `oc_bridge_opened_total` (F5)
- histogram `oc_bridge_container_connect_ms` (F5)
- histogram `oc_bridge_first_cu_latency_ms` (F5)
- counter `oc_bridge_closed_total{cause}` (F5)

**跨进程聚合**(可选,**不在本 PR 范围**): 若后续运维需从 host `/api/admin/metrics` 一站式看容器内 gateway 指标,需单独设计 scrape/forward 机制(例:commercial gateway 维护容器 registry,定时 `fetch(http://<containerBoundIP>:<port>/metrics)` 合并文本,或在 Prometheus 配置 per-container scrape target)。两种方案都要另起计划,不在本 observability plan 覆盖。

**端点职责**:
- 容器 `/metrics` — 容器内视角 Prometheus 聚合指标
- host `/api/admin/metrics` — host 视角 + bridge 聚合指标
- F4 `/api/admin/diag/subprocess` — 单体结构化 JSON(含 `telemetryDiagnostics`、pid、上次 activity 等 per-user 诊断快照)

---

### F9. Log correlation id

**Codex 原话**: msgId / sessionKey / pid 散在各处,出事后 grep 穿不起来。

**改动**: F1 的 `msgId = hashIdem(frame.idempotencyKey)` 作为贯穿 whole-request 的 correlation id,F2–F3 所有新日志**必须带 msgId 字段**。F6 stuck detector 扫到异常时 log 里也附 msgId,让 grep `msgId=<hex>` 能拉出端到端时间线。

无新 metric,仅日志字段纪律。

---

### F10. 前端无感知

**Codex 原话**: 诊断改动不能让用户 UI 回归(例如 ack 打断、按钮 disable)。

**保证**:
- F1 新加的 log/warn 不影响任何 outbound 帧(包括 rate_limit 路径已有的用户可见文本不改)。
- F6 stuck detector 只 log,不向 user WS 发帧。
- F7 telemetry stdout 由 subprocessRunner `handleStdout` 路由给 `emit('telemetry')`,**不经** ccbMessageParser,不会污染 block 流。
- 所有 admin 端点走 `/api/admin/*` 前缀,不在用户 router 触达。

---

## 交付物 checklist

代码:
- [ ] `packages/gateway/src/server.ts` — F1 (5 类 log,无 ingress registry)
- [ ] `packages/gateway/src/sessionManager.ts` — F2 (4 phase log + 1 histogram)
- [ ] `packages/gateway/src/subprocessRunner.ts` — F3 (spawn/first_stdout/stdin_error/exit log + 3 metric + `lastStdinWrite` / `_firstStdoutAfterStdin` 诊断字段)
- [ ] `packages/gateway/src/stuckDetector.ts` — F6 新文件,3 分类,无 killswitch
- [ ] `packages/commercial/src/http/adminDiag.ts` — F4 新文件(无 rate-limit,只 audit)
- [ ] `packages/commercial/src/http/router.ts`(或 admin.ts) — 挂 adminDiag 路由
- [ ] `packages/commercial/src/ws/userChatBridge.ts` — F5 (5 log + 4 metric,无 env debug 门)
- [ ] `packages/commercial/src/admin/metrics.ts` — F8 host 侧新 bridge metric 注册(F5 指标放这里)
- [ ] `claude-code-best/src/_openclaude/telemetry.ts` — F7 新文件(沿用 ccb-telemetry-refactor-plan §4.1)
- [ ] `claude-code-best/src/cli/print.ts` — F7 configureTelemetry 挂接点
- [ ] `claude-code-best/src/services/api/claude.ts` — F7 `turn.willCallApi` emit
- [ ] `claude-code-best/src/QueryEngine.ts` — F7 `turn.skipped` emit

测试(v2.3 按 R-F 收敛 — 打点日志不写单测,只测核心正确性和端点):
- [ ] `claude-code-best/src/_openclaude/__tests__/telemetry.test.ts` — F7 telemetry 模块(核心正确性,**必测**)
- [ ] `packages/commercial/src/http/__tests__/adminDiag.integ.test.ts` — F4 端点 integration(HTTP 200/403 + audit 写入)
- 其他 F1/F2/F3/F5 的打点日志 + counter **跳过单测**,靠 smoke + 生产日志验证

文档:
- [x] 本文件 `docs/observability-plan-v2.md`
- [ ] 更新 `docs/ccb-telemetry-refactor-plan.md` 的 "实施状态" 小节标注 F7 落地

部署:
- `deploy-to-remote.sh` → 34.146.172.239,重启 `openclaude.service` + 重建镜像(ccb 也改了),随后用 boss 上次发图的流程做 smoke,确认日志链路完整 + metric 端点可用。

---

## 预期收益

**对今天这个 case**: 同样的"发图后容器静默",下次重现时 `msgId=<hex>` grep 能立即定位到:
- `dispatch.begin` 有 → 帧到了容器
- `dispatch.session_ready` 有 → session 拿到了
- `submit.phase=stdin_written` 有但 `ccb.first_stdout` 无 → **stdin 写到 ccb 但 ccb 没产出** → 90% 是 ccb 子进程内部死锁或 media parse 卡住
- 然后 stuck_detected category 告诉我们是 `stdin_written_no_first_output`
- `/api/admin/diag/subprocess?uid=xx` 能直接拿到 pid、uptime、consecutiveCrashes,决定是 kill 还是 attach 进去 strace

整体从"全黑盒"到"端到端时间线 + 分类标签"。

---

## v2.3 Delta(自主收敛过度防御)

自查发现 v2.2 里多处 "为未来可能问题预防"、"仪式性 killswitch"、"验证实现细节的单测" 偏离了 R-A "诊断-only" 和 "只解决当下 case" 的初衷。本轮主动裁剪:

| v2.3 裁剪项 | 原因 |
|-------------|------|
| 删除 F1 `_ingressRegistry` LRU Map + R-I ingress registry 条款 | `ws.on('message')` 同步 `await dispatchInbound`,`received_no_dispatch` 窗口几乎不可能触发 |
| F2 5 phase → 4 phase(删除 `runner_called`)| 冷启动/重启确有 `await start()` 异步窗口,但用 F3 `ccb.spawn` 日志反推更直接,单独 `runner_called` phase 不新增信息 |
| 删除 F4 admin rate-limit (256 LRU + prune timer) | v3 admin 是内部个位数群体,连点刷新常见,只 audit log 即可 |
| F6 5 分类 → 3 分类(删 `received_no_dispatch` + `tool_pending_no_activity`)| 前者不会触发;后者与现有 `IDLE_TIMEOUT_TOOL` + 30 min 硬 idle 重复 |
| F7 4 hook → 2 hook(留 `turn.willCallApi` + `turn.skipped`,删 `tool.preUse` + `turn.apiResponse`)| 对 boss 今天 case 无用;`stop_reason` 已由 `ccbMessageParser.ts:489` 读出,`turn.apiResponse` 重复 |
| R-F 测试策略收敛(F7 必测 + F4 integration 必测,F1/F2/F3/F5 打点跳过单测)| "验证 log 被调用一次、counter ++ 一次" 测的是实现细节,一改实现就挂,维护成本 > 价值 |
| 删除 `OC_STUCK_DETECTOR_DISABLED=1` killswitch | setInterval 30s 只读现有 state + log,无性能顾虑,killswitch 纯仪式性 |
| 删除 `BRIDGE_DEBUG_FRAMES=1` env 门 | 现有 `bytesUC/bytesCU` 累计 + 新增 `first_uc/first_cu` 已够,逐帧 debug 本轮不需要 |

**保留**:F2 `lastStdinWrite` + `DIAGNOSTIC-ONLY` 注释(R-A 边界关键);F3 "不新建 channel、不 mark turn"(R-A 边界关键);F4 audit log(内部工具应有留痕);F7 `configureTelemetry` 沿用 §4.1 设计(核心正确性);F8 两 registry 分离(实事求是);R-B 全字段 hash(前三轮 Codex 已 PASS,改它不值得)。

---

## v2.1 Delta(响应 Codex 第二轮 PARTIAL)

| Codex 条目 | 解决方式 | 位置 |
|------------|---------|------|
| **F-privacy** (userId/sessionKey 原文泄漏) | R-B 升级为强制 hash 列表 + F5 明确审计 `userChatBridge` 现有 `uid` 字段也要改 | 本文 R-B 节 + F1/F2/F3/F4/F5 全部字段 |
| **F-stdin-semantics** (`stdin.write` 返回 backpressure 非 bytes,原 `stdin_callback` 不能阻塞 submit,现有方法名 `submit` 非 `sendMessage`) | F2 改为用 runner 内部 `lastStdinWrite` 诊断字段,**不扩展返回值**;v2.3 把原 `stdin_callback` 进一步简化为直接 log 的 `first_stdout` phase,submit 路径不加 await | F2 phase 表 + "诊断字段边界" 注释 |
| **F-stdin-error-boundary** (`stdin_failed` mark 超出诊断范围) | 删除 "mark turn as stdin_failed" 条款,只留 log + counter,明确"用户可见语义保留 pre-patch 状态" | F3 第 2 条 |
| **F-ingress-registry** (`received_no_dispatch` 与 "只扫 in-flight session" 矛盾) | **v2.3 超越该 finding**:既然 `received_no_dispatch` 分类本就不可能触发,整个分类 + ingress registry + R-I 相关条款一并删除,矛盾自动消失 | F6 分类表 + "In-flight gate" 节(3 分类版)|
| **F-metrics-reuse** (已有 `/api/admin/metrics` + handwritten serializer) | R-H 明令不引入 prom-client;F8 v2.2 进一步更正:两条 registry 跨进程分离,metric 按所属进程分配(gateway/ccb/stuck → 容器 `/metrics`;bridge → host `/api/admin/metrics`),跨进程聚合显式 out-of-scope | R-H + F8 全段 v2.2 重写 |
| **Suggestion-telemetry-module** (沿用 `ccb-telemetry-refactor-plan.md` 的 configureTelemetry / sink 注入 / MAX_EVENT_BYTES / diagnostics) | F7 第 1 条改为"直接沿用 §4.1 已敲定设计",补齐 MAX_FIELD_BYTES / MAX_ARRAY_LEN / sanitizeData / getDiagnostics | F7 第 1 条 |
| **Suggestion-tool-preuse-anchor** (tool.preUse 要具体锚点 + data 白名单) | **v2.3 裁剪**: `tool.preUse` hook 本轮不上(对 boss 今天的 case 无用),因此此 suggestion 不适用。若将来补这个 hook,按 v2.2 方案走 `query.ts:runToolUse` + `{ toolName, blockId, inputKeys }` 白名单 | v2.3 Delta 表 F7 行 |
| **Suggestion-rate-limit-prune** (admin diag rate-limit map 要 prune) | **v2.3 裁剪**: F4 已完全删除 admin diag rate-limit(v3 admin 是内部个位数群体),prune 条款因此不再适用 | v2.3 Delta 表 F4 行 |
| **Nit-skill-unavailable** | 不影响方案 | N/A |
| **Nit-line-number-drift** (stdin.write 行号 implementation 时 rg 重定位) | F3 开头加 "实施前 rg 重新定位" 要求 | F3 开头 |
