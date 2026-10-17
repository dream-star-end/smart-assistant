/**
 * Session post-terminal tail: runtime-event persistence batches, tail folding, cap markers, persistence tracking
 *
 * Moved verbatim out of SessionManager (sessionManager.ts) — FINDINGS §7.6, OCV5-480. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SessionTailHost lists exactly the SessionManager members this code
 * touches (typed from the class itself).
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DurableRuntimeEvent, SessionStreamEvent } from './engine/engineEvents.js'
import { getV3MasterSinkOrNull } from './v3MasterSink.js'
import type { OutboundContentBlock } from '@openclaude/protocol'
import { log } from './sessionManagerLog.js'
import { persistServerAuthoredTurnOutcome } from './sessionManager.js'
import type {
  SessionManager,
  AgentSession,
  TapePersistResult,
  TailFoldItem,
  TailFoldStreamState,
  TailPersistQueueItem,
} from './sessionManager.js'

export interface SessionTailHost {
  _buildTailCapMarker: SessionManager['_buildTailCapMarker']
  _chainTailPersist: SessionManager['_chainTailPersist']
  _drainTailPersistQueue: SessionManager['_drainTailPersistQueue']
  _enqueueTailPersist: SessionManager['_enqueueTailPersist']
  _foldPostTerminalTail: SessionManager['_foldPostTerminalTail']
  _getOwnerBudget: SessionManager['_getOwnerBudget']
  _lastMissingOwnerWarnAt: SessionManager['_lastMissingOwnerWarnAt']
  _missingOwnerMetrics: SessionManager['_missingOwnerMetrics']
  _pendingPersistence: SessionManager['_pendingPersistence']
  _persistTailBatch: SessionManager['_persistTailBatch']
  _runOnOwnerChain: SessionManager['_runOnOwnerChain']
  _scheduleTailPersistWorker: SessionManager['_scheduleTailPersistWorker']
  _tailFoldMinIntervalMs: SessionManager['_tailFoldMinIntervalMs']
  _tailFoldOwnerCap: SessionManager['_tailFoldOwnerCap']
  _tailFoldStreamCap: SessionManager['_tailFoldStreamCap']
  _tailOwnerBudgets: SessionManager['_tailOwnerBudgets']
  _tailPersistBatchMaxBytes: SessionManager['_tailPersistBatchMaxBytes']
  _tailPersistBatchMaxEvents: SessionManager['_tailPersistBatchMaxEvents']
  _trackPersistence: SessionManager['_trackPersistence']
  _warnMissingPostTerminalOwner: SessionManager['_warnMissingPostTerminalOwner']
}

function persistPostTerminalRuntimeEvents(args: {
  sessionKey: string
  sessionId: string
  turnIndex: number
  continuationOfTurnKey: string
  events: DurableRuntimeEvent[]
}): Promise<TapePersistResult> {
  if (args.events.length === 0) return Promise.resolve('skipped')
  const identity = createHash('sha256')
    .update('oc-post-terminal-runtime-batch-v1\0')
    .update(args.continuationOfTurnKey)
  for (const event of args.events) {
    const raw = JSON.stringify(event.payload)
    identity
      .update('\0')
      .update(String(event.ordinal))
      .update('\0')
      .update(String(event.observedAt))
      .update('\0')
      .update(event.source)
      .update('\0')
      .update(raw)
  }
  const identityHex = identity.digest('hex')
  // 三态透传:tail 折叠区分 acked|queued(可靠,更新 hash/count/转发)与 dropped
  // (不更新 → 冻结的 marker / 变化 tail 下次重试)。persistServerAuthoredTurnOutcome
  // 在 commercial-managed 缺 sink 时会 throw(配置异常),兜底折成 dropped。
  return persistServerAuthoredTurnOutcome({
    sessionKey: args.sessionKey,
    peerId: args.sessionId,
    agentId: `tail_${identityHex.slice(0, 24)}`,
    userId: undefined,
    turnIndex: args.turnIndex,
    turnKey: createHash('sha256')
      .update('oc-post-terminal-tape-batch-v1\0')
      .update(identityHex)
      .digest('hex'),
    continuationOfTurnKey: args.continuationOfTurnKey,
    createdAt: Math.min(...args.events.map((event) => event.observedAt)),
    text: '',
    status: 'completed',
    runtimeEvents: args.events.map((event) => structuredClone(event)),
  }).catch((err): TapePersistResult => {
    log.error('post-terminal runtime persist threw', { sessionKey: args.sessionKey }, err as Error)
    return 'dropped'
  })
}

type TailPersistOp =
  | { kind: 'real'; st: TailFoldStreamState; item: TailFoldItem; event: DurableRuntimeEvent }
  | {
      kind: 'stream_marker'
      st: TailFoldStreamState
      item: TailFoldItem
      event: DurableRuntimeEvent
    }
  | {
      kind: 'owner_marker'
      st: TailFoldStreamState
      item: TailFoldItem
      event: DurableRuntimeEvent
    }

/** tail 内容指纹 = tail + total_bytes + truncated_head + tool_use_id +
 *  parent_tool_use_id。bg bash 每秒 emit 的不变 tail 指纹相同 → 折叠丢弃。 */
function tailContentHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(typeof payload.tail === 'string' ? payload.tail : '')
    .update('\0')
    .update(String(typeof payload.total_bytes === 'number' ? payload.total_bytes : 0))
    .update('\0')
    .update(String(!!payload.truncated_head))
    .update('\0')
    .update(typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '')
    .update('\0')
    .update(typeof payload.parent_tool_use_id === 'string' ? payload.parent_tool_use_id : '')
    .digest('hex')
}

export async function _persistTailBatch(
  this: SessionTailHost,
  session: AgentSession,
  batch: TailPersistQueueItem[],
): Promise<void> {
  if (batch.length === 0) return
  const first = batch[0]!.item
  const owner = this._getOwnerBudget(first.ownerTurnKey)
  const metrics = (session._tailFoldMetrics ??= {
    unchangedSuppressed: 0,
    rateCoalesced: 0,
    capped: 0,
  })
  const ops: TailPersistOp[] = []
  const plannedHashes = new Map<TailFoldStreamState, string | null>()
  const plannedRealCounts = new Map<TailFoldStreamState, number>()
  let ownerRealCount = 0
  let ownerMarkerPlanned = false
  const streamMarkerPlanned = new Set<TailFoldStreamState>()
  // runtimeEvents-only 在 legacy/no-sink 路径会返回 skipped;它们按旧契约
  // 不占预算、不触发 cap。sink 存在时才做持久化预算规划。
  const enforcePersistentBudget = getV3MasterSinkOrNull() !== null

  for (const entry of batch) {
    const { st, item } = entry
    const currentHash = plannedHashes.has(st) ? plannedHashes.get(st)! : st.lastPersistedHash
    if (item.hash === currentHash) {
      metrics.unchangedSuppressed++
      continue
    }
    if (enforcePersistentBudget && (st.capped || owner.capped || ownerMarkerPlanned)) continue
    if (
      enforcePersistentBudget &&
      owner.persistedCount + ownerRealCount >= this._tailFoldOwnerCap
    ) {
      owner.markerEvent ??= this._buildTailCapMarker(item, 'owner_cap')
      ops.push({ kind: 'owner_marker', st, item, event: owner.markerEvent })
      ownerMarkerPlanned = true
      continue
    }
    const streamRealCount = plannedRealCounts.get(st) ?? 0
    if (enforcePersistentBudget && st.persistedCount + streamRealCount >= this._tailFoldStreamCap) {
      if (!streamMarkerPlanned.has(st)) {
        st.markerEvent ??= this._buildTailCapMarker(item, 'cap')
        ops.push({ kind: 'stream_marker', st, item, event: st.markerEvent })
        streamMarkerPlanned.add(st)
      }
      continue
    }
    ops.push({ kind: 'real', st, item, event: item.event })
    plannedHashes.set(st, item.hash)
    plannedRealCounts.set(st, streamRealCount + 1)
    ownerRealCount++
  }
  if (ops.length === 0) return

  const outcome = await persistPostTerminalRuntimeEvents({
    sessionKey: session.sessionKey,
    sessionId: first.ownerSessionId,
    turnIndex: first.turnIndex,
    continuationOfTurnKey: first.ownerTurnKey,
    events: ops.map((op) => op.event),
  })
  if (outcome === 'dropped') return

  for (const op of ops) {
    if (op.kind === 'owner_marker') {
      owner.capped = true
      metrics.capped++
      log.warn('post-terminal tail OWNER capped', {
        sessionKey: session.sessionKey,
        ownerTurnKey: op.item.ownerTurnKey,
        ownerPersistedCount: owner.persistedCount,
      })
      continue
    }
    if (op.kind === 'stream_marker') {
      op.st.capped = true
      metrics.capped++
      log.warn('post-terminal tail stream capped', {
        sessionKey: session.sessionKey,
        ownerTurnKey: op.item.ownerTurnKey,
        toolUseId: op.item.toolUseId,
        persistedCount: op.st.persistedCount,
      })
      continue
    }
    op.st.lastPersistedHash = op.item.hash
    if (outcome === 'acked' || outcome === 'queued') {
      op.st.persistedCount++
      owner.persistedCount++
      session._durableDelegateRuntimeEvents?.push(structuredClone(op.item.event))
    }
    op.item.onEvent({ kind: 'block', block: op.item.block })
  }
}

