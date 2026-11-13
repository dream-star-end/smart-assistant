/** Capacity admission, bounded queue and symmetric release for delegate runtime. */
import type { DelegateRuntimeHost, DelegateTaskResult } from './delegateRuntime.js';
import { DELEGATE_QUEUE_MAX_WAITERS, type DelegateGateBlock, type RunDelegateInput } from './delegatePolicy.js';
import type { DelegateFailureClass } from '@openclaude/protocol';

// ── delegate 资源闸有界排队 ──────────────────────────────────────────────────
/** 资源闸(并发上限/内存水位)命中时的最长排队等待,超时按原闸形状(429/503)拒绝。
 *  客户端余量:mcp-memory postJsonToGateway 超时 2h,delegate idle/hard 计时在
 *  排队放行**之后**才起表,90s 等待不挤占执行预算。 */
const DELEGATE_QUEUE_WAIT_DEFAULT_MS = 90_000

/** 排队复查间隔(每 2-3s 复查一次两道闸)。 */
const DELEGATE_QUEUE_POLL_DEFAULT_MS = 2_500

export function parseDelegateQueueWaitMs(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DELEGATE_QUEUE_WAIT_DEFAULT_MS
}

export type TryReserveDelegateSlotOpts = {
    parentBucketKey?: string
    isReview?: boolean
  }

/** 预占一个并发名额(判定+自增在同一同步段,单线程下原子,等待者间无超发);
 *  被闸拦截则返回原因、不占名额。P2 债C:非 review + 有父桶 → 同步 bump per-parent 运行计数。 */
export function _tryReserveDelegateSlot(
  this: DelegateRuntimeHost,
  opts?: TryReserveDelegateSlotOpts,
): DelegateGateBlock | null {
  const blocked = this._checkDelegateResourceGate(opts)
  if (blocked) return blocked
  this._activeDelegations++
  if (opts && !opts.isReview && opts.parentBucketKey) {
    const m = (this._runningDelegationsByParent ??= new Map())
    m.set(opts.parentBucketKey, (m.get(opts.parentBucketKey) ?? 0) + 1)
  }
  return null
}

export type ReleaseDelegateSlotOpts = {
    parentBucketKey?: string
    isReview?: boolean
  }

/** 释放一个已预占的并发名额(全局 + per-parent)。所有过闸后的路径必须经此释放,
 *  与 _tryReserveDelegateSlot 的增量口径严格对称(否则 per-parent 计数漂移锁死后续委派)。 */
export function _releaseDelegateSlot(
  this: DelegateRuntimeHost,
  opts?: ReleaseDelegateSlotOpts,
): void {
  this._activeDelegations--
  if (opts && !opts.isReview && opts.parentBucketKey) {
    const m = (this._runningDelegationsByParent ??= new Map())
    const cur = m.get(opts.parentBucketKey) ?? 0
    if (cur <= 1) m.delete(opts.parentBucketKey)
    else m.set(opts.parentBucketKey, cur - 1)
  }
}

export type WaitForDelegateCapacityResult = | { status: 'ok' }
  | { status: 'queue_full'; blocked: DelegateGateBlock }
  | { status: 'timeout'; blocked: DelegateGateBlock; waitedMs: number }
  | { status: 'aborted'; waitedMs: number }

export type WaitForDelegateCapacityArgs = {
    sessionKey: string
    /** P2 债C/3.5 — per-parent 分桶键(队长会话 sessionKey);缺省 → 只走全局闸。 */
    parentBucketKey?: string
    /** P2 债C — review 委派:走保留槽、豁免 per-parent 桶。 */
    isReview?: boolean
    onQueued?: (blocked: DelegateGateBlock) => void
  }

/**
 * delegate 资源闸有界排队:命中「并发 ≥ 上限」或「内存 ≥ 阈值」→ 轮询复查等待
 * 放行,而非立即 429/503(历史实况:并行 fanout 同秒双拒,队长收 503 后放弃委派
 * 自己兜底)。放行时已同步预占并发名额,调用方所有后续路径必须负责释放。
 *
 * 溯源:P5(f7453f4d)曾为旧重团队轨实现过"撞闸排队"(teamRunStore DB FIFO 队列),
 * 07-02 双轨清理(1ca107a8)删除旧 team_run 子系统时**连带**删除(非有意废弃)。
 * 本实现改为进程内等待收口:gateway 是容器内单进程,内存计数即权威,无需 DB 队列,
 * 且对所有 delegate(普通成员/hidden 审查员/嵌套)统一生效。
 *
 * 边界:
 * - 等待封顶 OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS(默认 90s)→ 'timeout';
 * - 排队人数封顶 DELEGATE_QUEUE_MAX_WAITERS(8,防雪崩)→ 'queue_full'(不等待);
 * - 用户 Stop 级联经 _delegateQueueWaiters 回调即时唤醒 → 'aborted';
 * - 无放行顺序保证(非 FIFO):等待者靠轮询抢占,依赖公平性的场景目前不存在。
 */
export async function _waitForDelegateCapacity(
  this: DelegateRuntimeHost,
  args: WaitForDelegateCapacityArgs,
): Promise<
  WaitForDelegateCapacityResult
