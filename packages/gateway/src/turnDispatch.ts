/**
 * Gateway turn dispatch: dispatch hooks, synthetic-turn barrier, dispatch/frame authority, admitted-turn dispatch and settlement records
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-533. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. TurnDispatchHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { randomBytes } from 'node:crypto'
import { decodeEnvelope, DISPATCH_AUTHORITY_KIND, type InboundFrame, isClientMessageId, withUserError } from '@openclaude/protocol'
import type { WebSocket } from 'ws'
import { removeSendToAgentIntent } from './sendToAgentIntentStore.js'
import type { DelegateJobSnapshot } from './delegateJobs.js'
import { parseParentEngine } from './jobTerminal.js'
import type { SessionRepoStatusOut } from './sessionRepoWorkspace.js'
import { messageSendAttempt, preStartStopKey } from './sessionManager.js'
import { getTurnAuthority } from './modelAuthority.js'
import { DISPATCH_AUTHORITY_FIELD, DispatchRejected, type DispatchTurnContext, type admitTurnDispatch, attachDispatchContext, buildTurnDispatchReceiptFrame } from './turnDispatchInbox.js'
import type { Gateway } from './server.js'

/** Bounds of Gateway._recentSettlements (FIFO evict + TTL); formerly Gateway statics. */
const RECENT_SETTLEMENT_MAX = 1000
const RECENT_SETTLEMENT_TTL_MS = 5 * 60_000

export interface TurnDispatchHost {
  _activeSendToAgentCallbacks: Gateway['_activeSendToAgentCallbacks']
  _admittedClientTurns: Gateway['_admittedClientTurns']
  _authorityConns: Gateway['_authorityConns']
  _delegateInflightSurface: Gateway['_delegateInflightSurface']
  _dispatchAuthority: Gateway['_dispatchAuthority']
  _recentSettlements: Gateway['_recentSettlements']
  _repoWorkspace: Gateway['_repoWorkspace']
  _resolveDelegateParentEngine: Gateway['_resolveDelegateParentEngine']
  _sendStatusFrame: Gateway['_sendStatusFrame']
  _syntheticTurnBarriers: Gateway['_syntheticTurnBarriers']
  dispatchInbound: Gateway['dispatchInbound']
  log: Gateway['log']
  sessions: Gateway['sessions']
}

export function _notifyDispatchHooks(this: TurnDispatchHost) {
  return {
    resolveParentEngine: (job: DelegateJobSnapshot) =>
      this._resolveDelegateParentEngine(job.callbackOriginSessionKey ?? job.parentSessionKey) ??
      parseParentEngine(job.parentEngine),
    resolveGoal: (job: DelegateJobSnapshot) =>
      this._activeSendToAgentCallbacks?.get(job.id)?.goal ??
      // Adopted delegate_task rows never registered a send_to_agent intent;
      // the inflight projection still carries the goal (flag-on only).
      this._delegateInflightSurface?.get(job.id)?.goal ??
      undefined,
    resolveCallbackOrigin: (job: DelegateJobSnapshot) => job.callbackOriginSessionKey,
    onDelivered: async (job: DelegateJobSnapshot) => {
      this._activeSendToAgentCallbacks.delete(job.id)
      await removeSendToAgentIntent(job.id)
    },
  }
}

export type AcquireSyntheticTurnBarrierResult = {
    owner: string
    release: () => void
  }

export async function _acquireSyntheticTurnBarrier(this: TurnDispatchHost, sessionKey: string): Promise<AcquireSyntheticTurnBarrierResult> {
  const barriers = (this._syntheticTurnBarriers ??= new Map())
  for (;;) {
    const existing = barriers.get(sessionKey)
    if (!existing) break
    await existing.done
  }
  const owner = `synthetic-${randomBytes(8).toString('hex')}`
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  let released = false
  const release = () => {
    if (released) return
    released = true
    const current = this._syntheticTurnBarriers?.get(sessionKey)
    if (current?.owner === owner) this._syntheticTurnBarriers?.delete(sessionKey)
    resolveDone()
  }
  barriers.set(sessionKey, { owner, done, release })
  return { owner, release }
}

