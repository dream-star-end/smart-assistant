/**
 * Gateway channel ingress: WeChat/QQ inbound, compensate and stop, inbound bypass check, engine preheat, turn cancel/reject/dispatch-state
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-481. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. ChannelHandlersHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'
import { resolve } from 'node:path'
import type { InboundFrame } from '@openclaude/protocol'
import { classifyRunError } from './errorClassify.js'
import { deleteClientSession } from '@openclaude/storage'
import { isModelAuthorityRequired } from './modelAuthority.js'
import {
  buildTurnDispatchStateResponse,
  getTurnDispatchState,
  getTurnDispatchStateByDispatch,
  isInboundBypassMethodAllowed,
  normalizeDispatchUserId,
  rejectTurnDispatchIfAbsent,
  cancelQueuedTurnDispatchExact,
} from './turnDispatchInbox.js'
import { V3_WECHAT_OUTBOUND_ADAPTER_ID, V3_QQBOT_OUTBOUND_ADAPTER_ID, validateEnginePreheatBody, runSessionPreheat } from './server.js'
import { ALLOWED_INBOUND_MODELS } from './delegatePolicy.js'
import { validateWechatInboundCompensateBody } from './wechatInboundCompensate.js'
import type { Gateway, SessionPreheatHost } from './server.js'
import type { WechatStartOutcome } from './wechatInboundCompensate.js'

export interface ChannelHandlersHost {
  _getIdempotencyEntry: Gateway['_getIdempotencyEntry']
  _markIdempotencyKey: Gateway['_markIdempotencyKey']
  _seenIdempotencyKeys: Gateway['_seenIdempotencyKeys']
  _sendAdapterOutboundMessage: Gateway['_sendAdapterOutboundMessage']
  _shuttingDown: Gateway['_shuttingDown']
  _updateWechatIdempotency: Gateway['_updateWechatIdempotency']
  channels: Gateway['channels']
  deliver: Gateway['deliver']
  deps: Gateway['deps']
  dispatchInbound: Gateway['dispatchInbound']
  getUserId: Gateway['getUserId']
  handleStop: Gateway['handleStop']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendInternalError: Gateway['sendInternalError']
  sendJson: Gateway['sendJson']
}

function wechatPeerIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  return /^agent:[^:]+:webchat:dm:(wsess-[0-9a-f]{16})$/.exec(sessionKey)?.[1]
}

export type UpdateWechatIdempotencyPatch = Partial<{
    started: boolean
    completed: boolean
    traceId: string
    sessionKey: string
    peerId: string
    agentId: string
  }>

export function _updateWechatIdempotency(
  this: ChannelHandlersHost,
  key: string,
  patch: UpdateWechatIdempotencyPatch,
): void {
  const entry = this._getIdempotencyEntry(key)
  if (!entry?.wechat) return
  entry.ts = Date.now()
  entry.wechat = { ...entry.wechat, ...patch }
}

/**
 * v3 WeChat broker → container inbound 通道(D3d HMAC 派生方案 B')。
 *
 * Master broker 通过 docker bridge gateway 主动 POST 到容器 gateway 的
 * `/internal/v3/wechat-inbound`。**与 checkBridgeBypass 严格不同**:
 *
 *   | 维度          | bridge bypass(file proxy)    | inbound bypass(broker → 容器) |
 *   | ------------- | ---------------------------- | --------------------------- |
 *   | 方向          | host → 容器(file/media 反代)  | host broker → 容器           |
 *   | path          | /api/file, /api/media/*       | /internal/v3/wechat-inbound  |
 *   | method        | GET / HEAD                    | POST                         |
 *   | nonce HMAC 域 | HMAC(s, containerId)           | HMAC(s, "inbound:" + cid)    |
 *   | env           | OC_BRIDGE_NONCE(hex 64)        | OPENCLAUDE_INBOUND_NONCE(b64url 43)|
 *   | header        | X-OpenClaude-Bridge-Nonce     | X-OpenClaude-Inbound-Nonce  |
 *
 * **故意编码不同**(hex vs base64url):env 名 / log / grep 一眼能区分两类 nonce,
 * 避免任何"复用同一校验函数 / 同一 header"的捷径让两条通道粘合。Codex r4 note 2 明确
 * 要求两条通道的 nonce 在 HMAC 输入域 + 编码上同时正交。
 *
 * TRUST_BRIDGE_IP / OC_CONTAINER_ID 与 file-proxy 共用;两个值同时缺/形态不对都直接
 * 拒(同 healthz capability 广播逻辑,避免 healthz advertise 但 bypass 失败的哑锁)。
 * 与 file-proxy 一样 fail-closed:env 缺一即恒 false。
 */
