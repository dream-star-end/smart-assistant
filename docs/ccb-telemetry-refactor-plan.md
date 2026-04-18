# CCB → Gateway Telemetry 通道重构计划 (v3)

**状态**: v3,Codex 第二轮反馈已并入,待第三轮审计
**创建**: 2026-04-18
**作者**: main agent
**v1 → v2 关键变更**:
- (Codex F4)PHANTOM 信号改三态 `called | skipped | unknown`,不再用 `boolean | null`
- (Codex F3)telemetry sink 不再假设全局 `structuredIO`,改为依赖注入 + 直接走 `writeToStdout + ndjsonSafeStringify`
- (Codex S6 高价值)stop_reason **不**走 telemetry —— CCB result 行已经带,只让 Gateway parser 多读一个字段。Telemetry 只承担"是否调过 API / 是否 skip"这一类**今天没有任何来源**的权威信号
- (Codex F5)Gateway listener cleanup 统一进 `detach()`
- (Codex F7)测试矩阵补 R5/R7/R8 缺口
- (Codex S8)telemetry 事件加 `schemaVersion` + `session_id`,长度按 UTF-8 字节算

**v2 → v3 关键变更**:
- (Codex v2 F4)session_id 契约改为"运行期期望存在,实现容忍缺失" —— Gateway 丢弃并计数,不当错误
- (Codex v2 F2)`ndjsonSafeStringify` import 路径修正为真实位置 `src/cli/ndjsonSafeStringify.ts`
- (Codex v2 F3)default sink 不吞异常;emit() 用内外两层 try/catch,`emittedCount` 仅在 sink 成功时自增,避免与 `sinkErrorCount` 双计
- (Codex v2 F1)`parse_error` listener 改 per-turn 注册,与 `telemetry` listener 一起进 `detach()`,error/exit/timeout 路径全部清理
- (Codex v2 NQ1)called+skipped 同时到达时保留"优先 skipped"策略,新增 `conflictCount` 防御性诊断(不扩第四态)
- (Codex v3 F1)parse_error handler 签名修正为 `(payload: { line, err }) => …`,匹配 `subprocessRunner.ts:545` 真实 emit payload
- (Codex v3 F2)§5.1 subprocessRunner 分流伪码补出 session_id 缺失时的 `drop + missingSessionIdCount++ + continue` 分支,把 §3.1 的协议容忍落地到实现层;R6 测试行新增对应用例

---

## 1. 问题与目标

### 当前症状
Gateway 把 CCB 当子进程跑、解析其 stream-json 输出。当 CCB 的本轮 API 返回 `stop_reason: end_turn` 但 0 个 content block 时(同时 `cost > 0`,即 API 实际被调用并扣费),Gateway 没有信号判断这是 **模型主动 end_turn** 还是 **会话上下文有问题导致模型放弃** 还是 **子进程内部状态错乱**。当前前端只能粗暴显示一句模糊的"模型本轮未输出新内容"。

### 根本架构问题
Gateway 通过启发式回猜 CCB 内部状态:
- PHANTOM_TURN 判定靠 `cost===0 && blocks===0 && tokens===0` 9 个 AND 条件
- AUTH_ERROR 判定靠正则匹配文案
- 空轮归因靠前端走查 `sess.messages` 推测"上一轮有没有内容"
- transcript 完整性 Gateway 完全看不到

### 目标
**最小侵入**在 CCB 加 observability hook,让 Gateway 拿到权威信号(是否调了 API、是否 skip、transcript 健康度),把"启发式回猜"改成"权威信号优先 + 启发式 fallback"。

**重要简化(v2)**:`stop_reason` 实际不需要 telemetry —— CCB 在 `QueryEngine.ts:1168` 的 result 行已经带 `stop_reason`、`session_id`、`usage`、`modelUsage`,Gateway 的 `ccbMessageParser._handleResult`(`ccbMessageParser.ts:426`)只用了 `usage` + `total_cost_usd`,**漏读了 `stop_reason`**。补这个字段就立刻拿到精确归因。Telemetry 只补 result 行**没有**的信号。

### 非目标
- 不替换 CCB(不切 `@anthropic-ai/claude-agent-sdk`)
- 不改 CCB 任何业务逻辑(tool loop / API call / transcript 管理 / permission / compaction 行为完全不变)
- 不动 v2 商用版(稳定后再 cherry-pick)

---

## 2. 设计原则(死规矩)

