# v5 Engine 适配层 + Codex 重接入 — 实施计划(方案已过 Codex 评审 PASS with nits,nits 已吸收)

完整架构方案见 /root/openclaude-scratch/v5-codex-engine-adapter-plan-2026-07-02.md(权威)。
本文件是 worktree 内的实施拆解。branch: feat/v5-codex-engine-adapter,base 7db61b72。

## 契约(M0 落地物,packages/gateway/src/engine/)

### engineEvents.ts(中立事件模块,权威源)
- `EngineEvent`:从 ccbMessageParser 的 SessionStreamEvent 迁移**内容/turn 生命周期**
  部分:`block` / `final` / `error` / `permission_request` / `turn_status`,
  另把 parser 回调 DetectedToolUse/DetectedToolResult 升格为事件:
  `tool_use_detected` / `tool_result_detected`(cron 桥接与 tool.called 指标的
  engine 中立来源)。
- `EngineBillingEvent`:engine-reported 计费侧信道(原 kind:'codex_billing' 语义),
  **不在 EngineEvent 联合里**;adapter 经独立 `'billing'` 事件通道 emit。
  wire 帧名 `outbound.codex_billing` 不变。
- `TurnSummary`(engine 中立,原 TurnResult 语义承接):usage(cost/tokens/cache)、
  assistantText/thinkingText、assistantSegments/thinkingSegments、tools
  (TurnToolEntry[])、stopReason、numTurns、isError、
  `errorKind?: 'auth' | 'other'`(auth 分类从 sessionManager 的
  AUTH_KEYWORDS_RE/AUTH_ERROR_PREFIX_RE 下沉到 CCB adapter —— 错误字符串是
  底座私有知识)、staleResumeId、
  `phantomSignals: { apiState: 'called'|'skipped'|'unknown'; skipReason?: string }`
  (CCB 由 TelemetryChannel 提供;其他 engine 缺省 'unknown' → 上层沿用legacy启发式)。
- `PartialSnapshot`:{ assistantText, thinkingText, completedTools,
  assistantSegments, thinkingSegments } —— crash/interrupt 部分持久化数据源
  (对应现 parser.assistantBuf/thinkingBuf/completedTools/segments 直读)。

### engineAdapter.ts
```ts
interface EngineAdapter extends EventEmitter {
  readonly engineId: string            // 'ccb' | 'codex'
  readonly capabilities: EngineCapabilities
  // lifecycle
  start(): Promise<void>
  submitTurn(params: TurnParams): Promise<TurnSummary>
  interrupt(): void
  shutdown(): Promise<void>
  // resume
  readonly nativeSessionId: string | null   // CCB session_id / codex thread_id
  clearSessionId(): void
  // setters(与现 SubprocessRunner 对齐)
  setModel(m: string): void
  setEffortLevel(e: string | undefined): void
  setTraceId(t: string | undefined): void
  updateConfig(...): void
  // permission
  sendPermissionResponse(requestId: string, resp: unknown): void
  // runtime state
  getPartialSnapshot(): PartialSnapshot
  readonly pendingToolCalls: number
  readonly isRunning: boolean
}
// events: 'event'(EngineEvent) 'billing'(EngineBillingEvent) 'session_id' 'spawn'
//         'exit' 'error' 'parse_error' 'overflow'
interface TurnParams {
  input: string | Array<{ type: string; [k: string]: unknown }>
  requestId?: string
  traceId?: string
  assistantMessageId?: string
  thinkingMessageId?: string
  toolMessageIdFactory?: (blockId: string) => string
  onEvent: (e: EngineEvent) => void
}
interface EngineCapabilities {
  billingMode: 'proxy' | 'engine-reported'
  supportsEffort: boolean
  resumeKind: 'ccb-session' | 'codex-thread'
  needsServerRequestId: boolean
}
```
- 硬约束:底座原生消息形状(CCB stream-json SdkMessage、codex fake-SDK
  RunnerMessage)**只允许存在于各 adapter 内部**,不得跨出 engine/ 模块。

### engineSessionId.ts
`engineSessionId(sessionKey) = 'oceng-' + sha256(sessionKey).hex.slice(0,48)`
(54 字符,满足 internalTurnWaive SESSION_ID_RE;唯一 helper,禁止各处自行 hash)。
M0 先落 helper + 测试;接线在 M2 计费。