/**
 * B5/B6 — post-terminal runtime 事件分发的**单一权威**(从 runEngineTurn 的
 * onPostTerminalRuntimeEvent 闭包抽出,给归属 fail-closure 与非 tail dropped 门控一个
 * 可直接单测的接缝)。三条不变量:
 *   - **归属缺失(B5)**:缺 ownerTurnKey/ownerSessionId 时,tail 类 **fail-closed 丢弃**
 *     (对齐 ccbAdapter._routeMessage:归属不明的 tail 绝不裸转发 —— 那正是 owner
 *     attribution bug 成因;tail 有 cap/去重/归档兜底,丢一帧无损);非 tail 类因无
 *     cap/去重保护且丢弃即真丢内容,**保持兜底转发**,但两类都记计数 + 限频 warn。
 *   - **非 tail dropped 门控(B6)**:非 tail 事件先持久化后转发,persist 结果 `dropped`
 *     时**不转发**(与 tail 路径 _enqueueTailPersist 的 dropped→不更新/不转发对称),
 *     绝不把未落盘的 post-terminal 快照抢先展示;durable 收集器 push 同步收敛到
 *     acked|queued(dropped/skipped 不进,消除"未落盘事件仍被当耐久重放"的类一致性缺陷)。
 *   - **tail 折叠**:归属齐备的 tail 交 _foldPostTerminalTail(去重/限频/cap)。
 */
export function _dispatchPostTerminalRuntimeEvent(
  this: SessionTailHost,
  session: AgentSession,
  event: DurableRuntimeEvent,
  block: OutboundContentBlock,
  ctx: {
    ownerTurnKey: string | undefined | null
    ownerSessionId: string | undefined | null
    turnIndex: number
    onEvent: (e: SessionStreamEvent) => void
  },
): void {
  const { ownerTurnKey, ownerSessionId, turnIndex, onEvent } = ctx
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : null
  const isTail = payload?.subtype === 'bash_output_tail'

  if (!ownerTurnKey || !ownerSessionId) {
    if (isTail) {
      // B5 fail-closed:归属不明的 tail 绝不裸转发(丢弃 + 计数 + 限频 warn)。
      this._warnMissingPostTerminalOwner('tail_dropped')
      return
    }
    // B5:非 tail 无 cap/去重保护,丢弃会真丢内容 → 保持兜底转发,但计数 + 限频 warn。
    this._warnMissingPostTerminalOwner('non_tail_forwarded')
    onEvent({ kind: 'block', block })
    return
  }

  if (!isTail) {
    // B6 非 tail:先持久化后转发,dropped 时 fail-closed 不转发(与 tail 路径对称)。
    this._chainTailPersist(session, async () => {
      const outcome = await persistPostTerminalRuntimeEvents({
        sessionKey: session.sessionKey,
        sessionId: ownerSessionId,
        turnIndex,
        continuationOfTurnKey: ownerTurnKey,
        events: [event],
      })
      // dropped:帧未落盘 → 绝不抢先展示未持久化的 post-terminal 快照。
      if (outcome === 'dropped') return
      // acked|queued 才进 durable 收集器(skipped=legacy 未落盘,转发但不计耐久;
      // 与 tail 路径 _enqueueTailPersist 完全对称)。
      if (outcome === 'acked' || outcome === 'queued') {
        session._durableDelegateRuntimeEvents?.push(structuredClone(event))
      }
      onEvent({ kind: 'block', block })
    })
    return
  }

  // tail → 折叠(去重 / 5s 限频 / 每流 24 + 每 turn 64 封顶)。
  const toolUseId = typeof payload!.tool_use_id === 'string' ? payload!.tool_use_id : ''
  const parentToolUseId =
    typeof payload!.parent_tool_use_id === 'string' ? payload!.parent_tool_use_id : ''
  this._foldPostTerminalTail(
    session,
    {
      event,
      block,
      hash: tailContentHash(payload!),
      ownerTurnKey,
      ownerSessionId,
      turnIndex,
      toolUseId,
      parentToolUseId,
      onEvent,
    },
    [ownerTurnKey, parentToolUseId, toolUseId].join('\u0000'),
  )
}

/** A1 — bash_output_tail 折叠入口(在发起 turn 的 onPostTerminalRuntimeEvent 内
 *  为每条 tail 调用)。去重(内容不变直接丢弃)→ 限频(<5s trailing-edge 合并,
 *  只保留最新一条,定时器到点 flush)→ 否则立即 enqueue 持久化。 */
