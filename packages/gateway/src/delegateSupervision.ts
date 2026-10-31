/**
 * Gateway delegate supervision: inflight surface, reaper/reconcile timers, runner liveness, resume-claim bookkeeping, job persist-and-close
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-473. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. DelegateSupervisionHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { dirname, join } from 'node:path'
import {
  type DelegateJobStore,
  DELEGATE_REAP_INTERVAL_MS,
  resolveDelegateHeartbeatTimeoutMs,
  type DelegateJobSnapshot,
} from './delegateJobs.js'
import { isDelegateCutoverEffective, isDelegateInflightSurfaceEffective } from './delegateSmFlag.js'
import { DelegateInflightSurfaceStore } from './delegateInflightSurface.js'
import {
  beginDelegateCutover,
  isDelegateRunnerIdle,
  resolveDelegateCutoverFreezeMs,
} from './delegateCutover.js'
import { resolveDelegateLedgerRetentionMs } from './delegateDurable.js'
import { nextDelegateReconcileAt, reconcileDelegateJobsOnBoot } from './delegateReconciler.js'
import type { Gateway } from './server.js'
import type { RunDelegateInput } from './delegatePolicy.js'
import { waitForStrictSessionCleanup } from './sessionLifecycle.js'

export interface DelegateSupervisionHost {
  _armDelegateReconcileFollowup: Gateway['_armDelegateReconcileFollowup']
  _delegateChildAlive: Gateway['_delegateChildAlive']
  _delegateDurablePath: Gateway['_delegateDurablePath']
  _delegateInflightSurface: Gateway['_delegateInflightSurface']
  _delegateJobs: Gateway['_delegateJobs']
  _delegateReapTimer: Gateway['_delegateReapTimer']
  _delegateReconcileTimer: Gateway['_delegateReconcileTimer']
  _delegateResume: Gateway['_delegateResume']
  _delegateRunnerIdle: Gateway['_delegateRunnerIdle']
  _ensureDelegateInflightSurface: Gateway['_ensureDelegateInflightSurface']
  _forgetDelegateInflight: Gateway['_forgetDelegateInflight']
  _notifyRetryTimer: Gateway['_notifyRetryTimer']
  _persistInterruptedSendToAgentCallbacks: Gateway['_persistInterruptedSendToAgentCallbacks']
  log: Gateway['log']
  sessions: Gateway['sessions']
}

export function _ensureDelegateInflightSurface(
  this: DelegateSupervisionHost,
): DelegateInflightSurfaceStore {
  if (this._delegateInflightSurface) return this._delegateInflightSurface
  this._delegateInflightSurface = new DelegateInflightSurfaceStore({
    dbPath: this._delegateDurablePath
      ? join(dirname(this._delegateDurablePath), 'delegate-inflight-surface.db')
      : undefined,
  })
  return this._delegateInflightSurface
}

export function _projectDelegateInflightFromJob(
  this: DelegateSupervisionHost,
  job: DelegateJobSnapshot,
): void {
  if (!isDelegateInflightSurfaceEffective()) return
  try {
    this._ensureDelegateInflightSurface().projectJob(job)
  } catch (err) {
    this.log.warn('delegate inflight surface project failed', { jobId: job.id }, err as Error)
  }
}

export function _forgetDelegateInflight(this: DelegateSupervisionHost, jobId: string): void {
  if (!isDelegateInflightSurfaceEffective()) return
  try {
    this._ensureDelegateInflightSurface().drop(jobId)
  } catch (err) {
    this.log.warn('delegate inflight surface drop failed', { jobId }, err as Error)
  }
}

export function _dropDelegateInflightSurface(this: DelegateSupervisionHost, jobId: string): void {
  this._forgetDelegateInflight(jobId)
}

export type TouchDelegateInflightSurfaceInput = {
    jobId?: string
    progressRunId?: string
    parentSessionKey?: string
    agentId: string
    goal?: string
    state?: import('@openclaude/protocol').DelegateJobState
    liveHint?: string
    runId?: string
    userId?: string
    nested?: boolean
    ownerRunId?: string
    background?: true
    preserveIdentity?: boolean
  }

export function _touchDelegateInflightSurface(
  this: DelegateSupervisionHost,
  input: TouchDelegateInflightSurfaceInput,
): void {
  if (!isDelegateInflightSurfaceEffective()) return
  try {
    const parentSessionKey = input.parentSessionKey
    if (!parentSessionKey) return
    const jobId = DelegateInflightSurfaceStore.resolveJobId(input.jobId, input.progressRunId)
    if (!jobId) return
    const store = this._ensureDelegateInflightSurface()
    const snap = this._delegateJobs?.snapshotOf(jobId)
    const fence = snap ? { fencingEpoch: snap.fencingEpoch, generation: snap.generation } : {}
    const patch = store.updateLive({
      jobId,
      state: input.state,
      liveHint: input.liveHint,
      runId: input.runId ?? input.progressRunId,
      goal: input.goal,
      agentId: input.agentId,
      parentSessionKey,
      userId: input.userId,
      nested: input.nested,
      ownerRunId: input.ownerRunId,
      preserveIdentity: input.preserveIdentity,
      background: input.background,
      ...fence,
    })
    if (patch) return
    store.upsertEnqueue({
      jobId,
      parentSessionKey,
      agentId: input.agentId,
      goal: input.goal,
      runId: input.runId ?? input.progressRunId,
      state: input.state ?? 'running',
      liveHint: input.liveHint,
      userId: input.userId,
      nested: input.nested,
      ownerRunId: input.ownerRunId,
      preserveIdentity: input.preserveIdentity,
      background: input.background,
      ...fence,
    })
  } catch (err) {
    this.log.warn(
      'delegate inflight surface write failed',
      { jobId: input.jobId, progressRunId: input.progressRunId },
      err as Error,
    )
  }
}

export function _armDelegateReconcileFollowup(
  this: DelegateSupervisionHost,
  store: DelegateJobStore,
  queueWaitMs: number,
): void {
  if (this._delegateReconcileTimer) {
    clearTimeout(this._delegateReconcileTimer)
    this._delegateReconcileTimer = undefined
  }
  const next = nextDelegateReconcileAt(store, { queueWaitMs })
  if (next == null) return
  const delay = Math.max(0, next - Date.now())
  this._delegateReconcileTimer = setTimeout(() => {
    this._delegateReconcileTimer = undefined
    if (!this._delegateJobs) return
    const summary = reconcileDelegateJobsOnBoot(this._delegateJobs, {
      isChildAlive: (job) => this._delegateChildAlive(job.sessionKey),
      queueWaitMs,
      claimPaused: isDelegateCutoverEffective(),
    })
    if (summary.killed > 0 || summary.capacityTimedOut > 0) {
      this.log.info('delegate durable reconcile follow-up', summary)
    }
    this._armDelegateReconcileFollowup(this._delegateJobs, queueWaitMs)
  }, delay)
  this._delegateReconcileTimer.unref()
}

/**
 * OCV5-164: periodic heartbeat-timeout reaper + ledger retention janitor.
 *
 * The boot reconciler only judges `owner_lease_until`, and it defers
 * indefinitely while the parent session still holds a runner object — so a
 * row that stopped making progress never reaches a terminal state and keeps
 * occupying delegate capacity. This interval closes that hole using
 * `last_activity_at`, then interrupts the child so the ledger and the
 * subprocess agree.
 *
 * Scope note: for `kind=delegate` the interrupt also unwinds
 * `_runDelegateTaskCore`, whose `finally` releases the Grok relay lease.
 * `kind=cron` never mints such a lease, so reaping a cron row frees delegate
 * capacity — not a Grok slot.
 *
 * Fencing: `reapStaleRunning` skips rows a *live* other instance owns, so
 * running two masters cannot double-reap; retention pruning is idempotent.
 */