| # | 规矩 | 理由 |
|---|---|---|
| R1 | **CCB 行为不变** —— hook 只观察、不改控制流 | 降低风险,保留可回滚性 |
| R2 | **emit 必须 try/catch,失败静默** | 观察点不应成为新故障源 |
| R3 | **协议字段 `type: '_oc_telemetry'` + `schemaVersion: 1`** | 与现有 stream-json type 集合正交,版本位预留演进空间 |
| R4 | **telemetry 走 stdout(stream-json 同通道)** —— 不开新 fd | 复用现有 IPC,行级原子 |
| R5 | **只在 stream-json + verbose 模式下 emit** | OpenClaude 永远以这个模式跑 CCB,其它模式不应被污染 |
| R6 | **Gateway 端在 subprocessRunner 层分流** —— `_oc` 行不进 ccbMessageParser | parser 不需要知道 telemetry 存在 |
| R7 | **telemetry 失效 = fallback 到现有启发式** | 某些 hook 可能因竞态/异常没 emit |
| R8 | **每个 hook 都可独立开关** —— `OC_TELEMETRY_DISABLED=1` 一键全关 | 紧急关停手段 |
| R9 | **(v2 新加)Gateway listener 必须随 turn 生命周期严格清理,统一进 `detach()`** | 防止 listener 累积/泄漏,error/exit/timeout 路径同样需要清理 |

---

## 3. 协议规约

### 3.1 Wire format

```json
{
  "type": "_oc_telemetry",
  "schemaVersion": 1,
  "event": "turn.willCallApi",
  "session_id": "abc-123",
  "data": { "model": "claude-opus-4-7", "messageCount": 42, "toolCount": 18 },
  "ts": 1776472150940
}
```

字段约束:
- `type` 固定为 `_oc_telemetry`(R3)
- `schemaVersion` 固定为 `1`(本期),未来不兼容变更升 `2`
- `event` 必填,小写点分(分类清单见 §3.2)
- `session_id` 运行期期望存在,实现容忍缺失(早期启动阶段 `getSessionId()` 可能返回 undefined,此时 payload 中 `session_id` 字段省略 —— Gateway 端对缺失 session_id 的 telemetry 行静默丢弃并计数,不作为错误)
- `data` plain object,纯 JSON 可序列化(无函数/Symbol/循环引用)
- `ts` epoch ms

体积约束(均按 **UTF-8 字节** 计):
- 单个字符串字段长度上限:`1024` 字节,超出截断,加 `"_truncated": true`
- 数组字段长度上限:`50` 元素
- **整个事件 UTF-8 字节上限**:`8192`,超出整事件丢弃,`droppedCount++`

### 3.2 事件清单

#### Phase A(本期 PR 实现)

| 事件 | 触发位置 | 关键字段 | 用途 |
|---|---|---|---|
| `turn.willCallApi` | `claude.ts:1786` 之后 | `model`, `messageCount`, `toolCount`, `thinkingBudget?` | 标记本轮已发出 API 请求 |
| `turn.skipped` | `QueryEngine.ts:559` `if (!shouldQuery)` 内 | `reason: 'shouldQuery=false'`, `commandName?` | 标记本轮**故意没调** API(本地 slash 命令) |

> **v2 删除了 `turn.apiResponse`** —— 因为 CCB result 行已带 `stop_reason` + `usage`,Gateway 在 parser 里多读一个字段即可,不需要 telemetry 重复传。

#### Phase B(下个 PR,v2 不实现但模块预留接口)

`transcript.warning` / `tool.dispatched` / `tool.returned` / `compaction.triggered` / `compaction.completed` / `session.resumed`

### 3.3 `result` 行字段消费(非 telemetry,纯 parser 改动)

CCB 在 `QueryEngine.ts:1160-1182` yield 的 `type:'result'` 消息,字段如下:
```ts
{
  type: 'result',
  subtype: 'success' | 'error_during_execution',
  is_error: boolean,
  duration_ms, duration_api_ms, num_turns,
  result: string,
  stop_reason: string | null,        // ← 当前 parser 漏读
  session_id: string,
  total_cost_usd: number,
  usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
  modelUsage: object,                // ← 当前 parser 漏读
  permission_denials: array,
  ...
}
```

Gateway parser 改造点:在 `ccbMessageParser._handleResult`(`ccbMessageParser.ts:426`)读取 `stop_reason` 并放进 `TurnResult` + `final.meta`。

---

## 4. CCB 端实现细节