export function _foldPostTerminalTail(
  this: SessionTailHost,
  session: AgentSession,
  item: TailFoldItem,
  streamKey: string,
): void {
  const streams = (session._tailFoldStreams ??= new Map())
  const metrics = (session._tailFoldMetrics ??= {
    unchangedSuppressed: 0,
    rateCoalesced: 0,
    capped: 0,
  })
  let st = streams.get(streamKey)
  if (!st) {
    st = {
      lastPersistedHash: null,
      lastPersistAt: 0,
      persistedCount: 0,
      pending: null,
      timer: null,
      capped: false,
      markerEvent: null,
    }
    streams.set(streamKey, st)
  }
  // 已封顶:静默丢弃(cap 已在触发时计数 + warn 一次)。
  if (st.capped) return
  // owner 已封顶 → 整 owner 全停,静默丢弃(只读 peek,不 churn owner LRU)。
  if (this._tailOwnerBudgets.get(item.ownerTurnKey)?.capped) return
  // 稳态洪泛:内容与上次持久化相同 → 丢弃(不持久化、不转发、不进 durable 收集器)。
  if (item.hash === st.lastPersistedHash) {
    metrics.unchangedSuppressed++
    return
  }
  const now = Date.now()
  if (st.lastPersistAt > 0 && now - st.lastPersistAt < this._tailFoldMinIntervalMs) {
    // 限频:trailing-edge 合并,只保留最新一条 pending;到点 flush 走同一串行链。
    metrics.rateCoalesced++
    st.pending = item
    if (!st.timer) {
      const delay = Math.max(0, st.lastPersistAt + this._tailFoldMinIntervalMs - now)
      st.timer = setTimeout(() => {
        st!.timer = null
        const pending = st!.pending
        st!.pending = null
        if (pending) this._enqueueTailPersist(session, st!, pending)
      }, delay)
      // 折叠定时器不该拖住进程退出:销毁路径会主动 flush pending 并 clear。
      const t = st.timer as { unref?: () => void }
      if (typeof t.unref === 'function') t.unref()
    }
    return
  }
  this._enqueueTailPersist(session, st, item)
}

/**
 * A1/F7 — 排空 tail 折叠:flush 各流 pending(**只绕过 5s 限频窗口,仍受 stream/owner
 * cap 约束** —— pending 走既有 cap 判定,cap 已满则落 marker 或丢弃,owner.capped 后
 * 不写任何东西),await 串行链排空。
 *
 * `destroy`(仅 runner 已停的三处销毁路径:destroySession / LRU 驱逐 / shutdownAll)
 * 时额外汇总 log + 清 stream 状态/metrics/session 链 —— **破坏性**。
 * `destroy=false`(F4:handleDelegateTask 摘取点,runner 仍活)为**非破坏 snapshot
 * drain**:只 flush + await,不清态,后续 tail 仍受既有去重/cap 状态约束。
 */
export async function _drainTailFolding(
  this: SessionTailHost,
  session: AgentSession,
  opts: { destroy: boolean },
): Promise<void> {
  const streams = session._tailFoldStreams
  if (streams) {
    for (const st of streams.values()) {
      if (st.timer) {
        clearTimeout(st.timer)
        st.timer = null
      }
      const pending = st.pending
      st.pending = null
      if (pending) this._enqueueTailPersist(session, st, pending)
    }
  }
  if (session._postTerminalRuntimeChain) {
    await session._postTerminalRuntimeChain.catch(() => {})
  }
  if (!opts.destroy) return
  const m = session._tailFoldMetrics
  if (m && (m.unchangedSuppressed || m.rateCoalesced || m.capped)) {
    log.info('post-terminal tail folding summary', {
      sessionKey: session.sessionKey,
      unchanged_suppressed: m.unchangedSuppressed,
      rate_coalesced: m.rateCoalesced,
      capped: m.capped,
    })
  }
  session._tailFoldStreams = undefined
  session._tailFoldMetrics = undefined
  session._postTerminalRuntimeChain = undefined
  session._postTerminalTailQueue = undefined
  session._postTerminalTailWorkerScheduled = false
  // owner 预算不在此清:它是 SessionManager 级、可被同 ownerTurnKey 的其它(delegate)
  // 会话共享,自身受 LRU(512)有界;随会话清会破坏跨会话聚合封顶。
}

