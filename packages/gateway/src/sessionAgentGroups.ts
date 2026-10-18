/**
 * Session agent groups: pending/late delegate agent-group buffering, delivery and owner-run bookkeeping
 *
 * Moved verbatim out of SessionManager (sessionManager.ts) — FINDINGS §7.6, OCV5-480. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SessionAgentGroupsHost lists exactly the SessionManager members this code
 * touches (typed from the class itself).
 */
import type { DurableAgentGroup } from '@openclaude/protocol'
import {
  buildLateDelegateContinuationArgs,
  isValidDelegateOwnerLocator,
  lateDelegateGroupIdentity,
  type DelegateOwnerTurnLocator,
} from './delegateLateCompletion.js'
import { log } from './sessionManagerLog.js'
import { takeDurableEventOrdinal, persistServerAuthoredTurnOutcome } from './sessionManager.js'
import type {
  SessionManager,
  AgentSession,
  PendingAgentGroupEntry,
  TapePersistResult,
  ExactOwnerRunState,
} from './sessionManager.js'

export interface SessionAgentGroupsHost {
  _admitExactOwnerRun: SessionManager['_admitExactOwnerRun']
  _claimDrainedOwnerGroups: SessionManager['_claimDrainedOwnerGroups']
  _compareOwnerRunIdentity: SessionManager['_compareOwnerRunIdentity']
  _exactOwnerRunKey: SessionManager['_exactOwnerRunKey']
  _exactOwnerRuns: SessionManager['_exactOwnerRuns']
  _getOwnerBudget: SessionManager['_getOwnerBudget']
  _matchLiveOwnerRun: SessionManager['_matchLiveOwnerRun']
  _matchLiveSessionsOwnerRun: SessionManager['_matchLiveSessionsOwnerRun']
  _ownerLocatorForSession: SessionManager['_ownerLocatorForSession']
  _sealOwnerTurn: SessionManager['_sealOwnerTurn']
  _trackPersistence: SessionManager['_trackPersistence']
  _trimExactOwnerRuns: SessionManager['_trimExactOwnerRuns']
  sessions: SessionManager['sessions']
}

/** OCV5-180 B1 — `_sealedOwnerTurnKeys` 有界 LRU 容量。 */
const SEALED_OWNER_TURN_KEYS_CAP = 32

/** OCV5-180 B1 — 把一张晚到的委派团队卡持久化为 owner turn 的受限
 * continuation tape(agentGroups-only 分支)。tape key 由 (ownerTurnKey, runId)
 * 推导:同一逻辑 run 永远命中同一 tape(master finalize 幂等 / 异内容 409);
 * root 暂不可达由 v3 sink 的 fsynced 重试队列表达('queued' ≠ 丢弃),不落纯内存 bucket。 */
function persistPostTerminalAgentGroup(args: {
  sessionKey: string
  owner: DelegateOwnerTurnLocator
  group: DurableAgentGroup
  onDroppedReason?: (reason: string) => void
}): Promise<TapePersistResult> {
  return persistServerAuthoredTurnOutcome({
    ...buildLateDelegateContinuationArgs({
      owner: args.owner,
      group: args.group,
      sessionKey: args.sessionKey,
    }),
    onDroppedReason: args.onDroppedReason,
  }).catch((err): TapePersistResult => {
    log.error(
      'post-terminal agent-group persist threw',
      { sessionKey: args.sessionKey, runId: args.group.runId },
      err as Error,
    )
    args.onDroppedReason?.(err instanceof Error ? err.message : String(err))
    return 'dropped'
  })
}

/** OCV5-180 B1 — 把 owner turn 已 seal 后到达(或 owner 会话已不在内存)的
 * 委派团队卡,作为受限 continuation tape 持久化到原 owner 名下。
 *
 * 幂等/冲突契约:同一 (ownerTurnKey, runId) 首次写入登记 identity;
 *  - 同 identity 重投(如 durable 重放)→ no-op(确定性 tape 本就幂等);
 *  - 不同内容同 run → 记 `late_delegate_group_conflict`(可观察),保留首卡,
 *    不再生成第二张卡。返回 false 仅表示「未调度新写」(invalid locator /
 *    冲突抑制),不含 sink 排队('queued' 是可靠等待,由 sink drainer 送达)。 */