### 4.1 新模块:`src/_openclaude/telemetry.ts`

**关键 v2 修正**:不假设全局 `structuredIO`(因为 `structuredIO` 是 `print.ts:582` 局部创建的)。改为**依赖注入 sink**,默认 sink 直接走 `process.stdout.write(ndjsonSafeStringify(...) + '\n')`。

```ts
// ~120 行,无外部 telemetry 依赖
import { ndjsonSafeStringify } from '../cli/ndjsonSafeStringify'  // 真实位置:src/cli/ndjsonSafeStringify.ts:30(v3 修正 Codex F2)

const DISABLED = process.env.OC_TELEMETRY_DISABLED === '1'
const SCHEMA_VERSION = 1
const MAX_FIELD_BYTES = 1024
const MAX_ARRAY_LEN = 50
const MAX_EVENT_BYTES = 8192

type Sink = (line: string) => void

let sink: Sink | null = null
let outputFormat: string | undefined
let verbose = false
let getSessionId: () => string | undefined = () => undefined
let droppedCount = 0
let emittedCount = 0
let sinkErrorCount = 0

export function configureTelemetry(opts: {
  outputFormat?: string
  verbose?: boolean
  sink?: Sink                          // 测试可注入
  sessionIdProvider?: () => string | undefined
}) {
  outputFormat = opts.outputFormat
  verbose = !!opts.verbose
  // v3 修正 Codex F3:默认 sink 不吞异常,让 emit() 外层 try/catch 统一处理,
  // 避免"写失败但 emittedCount 也 ++"的计数错乱
  if (opts.sink) sink = opts.sink
  else sink = (line: string) => { process.stdout.write(line) }
  if (opts.sessionIdProvider) getSessionId = opts.sessionIdProvider
}

export function getDiagnostics() {
  return { droppedCount, emittedCount, sinkErrorCount, configured: sink !== null }
}

export function emit(event: string, data: Record<string, unknown> = {}): void {
  if (DISABLED) return                                           // R8
  if (outputFormat !== 'stream-json' || !verbose) return         // R5
  if (!sink) return                                              // configureTelemetry 还没跑(早期阶段)
  try {
    const sanitized = sanitizeData(data)
    const payload = {
      type: '_oc_telemetry',
      schemaVersion: SCHEMA_VERSION,
      event,
      session_id: getSessionId(),
      data: sanitized,
      ts: Date.now(),
    }
    const json = ndjsonSafeStringify(payload)
    if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
      droppedCount++
      return
    }
    // v3 修正 Codex F3:sink 独立 try/catch,成功才 ++emittedCount,失败 ++sinkErrorCount,不重叠
    try {
      sink(json + '\n')
      emittedCount++
    } catch {
      sinkErrorCount++
    }
  } catch {
    // R2: 构造/序列化阶段失败,sink 还没调用,不计 emittedCount,只记 sinkErrorCount
    sinkErrorCount++
  }
}

function sanitizeData(input: any, depth = 0): any {
  if (depth > 4) return '[truncated:depth]'
  if (input == null) return input
  if (typeof input === 'string') {
    return Buffer.byteLength(input, 'utf8') > MAX_FIELD_BYTES
      ? input.slice(0, MAX_FIELD_BYTES / 4) + '…[truncated]'
      : input
  }
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (Array.isArray(input)) {
    const truncated = input.length > MAX_ARRAY_LEN
    const arr = input.slice(0, MAX_ARRAY_LEN).map(v => sanitizeData(v, depth + 1))
    return truncated ? Object.assign(arr, { _truncatedFromN: input.length }) : arr
  }
  if (typeof input === 'object') {
    const out: any = {}
    for (const k of Object.keys(input)) out[k] = sanitizeData((input as any)[k], depth + 1)
    return out
  }
  return undefined  // function / symbol / etc 丢弃
}
```

### 4.2 配置接入

`src/cli/print.ts`,在 `getStructuredIO` 之后:
```ts
// print.ts:583 之后(structuredIO 已构造完)
import { configureTelemetry } from '../_openclaude/telemetry'
import { getSessionId } from '../utils/sessionId'  // 已存在

configureTelemetry({
  outputFormat: options.outputFormat,
  verbose: options.verbose,
  sessionIdProvider: () => { try { return getSessionId() } catch { return undefined } },
  // 默认 sink: 直接 process.stdout.write — 与 structuredIO 同通道但独立
})
```