export function checkInboundBypass(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  url: URL,
): boolean {
  const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
  const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
  const INBOUND_NONCE = process.env.OPENCLAUDE_INBOUND_NONCE || ''
  if (!TRUST_BRIDGE_IP || !OC_CONTAINER_ID || !INBOUND_NONCE) return false
  if (!isIPv4(TRUST_BRIDGE_IP)) return false
  if (!/^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)) return false
  // base64url(32B) → 43 chars,无 padding,字符集 [A-Za-z0-9_-]
  if (!/^[A-Za-z0-9_-]{43}$/.test(INBOUND_NONCE)) return false
  const remoteIp = req.socket.remoteAddress || ''
  if (remoteIp !== TRUST_BRIDGE_IP && remoteIp !== `::ffff:${TRUST_BRIDGE_IP}`) return false
  if (!isInboundBypassMethodAllowed(req.method || '', url.pathname)) return false
  // Phase 1 只用一个端点,但前缀放开方便后续 broker → 容器扩控制面(notify-user 等)。
  // 任何不以 /internal/v3/ 开头的路径直接拒,确保 bypass 不会泄到其它路由。
  if (!url.pathname.startsWith('/internal/v3/')) return false
  const hdrId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
  if (hdrId !== OC_CONTAINER_ID) return false
  const hdrNonce = String(req.headers['x-openclaude-inbound-nonce'] ?? '').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(hdrNonce)) return false
  if (hdrNonce.length !== INBOUND_NONCE.length) return false
  try {
    return timingSafeEqual(
      Buffer.from(hdrNonce, 'base64url'),
      Buffer.from(INBOUND_NONCE, 'base64url'),
    )
  } catch {
    return false
  }
}

/**
 * v3 WeChat broker → 容器 dispatchInbound 桥。
 *
 * 调用前必须先过 checkInboundBypass(在 route 入口处已校验)。这里负责:
 *  1. 读 body(256KB 上限,与 internalServerAuthored 对齐;wechat 单消息远小于此,
 *     但 attachments 可能拼大;给个稳妥上限)
 *  2. 轻量手写 schema 校验(gateway 没 zod 依赖,不为单条路由引入新 dep)
 *  3. 构造 InboundFrame 直接喂 this.dispatchInbound —— 复用 line 5181-5190
 *     lazy-session 路径(channel='wechat',peer.id 由 broker 解析为 client_sessions.id,
 *     即 RFC v4 中 sessionPointer.current_session_id)。**不要走** inbound.hello/
 *     inbound.bind 任何模板 —— 那些是 WS-only 控制帧,跟 HTTP inbound 无关。
 *  4. 200 回 { ok, sessionKey };400/413 严守语义,broker outbox 端可按 status
 *     class 决定 fatal vs retry(参见 wechat-broker-design.md §4.8)
 *
 * **trust 模型**:body.userId 由 broker 自行决定(它持有 wechat_bindings 行),
 * 容器层不再二次校验 c:NN 跟容器 owner 的对齐 —— 容器只服务一个用户,broker 错配
 * 整段消息走错容器属于上游路由 bug,跟 dispatchInbound 收到一条 WS frame 信任
 * _userId 是同一信任模型(checkInboundBypass 已确认 caller = master broker)。
 */
/** OCV5-121: exact queued cancellation, never Stop an active predecessor. */
export async function handleTurnCancelIfQueued(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await this.readBody(req, 16 * 1024))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('invalid body')
    body = parsed as Record<string, unknown>
  } catch {
    this.sendJson(res, 400, { error: 'invalid or oversized body' })
    return
  }
  const { userId, sessionId, clientMessageId, dispatchId, attemptNo } = body
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof sessionId !== 'string' ||
    sessionId === '' ||
    typeof clientMessageId !== 'string' ||
    clientMessageId === '' ||
    typeof dispatchId !== 'string' ||
    dispatchId === '' ||
    typeof attemptNo !== 'number' ||
    !Number.isSafeInteger(attemptNo) ||
    attemptNo < 1
  ) {
    this.sendJson(res, 400, {
      error: 'userId/sessionId/clientMessageId/dispatchId/attemptNo required',
    })
    return
  }
  const result = await cancelQueuedTurnDispatchExact({
    userId,
    sessionId,
    clientMessageId,
    dispatchId,
    attemptNo,
  })
  this.sendJson(
    res,
    result.conflict ? 409 : 200,
    result.conflict ? { ...result, error: 'dispatch identity conflict' } : result,
  )
}

/**
 * RFC-v5-durable-turn-dispatch §3 — POST /internal/v3/turn-reject-if-absent。
 *
 * body { userId, sessionId, clientMessageId, dispatchId, attemptNo }。事务:有行返
 * 现有状态(negative proof 不成立);无行插 rejected(not_accepted)墓碑。返回
 * { inserted, state, outcome } —— reconciler 据此决定 fail-visible vs 转 accepted。
 */