export function deliverLateDelegateAgentGroup(
  this: SessionAgentGroupsHost,
  args: {
    owner: DelegateOwnerTurnLocator
    group: DurableAgentGroup
    sessionKey?: string
  },
): boolean {
  if (!isValidDelegateOwnerLocator(args.owner)) {
    log.warn('late delegate group dropped: invalid owner locator', {
      runId: args.group.runId,
    })
    return false
  }
  if (args.sessionKey) {
    const live = this.sessions.get(args.sessionKey)
    if (live && live.peerId !== args.owner.parentSessionId) {
      log.warn('late delegate group dropped: session/peer mismatch', {
        runId: args.group.runId,
        ownerSessionId: args.owner.parentSessionId,
      })
      return false
    }
  }
  const conflictKey = this._exactOwnerRunKey(args.owner.parentTurnKey, args.group.runId)
  const live = this._matchLiveSessionsOwnerRun(args.owner, args.group, args.sessionKey)
  if (live === 'conflict') {
    log.warn('late_delegate_group_conflict: same run with different content', {
      runId: args.group.runId,
      ownerTurnKey: args.owner.parentTurnKey,
    })
    return false
  }
  if (live === 'session_deleted') {
    log.warn('late delegate group dropped: session_deleted', {
      runId: args.group.runId,
    })
    return false
  }
  if (live === 'duplicate') return true
  const admission = this._admitExactOwnerRun(args.owner, args.group, 'inflight')
  if (admission === 'conflict') {
    log.warn('late_delegate_group_conflict: same run with different content', {
      runId: args.group.runId,
      ownerTurnKey: args.owner.parentTurnKey,
    })
    return false
  }
  if (admission === 'session_deleted') {
    log.warn('late delegate group dropped: session_deleted', {
      runId: args.group.runId,
    })
    return false
  }
  if (admission === 'duplicate') {
    const seen = this._exactOwnerRuns.get(conflictKey)
    if (
      seen?.state === 'inflight' ||
      seen?.state === 'queued' ||
      seen?.state === 'acked' ||
      seen?.state === 'buffered'
    ) {
      return true
    }
    return true
  }
  let droppedReason = ''
  // No pre-stage local lookup: master owns cross-root idempotency. The
  // async wrapper also captures a synchronous managed-sink rejection;
  // register its complete outcome chain before returning to shutdown.
  const persistence = (async () =>
    persistPostTerminalAgentGroup({
      sessionKey: args.sessionKey ?? args.owner.parentSessionId,
      owner: args.owner,
      group: args.group,
      onDroppedReason: (reason) => {
        droppedReason = reason
      },
    }))()
  const settled = persistence.then(
    (outcome) => {
      const rec = this._exactOwnerRuns.get(conflictKey)
      if (!rec || rec.identity !== lateDelegateGroupIdentity(args.owner, args.group)) return
      if (outcome === 'acked') {
        rec.state = 'acked'
        return
      }
      if (outcome === 'queued') {
        rec.state = 'queued'
        return
      }
      if (/session_deleted/i.test(droppedReason)) {
        rec.state = 'session_deleted'
        log.warn('late delegate group persist session_deleted', {
          runId: args.group.runId,
          ownerTurnKey: args.owner.parentTurnKey,
        })
        return
      }
      this._exactOwnerRuns.delete(conflictKey)
      log.warn('late delegate group persist dropped', {
        runId: args.group.runId,
        ownerTurnKey: args.owner.parentTurnKey,
        reason: droppedReason || outcome,
      })
    },
    (err: unknown) => {
      const rec = this._exactOwnerRuns.get(conflictKey)
      if (rec?.identity === lateDelegateGroupIdentity(args.owner, args.group)) {
        this._exactOwnerRuns.delete(conflictKey)
      }
      log.warn(
        'late delegate group persist failed before durable handoff',
        {
          runId: args.group.runId,
          ownerTurnKey: args.owner.parentTurnKey,
        },
        err instanceof Error ? err : new Error(String(err)),
      )
    },
  )
  this._trackPersistence(settled)
  return true
}