> {
  const reserveOpts = { parentBucketKey: args.parentBucketKey, isReview: args.isReview }
  const first = this._tryReserveDelegateSlot(reserveOpts)
  if (!first) {
    // SM 'wait' 预占的占位 waiter 在这里放行 → 必须一并删除,否则占位永久计入
    // DELEGATE_QUEUE_MAX_WAITERS(后续全部 queue_full)。只碰已存在的表:无压力快路径
    // 不得初始化等待者表(delegateResourceQueue 契约)。
    this._delegateQueueWaiters?.delete(args.sessionKey)
    return { status: 'ok' }
  }
  const waiters = (this._delegateQueueWaiters ??= new Map())
  const preAdmitted = waiters.has(args.sessionKey)
  if (!preAdmitted && waiters.size >= DELEGATE_QUEUE_MAX_WAITERS) {
    return { status: 'queue_full', blocked: first }
  }
  const waitBudgetMs = parseDelegateQueueWaitMs()
  const pollMs = Math.max(1, this._delegateQueuePollMs ?? DELEGATE_QUEUE_POLL_DEFAULT_MS)
  const clock = this._delegateMonotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n))
  const startedAt = clock()
  let aborted = false
  let wake: (() => void) | null = null
  const prevAbort = waiters.get(args.sessionKey)
  waiters.set(args.sessionKey, () => {
    aborted = true
    wake?.()
    prevAbort?.()
  })
  try {
    args.onQueued?.(first)
    let lastBlocked = first
    while (true) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, pollMs)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
      if (aborted || this._shuttingDown) {
        return { status: 'aborted', waitedMs: clock() - startedAt }
      }
      const blocked = this._tryReserveDelegateSlot(reserveOpts)
      if (!blocked) return { status: 'ok' }
      lastBlocked = blocked
      if (clock() - startedAt >= waitBudgetMs) {
        return { status: 'timeout', blocked: lastBlocked, waitedMs: clock() - startedAt }
      }
    }
  } finally {
    waiters.delete(args.sessionKey)
  }
}

/**
 * SM: undo whatever `_admitDelegateCreate` reserved for this input (running slot or
 * waiter entry) when `_runDelegateTaskCore` rejects BEFORE reaching the capacity gate
 * (depth / per-turn guard / agent not found / catalog reject / team-review 409 …).
 *
 * 2026-09-06 事故:这些早退路径原本不释放 → `_activeDelegations` 与 per-parent 计数
 * 只增不减(6 个 MODEL_CATALOG_UNAVAILABLE 拒绝 = 6 个幽灵槽位),随后所有委派
 * `too many concurrent delegations (in-use 7/7)` 等满 300s 后 429。
 * Idempotent:释放后清 flag,重复调用无副作用(与 gate 后的 finally 释放互斥)。
 */
export function _releasePreadmittedDelegateCapacity(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
): void {
  if (input.capacityReserved) {
    this._releaseDelegateSlot(input.capacitySlotOpts)
    input.capacityReserved = false
  }
  if (input.capacitySlotOpts && input.sessionKey) {
    this._delegateQueueWaiters?.delete(input.sessionKey)
  }
  input.capacitySlotOpts = undefined
}

/**
 * SM: admit Enqueue and job create in one synchronous step.
 * 'slot' = already reserved a running slot; 'wait' = reserved a waiter; 'full' = no row.
 */
export function _admitDelegateCreate(
  this: DelegateRuntimeHost,
  sessionKey: string,
  opts: { parentBucketKey?: string; isReview?: boolean },
): 'slot' | 'wait' | 'full' {
  const blocked = this._tryReserveDelegateSlot(opts)
  if (!blocked) return 'slot'
  const waiters = (this._delegateQueueWaiters ??= new Map())
  if (waiters.size >= DELEGATE_QUEUE_MAX_WAITERS) return 'full'
  waiters.set(sessionKey, () => {})
  return 'wait'
}

export type ApplyDelegateCapacityRejectArgs = {
    httpStatus: number
    message: string
    failureClass?: DelegateFailureClass
    drop: boolean
  }

/**
 * Capacity reject must not leave an executable job, and must not fail a job
 * that already lost the race to claimQueued. Single-threaded Map ops make
 * settle vs claim exclusive; this just chooses drop / fail / already-dispatched
 * on the production write path (not later in the async `.then`).
 */
export function _applyDelegateCapacityReject(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
  args: ApplyDelegateCapacityRejectArgs,
): DelegateTaskResult {
  const jobId = input.backgroundJobId
  const store = this._delegateJobs
  if (jobId && store) {
    if (store.smEnabled) {
      const outcome = store.settleCapacityReject(jobId, {
        failureClass: args.failureClass ?? 'capacity_timeout',
        detail: args.message,
        httpStatus: args.httpStatus,
        drop: args.drop,
        nextState: args.failureClass === 'cancelled' ? 'cancelled' : 'failed',
      })
      if (outcome === 'claimed') {
        return {
          kind: 'rejected',
          httpStatus: args.httpStatus,
          message: args.message,
          failureClass: args.failureClass,
          alreadyDispatched: true,
        }
      }
    } else {
      store.complete(jobId, {
        httpStatus: args.httpStatus,
        body: {
          error: args.message,
          ...(args.failureClass ? { failure_class: args.failureClass } : {}),
        },
      })
    }
  }
  return {
    kind: 'rejected',
    httpStatus: args.httpStatus,
    message: args.message,
    failureClass: args.failureClass,
  }
}