### 4.3 Hook 注入点

**Hook 1: turn.willCallApi**

`src/services/api/claude.ts:1786` 之后:
```ts
captureAPIRequest(params, options.querySource)
emit('turn.willCallApi', {
  model: params.model,
  messageCount: params.messages.length,
  toolCount: params.tools?.length ?? 0,
  thinkingBudget: (params as any).thinking?.budget_tokens,
})
```

只 hook 流式主路径(2229 起的 stream).不 hook:
- `claude.ts:521` `verifyApiKey()` —— 在 `isNonInteractiveSession`(Gateway 跑的模式)下直接跳过,不会触发(Codex F2 修正)
- `claude.ts:851` 非流式 fallback —— 是流式失败时的兜底,会回流到 Hook 1 上层 turn 边界,不会让 Gateway 误判 phantom(Hook 1 已 fire 过)

**Hook 3: turn.skipped**(注:v2 删了 Hook 2,所以只剩两个,序号保留以便对照 v1)

`src/QueryEngine.ts:559`:
```ts
if (!shouldQuery) {
  emit('turn.skipped', { reason: 'shouldQuery=false' })
  for (const msg of messagesFromUserInput) {
    ...
  }
}
```

### 4.4 总改动量(Phase A,v2)

- 新文件: `src/_openclaude/telemetry.ts`(~120 行)
- 修改文件:
  - `src/cli/print.ts`(+5 行 configureTelemetry 调用)
  - `src/services/api/claude.ts`(+10 行,Hook 1 一处 emit)
  - `src/QueryEngine.ts`(+1 行,Hook 3 一处 emit)
- 单元测试: `src/_openclaude/__tests__/telemetry.test.ts`(~150 行)

总 diff < 300 行。

---

## 5. Gateway 端实现细节

### 5.1 subprocessRunner 分流 + parse_error 处理

`packages/gateway/src/subprocessRunner.ts:537` 之前:
```ts
const msg = JSON.parse(trimmed) as SdkMessage
// v2 新增分流
// v3(Codex v3 Finding 2):session_id 缺失 → drop + 计数,与 §3.1 "实现容忍缺失" 对齐
if ((msg as any)?.type === '_oc_telemetry') {
  const telemetryMsg = msg as any
  if (typeof telemetryMsg.session_id !== 'string' || !telemetryMsg.session_id) {
    this.missingSessionIdCount = (this.missingSessionIdCount ?? 0) + 1
    // 静默丢弃,不进 'telemetry' 监听器,不算 parse_error
    offset = nlIdx + 1
    continue
  }
  this.emit('telemetry', telemetryMsg)
  // 不更新 currentSessionId(telemetry 不应触发 session 切换)
  // 不 emit 'message',不进 parser
  offset = nlIdx + 1
  continue
}
if (msg.session_id && msg.session_id !== this.currentSessionId) {
  ...
}
this.emit('message', msg)
```

`missingSessionIdCount` 为 runner 实例级计数,供诊断查询(如 `/health` 输出或 `sessionManager` 在 `detach()` 时 snapshot 一次)。

EventEmitter 类型签名扩展:`emit('telemetry', OcTelemetryEvent)`、`on('telemetry', listener)`。

**parse_error**(`subprocessRunner.ts:545`)v2 增加上层日志,因为 telemetry 行损坏会经此路径:Gateway 在 `sessionManager` 注册 `runner.on('parse_error', ...)`,记 warn 日志,不抛错。

### 5.2 新模块:`packages/gateway/src/telemetryChannel.ts`