/**
 * P2 债A — buffer a completed delegation (team card) onto the leader session
 * so it drains into that session's turn-end server-authored persist.
 *
 * Called from `handleDelegateTask` collection at delegate完成/失败/超时 收尾,
 * keyed by the parent (leader) sessionKey.
 *
 * OCV5-180 B1 — exact-owner admission:带 `owner`(launch 时冻结的
 * {parentSessionId,parentTurnKey,turnIndex})时,只有「parent 的当前 turn 仍是
 * 该 owner turn 且该 turn 未被 seal」才接受入内存缓冲;否则返回 false,由调用方
 * 走 `deliverLateDelegateAgentGroup` 持久晚到通路。不带 owner 保持旧语义
 * (存量测试/旧调用方)。父会话不在内存同样返回 false —— 调用方凭冻结 locator
 * 仍可持久化晚到卡,不再退化为 client-only 丢失。
 *
 * Array.push is safe under concurrent parallel delegations (single-threaded
 * event loop, no torn writes).
 */
export function bufferPendingAgentGroup(
  this: SessionAgentGroupsHost,
  parentSessionKey: string,
  group: DurableAgentGroup,
  owner?: DelegateOwnerTurnLocator,
): boolean {
  const parent = this.sessions.get(parentSessionKey)
  if (!parent) return false
  if (owner) {
    if (!isValidDelegateOwnerLocator(owner)) return false
    if (parent.peerId !== owner.parentSessionId) return false
    if (parent._currentTurnKey !== owner.parentTurnKey) return false
    if (parent._sealedOwnerTurnKeys?.has(owner.parentTurnKey)) return false
    const live = this._matchLiveOwnerRun(parent, owner, group)
    if (live === 'conflict' || live === 'session_deleted') return false
    if (live === 'duplicate') return true
    const admission = this._admitExactOwnerRun(owner, group, 'buffered')
    if (admission === 'conflict' || admission === 'session_deleted') return false
    if (admission === 'duplicate') return true
  }
  // OCV5-189 diagnostics only: exact-owner requests for an earlier/sealed
  // turn were already rejected above and the caller takes the durable late
  // path. Legacy ownerless or anomalous billings may still reach this point;
  // logging must not change admission, queue ownership or drain semantics.
  const currentTurnKey = parent._currentTurnKey
  const crossTurn = (group.engineBillings ?? []).filter(
    (billing) =>
      typeof billing.parentTurnKey === 'string' && billing.parentTurnKey !== currentTurnKey,
  )
  if (currentTurnKey && crossTurn.length > 0) {
    log.warn('delegate team card drains into a later turn than its billing parent', {
      parentSessionKey,
      runId: group.runId,
      agentId: group.agentId,
      currentTurnKey,
      billingParentTurnKeys: [...new Set(crossTurn.map((billing) => billing.parentTurnKey))],
      requestIds: crossTurn.map((billing) => billing.requestId),
    })
  }
  ;(parent._pendingAgentGroups ??= []).push({
    group: {
      ...group,
      _ocEventOrdinal: group._ocEventOrdinal ?? takeDurableEventOrdinal(parent),
    },
    ownerTurnKey: owner?.parentTurnKey,
  })
  return true
}

/** P2 债A — take the leader session's buffered team cards for the turn-end
 *  persist. Returns [] when empty.
 *
 * OCV5-180 B1 — 带 `turnKey`(终态冻结点:completed persist 或 terminal
 * partial persist,两处均在同一同步临界段内冻结 payload)时:
 *  1. 只取 ownerTurnKey 匹配本 turn(或无 owner 的旧条目)的卡 —— 其他
 *     turn 的晚到卡绝不再混入本 turn 的 tape(历史 65 条坏 tape 的根因);
 *  2. 同步把该 turn 记入 `_sealedOwnerTurnKeys`(B-R2-1:封口判据 = payload
 *     已冻结,不是 master ACK/finalized)。此后同 owner 的完成只能走持久
 *     晚到通路。不带 turnKey 保持旧 take-and-clear 语义(存量测试)。 */