### registry.ts
- `registerEngine(engineId, factory)` / `resolveEngine(model, agentDef) → engineId`。
- 单一权威:模型注册表 model→engine(M0 仅 'ccb';M1 加 gpt-* → 'codex');
  `agentDef.provider === 'codex-native'` 显式 pin 到 codex(且仅接受
  runnerKind 缺省/'app-server';'exec'/未知 runnerKind fail-closed 抛错)。
- v5 硬闸(sessionManager.ts:1266)语义升级:从"禁 codex-native"改为
  "resolveEngine 未注册 → fail-closed"。M0 阶段 codex 未注册,行为等价现状。

### ccbAdapter.ts(M0 核心)
- 组合 SubprocessRunner(spawn/stdin/stdout 归它)+ per-turn CcbMessageParser。
- 从 sessionManager._runOneTurn **下沉进 adapter** 的 CCB 私有逻辑:
  parser 构造与生命周期、TelemetryChannel 每 turn 实例(→ TurnSummary.phantomSignals)、
  auth 错误分类(AUTH_*_RE → errorKind:'auth')、staleResumeId 透传、
  interrupt/sendPermissionResponse 的 stdin control_request 协议(已在 runner 内,保持)。
- **留在 sessionManager** 的 engine 中立编排(改为消费 EngineEvent/TurnSummary):
  idle timer(30min 无事件 → interrupt+waive)、pendingFinal 缓冲与 auth 门、
  turnBlockCount/permissionCount 统计、phantom 三态判定(输入=
  TurnSummary.phantomSignals + 计数)、session totals 回滚、cron 桥接与
  tool.called 指标(改由 tool_use_detected/tool_result_detected 事件驱动)、
  resume-map 维护、waive 上报。
- 成本 delta 基线(session._lastCcbCumulativeCost / spawn resumed 语义)行为
  必须逐字节不变 —— 实现方式不限(totals ref 传入或 TurnSummary 带 delta),
  以现有测试 + 新增回归测试证明。

## M0 验收(全部满足才算完)
1. `npm run typecheck` rc=0;`npm run test:gateway` 全绿(现有测试不改语义,
   仅允许机械 import/构造调整)。
2. 新增测试:engineSessionId;registry fail-closed(codex-native on v5 → 抛错,
   语义等价旧硬闸);CcbAdapter turn 汇总 parity(text/thinking/tool/segments/
   stopReason/staleResumeId/auth 分类);**crash/interrupt partial persistence**
   (getPartialSnapshot 主风险面);phantom 三态判定回归。
3. sessionManager.getOrCreate 无条件 `new SubprocessRunner` 替换为 registry
   factory;`session.runner` 字段类型改为 EngineAdapter(命名允许迁移为
   `session.engine`,但需全量同步引用点,含 server.ts)。
4. CCB 行为零变化:不改 subprocessRunner 的 spawn argv/env;不改 wire 帧;
   不改 ccbMessageParser 解析语义(允许把类型定义搬到 engine/engineEvents.ts
   并从原文件 re-export 兼容)。

## M1..M4(概要,详见权威方案)
- M1:CodexAdapter(基线=git show 0bed2f76^ 的 codexAppServerRunner/
  codexLaunchOverrides + v3 HEAD 后续修复;fake-SDK 内聚,内部自建 parser 实例
  产出 EngineEvent;exec 路径不复活)+ commercial 侧账号池/auth/relay 复活
  + supervisor/entrypoint 接线 + 模型面(gpt-5.5 → codex 注册)。
- M2:计费双钱包整合(settleUsageAndLedger/spendTwoBucket 唯一收口、零输出免单、
  engineSessionId 接 turn-waive、account_id=null、balanceAfter=双桶总余额、
  bridge inflight/drain/防重 全量复活,readyState 检查前拦截 billing 帧)。
- M3:镜像 OC_INCLUDE_CODEX=1 重建 + canary 部署。
- M4:两底座 e2e 卡片矩阵 + Codex 代码审计 PASS。

## M1a 落地记录(2026-07-02,gateway 侧 CodexAdapter 复活)