export async function handleTurnRejectIfAbsent(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: string
  try {
    raw = await this.readBody(req, 16 * 1024)
  } catch {
    this.sendJson(res, 400, { error: 'read failed' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    this.sendJson(res, 400, { error: 'invalid json' })
    return
  }
  const body = (parsed ?? {}) as Record<string, unknown>
  const userId = body.userId
  const sessionId = body.sessionId
  const clientMessageId = body.clientMessageId
  const dispatchId = body.dispatchId
  const attemptNo = body.attemptNo
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof sessionId !== 'string' ||
    sessionId === '' ||
    typeof clientMessageId !== 'string' ||
    clientMessageId === '' ||
    typeof dispatchId !== 'string' ||
    dispatchId === '' ||
    typeof attemptNo !== 'number' ||
    !Number.isInteger(attemptNo) ||
    attemptNo < 1
  ) {
    this.sendJson(res, 400, {
      error: 'userId/sessionId/clientMessageId/dispatchId/attemptNo required',
    })
    return
  }
  // B1:inbox 逻辑键 user_id 统一裸 uid(与 descriptor.uid / OC_USER_ID 同源)。master 若
  // 漏传 c:<uid> 前缀 → 归一,避免同用户在 inbox 裂成两把键(去重/negative proof 失效)。
  const result = await rejectTurnDispatchIfAbsent({
    userId: normalizeDispatchUserId(userId),
    sessionId,
    clientMessageId,
    dispatchId,
    attemptNo,
  })
  // MINOR ①:dispatch_id 撞了别的逻辑键(master 契约破坏)→ 409,明确 conflict,绝不谎报
  // inserted:true / 让 reconciler 误当作"已落 negative proof"。正常路径仍 200。
  if (result.conflict) {
    this.log.error('turn reject-if-absent: dispatchId collides with another logical key', {
      dispatchId,
      attemptNo,
    })
    this.sendJson(res, 409, {
      error: 'dispatch identity conflict',
      conflict: true,
      inserted: false,
      state: null,
      outcome: null,
    })
    return
  }
  this.sendJson(res, 200, {
    inserted: result.inserted,
    state: result.state,
    outcome: result.outcome,
    ...(result.userFailureCode ? { userFailureCode: result.userFailureCode } : {}),
  })
}

/**
 * RFC-v5-durable-turn-dispatch §3 — GET /internal/v3/turn-dispatch-state。
 *
 * 按 dispatchId+attemptNo 或逻辑键(userId+sessionId+clientMessageId)查行。
 * 200 { found, state, outcome, dispatchId, attemptNo } —— reconciler accepted+stuck
 * 分支据此判 sink_staged/terminal(等)/ running(等)/ 行消失(manual)。
 */
export async function handleTurnDispatchState(
  this: ChannelHandlersHost,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const q = url.searchParams
  const dispatchId = q.get('dispatchId')
  const attemptNoRaw = q.get('attemptNo')
  let row = null as Awaited<ReturnType<typeof getTurnDispatchState>>
  if (dispatchId && attemptNoRaw) {
    const attemptNo = Number(attemptNoRaw)
    if (!Number.isInteger(attemptNo) || attemptNo < 1) {
      this.sendJson(res, 400, { error: 'attemptNo must be a positive integer' })
      return
    }
    row = await getTurnDispatchStateByDispatch(dispatchId, attemptNo)
  } else {
    const userId = q.get('userId')
    const sessionId = q.get('sessionId')
    const clientMessageId = q.get('clientMessageId')
    if (!userId || !sessionId || !clientMessageId) {
      this.sendJson(res, 400, {
        error: 'dispatchId+attemptNo or userId+sessionId+clientMessageId required',
      })
      return
    }
    // B1:同 reject-if-absent —— user_id 归一裸 uid,查询键与准入键同源。
    row = await getTurnDispatchState({
      userId: normalizeDispatchUserId(userId),
      sessionId,
      clientMessageId,
    })
  }
  // B4(R3):行缺失 → state:'absent'(非 null),master client 据此对 accepted 行走 manual_reconcile。
  // 响应形状收敛到 buildTurnDispatchStateResponse 单一权威(可断言,两侧契约同源)。
  this.sendJson(res, 200, buildTurnDispatchStateResponse(row))
}

export async function handleWechatInbound(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  source: 'wechat' | 'qqbot' = 'wechat',
): Promise<void> {
  const MAX_INBOUND_BODY = 256 * 1024
  let raw: string
  try {
    raw = await this.readBody(req, MAX_INBOUND_BODY)
  } catch (err) {
    const tooLarge = String((err as Error)?.message ?? err).includes('body too large')
    this.sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large' : 'read failed' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    this.sendJson(res, 400, { error: 'invalid json' })
    return
  }
  if (!parsed || typeof parsed !== 'object') {
    this.sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const body = parsed as Record<string, unknown>

  // ── Schema validation(手写,精度等价 zod minimum,但零 dep)──
  const userId = body.userId
  if (typeof userId !== 'string' || !/^c:[1-9][0-9]{0,18}$/.test(userId)) {
    this.sendJson(res, 400, { error: 'userId must match c:<uid>' })
    return
  }
  const peerRaw = body.peer as Record<string, unknown> | undefined
  if (!peerRaw || typeof peerRaw !== 'object') {
    this.sendJson(res, 400, { error: 'peer required' })
    return
  }
  const peerKind = peerRaw.kind
  const peerId = peerRaw.id
  // Phase 1 只支持 DM。group 留给 future phase(WeChat group bot 是另一套 API)。
  if (peerKind !== 'dm') {
    this.sendJson(res, 400, { error: 'peer.kind must be dm in P1' })
    return
  }
  if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 256) {
    this.sendJson(res, 400, { error: 'peer.id required (1..256 chars)' })
    return
  }
  const peerDisplayName = peerRaw.displayName
  if (
    peerDisplayName !== undefined &&
    (typeof peerDisplayName !== 'string' || peerDisplayName.length > 256)
  ) {
    this.sendJson(res, 400, { error: 'peer.displayName must be string ≤256' })
    return
  }
  const agentId = body.agentId
  if (
    agentId !== undefined &&
    (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId))
  ) {
    this.sendJson(res, 400, { error: 'agentId charset/length invalid' })
    return
  }
  const model = body.model
  const modelAllowedByShape =
    typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)
  if (
    model !== undefined &&
    (typeof model !== 'string' ||
      (isModelAuthorityRequired() ? !modelAllowedByShape : !ALLOWED_INBOUND_MODELS.has(model)))
  ) {
    this.sendJson(res, 400, { error: 'model unsupported for inbound dispatch' })
    return
  }
  const requestId = body.requestId
  if (
    requestId !== undefined &&
    (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId))
  ) {
    this.sendJson(res, 400, { error: 'requestId must be 32 lowercase hex chars' })
    return
  }
  const contentRaw = body.content as Record<string, unknown> | undefined
  if (!contentRaw || typeof contentRaw !== 'object') {
    this.sendJson(res, 400, { error: 'content required' })
    return
  }
  const text = contentRaw.text
  if (typeof text !== 'string') {
    this.sendJson(res, 400, { error: 'content.text required (P1 text-only)' })
    return
  }
  // 单条 text 上限:与 protocol 默认一致(_capToolEntry 类似 64 KB UTF-8 budget),
  // 但 inbound 是用户消息,容许大点(WeChat 长截图描述 / 用户粘贴);256KB body
  // cap 已经是硬上限,这里只做 schema-level 防御。
  if (text.length > 65536) {
    this.sendJson(res, 400, { error: 'content.text too long (>65536 chars)' })
    return
  }
  const idempotencyKey = body.idempotencyKey
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 128
  ) {
    this.sendJson(res, 400, { error: 'idempotencyKey required (1..128 chars)' })
    return
  }
  const tsRaw = body.ts
  let ts: number
  if (tsRaw === undefined) {
    ts = Date.now()
  } else if (
    typeof tsRaw === 'number' &&
    Number.isFinite(tsRaw) &&
    tsRaw >= 0 &&
    tsRaw <= Number.MAX_SAFE_INTEGER
  ) {
    ts = Math.floor(tsRaw)
  } else {
    this.sendJson(res, 400, { error: 'ts must be non-negative finite number' })
    return
  }

  // ── 构造 InboundFrame 并喂 dispatchInbound ──
  // 不模拟 inbound.hello / inbound.bind 任何控制帧,直接命中 line 5181-5190
  // lazy-session 路径。peer.id === sessionId(broker 保证),sessionKey 由
  // dispatchInbound 用 agent.id+channel+peer.kind+peer.id 派生 —— 跟 webchat
  // 路径完全同形,sessionManager.handleResult 处的 client_sessions 写回路径自然命中
  // (channel='wechat' 由 P1.4 sink gate 放行)。
  const peerOut: { kind: 'dm'; id: string; displayName?: string } = {
    kind: 'dm',
    id: peerId,
  }
  if (typeof peerDisplayName === 'string') peerOut.displayName = peerDisplayName
  const frame = {
    type: 'inbound.message' as const,
    idempotencyKey,
    // WeChat-originated turns run on the normal webchat session key so the
    // realtime process link can attach to the same runner via WebSocket
    // hello/auto-resume. We still pass the v3-wechat-outbound adapter below;
    // that adapter is the only path that mirrors final text back to iLink.
    channel: 'webchat',
    peer: peerOut,
    ...(typeof agentId === 'string' ? { agentId } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
    content: { text },
    ts,
  }
  // _userId 私有 stash,与 WS path(line 4163)同语义:dispatchInbound 内部读
  // (frame as any)._userId 决定 peerKey 命名空间和 client_sessions 归属。
  ;(frame as any)._userId = userId
  // The turn must run in the `webchat` session namespace so the realtime
  // link can attach to the same runner.  Only the rate-limit bucket remains
  // WeChat-scoped; lastActive must stay webchat/wsess so cron/webhook/
  // inter-agent pushes continue to reach the linked browser session.
  if (source === 'qqbot') {
    ;(frame as any)._rateLimitChannel = 'qqbot'
  } else {
    ;(frame as any)._rateLimitChannel = 'wechat'
  }

  // V3 broker → 容器 outbound 回路。
  //
  // dispatchInbound 不带 adapter 会走 WS 广播路径(server.ts deliver() line 6314+),
  // 但容器侧没有 WS 客户端订阅这条 wechat peerKey,assistant 帧只会落进
  // outboundRing 等到永不发生的 hello-resume —— master 这边却收到 200,
  // broker retry queue 不会兜底 → assistant 静默丢失。
  //
  // 显式查 v3-wechat-outbound adapter 把 outbound 出口绑死;adapter 在容器进程
  // 装配时由 cli/gateway.ts 注册(env OPENCLAUDE_V3_MASTER_BASE_URL +
  // OPENCLAUDE_V3_CONTAINER_TOKEN 同时存在),adapter.send 通过
  // POST /internal/v3/wechat-outbound 回送到 master broker。
  //
  // adapter 缺失 = 容器装配错误,broker 不该 POST 到没装 adapter 的容器:
  // 503 fail-closed 让 broker retry queue 视为 transient + 让运维看 log 找到
  // "adapter not registered"。不修改 dispatchInbound 通用行为,其他 channel 不受影响。
  const outboundAdapterId =
    source === 'qqbot' ? V3_QQBOT_OUTBOUND_ADAPTER_ID : V3_WECHAT_OUTBOUND_ADAPTER_ID
  const v3OutboundAdapter =
    source === 'qqbot'
      ? this.channels.get(V3_QQBOT_OUTBOUND_ADAPTER_ID)
      : this.channels.get('v3-wechat-outbound')
  if (!v3OutboundAdapter) {
    this.log.error(
      `handleWechatInbound: ${outboundAdapterId} adapter not registered; refusing dispatch`,
      { userId, peerId, idempotencyKey },
    )
    this.sendJson(res, 503, {
      error: {
        code: source === 'qqbot' ? 'V3_QQBOT_OUTBOUND_NOT_WIRED' : 'V3_WECHAT_OUTBOUND_NOT_WIRED',
        message: `container missing ${outboundAdapterId} adapter; outbound cannot return to master`,
      },
    })
    return
  }
  const safePeerId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const resolvedAgentId = typeof agentId === 'string' ? agentId : 'main'
  const sessionKey = `agent:${resolvedAgentId}:webchat:dm:${safePeerId}`
  if (this._shuttingDown) {
    this.sendJson(res, 503, { error: 'gateway shutting down' })
    return
  }

  // Long WeChat tasks can run for hours. The master broker's Step 1 HTTP
  // deadline is intentionally short (seconds), so this endpoint must ACK
  // after validation instead of holding the request open until final.
  //
  // Idempotency is normally marked inside dispatchInbound. Because this path
  // ACKs before dispatch finishes, reserve the key synchronously here and
  // tell dispatchInbound not to treat that reservation as a duplicate.
  const duplicateEntry = this._getIdempotencyEntry(idempotencyKey)
  if (duplicateEntry) {
    let originalWechat = duplicateEntry.wechat
    if (!originalWechat) {
      this.sendJson(res, 409, { error: 'duplicate idempotencyKey owned by non-WeChat turn' })
      return
    }
    if (!originalWechat.started && !originalWechat.traceId && originalWechat.startPromise) {
      try {
        await originalWechat.startPromise
        originalWechat = this._getIdempotencyEntry(idempotencyKey)?.wechat ?? originalWechat
      } catch (err) {
        this._seenIdempotencyKeys.delete(idempotencyKey)
        this.log.error(
          'wechat-inbound duplicate failed before original start',
          {
            userId,
            peerId,
            idempotencyKey,
            sessionKey: originalWechat.sessionKey,
          },
          err as Error,
        )
        this.sendJson(res, 500, { error: 'dispatch failed before start' })
        return
      }
    }
    const originalPeerId =
      wechatPeerIdFromSessionKey(originalWechat.sessionKey) ?? originalWechat.peerId
    this.sendJson(res, 200, {
      ok: true,
      deduplicated: true,
      accepted: originalWechat.started !== false,
      started: originalWechat.started,
      completed: originalWechat.completed === true,
      sessionKey: originalWechat.sessionKey,
      sessionId: originalPeerId,
      agentId: originalWechat.agentId,
      ...(originalWechat.traceId ? { traceId: originalWechat.traceId } : {}),
    })
    return
  }

  let startSettled = false
  let resolveStart!: (value: WechatStartOutcome) => void
  let rejectStart!: (err: unknown) => void
  const startPromise = new Promise<WechatStartOutcome>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })
  const settleStart = (value: WechatStartOutcome) => {
    if (startSettled) return
    startSettled = true
    resolveStart(value)
  }
  this._markIdempotencyKey(idempotencyKey, {
    sessionKey,
    peerId,
    agentId: resolvedAgentId,
    started: false,
    startPromise,
  })
  ;(frame as any)._idempotencyPreReserved = true
  ;(frame as any)._wechatDispatchStarted = (info?: {
    traceId?: string
    sessionKey?: string
    agentId?: string
  }) => {
    const routedPeerId = wechatPeerIdFromSessionKey(info?.sessionKey)
    this._updateWechatIdempotency(idempotencyKey, {
      started: true,
      ...(info?.traceId ? { traceId: info.traceId } : {}),
      ...(info?.sessionKey ? { sessionKey: info.sessionKey } : {}),
      ...(routedPeerId ? { peerId: routedPeerId } : {}),
      ...(info?.agentId ? { agentId: info.agentId } : {}),
    })
    settleStart({
      started: true,
      ...(info?.traceId ? { traceId: info.traceId } : {}),
      ...(info?.sessionKey ? { sessionKey: info.sessionKey } : {}),
      ...(routedPeerId ? { peerId: routedPeerId } : {}),
      ...(info?.agentId ? { agentId: info.agentId } : {}),
    })
  }
  const publishPostStartDispatchFailure = async (err: unknown) => {
    this._updateWechatIdempotency(idempotencyKey, { completed: true })
    const currentWechat = this._getIdempotencyEntry(idempotencyKey)?.wechat
    const errMessage = err instanceof Error ? err.message : String(err)
    // E5 — 渠道用户只看分类后的受控文案;原文经下方 log.error 进日志。
    const classifiedDispatchError = classifyRunError(errMessage)
    const publicDispatchReason =
      classifiedDispatchError.code === 'unknown'
        ? '任务执行暂时中断，请直接重试本条消息'
        : classifiedDispatchError.message
    const terminalPeer = {
      ...peerOut,
      id: currentWechat?.peerId ?? wechatPeerIdFromSessionKey(currentWechat?.sessionKey) ?? peerId,
    }
    const terminalOut = {
      type: 'outbound.message' as const,
      sessionKey: currentWechat?.sessionKey ?? sessionKey,
      channel: 'webchat' as const,
      peer: terminalPeer,
      agentId: currentWechat?.agentId ?? resolvedAgentId,
      blocks: [
        {
          kind: 'text' as const,
          text: `[error] ${source === 'qqbot' ? 'QQ' : '微信'}任务启动后失败：${publicDispatchReason}`,
        },
      ],
      isFinal: true,
      ...(currentWechat?.traceId ? { traceId: currentWechat.traceId } : {}),
      _userId: userId,
    }
    this.log.error(
      'wechat-inbound async dispatch failed',
      {
        userId,
        peerId,
        idempotencyKey,
        sessionKey: terminalOut.sessionKey,
      },
      err as Error,
    )
    this.deliver(terminalOut, undefined)
    try {
      await this._sendAdapterOutboundMessage(terminalOut, v3OutboundAdapter)
    } catch (sendErr) {
      this.log.error(
        'wechat-inbound async failure terminal send failed',
        {
          userId,
          peerId,
          idempotencyKey,
          sessionKey: terminalOut.sessionKey,
        },
        sendErr as Error,
      )
    }
  }
  const dispatchPromise = this.dispatchInbound(frame as InboundFrame, v3OutboundAdapter)
    .then(() => {
      if (!startSettled) {
        settleStart({ accepted: false, started: false })
      }
    })
    .catch((err) => {
      if (!startSettled) {
        startSettled = true
        rejectStart(err)
        return
      }
      void publishPostStartDispatchFailure(err)
    })

  let startOutcome: WechatStartOutcome
  try {
    startOutcome = await startPromise
  } catch (err) {
    this._seenIdempotencyKeys.delete(idempotencyKey)
    this.log.error(
      'wechat-inbound dispatch failed before start',
      {
        userId,
        peerId,
        idempotencyKey,
        sessionKey,
      },
      err as Error,
    )
    this.sendJson(res, 500, { error: 'dispatch failed before start' })
    return
  }
  void dispatchPromise

  this.sendJson(res, 200, {
    ok: true,
    accepted: startOutcome.accepted !== false,
    started: startOutcome.started,
    sessionKey: startOutcome.sessionKey ?? sessionKey,
    sessionId:
      startOutcome.peerId ??
      wechatPeerIdFromSessionKey(startOutcome.sessionKey ?? sessionKey) ??
      peerId,
    ...(startOutcome.agentId ? { agentId: startOutcome.agentId } : {}),
    ...(startOutcome.traceId ? { traceId: startOutcome.traceId } : {}),
  })
}