export async function _drainTailPersistQueue(
  this: SessionTailHost,
  session: AgentSession,
): Promise<void> {
  const queue = (session._postTerminalTailQueue ??= [])
  while (queue.length > 0) {
    const first = queue.shift()!
    const batch = [first]
    let bytes = Buffer.byteLength(JSON.stringify(first.item.event), 'utf8')
    while (queue.length > 0 && batch.length < this._tailPersistBatchMaxEvents) {
      const next = queue[0]!
      // continuation tape 的 owner 必须唯一;遇到另一 owner 就先收当前批。
      if (next.item.ownerTurnKey !== first.item.ownerTurnKey) break
      const nextBytes = Buffer.byteLength(JSON.stringify(next.item.event), 'utf8')
      if (batch.length > 0 && bytes + nextBytes > this._tailPersistBatchMaxBytes) break
      queue.shift()
      batch.push(next)
      bytes += nextBytes
    }
    await this._runOnOwnerChain(first.item.ownerTurnKey, () =>
      this._persistTailBatch(session, batch),
    )
  }
}

/** F1b — 冻结的 capped marker 事件(ordinal/observedAt/payload 首次构造后不再变),
 *  保证 dropped 重试时 identity 稳定、master UPSERT 去重,绝不产生多条 marker。 */
export function _buildTailCapMarker(
  this: SessionTailHost,
  item: TailFoldItem,
  reason: 'cap' | 'owner_cap',
): DurableRuntimeEvent {
  return {
    ordinal: item.event.ordinal,
    observedAt: Date.now(),
    source: 'gateway',
    payload: {
      type: 'system',
      subtype: 'bash_output_tail_capped',
      tool_use_id: item.toolUseId,
      ...(item.parentToolUseId ? { parent_tool_use_id: item.parentToolUseId } : {}),
      suppressed_reason: reason,
    },
  }
}

export function _scheduleTailPersistWorker(this: SessionTailHost, session: AgentSession): void {
  if (session._postTerminalTailWorkerScheduled) return
  session._postTerminalTailWorkerScheduled = true
  this._chainTailPersist(session, async () => {
    try {
      await this._drainTailPersistQueue(session)
    } finally {
      session._postTerminalTailWorkerScheduled = false
      // JS 同步段无竞态,但持久化 await 期间可能到新事件;
      // worker 退出前再补挂一次,不留无主队列。
      if ((session._postTerminalTailQueue?.length ?? 0) > 0) {
        this._scheduleTailPersistWorker(session)
      }
    }
  })
}

/** A1 — 把一次 tail 持久化(或 capped marker)追加到 **per-session** 串行链,并
 *  纳入 pending-persistence 跟踪。折叠/非折叠 post-terminal 事件都经此串行化,
 *  故定时器 flush 与事件回调不会并发双写。 */
export function _chainTailPersist(
  this: SessionTailHost,
  session: AgentSession,
  task: () => Promise<void>,
): void {
  const chain = (session._postTerminalRuntimeChain ?? Promise.resolve()).then(task).catch((err) => {
    log.error(
      'post-terminal runtime persist failed',
      { sessionKey: session.sessionKey },
      err as Error,
    )
  })
  session._postTerminalRuntimeChain = chain
  this._trackPersistence(chain)
}

export function _trackPersistence(this: SessionTailHost, p: Promise<unknown>): void {
  this._pendingPersistence.add(p)
  // Two-handler `.then` instead of `.finally` so a rejected `p`
  // doesn't propagate through the chain and trigger an
  // unhandledRejection. `persistServerAuthoredTurn` itself never
  // rejects (its catches absorb sink/storage errors into log lines),
  // but this is belt-and-braces — a future call site swapping in a
  // different awaitable shouldn't be able to crash the gateway.
  const cleanup = (): void => {
    this._pendingPersistence.delete(p)
  }
  p.then(cleanup, cleanup)
}

/** B5 — 归属缺失计数 + 限频 warn(30s)。丢弃/兜底转发两类共用一个限频锚点,
 *  日志带累计计数便于观测该缺陷是个例还是持续。 */
export function _warnMissingPostTerminalOwner(
  this: SessionTailHost,
  kind: 'tail_dropped' | 'non_tail_forwarded',
): void {
  if (kind === 'tail_dropped') this._missingOwnerMetrics.tailDropped++
  else this._missingOwnerMetrics.nonTailForwarded++
  const now = Date.now()
  if (now - this._lastMissingOwnerWarnAt < 30_000) return
  this._lastMissingOwnerWarnAt = now
  log.warn('post-terminal runtime event missing owner attribution', {
    kind,
    tail_dropped: this._missingOwnerMetrics.tailDropped,
    non_tail_forwarded: this._missingOwnerMetrics.nonTailForwarded,
  })
}