```ts
// ~180 行,带三态信号(v2 修正:Codex F4)
export interface OcTelemetryEvent {
  type: '_oc_telemetry'
  schemaVersion: number
  event: string
  session_id?: string
  data: Record<string, unknown>
  ts: number
}

export type ApiState = 'called' | 'skipped' | 'unknown'  // v2 三态

export interface TurnSignals {
  apiState: ApiState
  skipReason: string | null
  willCallApiAt: number | null
  // stop_reason / blockCount 不在这里 —— 直接从 parser TurnResult 读
}

export class TelemetryChannel {
  private willCallApi?: OcTelemetryEvent
  private skipped?: OcTelemetryEvent
  private incompleteCount = 0  // willCallApi 但 turn 结束时还没 final result 的计数
  private conflictCount = 0    // v3:called+skipped 同时到达的冲突计数(诊断用)

  ingest(ev: OcTelemetryEvent): void {
    // 防御:只接受已知 event,未知 event 忽略不报错(向前兼容)
    if (ev.event === 'turn.willCallApi') {
      this.willCallApi = ev
      // v3(Codex v2 NQ1):若先收到 skipped 后收到 willCallApi,记冲突但保留 skipped 优先
      //                  —— 该情形理论上不会发生(print.ts 是串行单进程),仅作诊断
      if (this.skipped) this.conflictCount++
    } else if (ev.event === 'turn.skipped') {
      this.skipped = ev
      if (this.willCallApi) this.conflictCount++
    }
    // 不认识的 event 静默忽略(向前兼容 schemaVersion 升级)
  }

  getConflictCount(): number { return this.conflictCount }

  getTurnSignals(): TurnSignals {
    if (this.skipped) {
      return {
        apiState: 'skipped',
        skipReason: (this.skipped.data.reason as string) ?? null,
        willCallApiAt: null,
      }
    }
    if (this.willCallApi) {
      return {
        apiState: 'called',
        skipReason: null,
        willCallApiAt: this.willCallApi.ts,
      }
    }
    return { apiState: 'unknown', skipReason: null, willCallApiAt: null }
  }

  /** 一次 turn 结束时调用,清空状态准备下一轮 */
  resetForNewTurn(): void {
    this.willCallApi = undefined
    this.skipped = undefined
  }

  noteIncomplete(): void { this.incompleteCount++ }
  getIncompleteCount(): number { return this.incompleteCount }
}
```

### 5.3 ccbMessageParser 增强 —— 读 result.stop_reason

**这是 v2 最大简化点(Codex S6)**。`ccbMessageParser._handleResult`(line 426)增加:

```ts
// ccbMessageParser.ts:442 修改
this.turnResult = {
  cost: turnCost,
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  assistantText: this.assistantBuf,
  isError: !!(msg as any).is_error,
  stopReason: (msg as any).stop_reason ?? null,   // v2 新增
  numTurns: (msg as any).num_turns ?? null,       // v2 新增,诊断用
}
```

`TurnResult` interface 同步加字段。

`final.meta` 也补:
```ts
this.onEvent({
  kind: 'final',
  meta: {
    cost: turnCost,
    inputTokens: usage.input_tokens,
    ...,
    stopReason: (msg as any).stop_reason ?? undefined,  // v2 新增
  },
})
```

### 5.4 接入 sessionManager

`_runOneTurn` 内部:

```ts
const telemetry = new TelemetryChannel()
const telemetryHandler = (msg: OcTelemetryEvent) => telemetry.ingest(msg)
// v3(Codex v2 Finding 1):parse_error listener 也要 per-turn 注册并在 detach 清
// v3(Codex v3 Finding 1):runner 真实 emit 签名是 `emit('parse_error', { line, err })`
//                         (subprocessRunner.ts:545),handler 必须接单对象参数
const parseErrorHandler = (payload: { line: string; err: unknown }) => {
  const err = payload.err as Error | undefined
  log.warn('ccb stdout parse_error', {
    sessionKey,
    msg: err?.message,
    sample: payload.line?.slice(0, 200),
  })
  // 若 parse_error 命中 result 行,turn 可能拿不到 stopReason
  // TelemetryChannel 提供 incompleteCount 供事后诊断,但这里不改 phantom 主链路
}
runner.on('telemetry', telemetryHandler)
runner.on('parse_error', parseErrorHandler)

// v2 修正(Codex F5):cleanup 进 detach,error/exit/timeout 都覆盖
// v3 修正(Codex v2 Finding 1):parse_error 监听器也入 detach,防 per-turn 泄漏
const detach = () => {
  clearTimeout(timer)
  parser.finish()
  if (session._currentParser === parser) session._currentParser = undefined
  runner.off('message', handleMessage)
  runner.off('error', handleError)
  runner.off('exit', handleExit)
  runner.off('telemetry', telemetryHandler)      // ← v2 新增
  runner.off('parse_error', parseErrorHandler)   // ← v3 新增
}

// onFinish 改造
onFinish: (result) => {
  detach()  // detach 现在会清 telemetry listener

  // 1. AUTH_ERROR 检测 — 不变
  if (isAuthError) { ... }

  // 2. PHANTOM_TURN 三态判定(v2 修正:Codex F4)
  const signals = telemetry.getTurnSignals()
  let isPhantomTurn: boolean
  switch (signals.apiState) {
    case 'skipped':
      // CCB 明确告知没该调 API(slash 命令等)→ 不算 phantom,正常完成
      isPhantomTurn = false
      log.info('turn.skipped (telemetry)', { sessionKey, reason: signals.skipReason })
      break
    case 'called':
      // CCB 明确调了 API → 不可能是 phantom
      isPhantomTurn = false
      // 但若 result.stop_reason 缺失 + 0 block,记 incomplete telemetry
      if (!result?.stopReason && !turnBlockCount) telemetry.noteIncomplete()
      break
    case 'unknown':
      // 没 telemetry 信号 → fallback 到原启发式(R7)
      isPhantomTurn = legacyPhantomHeuristic(result, ...)
      break
  }

  if (isPhantomTurn) {
    // 现有 rollback 逻辑不变
    ...
  }

  // 3. 空轮归因 — 直接读 parser 拿到的 result.stopReason
  // 不再需要 telemetry 提供 stopReason
  if (pendingFinal && pendingFinal.kind === 'final') {
    onEvent(pendingFinal)
  }
}
```

