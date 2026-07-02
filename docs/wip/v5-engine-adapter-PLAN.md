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