export function drainPendingAgentGroups(
  this: SessionAgentGroupsHost,
  session: AgentSession,
  turnKey?: string,
): DurableAgentGroup[] {
  const pending = session._pendingAgentGroups
  if (turnKey === undefined) {
    if (!pending || pending.length === 0) return []
    session._pendingAgentGroups = undefined
    return pending.map((entry) => entry.group)
  }
  // Exact-owner drain: seal the turn **even when nothing was buffered** —
  // the turn-end payload freeze happens regardless, so a late completion
  // for this owner must never enter the in-memory buffer afterwards.
  this._sealOwnerTurn(session, turnKey)
  if (!pending || pending.length === 0) return []
  const take: DurableAgentGroup[] = []
  const keep: PendingAgentGroupEntry[] = []
  const takenRuns = new Set<string>()
  for (const entry of pending) {
    if (entry.ownerTurnKey === undefined || entry.ownerTurnKey === turnKey) {
      if (takenRuns.has(entry.group.runId)) continue
      takenRuns.add(entry.group.runId)
      take.push(entry.group)
    } else keep.push(entry)
  }
  session._pendingAgentGroups = keep.length > 0 ? keep : undefined
  if (take.length > 0) {
    this._claimDrainedOwnerGroups(session, turnKey, take)
  }
  return take
}

export function _settleDrainedOwnerGroups(
  this: SessionAgentGroupsHost,
  session: AgentSession,
  turnKey: string,
  groups: DurableAgentGroup[],
  outcome: TapePersistResult,
): void {
  const owner = this._ownerLocatorForSession(session, turnKey)
  const durable = outcome === 'acked' || outcome === 'queued' || outcome === 'skipped'
  if (durable && isValidDelegateOwnerLocator(owner)) {
    const byTurn = (session._ackedExactOwnerRuns ??= new Map())
    let runs = byTurn.get(turnKey)
    if (!runs) {
      runs = new Map()
      byTurn.set(turnKey, runs)
    }
    for (const group of groups) {
      runs.set(group.runId, lateDelegateGroupIdentity(owner, group))
    }
  }
  for (const group of groups) {
    const key = this._exactOwnerRunKey(turnKey, group.runId)
    const rec = this._exactOwnerRuns.get(key)
    if (!rec) continue
    if (
      isValidDelegateOwnerLocator(owner) &&
      rec.identity !== lateDelegateGroupIdentity(owner, group)
    ) {
      continue
    }
    if (outcome === 'acked') rec.state = 'acked'
    else if (outcome === 'queued') rec.state = 'queued'
    else if (outcome === 'skipped') rec.state = 'acked'
    else this._exactOwnerRuns.delete(key)
  }
}

export function _claimDrainedOwnerGroups(
  this: SessionAgentGroupsHost,
  session: AgentSession,
  turnKey: string,
  groups: DurableAgentGroup[],
): void {
  const owner = this._ownerLocatorForSession(session, turnKey)
  if (!isValidDelegateOwnerLocator(owner)) return
  for (const group of groups) {
    const key = this._exactOwnerRunKey(turnKey, group.runId)
    const identity = lateDelegateGroupIdentity(owner, group)
    const seen = this._exactOwnerRuns.get(key)
    if (seen && seen.identity !== identity) continue
    this._exactOwnerRuns.set(key, { identity, state: 'inflight' })
  }
  this._trimExactOwnerRuns()
}

/** OCV5-180 B1 — mark an owner turn sealed (payload frozen). Insertion-order
 * LRU; re-sealing an already-sealed key is a no-op. */