/**
 * v3 WeChat `/stop` bridge. Master resolves the current WeChat wsess and
 * calls this container-local endpoint; the actual runner is keyed as a
 * webchat session so the Web realtime link and WeChat interrupt hit the
 * same `agent:<id>:webchat:dm:<wsess>` SessionManager entry.
 */
export async function handleWechatStop(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const MAX_STOP_BODY = 16 * 1024
  let raw: string
  try {
    raw = await this.readBody(req, MAX_STOP_BODY)
  } catch (err) {
    const tooLarge = String((err as Error)?.message ?? err).includes('body too large')
    this.sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large' : 'read failed' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    this.sendJson(res, 400, { error: 'invalid json' })
    return
  }
  if (!parsed || typeof parsed !== 'object') {
    this.sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const body = parsed as Record<string, unknown>
  const userId = body.userId
  if (typeof userId !== 'string' || !/^c:[1-9][0-9]{0,18}$/.test(userId)) {
    this.sendJson(res, 400, { error: 'userId must match c:<uid>' })
    return
  }
  const peerRaw = body.peer as Record<string, unknown> | undefined
  if (!peerRaw || typeof peerRaw !== 'object') {
    this.sendJson(res, 400, { error: 'peer required' })
    return
  }
  if (peerRaw.kind !== 'dm') {
    this.sendJson(res, 400, { error: 'peer.kind must be dm' })
    return
  }
  const peerId = peerRaw.id
  if (typeof peerId !== 'string' || !/^wsess-[0-9a-f]{16}$/.test(peerId)) {
    this.sendJson(res, 400, { error: 'peer.id must be wsess-[0-9a-f]{16}' })
    return
  }
  const agentId = body.agentId
  if (
    agentId !== undefined &&
    (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId))
  ) {
    this.sendJson(res, 400, { error: 'agentId charset/length invalid' })
    return
  }
  const interrupted = await this.handleStop({
    type: 'inbound.control.stop',
    channel: 'webchat',
    peer: { kind: 'dm', id: peerId },
    ...(typeof agentId === 'string' ? { agentId } : {}),
  })
  this.sendJson(res, 200, { ok: true, interrupted })
}