export function _armDelegateReaper(this: DelegateSupervisionHost, store: DelegateJobStore): void {
  if (this._delegateReapTimer) return
  const timeoutMs = resolveDelegateHeartbeatTimeoutMs()
  const retentionMs = resolveDelegateLedgerRetentionMs()
  const tick = () => {
    try {
      for (const { job, idleSec } of store.reapStaleRunning({ timeoutMs })) {
        // Settling the ledger row does not stop the child. Interrupt it here
        // (the same closeout the delegate lease path performs when
        // casHeartbeat fails), otherwise the row reads `failed` while the
        // subprocess keeps running and, for cron-origin-inject, the origin
        // has already been told the job failed.
        let interrupted = false
        if (job.sessionKey) {
          try {
            interrupted = this.sessions.interrupt(job.sessionKey) === true
          } catch (err) {
            this.log.warn(
              'delegate_heartbeat_timeout_interrupt_failed',
              { jobId: job.id, sessionKey: job.sessionKey },
              err as Error,
            )
          }
        }
        this.log.warn('delegate_heartbeat_timeout_reaped', {
          jobId: job.id,
          kind: job.kind,
          agentId: job.agentId,
          sessionKey: job.sessionKey,
          idleSec,
          failureClass: job.failureClass,
          interrupted,
        })
      }
    } catch (err) {
      this.log.warn('delegate heartbeat reaper failed', {}, err as Error)
    }
    try {
      const pruned = store.pruneRetiredLedger({ retentionMs })
      if (pruned > 0) this.log.info('delegate ledger pruned', { pruned, retentionMs })
    } catch (err) {
      this.log.warn('delegate ledger prune failed', {}, err as Error)
    }
  }
  this._delegateReapTimer = setInterval(tick, DELEGATE_REAP_INTERVAL_MS)
  this._delegateReapTimer.unref?.()
}