export function _rejectAuthority(this: TurnDispatchHost, ws: WebSocket, code: string, detail: string, frame?: Record<string, unknown>): void {
  // 拒帧是安全事件:reason 进日志(运维可见),**不**回给客户端内文
  // (避免把 epoch / challenge / keyId 等内部线索泄漏给容器内的用户 AI)。
  this.log.warn('model_authority.rejected', { code, detail })
  // Correlation only: unverified envelope fields never authorize execution or
  // establish absence. Master checks its exact attempt and obtains a durable
  // reject-if-absent tombstone before replaying anything.
  const peer = frame?.peer as { id?: unknown; kind?: unknown } | undefined
  let dispatch: Record<string, unknown> | undefined
  try {
    const raw = frame?.[DISPATCH_AUTHORITY_FIELD]
    if (typeof raw === 'string') dispatch = decodeEnvelope(raw, DISPATCH_AUTHORITY_KIND).payload as Record<string, unknown>
  } catch { /* malformed authority has no usable dispatch correlation */ }
  const correlated = frame?.type === 'inbound.message' && isClientMessageId(frame.clientMessageId) &&
    typeof peer?.id === 'string' && peer.kind === 'dm' && typeof dispatch?.dispatchId === 'string' &&
    Number.isSafeInteger(dispatch.attemptNo) && (dispatch.attemptNo as number) > 0
  try {
    ws.send(
      JSON.stringify(withUserError({
        type: 'error',
        code: 'MODEL_AUTHORITY_REJECTED',
        error: 'model authority rejected',
        ...(correlated && dispatch ? {
          clientMessageId: frame.clientMessageId, peer: { id: peer.id, kind: 'dm' },
          dispatchId: dispatch.dispatchId, attemptNo: dispatch.attemptNo,
          authorityExpired: code === 'expired',
        } : {}),
      })),
    )
  } catch { /* ws may already be closed */ }
}

/**
 * RFC-v5-durable-turn-dispatch §3.b — 已有 inbox 行时回执给 bridge。
 *
 * bridge 据此 CAS accepted(dispatch 已被容器受理执行,不再开第二条 IIFE)。控制帧,
 * bridge 拦截消费,**绝不**透传给浏览器(同 container_attest)。
 */
export function _sendTurnDispatchReceipt(this: TurnDispatchHost, ws: WebSocket, ctx: DispatchTurnContext, row: Awaited<ReturnType<typeof admitTurnDispatch>>['row']): void {
  try {
    ws.send(JSON.stringify(buildTurnDispatchReceiptFrame(ctx, row, Date.now())))
  } catch { /* ws may already be closed */ }
}

/**
 * RFC-v5-durable-turn-dispatch §3 — 消费 webchat-DM inbound.message 的 dispatch 票据。
 *
 * 返回值 = 是否放行本帧继续处理(caller:`if (!_consumeDispatchAuthority(...)) return` 丢帧)。
 *
 * 无票据 no-op → legacy(return true):非 bridge 连接 / 非 webchat-DM / 不带 __oc_dispatch /
 * dispatchAuthority 未 enabled —— 一律放行走 legacy(不建 inbox 行,现状语义)。census 100% 前
 * 混跑期,没有 dispatch 追踪的 turn 行为等同今天。
 *
 * **带票据但消费失败 = fail-closed 拒帧(return false)**:一旦帧带 __oc_dispatch 且各前置门
 * 满足,验签/断言任一失败(配置漂移 / keyring 不符 / 篡改)都**拒帧**,绝不回落 legacy 执行 ——
 * master 已同事务建 dispatch,legacy 跑完真 tape = 与 reconciler 的 tombstone 双终态分裂。拒帧后
 * master reconciler 走 reject-if-absent → not_accepted → 用户可见失败(I1/I2 双保)。仅告警,不回内文。
 *
 * 验签+全断言通过 → descriptor 挂 WeakMap(dispatchInbound 据此走 durable 准入),return true。
 */
export function _consumeDispatchAuthority(this: TurnDispatchHost, ws: WebSocket, frame: Record<string, unknown>, isFromBridge: boolean): boolean {
  if (!isFromBridge || !this._dispatchAuthority.enabled) return true
  const peer = frame.peer as { kind?: unknown } | undefined
  if (frame.channel !== 'webchat' || peer?.kind !== 'dm') return true
  const raw = frame[DISPATCH_AUTHORITY_FIELD]
  if (raw === undefined || raw === null) return true
  const conn = this._authorityConns.get(ws)
  if (!conn) return true
  try {
    // 帧体 hash 断言需真实 content(text + media);computeDispatchRequestHash 只取
    // 内容身份字段(kind + url/base64 摘要),UI-only 字段自动被忽略。
    const content = (frame.content ?? {}) as {
      text?: string
      media?: readonly { kind?: string; url?: string; base64?: string }[]
    }
    // B9:同 turn 的 model-authority descriptor(_consumeFrameAuthority 已在本入口之前消费)
    // 带 billingRequestId 时交叉核对 —— 两票据 master 同事务铸造,billing 身份必一致。
    const modelAuthorityBillingRequestId = getTurnAuthority(frame as object)?.billingRequestId
    const ctx: DispatchTurnContext = this._dispatchAuthority.consume(frame, conn.challenge, content, {
      ...(modelAuthorityBillingRequestId !== undefined ? { modelAuthorityBillingRequestId } : {}),
    })
    attachDispatchContext(frame, ctx)
    return true
  } catch (err) {
    // 带票据的帧消费失败 = 配置漂移(keyring)或篡改。绝不 legacy 执行(master 已建
    // dispatch,legacy 跑完 = 双终态分裂);拒帧后 master reconciler 走 tombstone →
    // not_accepted → 用户可见失败,I1/I2 双保。
    if (err instanceof DispatchRejected) {
      this.log.error('dispatch_authority.rejected: frame refused', { code: err.code })
    } else {
      this.log.error('dispatch_authority.error: frame refused', {
        err: (err as Error)?.message ?? String(err),
      })
    }
    return false
  }
}