已完成(只动 packages/gateway/**):

1. **复活文件**(源 = `git show 0bed2f76^`,byte-parity 除注明处):
   - `engine/codexAppServerRunner.ts`(2680 行,CodexAdapter 内核;仅 import 路径改
     `codexRunner.js → codexShared.js`、相对路径加 `../`)。
   - `engine/codexShared.ts`(新):旧 codexRunner.ts 的 6 符号闭包抽离
     (_sanitizeThreadId / copyImagePathsToPublicDir / codexReasoningEffortConfig /
     CodexProviderConfigOverride / buildCodexProviderConfigArgs / buildCodexEnv);
     exec 路径其余代码不进树。
   - `codexLaunchOverrides.ts`:P1f 搬进 subprocessRunner 的三函数改**反向 import**
     + re-export(单一权威在 subprocessRunner,不复制第二份)。codex vision 4 env 键
     (CODEX_HOME / OPENCLAUDE_VISION_CODEX_*)**不回补** —— vision 默认 MiniMax
     backend(v1.0.341),codex vision backend 不随 M1a 恢复(文件头有注)。
   - `v3CodexRelay.ts` + server.ts loopback 挂载(/internal/v3/codex-relay,
     loopback-only)。
   - promptSlots 两处 codex 分支:GPT understand_image 提示段 + **literature
     scrub 安全 gate**(`provider !== 'codex-native'`)。CodexAdapter 构造内核时
     **强制 agentProvider='codex-native'**:engine 按模型判定后任意 provider 的
     agent 都可能落 codex 底座,收口保证 gate 恒命中(与 buildCodexEnv scrub 成对)。

2. **engine/codexAdapter.ts**:EngineAdapter 实现。fake-SDK RunnerMessage 内聚
   (仅存在于 codexAdapter.ts / codexAppServerRunner.ts);内部自建 per-turn
   CcbMessageParser 产出 EngineEvent;capabilities = { billingMode:
   'engine-reported', supportsEffort:true, resumeKind:'codex-thread',
   needsServerRequestId:true };phantomSignals 恒 {apiState:'unknown'};
   errorKind 'auth' 按 codex 错误形状(401/token 失效,含 catch 路径 result
   error 原文);billing 经独立 'billing' 通道 emit EngineBillingEvent
   (**新增 engineSessionId 字段** = engineSessionId(sessionKey),M2 settle/waive
   记账键;wire 帧 OutboundCodexBilling 暂不携带 —— protocol 包不在本批)。

3. **registry / sessionManager 接线**:
   - MODEL_ENGINE_MAP 登记 'gpt-5.5' → 'codex';registerEngine('codex', factory)。
   - getOrCreate:providerTag 泛化为 **engine id**('ccb'/'codex',字段名保留);
     新增 `opts.model`(inbound desired model,server dispatchInbound 传 safeModel)
     参与 resolveEngine 判定 → engine 变化走 provider-switch teardown + compact
     transcript preamble;**无模型调用不参与比较**(防 cron/pre-warm 误踢 engine)。
     resume-map 按 engine 隔离(legacy 'codex-native' tag 加载时归一 'codex')。
   - _runOneTurn:'billing' 事件 turn-scoped 转发为 SessionStreamEvent
     'codex_billing' → server.ts outbound.codex_billing 帧(P1f 前原样回贴)。
   - inferAgentForModel:gpt-* 不再 'gpt_unsupported' fail-closed,也**不再路由
     固定 id='codex' agent**(engine 由 registry 按模型判定,agent 不换)——
     旧 v3 "provider 决定 runner → 必须换 agent"设计随 engine 维度取消。
   - pickIdleTimeoutMs 第三参 = engine id('codex' 命中 TOOL 档)。

4. **M0 Codex 评审 nits**:①TurnParams.sessionTotals 改中立 EngineSessionTotals
   ({totalCostUSD, turns});CCB 私有 _lastCcbCumulativeCost 收进 ccbAdapter 的
   CcbSessionTotals 兼容子契约(asCcbSessionTotals 收窄,缺省补 0)。
   ②stale-resume 时序回归测试(sessionManagerEngineSwitch.test.ts)。

5. **测试**:test:gateway 1176/1176(M0 基线 995 + 181);typecheck rc=0。
   新增/复活:codexAppServerRunner.test.ts(113,复活)、codexLaunchOverrides.test.ts
   (26,复活)、v3CodexRelay.test.ts(3,复活)、codexShared.test.ts(11,新)、
   codexAdapterTurnParity.test.ts(15,新:握手/thread start+resume/全卡片映射/
   imageGeneration 落盘/billing/interrupt/approval auto-response/崩溃 partial)、
   sessionManagerEngineSwitch.test.ts(7,新:跨 engine 切换 + nit②)。

**M1a 未做 / 留给后续批次**(有意,非遗漏):
- codexRoute 覆盖链(server `_buildSafeCodexRouteOverride` / submit(codexRoute) /
  wechat `__oc_codex_route` 校验 / codex-native 无 model AGENT_AUTHZ 防御):
  依赖 commercial 侧 relay/账号组(M1b/M2)。CodexAdapter 已留 setCodexRoute /
  setConversationMode 直通口。
- OAUTH_PROVIDERS.codex + codexAuthSync:个人版/单机形态,v5 商业走 account-pool
  codex-auth,不复活(复活底稿 A4 结论)。
- codexAutoPlanMode:不复活,conversationMode 恒 'default'。
- `_reportTurnWaive` 对 codex session 仍上报 thread id(错口径)——M2 用
  EngineBillingEvent.engineSessionId 统一记账键时一并改。
- OutboundCodexBilling wire 帧扩 engineSessionId 字段(protocol 包)→ M2。

---

## M1b 实施记录(2026-07-02,commercial 侧 codex 基础设施复活)

**范围**:packages/commercial/**(+db migration 0098 + 本文档)。bridge 计费状态机
(userChatBridge codexBinding/createCodexRoute/expireCodexRoute + inflight/drain)
留 M2,恢复源 `git show eb1ab67b^:packages/commercial/src/ws/userChatBridge.ts`。

1. **复活文件**(0bed2f76^ 原样 + v5 lead 版):account-pool/{codexAccountActor,
   codexDisableFanout,codexEgress,codexLazyMigrate}、codex-auth/* 整目录、
   http/{internalCodexRelay,internalCodexTokenRefresh}、billing/codexFinalizer、
   refresh.ts codex 段(-233 行反打)、v3supervisor codex auth/relay env 注入 +
   codex HOME 卷(4→5)、admin codex-disable-rebind 钩子、entrypoint codex seed
   agent(gpt-5.5 / codex-native / app-server)、index.ts 全部接线(调度器按
   trackScheduler 登记制)。

2. **架构决策①:codex 账号池权威按 runtime_channel 划分(migration 0098)**。
   claude_accounts 加 runtime_channel 列(default 'v3',CHECK IN('v3','v5'),
   v3 现网零影响);v5 的 codexAccountActor 枚举 / pickCodexAccountForBindingInTx /
   hasActiveOfficialOAuthAccountInGroup(codex)严格只取本 channel 行,fail-closed
   池空不回落 —— 防 v3/v5 双 master 共刷同一 codex OAuth refresh-token family 吊销
   (个人版 Claude OAuth 双权威源同型事故)。codexRefreshActor / codexDriftReconciler
   登记为 **v5-owned(channel-scoped)** 域,gate `(controlPlaneEnabled || channel==='v5')`。
   claude provider 行暂不按 channel 分流(共享池语义不动)。
   **运维待办**:v5 要用 codex,须由 admin 以 runtime_channel='v5' 录入专属账号行
   (或把某 v3 行整行迁给 v5 —— 迁移即换权威,禁止两 channel 同链共刷)。

3. **架构决策②:codex relay 归属 egress 进程**。装配收口新模块
   http/codexInternalAssembly.ts(master 与 egress 共用同一份 db 闭包/fileWriter,
   根除双份手抄漂移);egress/main.ts 本地挂载 codex-relay(流式)+ token-refresh
   (401 自愈,fanout 在 egress 进程直连 enqueue,FOR UPDATE 跨进程安全),
   master dispatchInternal 挂载保留服务非 split 拓扑。
   **⚠️ 部署**:改 codex relay/refresh/assembly 代码须 `deploy-v5.sh --egress`。

4. **计费红线预埋(finalizer v5 形态,bridge 不接)**:codexFinalizer 经
   settleUsageAndLedger → spendTwoBucket(双钱包自动生效,balanceAfter=总可用);
   零输出免单在 finalizer 层显式补(success+output=0+本有成本 → cost=0 落 audit,
   snapshot 记 waived/wouldHaveCharged);usage_records.account_id 恒 NULL(弃 0n
   假账号);session_id = deriveEngineSessionId('oceng-'+sha256(key).hex[0:48],
   单一权威 helper,构造期形状 fail-closed)。wechat codex 路径已按新口径接
   (顺带修 v3 遗留 appendCostCredits 未加 c: 前缀的孤儿成本 bug)。

5. **测试**:复活 12 个 commercial codex 测试 + v3Supervisor.test 反打;
   codexFinalizer.test 改双钱包 fake SQL + 新增 6 case(免单/NULL 账号/session 口径);
   codexLazyMigrate.test 2 处断言更新为 channel SQL;新增
   codexChannelPartition.integ.test(8 case:0098 幂等/CHECK/picker fail-closed/
   actor 枚举口径/claude 不受影响,真 PG 全绿)。runtimeEntrypointPolicy.test
   翻转为断言 codex seed 存在。单测/integ 失败集与 canonical 逐名一致(零新增)。

**M1b 未做 / 留给 M2**:bridge codex 计费状态机与 codexBinding 三件套接线;
userChatBridgeCodexBilling.test(1167 行)改造复用;runtime image 以
OC_INCLUDE_CODEX=1 重建(M3);/api/public/models gpt-5.5 可见性确认。

---

## M2 落地记录(2026-07-02,codex 真扣费 bridge 闭环 / 双钱包)

**范围**:packages/{protocol,gateway,commercial} + 本文档。四条钱安全红线
(方案 §D)全部落地,落点见下。

1. **protocol**:`OutboundCodexBilling` 扩 `engineSessionId` 字段
   (`Type.Optional(Type.String({ pattern: '^oceng-[0-9a-f]{48}$' }))`,
   frames.ts)。Optional 仅为渐进部署(旧容器镜像不带);master 侧对缺失/非法
   fail-closed(见 3)。

2. **gateway**:
   - server.ts codex_billing 分支:`engineSessionId: e.engineSessionId` 进 wire 帧
     (M1a 遗留项收口)。
   - sessionManager:`_reportTurnWaive` 记账键按 **billingMode 能力分支**收口到新
     exported helper `waiveAccountingSessionId`:'engine-reported'(codex)→
     `engineSessionId(sessionKey)`(恒可派生,不依赖 native id);'proxy'(CCB)→
     原生 ccb session id(未学到跳过,行为不变)。M1a 偏离项4(codex 上报 thread
     id 的错口径)就此消除 —— settle 与 waive 由构造保证同 helper 同入参。

3. **commercial bridge(核心,ws/userChatBridge.ts)**:以 `0bed2f76^`(计费分支)
   + `eb1ab67b^`(脚手架)为底本手工合流进现 HEAD(与 turnActiveUntil 心跳宽限 /
   resume 裁决权归容器 / relay_ready 等 P1f 后改动共存):
   - inbound:AGENT_AUTHZ_IMPLIED_MODEL 回登 codex→gpt-5.5;`__oc_codex_route`
     client 输入剥离;codex IIFE(route 决策 → codexBinding.acquire 严格单飞/
     legacy 透传/stale recycle → preCheckWithCost → startInflightJournal →
     inflight snapshot 注册 → frame rewrite 注入 server-owned requestId+traceId
     → forward)。
   - **M2 结构改动:finalizer 延迟到 billing 帧构造**(CodexTurnSnapshot.getFinalizer/
     abandon,单一 snapState 状态机)。原因:usage_records.session_id 的权威值 =
     帧上的 engineSessionId(gateway 唯一 helper 产物);inbound 期 bridge 不可靠知道
     gateway 侧 sessionKey(agent 路由可改写 sessionKey),自行派生会破坏
     settle=waive 同值不变量。abandon = abort journal + release reservation(等价
     finalizer.fail;finalizer 已构造则委托 _done 守门)。
   - outbound:`outbound.codex_billing` 拦截在 **userWs.readyState 检查之前**
     (drain 期用户已断也落账);engineSessionId 缺失/形状非法 → **fail-closed
     免单**(abandon + error 告警,宁可少收不可乱扣 —— 口径错的 session_id 入库
     会让退款窗口圈不到,变成"该退不退");settle 走 M1b codexFinalizer
     (settleUsageAndLedger→spendTwoBucket 双钱包 / 零输出免单 / account_id NULL);
     duplicate 帧防重 = Map 同步 delete + finalizer._done;cost_charged
     balanceAfter = 双钱包总可用;G6 outbound 终态早释放回贴。
   - cleanup:drain 状态机回贴(user_close+inflight → drain 窗口;DRAIN_BILLING_MS
     改 env 可覆盖、读时求值,默认 5s —— 旧版模块常量测试只能真等 5s);
     checkDrainComplete;finalCleanup fail-abort(残留 inflight abandon)+ 槽/route
     兜底释放。heartbeat 超时同走 drain(client_close 语义)。
   - `accountIdForLedger` 更名 `accountIdForQuota`:M2 起该值只服务 rateLimits 落
     claude_accounts.quota_*(usage_records.account_id 恒 NULL)。

4. **commercial index.ts**:复活 `createCommercialCodexRoute`(api_relay/
   official_oauth/unavailable 判别联合)+ `codexBinding` handle(FOR UPDATE +
   stale recycle + lazy migrate,P1f^ 原样;**一处刻意偏离**:legacy NULL 分支的
   池非空探测 SQL 补 `runtime_channel` 过滤 —— 0098 后 picker 是 channel-scoped,
   不同口径会让 v5 看见 v3 行误判"池非空"→ recycle 死循环)+ bridge 三件套
   deps 注入(codexBinding/createCodexRoute/expireCodexRoute)。

5. **四条钱安全红线落点**:
   1. 零输出免单:billing/codexFinalizer.ts(M1b 已备)+ bridge settle 直连生效;
      e2e case = userChatBridgeCodexBilling"零输出免单"套;
   2. settle=waive 同一 engineSessionId:gateway engineSessionId helper(唯一权威)
      → CodexAdapter billing 事件 → wire 帧 → bridge settle 落库;waive 侧
      sessionManager.waiveAccountingSessionId 同 helper 同入参;
      refund.refundSessionWindow 按 usage_records.session_id 圈账即可命中;
   3. account_id NULL:codexFinalizer settle 恒传 null;bridge 不再有 0n 假账号
      进 usage_records(仅 quota 路径保留 0n=无关联语义);
   4. balanceAfter 双桶:spendTwoBucket.totalAfter 经 SettleResult → finalizer →
      cost_charged 广播。

6. **测试**:protocol frames.test +3(engineSessionId 形状);gateway 新增
   sessionManagerTurnWaive.test(3:能力分支纯函数 + waive POST e2e,e2e 等真实
   5s SEND_DELAY);test:gateway 1179/1179(M1a 基线 1176+3);
   userChatBridgeCodexBilling.test 复活(20 case 全绿:happy path 双钱包断言/
   duplicate/safeNum/零输出免单/balanceAfter 双桶跨桶两条 ledger/engineSessionId
   缺失+非法 fail-closed/drain 落账(readyState 前拦截)/drain timeout fail-abort/
   legacy NULL 逐轮计费(account_id NULL)/relay 四态/stale recycle/CG2c trace×2/
   partial deps + codexBinding-无三件套 boot fail-closed)。fake pgPool 兜
   spendTwoBucket 序列(users FOR UPDATE / user_subscriptions FOR UPDATE /
   period UPDATE / 每桶一条 ledger / getSpendableBalance 双桶查询)。
   test:commercial:unit 失败集与 HEAD(a08a7ab6)基线逐名一致零新增。

7. **⚠️ 部署红线(92ddbbdc 拓扑判定)**:
   - M2 改动均落 **master 进程**(userChatBridge / index 装配 / codexFinalizer
     调用侧)与 **容器 gateway**(server.ts/sessionManager,需 M3 runtime image
     重建才进容器);egress 进程职责(/v1/messages anthropicProxy、codex-relay、
     token-refresh)本批**零改动** → M2 单独部署不强制 `--egress`。
   - 但 codex 全链上线 = M1b(relay/refresh/assembly 归 egress)+ M2 一起发,
     **合并部署必须 `deploy-v5.sh --egress`**(否则 egress 跑旧代码没有
     codex-relay 本地挂载);protocol 包为共享依赖,--egress 顺带消除两进程
     版本漂移。结论:**M2/M3 上线批次按 --egress 执行**。

**M2 未做 / 留给 M3+**:runtime image OC_INCLUDE_CODEX=1 重建 + canary;
/api/public/models gpt-5.5 可见性确认;e2e 卡片矩阵 + Codex 审计(M4)。