export function _delegateRunnerIdle(
  this: DelegateSupervisionHost,
  job: DelegateJobSnapshot,
): boolean {
  const store = this._delegateJobs
  if (!store) return false
  try {
    const session = job.sessionKey
      ? (this.sessions?.getByKey?.(job.sessionKey) as
          | {
              _activeTurnCount?: number
              _activeClientTurnCount?: number
            }
          | undefined)
      : undefined
    return isDelegateRunnerIdle(
      job,
      store,
      session
        ? {
            activeTurnCount: session._activeTurnCount ?? 0,
            activeClientTurnCount: session._activeClientTurnCount ?? 0,
          }
        : null,
    )
  } catch {
    return false
  }
}

export function _delegateChildAlive(
  this: DelegateSupervisionHost,
  sessionKey: string | undefined,
): boolean | undefined {
  if (!sessionKey) return undefined
  try {
    const session = this.sessions?.getByKey?.(sessionKey) as { runner?: unknown } | undefined
    if (session?.runner) return true
    return undefined
  } catch {
    return undefined
  }
}

/**
 * P2 债C — handleDelegateTask 的 HTTP-无关委派执行核心。
 *
 * 承接原 handleDelegateTask 的全部执行逻辑(深度/熔断/资源闸有界排队/session 创建/
 * submit/timeout/进度回传/团队卡缓冲),但以结构化 {@link RunDelegateInput} 入、
 * {@link DelegateTaskResult} 出,不碰 req/res。两个调用方:
 *   1. handleDelegateTask —— HTTP 委派端点(队长/成员经 delegate_task MCP 工具);
 *   2. dispatchInbound 的硬编排 review pass —— 队长 final 放行前直调,isReview:true。
 *
 * `isReview` 语义:走资源闸保留槽 + 免 per-parent 桶(审查不受某父 fan-out 挤占);
 * runLog 打 isReview;完成后从审查输出解析结构化 verdict 一并回带 + 落团队卡。
 */
export function _forgetEvictedDelegateResumes(this: DelegateSupervisionHost, keys: string[]): void {
  for (const key of keys) {
    try {
      this.sessions.forgetResume(key)
    } catch {
      // stub sessions in tests may omit forgetResume
    }
  }
}

export async function _completeDelegateResumeClaim(
  this: DelegateSupervisionHost,
  input: RunDelegateInput,
  sessionSpawned: boolean,
): Promise<void> {
  if (!input.resumable || !input.sessionKey) return
  const reg = this._delegateResume
  if (!reg) return
  if (!sessionSpawned) {
    reg.abort(input.sessionKey, input.resumeMinted === true)
    return
  }
  reg.markRetiring(input.sessionKey)
  if (input.backgroundControl) {
    const sessionKey = input.sessionKey
    await waitForStrictSessionCleanup(async () => {
      await this.sessions.retireKeepResume(sessionKey, { strictCleanup: true })
      if (this.sessions.hasLiveSession(sessionKey)) throw new Error('strict retirement still has a live session')
    }, error => this.log.warn('background delegate retirement pending cleanup ACK', { sessionKey, err: String(error) }))
    reg.release(sessionKey)
    return
  }
  try {
    await this.sessions.retireKeepResume(input.sessionKey)
  } catch (err) {
    this.log.warn('delegate session retireKeepResume failed', {
      sessionKey: input.sessionKey,
      err: String(err),
    })
  }
  // Occupancy stays until the live session is actually gone. If retire threw
  // before deleting the map entry, a second resume must still 409.
  const stillLive =
    typeof this.sessions.hasLiveSession === 'function' &&
    this.sessions.hasLiveSession(input.sessionKey)
  if (stillLive) return
  reg.release(input.sessionKey)
}

export async function _persistAndCloseDelegateJobs(this: DelegateSupervisionHost): Promise<void> {
  if (this._delegateReconcileTimer) {
    clearTimeout(this._delegateReconcileTimer)
    this._delegateReconcileTimer = undefined
  }
  if (this._delegateReapTimer) {
    clearInterval(this._delegateReapTimer)
    this._delegateReapTimer = undefined
  }
  if (this._notifyRetryTimer) {
    clearTimeout(this._notifyRetryTimer)
    this._notifyRetryTimer = undefined
  }
  if (isDelegateCutoverEffective() && this._delegateJobs) {
    try {
      await beginDelegateCutover(this._delegateJobs, {
        freezeBudgetMs: resolveDelegateCutoverFreezeMs(),
        isIdle: (job) => this._delegateRunnerIdle(job),
      })
    } catch (err) {
      this.log.error('delegate shutdown cutover freeze failed', undefined, err as Error)
    }
  }
  await this._persistInterruptedSendToAgentCallbacks()
  this._delegateJobs?.close()
  this._delegateJobs = undefined
  this._delegateInflightSurface?.close()
  this._delegateInflightSurface = undefined
}