/**
 * Phase 5:bind status 回调统一 wrapper。两个路径共用(立即处理 / pending flush)。
 * 顺序:先 forward 给 ws → 再读 _repoWorkspace 当前 snapshot 触发 recycle。
 * 单进程下 status callback 是 _repoWorkspace 短锁内 commit 后才调,
 * getRepoSnapshot 此时已是最新值,recycle 决策按最新 snapshot 走。
 */
export function _buildStatusCallback(this: TurnDispatchHost, ws: WebSocket, sessionId: string): (frame: SessionRepoStatusOut) => void {
  return (statusFrame) => {
    this._sendStatusFrame(ws, statusFrame)
    const snap = this._repoWorkspace.getRepoSnapshot(sessionId)
    this.sessions
      .recyclePeerForRepoChange(sessionId, snap)
      .catch((err) =>
        this.log.warn('recycle_for_repo_change_failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
  }
}

/** OCV5-435 — a webchat turn counts as admitted from ws dispatch until it
 * settles, so a Stop that beats its engine run still binds to this turn. */
export async function _dispatchAdmittedClientTurn(this: TurnDispatchHost, frame: InboundFrame): Promise<void> {
  const clientMessageId = (frame as { clientMessageId?: unknown }).clientMessageId
  if (
    frame.type !== 'inbound.message' ||
    frame.channel !== 'webchat' ||
    !isClientMessageId(clientMessageId)
  ) {
    return this.dispatchInbound(frame)
  }
  const key = preStartStopKey(frame.peer.id, clientMessageId)
  const admitted = (this._admittedClientTurns ??= new Map())
  admitted.set(key, (admitted.get(key) ?? 0) + 1)
  this.sessions.adoptPreStartStopOnAdmission(
    frame.peer.id,
    clientMessageId,
    messageSendAttempt((frame as { idempotencyKey?: unknown }).idempotencyKey, clientMessageId),
  )
  try {
    await this.dispatchInbound(frame)
  } finally {
    const left = (admitted.get(key) ?? 1) - 1
    if (left > 0) {
      admitted.set(key, left)
    } else {
      admitted.delete(key)
      this.sessions.clearPreStartStop(frame.peer.id, clientMessageId)
    }
  }
}

export type RecordSettlementEntry = {
      behavior: 'allow' | 'deny'
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      sessionKey: string
      userId: string
      answers?: Record<string, string>
    }

/** Record an authoritative settlement for later replay to late duplicates.
 *  `answers` is carried so that a 3rd tab hitting the already-settled
 *  replay path still sees the collected AskUserQuestion answers. */
export function _recordSettlement(this: TurnDispatchHost, requestId: string, entry: RecordSettlementEntry): void {
  // FIFO evict (Map preserves insertion order) to cap memory under burst load.
  while (this._recentSettlements.size >= RECENT_SETTLEMENT_MAX) {
    const oldestKey = this._recentSettlements.keys().next().value
    if (oldestKey === undefined) break
    this._recentSettlements.delete(oldestKey)
  }
  this._recentSettlements.set(requestId, { ...entry, ts: Date.now() })
}

export type LookupSettlementResult = {
    behavior: 'allow' | 'deny'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    sessionKey: string
    userId: string
    answers?: Record<string, string>
  } | null

/** Look up a recent settlement, honoring TTL (returns null if expired). */
export function _lookupSettlement(this: TurnDispatchHost, requestId: string): LookupSettlementResult {
  const e = this._recentSettlements.get(requestId)
  if (!e) return null
  if (Date.now() - e.ts > RECENT_SETTLEMENT_TTL_MS) {
    this._recentSettlements.delete(requestId)
    return null
  }
  return {
    behavior: e.behavior,
    channel: e.channel,
    peer: e.peer,
    sessionKey: e.sessionKey,
    userId: e.userId,
    answers: e.answers,
  }
}