/**
 * v3 WeChat broker → 容器 inbound 补偿端点。
 *
 * 调用前已过 checkInboundBypass(在 route 入口处校验);body 是 dispatcher
 * tryCompensation 构造的 `{sessionId, bindingUserId, reason, traceId?}` JSON。
 *
 * **idempotent + always-200**:
 *   - 行存在且未 soft-deleted → 调 deleteClientSession,200 `{ok:true, deleted:true}`
 *   - 行已 soft-deleted / 不存在 / 跨 tenant userId mismatch → 200 `{ok:true, deleted:false}`
 *   - schema 错 → 400(语义是 caller 出错,不是 compensation 失败 — 跟 idempotent 语义不冲突)
 *   - body 过大 → 413(同 handleWechatInbound 风格)
 *   - DB 异常 → 200 `{ok:true, deleted:false, errMessage}`(dispatcher 不该 retry 同条
 *     compensation;reconcile 30s 兜底)
 *
 * `userId` 通过 `c:` + `bindingUserId` 派生,与 master sqlite Step 2a 写入的
 * `MASTER_USER_PREFIX + bindingUserId` 字节级一致 — deleteClientSession 内部的
 * `WHERE id=? AND user_id=?` 自带 tenant scope 防御。
 */
export async function handleWechatInboundCompensate(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const MAX_COMPENSATE_BODY = 8 * 1024
  let raw: string
  try {
    raw = await this.readBody(req, MAX_COMPENSATE_BODY)
  } catch (err) {
    const tooLarge = String((err as Error)?.message ?? err).includes('body too large')
    this.sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large' : 'read failed' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    this.sendJson(res, 400, { error: 'invalid json' })
    return
  }

  const v = validateWechatInboundCompensateBody(parsed)
  if (!v.ok) {
    this.sendJson(res, 400, { error: v.error })
    return
  }
  const { sessionId, bindingUserId, reason, traceId } = v.payload

  const userId = `c:${bindingUserId}`
  let deleted = false
  let errMessage: string | undefined
  try {
    deleted = await deleteClientSession(sessionId, userId)
  } catch (err) {
    errMessage = (err as Error)?.message ?? String(err)
    this.log.error('wechat-inbound-compensate db error', {
      sessionId,
      userId,
      reason,
      traceId,
      errMessage,
    })
  }

  this.log.info('wechat-inbound-compensate', {
    sessionId,
    userId,
    reason,
    ...(traceId ? { traceId } : {}),
    deleted,
    ...(errMessage ? { errMessage } : {}),
  })
  this.sendJson(res, 200, {
    ok: true,
    deleted,
    ...(errMessage ? { errMessage } : {}),
  })
}