### 5.5 协议 schema 扩展

`packages/protocol/src/frames.ts`:
```ts
// OutboundMessage.meta 新增字段
stopReason: Type.Optional(Type.String()),
```

`packages/gateway/src/ccbMessageParser.ts:24-35`:
```ts
| {
    kind: 'final'
    meta?: {
      cost?: number
      ...
      stopReason?: string  // v2 新增
    }
  }
```

### 5.6 前端文案分流

`packages/web/public/modules/websocket.js:1114-1116`:
```js
const stopReason = frame.meta?.stopReason
let noticeText
switch (stopReason) {
  case 'end_turn':
    noticeText = '模型本轮主动结束(可能判断不需回复或上下文已表达完整)。可继续追问。'
    break
  case 'pause_turn':
    noticeText = '模型暂停(通常因长任务超时),可重新发送让其继续。'
    break
  case 'max_tokens':
    noticeText = '本轮输出达到 token 上限,内容可能不完整。可让其"继续"。'
    break
  case 'refusal':
    noticeText = '模型拒绝回复本轮内容。'
    break
  case 'tool_use':
    // 异常:stop_reason=tool_use 但 0 block,通常意味着工具调用流被截断
    noticeText = '工具调用流意外中断,请重试。'
    break
  default:
    if (stopReason) {
      noticeText = `模型本轮无内容输出 (stop_reason=${stopReason})。可重试。`
    } else if (priorTurnHadContent) {
      noticeText = '模型本轮未输出新内容,可继续追问或重新提问。'
    } else {
      noticeText = '未收到回复 — 服务端标记已完成,但没有生成任何内容。请重试。'
    }
}
```

### 5.7 总改动量(Gateway,v2)

- 新文件: `packages/gateway/src/telemetryChannel.ts`(~180 行)
- 修改文件:
  - `subprocessRunner.ts`(+8 行分流 + parse_error 上报)
  - `sessionManager.ts`(+25 行 telemetry 接入 + phantom 三态判定 + detach 清理)
  - `ccbMessageParser.ts`(+5 行读 result.stop_reason + final.meta + TurnResult interface)
  - `protocol/src/frames.ts`(+1 行 schema)
  - `web/public/modules/websocket.js`(~25 行文案分流)
- 单元测试:
  - `__tests__/telemetryChannel.test.ts`(~180 行)
  - `__tests__/subprocessRunner.test.ts`(新建,~120 行)
  - `__tests__/ccbMessageParser.test.ts`(扩展,~40 行)
  - `__tests__/sessionManager.test.ts`(扩展,~80 行)

总 diff < 700 行。

---

## 6. 验证策略(v2 加强)

### 6.1 单元测试矩阵

按 R1-R9 死规矩追溯:

| 规矩 | 测试覆盖 |
|---|---|
| R1(CCB 行为不变) | 所有现有 `bun test`(CCB 1286 tests)必须通过,无 regression |
| R2(emit try/catch) | `telemetry.test.ts`: sink 抛异常 → emit 不抛、`sinkErrorCount` +1;`sanitizeData` 内部异常静默 |
| R3(协议 type) | `telemetry.test.ts`: emit 后断言 `type === '_oc_telemetry'` + `schemaVersion === 1` |
| R4(stdout 同通道) | `telemetry.test.ts`: 注入 sink 拦截,确认 newline 终结、ndjson safe |
| **R5(只在 stream-json+verbose)** | `telemetry.test.ts`: outputFormat=text 不发;outputFormat=stream-json+verbose=false 不发(v2 补) |
| R6(parser 不感知) | `subprocessRunner.test.ts`: `_oc_telemetry` 行触发 emit('telemetry'),`message` 不触发;**session_id 缺失的 telemetry 行静默丢弃、不触发 emit('telemetry')、`missingSessionIdCount` +1**(v3 补 Codex v3 F2) |
| **R7(fallback)** | `telemetryChannel.test.ts`: 空状态 → `apiState: 'unknown'`;只 willCallApi → `'called'`;只 skipped → `'skipped'`;两个都到 → 优先 skipped + `conflictCount=1`(v3 补防御性冲突诊断);`sessionManager.test.ts`: 三态分别走对应分支(v2 补) |
| **R8(disable)** | `telemetry.test.ts`: `OC_TELEMETRY_DISABLED=1` env → emit no-op;`sessionManager.test.ts`: 端到端 disable 等价测试 —— 在 mock subprocess 下不发任何 telemetry,验证 phantom 判定行为与 today heuristic 完全一致(v2 补) |
| R9(listener 清理) | `sessionManager.test.ts`: error/exit/timeout 三条退出路径分别验证 **telemetry + parse_error** listener 都被解绑(v3 补 parse_error 项 —— Codex v2 F1);反复运行 N 轮后 `runner.listenerCount('telemetry')` 与 `runner.listenerCount('parse_error')` 都恒定 |

### 6.2 集成测试

新建 `gateway/src/__tests__/integration/telemetry-integration.test.ts`,5 个场景:

1. **正常 turn**(text + tool blocks):telemetry 走完,result.stopReason='end_turn',`final.meta.stopReason` 正确,phantom 判定为 false
2. **空 turn 但 telemetry 完整**:willCallApi 到 + result.stopReason='end_turn' + 0 blocks → phantom=false,前端文案"模型本轮主动结束"
3. **shouldQuery=false skip**:turn.skipped 到 + 0 cost + 0 block → phantom=false(明确不是)、不重启子进程
4. **半权威 v2 新增**:willCallApi 到了但模拟 result 行 parse_error → telemetry.incompleteCount=1,fallback 启发式生效,前端文案 fallback 到通用版
5. **disable 等价**:全程不发 telemetry → phantom 判定与 today 行为完全一致(用同一组 subprocess 输入,对比 enable 前的快照)

### 6.3 本地 smoke 测试

1. **CCB 单跑**:
   ```bash
   cd /opt/openclaude/claude-code-best
   bun run src/entrypoints/cli.tsx --output-format stream-json --verbose -p "say hello"
   ```
   stdout 应能 grep 到 `{"type":"_oc_telemetry","schemaVersion":1,"event":"turn.willCallApi",...}` 和 `"event":"turn.apiResponse"` 替代物(实际 v2 没这个事件,但能 grep 到 result.stop_reason)。

2. **OpenClaude 整体跑**:
   ```bash
   openclaude-safe-restart
   # web 发送一句简单问候
   tail -f /var/log/openclaude.log | grep -E 'telemetry|phantom|stopReason|turn.skipped'
   ```
   应能看到 `turn.skipped (telemetry)` 等 info 级日志、final 帧带 stopReason。

3. **复现用户 bug**:
   重新打开用户截图里的 session(`web-mo3jtnld-2awe3ot5`)、再发"新加坡机器上有个 ds 的服务",**预期**:
   - 如果还是空 turn → 日志能看到 `stopReason=end_turn` + `apiState=called`、前端文案变成"模型本轮主动结束"(精确)
   - 如果是 transcript 问题 → 看到 `transcript.warning`(Phase B,本期不实现,但 fallback 文案仍优于 today)

### 6.4 回归保证

- CCB 全套 `bun test`(1286 tests)通过,0 regression
- Gateway 全套 `bun test` 通过
- `OC_TELEMETRY_DISABLED=1` 启动 OpenClaude → web/TG 双端发消息正常,phantom 判定行为应完全等同 today(由 §6.1 R8 单元测试 + §6.2 场景 5 集成测试保证)
- v2 商用版本期不动

---

