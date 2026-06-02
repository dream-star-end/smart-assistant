/**
 * P1.7 slice 7c — `handleWechatInbound` ↔ v3-wechat-outbound adapter 装配契约
 * 的结构化回归断言。
 *
 * Codex 在 7c-10 review 发现的 bug:`handleWechatInbound` 之前调
 * `dispatchInbound(frame)` 不传 adapter → `deliver()` 走 WS 广播分支
 * (server.ts:6314+),容器侧没 WS 客户端订阅 wechat peerKey → assistant 帧
 * 静默落进 outboundRing,master 假阳性 200,broker retry queue 不会兜底 →
 * 出口黑洞化。
 *
 * 修复:显式 `channels.get('v3-wechat-outbound')` 取容器侧出口 adapter,
 * 不存在则 503 fail-closed 让 broker retry queue 感知配置错误;存在则
 * `dispatchInbound(frame, adapter)` 把出口绑死。
 *
 * **测试形态决策(static source scan vs runtime)**:
 *
 * 这层"是否取 adapter + 是否传给 dispatchInbound"的契约,跑端到端 integ 要
 * 构造完整 Gateway(config / agentsConfig / web / ccb subprocess / agents.yaml…)
 * 才能让 dispatchInbound 真跑通,代价巨大且测试本身 brittle 概率高。
 *
 * **该 repo 现有先例**:`dispatchInboundTraceStamp.test.ts`(CG7 turn-level
 * trace 校验)处理同型问题就是用"scan method body 源码 + 正则断言模式"。
 * Codex 当时(plan v3)接受这种形式,理由是:能直接锁住"新增分支忘了 stamp /
 * 忘了 lookup"的 regression — 比"半假执行 + spy 调用次数"更直接。
 *
 * 本测试沿用同一范式,scan 三件套:
 *   1. handleWechatInbound 含 `channels.get('v3-wechat-outbound')`
 *   2. handleWechatInbound 含 503 + 'V3_WECHAT_OUTBOUND_NOT_WIRED' 早返块
 *   3. handleWechatInbound 把 lookup 结果作为 dispatchInbound 的 2nd 实参
 *   4. 三个 pattern 的出现顺序:lookup → fail-closed → dispatch
 *   5. peerOut 构造保留 displayName(senderId carrier 完整性 — Codex 7c review
 *      的额外 ask,防止修复时顺手破坏 broker 经 displayName 携带 senderId 的契约)
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/wechatInboundAdapterBinding.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')

/**
 * 抽取 handleWechatInbound 方法体源码(从 `private async handleWechatInbound`
 * 起,到下一个 method 起始之前)。
 *
 * 找下一个 method 用 `^  private` / `^  public` / `^  protected` / `^  async`
 * 起首的下一行(class 内 method 缩进固定 2 空格)。
 */
function extractMethodBody(source: string, methodName: string): string {
  const startRe = new RegExp(`^  (private|public|protected)?\\s*(async\\s+)?${methodName}\\b`, 'm')
  const startMatch = startRe.exec(source)
  if (!startMatch) {
    throw new Error(`method ${methodName} not found in source`)
  }
  const startIdx = startMatch.index
  // 在 startIdx 之后找下一个 method 起始
  const rest = source.slice(startIdx + startMatch[0].length)
  const nextRe = /^  (private|public|protected|async|static)\b/m
  const nextMatch = nextRe.exec(rest)
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : source.length
  return source.slice(startIdx, endIdx)
}

const handleWechatInbound = extractMethodBody(SERVER_TS, 'handleWechatInbound')
const handleStop = extractMethodBody(SERVER_TS, 'handleStop')