export async function _handleWechat(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const userId = this.getUserId(req)
  // 来自 config;enabled=false 时 manager 从未启动(gateway.ts:88 直接跳过 import)
  // 此时禁止 pair/* 等会真正调上游 iLink 的写操作,避免用户扫完码绑定成功 —
  // 实际 worker 没跑 — UI 显示 active 误导用户(生产踩过坑,audit P0-1)。
  // GET/DELETE binding 仍放行,让用户看到/清理残留。
  const wechatEnabled = Boolean((this.deps.config.channels as any)?.wechat?.enabled)
  const isPairingWrite =
    (pathname === '/api/wechat/pair/start' && req.method === 'POST') ||
    (pathname === '/api/wechat/pair/poll' && req.method === 'POST') ||
    (pathname === '/api/wechat/pair/cancel' && req.method === 'POST') ||
    (pathname === '/api/wechat/binding/status' && req.method === 'PUT')
  if (!wechatEnabled && isPairingWrite) {
    this.sendJson(res, 409, {
      error: {
        code: 'WECHAT_DISABLED',
        message: '服务端暂未启用微信通道,请联系管理员',
      },
    })
    return
  }

  // Lazy import so the gateway doesn't pull in qrcode/iLink deps unless the
  // WeChat channel is wired up. Importing a workspace package is ~free in
  // Bun — this is purely to avoid hard-coupling the gateway to it.
  let pairing: any
  try {
    pairing = await import('@openclaude/channel-wechat' as any)
  } catch (err) {
    // E5 — import 失败细节(路径/栈)只进日志。
    this.log.error('channel-wechat module unavailable', undefined, err as Error)
    this.sendJson(res, 503, {
      error: {
        code: 'WECHAT_UNAVAILABLE',
        message: '微信通道模块不可用，请检查服务端安装',
      },
    })
    return
  }
  const { startPairing, resumePairing, cancelPairing } = pairing as typeof import('@openclaude/channel-wechat')

  const {
    getWechatBindingByUserId,
    deleteWechatBinding,
    updateWechatBindingStatus,
    WechatAccountAlreadyBoundError,
  } = await import('@openclaude/storage')

  // ── POST /api/wechat/pair/start ──
  if (pathname === '/api/wechat/pair/start' && req.method === 'POST') {
    try {
      const { qrcode, qrcodeImgContent } = await startPairing(userId)
      this.sendJson(res, 200, { qrcode, qrcodeImgContent })
    } catch (err: any) {
      // E5 — 上游错误原文只进日志,响应体给受控文案。
      this.log.error('wechat pairing QR fetch failed', { userId }, err)
      this.sendError(res, 502, '获取微信配对二维码失败，请稍后重试')
    }
    return
  }

  // ── POST /api/wechat/pair/poll {qrcode} ──
  // Long-poll shim: wechat server itself long-polls ~35s; we just relay.
  if (pathname === '/api/wechat/pair/poll' && req.method === 'POST') {
    try {
      const body = await this.readBody(req)
      const { qrcode } = JSON.parse(body || '{}') as { qrcode?: string }
      if (!qrcode) {
        this.sendError(res, 400, 'qrcode required')
        return
      }
      const status = await resumePairing(userId, qrcode)
      this.sendJson(res, 200, status)
    } catch (err: any) {
      if (
        err instanceof WechatAccountAlreadyBoundError ||
        err?.name === 'WechatAccountAlreadyBoundError'
      ) {
        this.sendJson(res, 409, {
          error: {
            code: 'WECHAT_ACCOUNT_ALREADY_BOUND',
            message: '该微信已绑定到其他账号，请先解绑或换一个微信',
          },
        })
        return
      }
      // E5 — 上游错误原文只进日志,响应体给受控文案。
      this.log.error('wechat pairing poll failed', { userId }, err)
      this.sendError(res, 500, '微信配对状态查询失败，请稍后重试')
    }
    return
  }

  // ── POST /api/wechat/pair/cancel {qrcode} ──
  if (pathname === '/api/wechat/pair/cancel' && req.method === 'POST') {
    try {
      const body = await this.readBody(req)
      const { qrcode } = JSON.parse(body || '{}') as { qrcode?: string }
      if (qrcode) cancelPairing(qrcode)
      this.sendJson(res, 200, { ok: true })
    } catch {
      this.sendJson(res, 200, { ok: true })
    }
    return
  }

  // ── GET /api/wechat/binding ──
  if (pathname === '/api/wechat/binding' && req.method === 'GET') {
    const b = await getWechatBindingByUserId(userId)
    if (!b) {
      // binding=null 时仍要带 channel_enabled,前端 wechat.js 用这个值决定
      // 是否渲染"服务端暂未启用微信通道"红字提示(否则 enabled=false 下点
      // 开始按钮才 409,UX 差 —— Codex R2 IMPORTANT#2)
      this.sendJson(res, 200, { binding: null, channel_enabled: wechatEnabled })
      return
    }
    // worker_running:enabled × manager 实际持有该用户的 worker 才算 true。
    // enabled=false → 必 false;enabled=true 但 manager 没起 worker(新绑定
    // 还没过 reconcile 或 init 失败)→ false。前端据此显示"通道未启用/消息收不到"。
    // 读 adapter 时用 duck-typed 方法访问(manager.ts 暴露 isWorkerRunning),
    // 避免污染 plugin-sdk 的 ChannelAdapter 公共接口。
    const adapter = this.channels.get('wechat') as unknown as
      | { isWorkerRunning?: (uid: string) => boolean }
      | undefined
    const workerRunning =
      wechatEnabled &&
      b.status === 'active' &&
      typeof adapter?.isWorkerRunning === 'function' &&
      adapter.isWorkerRunning(userId) === true
    // Redact bot_token from client view
    this.sendJson(res, 200, {
      binding: {
        accountId: b.accountId,
        loginUserId: b.loginUserId,
        status: b.status,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        lastEventAt: b.lastEventAt,
        worker_running: workerRunning,
      },
      channel_enabled: wechatEnabled,
    })
    return
  }

  // ── DELETE /api/wechat/binding ──
  if (pathname === '/api/wechat/binding' && req.method === 'DELETE') {
    await deleteWechatBinding(userId)
    try {
      await this.deps.commercial?.wechatBroker?.cleanupBinding?.(userId)
    } catch (err: any) {
      this.log.warn(`[wechat] broker cleanup failed for user=${userId}`, undefined, err)
    }
    this.sendJson(res, 200, { ok: true })
    return
  }

  // ── PUT /api/wechat/binding/status {status} ──
  if (pathname === '/api/wechat/binding/status' && req.method === 'PUT') {
    try {
      const body = await this.readBody(req)
      const { status } = JSON.parse(body || '{}') as { status?: string }
      if (status !== 'active' && status !== 'disabled') {
        this.sendError(res, 400, 'status must be active or disabled')
        return
      }
      await updateWechatBindingStatus(userId, status)
      this.sendJson(res, 200, { ok: true, status })
    } catch (err: any) {
      this.sendInternalError(res, err)
    }
    return
  }

  this.sendError(res, 404, 'wechat route not found')
}