## 7. 风险与缓解(v2)

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `_oc_telemetry` type 与未来 CCB 升级冲突 | 低 | 中 | `_oc` 前缀 + `schemaVersion` 双层防护 |
| emit 异常拖垮 CCB 主流程 | 低 | 高 | R2 强制 try/catch,`sinkErrorCount` 可观测 |
| Gateway listener 累积泄漏 | 中(v1 真有这风险) | 中 | R9 强制 detach 统一清理,单测覆盖三条退出路径 |
| 三态判定误把 unknown 当 phantom | 中(v1 真有这风险) | 中 | apiState=unknown 强制走 fallback 启发式,不强判 |
| stop_reason 字段在 result 行偶尔缺失 | 低 | 低 | parser 用 `?? null`,sessionManager 用 `if (stopReason)` 守护 |
| 半权威场景(willCallApi 到,result parse 失败)累计 | 低 | 低 | `incompleteCount` 可观测,达到阈值打 warn |
| 上线后某 edge case 不停打 phantom warning | 中 | 低 | 同 sessionKey 5 分钟内最多 3 条 rate limit |
| **(v2 新)`getSessionId` 早期阶段返回 undefined** | 中 | 低 | telemetry 事件允许 `session_id` 为 undefined,Gateway 不强求 |
| **(v2 新)stdout 写入与 structuredIO 错位** | 低 | 中 | telemetry 走独立 `process.stdout.write`,行级原子,与 structuredIO 互不依赖 |

---

## 8. 上线步骤(v2 不变)

1. 本地完成所有改动 + 测试 → commit master 但不 push
2. Codex 第二轮审计 diff,迭代到 PASS
3. `bun test` 全套通过(CCB + Gateway)
4. 手动 smoke 测试 §6.3
5. `openclaude-safe-restart`(自动检查过去 5 分钟有无非 boss 用户活跃)
6. 观察 30 分钟 — `tail -f /var/log/openclaude.log | grep -E 'telemetry|phantom|stopReason'`
7. 如异常 → `OC_TELEMETRY_DISABLED=1` 环境变量重启降级
8. 稳定 24 小时后 → 评估是否 cherry-pick 到 v2 商用版

---

## 9. 实施顺序(防 30 分钟会话超时)

| Step | 估时 | 落盘检查点 |
|---|---|---|
| S1. 写 telemetry.ts 模块 + 单测 | ~10 min | commit `feat(ccb): add telemetry module skeleton` |
| S2. print.ts configureTelemetry + Hook 1/3 | ~10 min | commit `feat(ccb): emit phase-A telemetry hooks` |
| S3. 写 telemetryChannel.ts(三态)+ 单测 | ~10 min | commit `feat(gateway): add telemetry channel with three-state api signal` |
| S4. subprocessRunner 分流 + parse_error 上报 + 测试 | ~10 min | commit `feat(gateway): route _oc_telemetry to channel` |
| S5. ccbMessageParser 读 result.stop_reason + TurnResult/meta 字段扩展 | ~10 min | commit `feat(gateway): consume result.stop_reason from CCB` |
| S6. sessionManager 接入(三态 phantom + detach 清理) | ~15 min | commit `feat(gateway): three-state phantom detection with telemetry priority` |
| S7. protocol schema + 前端文案 | ~10 min | commit `feat(web): differentiate empty-turn notice by stop_reason` |
| S8. 集成测试 + 全套 bun test | ~15 min | commit `test: integration coverage for telemetry path` |
| S9. Codex 第二轮审计 + 修复 | 不定 | commit per 修复 |
| S10. smoke + safe-restart | ~10 min | 部署 |

每一步独立 commit,会话切断接得上。

---

## 10. v2 → 给 Codex 第二轮的关键问题

1. 三态 `apiState: 'called' | 'skipped' | 'unknown'` 是否覆盖了所有真实场景?有没有第四态需要?
2. `ccbMessageParser._handleResult` 读 `result.stop_reason` 后,`final.meta.stopReason` 透传到 protocol 这条链是否全程 type-safe?
3. `sessionManager` 的 `detach()` 改造里增加 `runner.off('telemetry', ...)`,是否所有调用 `detach` 的路径都覆盖到?(idle timeout、error、exit、normal finish)
4. `OC_TELEMETRY_DISABLED=1` 端到端等价测试 —— 是否有遗漏的副作用(比如 telemetry listener 即使没事件也注册了)?
5. 前端文案 `switch(stopReason)` 是否覆盖 Anthropic API 当前所有 stop_reason 取值?(`end_turn`/`max_tokens`/`stop_sequence`/`tool_use`/`pause_turn`/`refusal` —— 是否全?)