export function _sealOwnerTurn(
  this: SessionAgentGroupsHost,
  session: AgentSession,
  turnKey: string,
): void {
  const sealed = (session._sealedOwnerTurnKeys ??= new Map<string, number>())
  if (sealed.has(turnKey)) return
  sealed.set(turnKey, Date.now())
  if (sealed.size > SEALED_OWNER_TURN_KEYS_CAP) {
    const oldest = sealed.keys().next().value
    if (oldest !== undefined) {
      sealed.delete(oldest)
      session._ackedExactOwnerRuns?.delete(oldest)
    }
  }
}

/** F6 — 在 owner 级串行链上跑一个任务(跨 session 预算临界区串行化)。返回本任务
 *  完成时 resolve 的 promise,供 session 链任务 `await`(方向恒为 session→owner,
 *  owner 任务内绝不 await session 链 → 无环、无死锁)。 */
export function _runOnOwnerChain(
  this: SessionAgentGroupsHost,
  ownerTurnKey: string,
  task: () => Promise<void>,
): Promise<void> {
  const budget = this._getOwnerBudget(ownerTurnKey)
  const next = budget.chain
    .then(task)
    .catch((err) =>
      log.error('post-terminal tail owner-chain task failed', { ownerTurnKey }, err as Error),
    )
  budget.chain = next
  return next
}

/** Shared exact-owner logical-run admission for buffer / drain / late. */
export function _admitExactOwnerRun(
  this: SessionAgentGroupsHost,
  owner: DelegateOwnerTurnLocator,
  group: DurableAgentGroup,
  next: ExactOwnerRunState,
): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
  const key = this._exactOwnerRunKey(owner.parentTurnKey, group.runId)
  const identity = lateDelegateGroupIdentity(owner, group)
  const seen = this._exactOwnerRuns.get(key)
  if (!seen) {
    this._exactOwnerRuns.set(key, { identity, state: next })
    this._trimExactOwnerRuns()
    return 'accept'
  }
  if (seen.identity !== identity) return 'conflict'
  if (seen.state === 'session_deleted') return 'session_deleted'
  return 'duplicate'
}

export function _matchLiveSessionsOwnerRun(
  this: SessionAgentGroupsHost,
  owner: DelegateOwnerTurnLocator,
  group: DurableAgentGroup,
  sessionKey?: string,
): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
  const liveSession = sessionKey ? this.sessions.get(sessionKey) : undefined
  if (liveSession) {
    const live = this._matchLiveOwnerRun(liveSession, owner, group)
    if (live !== 'accept') return live
  }
  for (const session of this.sessions.values()) {
    if (session.peerId !== owner.parentSessionId) continue
    const live = this._matchLiveOwnerRun(session, owner, group)
    if (live !== 'accept') return live
  }
  return 'accept'
}

export function _matchLiveOwnerRun(
  this: SessionAgentGroupsHost,
  session: AgentSession,
  owner: DelegateOwnerTurnLocator,
  group: DurableAgentGroup,
): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
  const pending = session._pendingAgentGroups
  if (pending) {
    for (const entry of pending) {
      if (entry.ownerTurnKey !== owner.parentTurnKey) continue
      if (entry.group.runId !== group.runId) continue
      return this._compareOwnerRunIdentity(
        lateDelegateGroupIdentity(owner, entry.group),
        owner,
        group,
      )
    }
  }
  const acked = session._ackedExactOwnerRuns?.get(owner.parentTurnKey)?.get(group.runId)
  if (acked !== undefined) return this._compareOwnerRunIdentity(acked, owner, group)
  return 'accept'
}

export function _trimExactOwnerRuns(this: SessionAgentGroupsHost): void {
  if (this._exactOwnerRuns.size <= 256) return
  const evictable: string[] = []
  for (const [key, rec] of this._exactOwnerRuns) {
    if (rec.state === 'buffered' || rec.state === 'inflight') continue
    evictable.push(key)
  }
  while (this._exactOwnerRuns.size > 256 && evictable.length > 0) {
    const oldest = evictable.shift()
    if (oldest === undefined) break
    const rec = this._exactOwnerRuns.get(oldest)
    if (!rec || rec.state === 'buffered' || rec.state === 'inflight') continue
    this._exactOwnerRuns.delete(oldest)
  }
}