// ── 基础前置:method 抽出来非空、且包含必要 keyword ──
test('extractMethodBody finds handleWechatInbound and includes core skeleton', () => {
  assert.ok(handleWechatInbound.length > 200, 'method body must be non-trivial')
  assert.match(handleWechatInbound, /private async handleWechatInbound/)
  assert.match(handleWechatInbound, /dispatchInbound\(/)
})

// ── 主断言:adapter lookup 出现 + 用 'v3-wechat-outbound' literal ──
test("handleWechatInbound looks up channels.get('v3-wechat-outbound')", () => {
  // 单/双引号都接受;但 literal name 必须严格匹配
  assert.match(
    handleWechatInbound,
    /channels\.get\(\s*['"]v3-wechat-outbound['"]\s*\)/,
    "v3 broker inbound 必须显式查 v3-wechat-outbound adapter,不能依赖 dispatchInbound 默认无 adapter 兜底",
  )
})

// ── 主断言:adapter 缺失 → 503 V3_WECHAT_OUTBOUND_NOT_WIRED fail-closed ──
test('handleWechatInbound returns 503 V3_WECHAT_OUTBOUND_NOT_WIRED when adapter missing', () => {
  // sendJson(res, 503, ...) 调用
  assert.match(
    handleWechatInbound,
    /sendJson\(\s*res\s*,\s*503\s*,/,
    '503 fail-closed 必须出现在 handleWechatInbound — adapter 缺失时不能默默 200',
  )
  // error code literal — broker retry/fatal 分类按 HTTP status(503=transient),
  // code 字面只用于日志/观测(grep "V3_WECHAT_OUTBOUND_NOT_WIRED" 定位配置错误)。
  // lock 死 literal 是为了让 ops grep 稳定,不是分类逻辑依赖。
  assert.match(
    handleWechatInbound,
    /V3_WECHAT_OUTBOUND_NOT_WIRED/,
    'error.code 字面必须是 V3_WECHAT_OUTBOUND_NOT_WIRED(observability 用,broker 分类走 status code)',
  )
})

// ── 主断言:dispatchInbound 把 adapter 作为 2nd 实参传入 ──
test('handleWechatInbound passes the v3 outbound adapter as the 2nd arg to dispatchInbound', () => {
  // 形如 `this.dispatchInbound(frame as InboundFrame, v3OutboundAdapter)` —
  // 第二个实参是引用 lookup 结果的标识符。允许命名是 v3OutboundAdapter /
  // adapter / 任意 [A-Za-z_][A-Za-z0-9_]* — 但必须非空。
  assert.match(
    handleWechatInbound,
    /this\.dispatchInbound\(\s*frame\s+as\s+InboundFrame\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/,
    'dispatchInbound 必须显式接收 adapter 参数,不能空调(空调会走 WS 广播 → 容器无 client → 输出黑洞)',
  )
})

// ── 顺序断言:lookup → 503 fail-closed → dispatchInbound ──
test('handleWechatInbound: lookup precedes the 503 guard, which precedes dispatchInbound', () => {
  const idxLookup = handleWechatInbound.search(/channels\.get\(\s*['"]v3-wechat-outbound['"]/)
  const idxGuard = handleWechatInbound.search(/V3_WECHAT_OUTBOUND_NOT_WIRED/)
  const idxDispatch = handleWechatInbound.search(
    /this\.dispatchInbound\(\s*frame\s+as\s+InboundFrame\s*,/,
  )
  assert.ok(idxLookup >= 0 && idxGuard >= 0 && idxDispatch >= 0,
    'all three patterns must occur in handleWechatInbound')
  assert.ok(idxLookup < idxGuard,
    'adapter lookup must precede the 503 fail-closed block — otherwise the guard reads an undefined variable')
  assert.ok(idxGuard < idxDispatch,
    'the 503 fail-closed block must precede dispatchInbound — otherwise dispatch fires before the guard')
})


// ── 模型字段:master broker 可把用户默认模型带进容器 inbound frame ──
test('handleWechatInbound validates optional body.model against ALLOWED_INBOUND_MODELS', () => {
  assert.match(
    handleWechatInbound,
    /const model\s*=\s*body\.model[\s\S]+ALLOWED_INBOUND_MODELS\.has\(model\)[\s\S]+model unsupported for inbound dispatch/,
    'body.model 必须经过 ALLOWED_INBOUND_MODELS 校验,避免 user_preferences 旧值/非法值进 runner --model',
  )
})

test('handleWechatInbound forwards validated model onto the InboundFrame', () => {
  assert.match(
    handleWechatInbound,
    /\.\.\.\(typeof model === ['"]string['"] \? \{ model \} : \{\}\)/,
    '通过校验的 body.model 必须透传到 frame.model,让 dispatchInbound/sessionManager 切换到用户默认模型',
  )
})

test('handleWechatInbound validates and forwards master-owned requestId', () => {
  assert.match(
    handleWechatInbound,
    /const requestId\s*=\s*body\.requestId[\s\S]+\^\[0-9a-f\]\{32\}\$/m,
    'body.requestId 必须按 32-hex server-owned Codex billing id 校验',
  )
  assert.match(
    handleWechatInbound,
    /\.\.\.\(typeof requestId === ['"]string['"] \? \{ requestId \} : \{\}\)/,
    'validated requestId 必须透传到 InboundFrame,让 sessionManager 生成 codex_billing',
  )
})

test('handleWechatInbound accepts only api-relay codex route overrides for WeChat', () => {
  assert.match(
    handleWechatInbound,
    /body\.__oc_codex_route/,
    'WeChat inbound handler 必须读取 master-owned __oc_codex_route',
  )
  assert.match(
    handleWechatInbound,
    /\.kind\s*===\s*['"]official_oauth['"]/,
    'WeChat 暂不支持 official_oauth route marker,必须在 handler 边界拒绝',
  )
  assert.match(
    handleWechatInbound,
    /_buildSafeCodexRouteOverride\(\{[\s\S]+agentProvider:\s*['"]codex-native['"][\s\S]+rawRoute:\s*rawCodexRoute[\s\S]+\}\)/,
    'api-relay route 仍需复用 shared sanitizer 校验 baseUrl/modelProvider 等字段',
  )
  assert.match(
    handleWechatInbound,
    /\.\.\.\(rawCodexRoute !== undefined \? \{ __oc_codex_route: rawCodexRoute \} : \{\}\)/,
    '通过校验的 raw route 必须透传到 frame,由 dispatchInbound 再按真实 agent/model 应用',
  )
})

// ── 副断言:peer.displayName carrier 完整性(slice 7c senderId 通过 peer.displayName 携带)──
test('handleWechatInbound preserves peer.displayName on the outbound frame', () => {
  // peerOut 构造分支必须把 peerDisplayName(来自 body.peer.displayName)
  // 透传到 frame.peer.displayName — broker 通过该字段携带 senderId,
  // inboundDispatcher 反解出 senderId 写入 origin。
  assert.match(
    handleWechatInbound,
    /peerOut\.displayName\s*=\s*peerDisplayName/,
    'peer.displayName carrier 必须被透传(broker senderId 协议依赖此字段)',
  )
})

test('dispatchInbound keeps completed WeChat idempotency entries accepted for Step1 retries', () => {
  assert.doesNotMatch(
    SERVER_TS,
    /_updateWechatIdempotency\(\s*frame\.idempotencyKey\s*,\s*\{\s*started:\s*false\s*\}\s*\)/,
    'successful final must not flip cached WeChat idempotency metadata to started:false; late Step1 retries still need accepted:true so master persists the already-started wsess',
  )
})

test('WeChat Step1 start callback reports routed sessionKey and agentId', () => {
  assert.match(
    SERVER_TS,
    /wechatDispatchStarted\(\{\s*traceId:\s*turnTraceId,\s*sessionKey,\s*agentId:\s*agent\.id,/,
    'Step1 ACK must expose the post-routing sessionKey/agentId so master stores the same runner tuple used by Web hello and /stop',
  )
})

test('WeChat Step1 ACK returns the routed wsess when dispatch reroutes the runner', () => {
  assert.match(
    SERVER_TS,
    /function\s+wechatPeerIdFromSessionKey\([\s\S]+webchat:dm:\(wsess-\[0-9a-f\]\{16\}\)/,
    'gateway must be able to derive the routed wsess from the routed sessionKey',
  )
  assert.match(
    handleWechatInbound,
    /const routedPeerId\s*=\s*wechatPeerIdFromSessionKey\(info\?\.sessionKey\)/,
    'Step1 start callback must capture the routed wsess instead of keeping the provisional peer id',
  )
  assert.match(
    handleWechatInbound,
    /sessionId:\s*startOutcome\.peerId\s*\?\?\s*wechatPeerIdFromSessionKey\(startOutcome\.sessionKey\s*\?\?\s*sessionKey\)\s*\?\?\s*peerId/,
    'accepted Step1 ACK must serialize the routed wsess as sessionId so master pointers/stop target the real runner',
  )
})

test('WeChat realtime-link routing keeps rate-limit WeChat-scoped but lastActive webchat-scoped', () => {
  assert.match(
    handleWechatInbound,
    /_rateLimitChannel\s*=\s*['"]wechat['"]/,
    'WeChat inbound must keep a WeChat-scoped rate-limit bucket even though the runner session is webchat',
  )
  assert.doesNotMatch(
    handleWechatInbound,
    /_lastActiveChannel\s*=\s*['"]wechat['"]/,
    'WeChat inbound must not rewrite lastActive away from webchat; the realtime link relies on webchat/wsess pushes',
  )
  assert.doesNotMatch(
    handleWechatInbound,
    /_lastActivePeerId\s*=/,
    'WeChat inbound must leave lastActive peerId as wsess so cron/webhook/inter-agent pushes hit the linked Web session',
  )
  assert.match(
    SERVER_TS,
    /const rateLimitChannel[\s\S]+_rateLimitChannel[\s\S]+rateLimiter\.check\(frame\.peer\.id,\s*rateLimitChannel\)/,
    'dispatchInbound must not charge WeChat-originated retries against the linked webchat bucket',
  )
  assert.match(
    SERVER_TS,
    /const lastActiveChannel[\s\S]+_lastActiveChannel[\s\S]+channel:\s*lastActiveChannel/,
    'dispatchInbound must record the original channel when a private last-active override is present',
  )
})

test('duplicate WeChat Step1 waits for the original start promise before ACK', () => {
  assert.match(
    SERVER_TS,
    /await\s+originalWechat\.startPromise/,
    'deduplicated Step1 requests must wait for the original start result instead of replaying provisional started:false metadata',
  )
})

test('duplicate WeChat Step1 ACK returns the cached routed wsess', () => {
  assert.match(
    handleWechatInbound,
    /const originalPeerId\s*=\s*wechatPeerIdFromSessionKey\(originalWechat\.sessionKey\)\s*\?\?\s*originalWechat\.peerId/,
    'duplicate Step1 ACK must not leak the retry/provisional wsess when the original turn rerouted to an existing runner',
  )
  assert.match(
    handleWechatInbound,
    /sessionId:\s*originalPeerId/,
    'duplicate Step1 ACK must return the routed cached wsess as sessionId',
  )
  assert.match(
    handleWechatInbound,
    /accepted:\s*originalWechat\.started\s*!==\s*false/,
    'duplicates for already-started/completed turns must remain accepted:true so master can persist the session after a lost Step1 response',
  )
})

test('pre-start terminal dispatch exits are ACKed as unaccepted, not ghost sessions', () => {
  assert.doesNotMatch(
    handleWechatInbound,
    /\.then\(\(\)\s*=>\s*settleStart\(\{\s*started:\s*false\s*\}\)\s*\)/,
    'pre-start rate-limit/model rejects must not be acknowledged as accepted wsess sessions',
  )
  assert.match(
    handleWechatInbound,
    /settleStart\(\{\s*accepted:\s*false,\s*started:\s*false\s*\}\)/,
    'if dispatchInbound returns before the start callback, Step1 should be 200 accepted:false: terminal already reached WeChat, but master must not persist it as a real runner',
  )
  assert.match(
    handleWechatInbound,
    /accepted:\s*startOutcome\.accepted\s*!==\s*false/,
    'Step1 response must surface accepted:false to master so it can skip client_sessions/pointer upserts',
  )
})

test('live WeChat stream does not retain every process block until final', () => {
  const liveBranch = /if \(liveWechatAdapter\) \{([\s\S]*?)\n\s*\} else if \(adapter\)/.exec(SERVER_TS)
  assert.ok(liveBranch?.[1], 'live WeChat branch must be present in dispatchInbound block handler')
  assert.doesNotMatch(
    liveBranch[1],
    /out\.blocks\.push/,
    'the realtime-link branch already delivers each block to Web and must not retain the whole stream in out.blocks for multi-hour tasks',
  )
})

test('post-start async dispatch failures emit a terminal error to Web and WeChat', () => {
  assert.match(
    handleWechatInbound,
    /publishPostStartDispatchFailure/,
    'post-start dispatch rejection must not be log-only after Step1 has already ACKed',
  )
  assert.match(
    handleWechatInbound,
    /this\.deliver\(\s*terminalOut\s*,\s*undefined\s*\)/,
    'post-start dispatch rejection must terminate the linked Web realtime session',
  )
  assert.match(
    handleWechatInbound,
    /const terminalPeer\s*=\s*\{[\s\S]+id:\s*currentWechat\?\.peerId\s*\?\?\s*wechatPeerIdFromSessionKey\(currentWechat\?\.sessionKey\)\s*\?\?\s*peerId/,
    'post-start dispatch rejection must send its terminal error to the routed wsess, not the provisional Step1 peer',
  )
  assert.match(
    handleWechatInbound,
    /await\s+this\._sendAdapterOutboundMessage\(\s*terminalOut\s*,\s*v3OutboundAdapter\s*\)/,
    'post-start dispatch rejection must also send a final error back through WeChat outbound',
  )
  assert.match(
    handleWechatInbound,
    /_updateWechatIdempotency\(\s*idempotencyKey\s*,\s*\{\s*started:\s*false\s*\}\s*\)/,
    'post-start dispatch rejection must mark cached WeChat idempotency as no longer running',
  )
})

test('handleStop scans live webchat sessions when agentId is omitted', () => {
  assert.match(
    handleStop,
    /this\.sessions\.list\(\)/,
    'agent-less WeChat /stop fallback must enumerate live sessions for upgraded pointers without current_agent_id',
  )
  assert.match(
    handleStop,
    /\.endsWith\(suffix\)/,
    'agent-less WeChat /stop fallback must match by channel/kind/wsess suffix across agents',
  )
  assert.match(
    handleStop,
    /this\.sessions\.interrupt\(live\.sessionKey\)/,
    'agent-less WeChat /stop fallback must interrupt the matched live runner instead of defaulting to main',
  )
})