/**
 * POST /internal/v3/engine-preheat。先 200 再异步 spawn:master POST 3s 超时
 * 不能卡在 CCB ~20s 冷启动上。失败只 warn,不再写响应。
 */
export async function handleEnginePreheat(
  this: ChannelHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: string
  try {
    raw = await this.readBody(req, 16 * 1024)
  } catch {
    this.sendJson(res, 400, { error: 'read failed' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    this.sendJson(res, 400, { error: 'invalid json' })
    return
  }
  const validated = validateEnginePreheatBody(parsed)
  if (!validated.ok) {
    this.sendJson(res, 400, { error: validated.error })
    return
  }
  this.sendJson(res, 200, { ok: true })
  const ocUid = (process.env.OC_USER_ID ?? '').trim()
  const userId = /^[1-9][0-9]{0,18}$/.test(ocUid) ? `c:${ocUid}` : 'default'
  void runSessionPreheat(
    this as unknown as SessionPreheatHost,
    validated.payload.sessionId,
    userId,
    {
      agentId: validated.payload.agentId,
      ...(validated.payload.modelId ? { modelId: validated.payload.modelId } : {}),
      ...(validated.payload.effortLevel !== undefined ? { effortLevel: validated.payload.effortLevel } : {}),
      ...(validated.payload.workspaceMode ? { workspaceMode: validated.payload.workspaceMode } : {}),
      ...(validated.payload.codexRouteHint ? { codexRouteHint: validated.payload.codexRouteHint } : {}),
    },
  ).catch((err) => {
    this.log.warn(
      'engine-preheat spawn failed',
      { sessId: validated.payload.sessionId },
      err as Error,
    )
  })
}
