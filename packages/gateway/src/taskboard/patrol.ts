// Taskboard 统一 60s tick 引擎 + run 执行 + 状态推进。
//
// 设计意图:
//   不给每个 stage 建 cron job(会撞 CronScheduler 的 50 job / 12 次每小时上限)。
//   一个 setInterval(60s) 扫全部 patrolEnabled 的 stage,用 patrolWindow.shouldPatrol
//   判断本轮是否到点,再对 status=ready 的票做过滤 → 取 lease → 同进程直调
//   delegate → 按 on_success / on_failure 经 stateMachine 迁移。
//
// 执行落地(CORRECTIONS §1.3 §1.4 §2.1):
//   - 同进程 PatrolDelegateFn,生产里包一层 Gateway._runDelegateTask。
//     不要打 HTTP,只有同进程拿得到 timedOut。
//   - sessionKey 必须 buildPatrolSessionKey() =
//     `agent:<agentId>:taskboard:<ticketId>:<stageId>:<runId>`。
//     裸 `taskboard:...` 会被当成聊天会话长留内存。
//   - 绝对不要把 taskboard 加进 MASTER_SINK_PERSIST_CHANNELS。
//
// skipped run 落库策略:
//   被跳过的**候选票**写 status=skipped + skipReason,这是前端「为什么这张卡没动」
//   的唯一可解释来源。但 60s tick × 每张 ready 卡会淹没时间线,所以:
//     同一 ticket + 同一 stage + 同一 skipReason,本地日历日只落 **一条**。
//   阶段级未到点(cron / 静默 / 空转降频 / 急停)不写 per-ticket skipped ——
//   那不是「这张卡被拒绝」,是「这轮根本没巡这站」。
//
// 坑:
//   - lease TTL 必须 > 45min 硬超时(用 GUARDRAIL_DEFAULTS.leaseTtlMs=50min)。
//   - 状态转移一律 assertTransition,actor 用 agent;熔断/循环/回收用 system。
//   - 并发槽是本模块的 PatrolSlotCounter,与 delegate 全局 4 槽无关。
//   - tick 里的 timer 由 server.ts 持有并 unref/clearInterval;本文件不自己
//     setInterval,以便测试进程能退出。

import { createActivity } from './db/activity.js'
import { createComment, listComments } from './db/comments.js'
import type { TaskboardDb } from './db/index.js'
import { getStage, listStages, updateStage } from './db/pipelines.js'
import { listRelations } from './db/relations.js'
import {
  acquireLease,
  getActiveLease,
  getRun,
  insertRun,
  listRuns,
  reapExpiredLeases,
  releaseLease,
  updateRun,
} from './db/runs.js'
import {
  type TaskboardSettings,
  countConsecutiveStageFailures,
  countTicketStageRunsToday,
  getSettings,
  getUsage,
  hasSkippedRunToday,
  updateSettings,
} from './db/settings.js'
import { getTicket, listTickets, updateTicket } from './db/tickets.js'
import {
  type Actor,
  GUARDRAIL_DEFAULTS,
  type PipelineStage,
  type RunSkipReason,
  type RunTrigger,
  type Ticket,
  type TicketComment,
  type TicketPriority,
  type TicketRun,
  type TicketStatus,
  buildPatrolSessionKey,
} from './domain.js'
import { evaluateEntryCondition, parseEntryCondition } from './entryCondition.js'
import {
  type GuardrailAlert,
  type GuardrailAlertHandler,
  IdleBackoffState,
  type PatrolSlotCounter,
  checkCircuitBreaker,
  checkDailyBudget,
  checkPatrolPaused,
  checkStageLoop,
  emitGuardrailAlert,
  getSharedPatrolSlots,
  nextStageLoopCount,
  resetSharedPatrolSlots,
} from './guardrails.js'
import { type TaskboardNotifyHooks, fireNotify } from './notify.js'
import { shouldPatrol } from './patrolWindow.js'
import { renderPrompt } from './promptRender.js'
import { assertTransition } from './stateMachine.js'

const PRIORITY_RANK: Record<TicketPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
const TERMINAL = new Set(['done', 'canceled'])
const SUMMARY_MAX = 400

export interface PatrolDelegateInput {
  agentId: string
  goal: string
  context?: string
  toolsets?: string[] | null
  effort?: string | null
  sessionKey: string
  timeoutSec: number
}

export interface PatrolDelegateResult {
  ok: boolean
  output: string
  error?: string
  timedOut?: boolean
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
}

export type PatrolDelegateFn = (input: PatrolDelegateInput) => Promise<PatrolDelegateResult>

export interface PatrolEngineOptions {
  getDb: () => TaskboardDb
  delegate: PatrolDelegateFn
  now?: () => number
  onAlert?: GuardrailAlertHandler
  /** 待确认 / 每日简报。熔断走 onAlert → notifier.onGuardrailAlert。 */
  notify?: TaskboardNotifyHooks
  /** 测试注入,避免共用进程级槽位。生产省略则用模块单例。 */
  slots?: PatrolSlotCounter
  idle?: IdleBackoffState
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export interface TickReport {
  reaped: number
  paused: boolean
  started: number
  skipped: number
  settled: number
}

const sharedIdle = new IdleBackoffState()

export function resetSharedPatrolState(): void {
  resetSharedPatrolSlots()
  sharedIdle.reset()
}

export class PatrolEngine {
  readonly slots: PatrolSlotCounter
  readonly idle: IdleBackoffState
  private readonly getDb: () => TaskboardDb
  private readonly delegate: PatrolDelegateFn
  private readonly nowFn: () => number
  private readonly onAlert?: GuardrailAlertHandler
  private readonly notify?: TaskboardNotifyHooks
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void
  private ticking = false

  constructor(opts: PatrolEngineOptions) {
    this.getDb = opts.getDb
    this.delegate = opts.delegate
    this.nowFn = opts.now ?? Date.now
    this.onAlert = opts.onAlert
    this.notify = opts.notify
    this.slots = opts.slots ?? getSharedPatrolSlots()
    this.idle = opts.idle ?? sharedIdle
    this.log = opts.log ?? (() => {})
  }

  /**
   * 一轮巡检。单飞:上一轮还在跑则本轮空过,避免 60s 重叠把同一张卡排队两次。
   * 测试直接调这个,不要真开 setInterval。
   */
  async tick(at?: Date): Promise<TickReport> {
    const empty: TickReport = { reaped: 0, paused: false, started: 0, skipped: 0, settled: 0 }
    if (this.ticking) return empty
    this.ticking = true
    try {
      return await this.tickOnce(at ?? new Date(this.nowFn()))
    } finally {
      this.ticking = false
    }
  }

  /**
   * HTTP 手动巡检已经 claim 过,这里只跑 agent 并收尾。
   * 槽满仍执行:用户已经拿到 202,不能把票留在 running;HTTP 层事先用
   * activeRuns / 槽位做了 429。tryAcquire 成功则计入槽,失败就裸跑。
   */
  async executeJob(job: {
    ticketId: string
    runId: string
    stageId: string
    agentId: string | null
    sessionKey: string
  }): Promise<void> {
    const db = this.getDb()
    const ticket = getTicket(db, job.ticketId)
    const stage = getStage(db, job.stageId)
    const run = getRun(db, job.runId)
    if (!ticket || !stage || !run) return
    const settings = getSettings(db)
    this.slots.setLimit(settings.maxConcurrentRuns)
    const acquired = this.slots.tryAcquire()
    try {
      await this.runClaimed(db, ticket, stage, run, settings)
    } finally {
      if (acquired) this.slots.release()
    }
  }

  private async tickOnce(at: Date): Promise<TickReport> {
    const db = this.getDb()
    const now = at.getTime()
    const settings = getSettings(db)
    this.slots.setLimit(settings.maxConcurrentRuns)

    try {
      return await this.tickOnceInner(db, at, now, settings)
    } finally {
      fireNotify(
        () => this.notify?.onDigestTick({ db, at, settings }),
        this.log,
        'taskboard digest notify failed',
      )
    }
  }

  private async tickOnceInner(
    db: TaskboardDb,
    at: Date,
    now: number,
    settings: TaskboardSettings,
  ): Promise<TickReport> {
    const reaped = this.recoverExpired(db, now)

    const paused = checkPatrolPaused(settings)
    if (!paused.ok) {
      return { reaped, paused: true, started: 0, skipped: 0, settled: 0 }
    }

    const usage = getUsage(db, now)
    const budget = checkDailyBudget(usage, settings, now)
    if (!budget.ok) {
      emitGuardrailAlert(this.onAlert, budget.alert)
      updateSettings(db, { patrolPaused: true })
      return { reaped, paused: true, started: 0, skipped: 0, settled: 0 }
    }

    const stages = listPatrolEnabledStages(db)
    let started = 0
    let skipped = 0
    let settled = 0
    const jobs: Promise<void>[] = []

    for (const stage of stages) {
      const idleSnap = this.idle.snapshot(stage.id)
      const verdict = shouldPatrol(
        {
          ...stage,
          quietHoursStart: stage.quietHoursStart ?? settings.quietHoursStart,
          quietHoursEnd: stage.quietHoursEnd ?? settings.quietHoursEnd,
        },
        at,
        idleSnap.lastPatrolAt,
        idleSnap.idleTicks,
      )
      if (!verdict.patrol) continue

      this.idle.markPatrolAttempt(stage.id, at)

      const threshold = stage.circuitBreakerThreshold || settings.circuitBreakerThreshold
      const fails = countConsecutiveStageFailures(db, stage.id)
      const circuit = checkCircuitBreaker(fails, threshold, stage.id, now)
      if (!circuit.ok) {
        this.tripCircuit(db, stage, circuit.alert)
        skipped += this.skipReadyTickets(db, stage, 'circuit_open', now)
        continue
      }

      const picked = this.collectCandidates(db, stage, settings, now)
      skipped += picked.skipped
      if (picked.runnable.length === 0) {
        this.idle.recordIdle(stage.id, at)
        continue
      }
      this.idle.recordBusy(stage.id, at)

      for (const ticket of picked.runnable) {
        if (started >= settings.maxRunsPerTick) break
        const inflight = Math.max(this.slots.getActive(), getUsage(db, now).activeRuns)
        if (inflight >= settings.maxConcurrentRuns || !this.slots.tryAcquire()) {
          skipped += this.recordSkip(db, ticket, stage, 'concurrency_full') ? 1 : 0
          continue
        }
        let claimed: TicketRun
        try {
          claimed = this.claimTicket(db, ticket, stage, now)
        } catch (err) {
          this.slots.release()
          this.log('taskboard claim failed', { ticketId: ticket.id, err: String(err) })
          continue
        }
        started += 1
        const fresh = getTicket(db, ticket.id) as Ticket
        jobs.push(
          this.runClaimed(db, fresh, stage, claimed, settings)
            .then(() => {
              settled += 1
            })
            .catch((err) => {
              this.log('taskboard run failed', { ticketId: ticket.id, err: String(err) })
            })
            .finally(() => this.slots.release()),
        )
      }
    }

    await Promise.all(jobs)
    return { reaped, paused: false, started, skipped, settled }
  }

  private recoverExpired(db: TaskboardDb, now: number): number {
    const reaped = reapExpiredLeases(db, now)
    for (const run of reaped) {
      const ticket = getTicket(db, run.ticketId)
      if (!ticket || ticket.status !== 'running') continue
      const stage = ticket.stageId ? getStage(db, ticket.stageId) : null
      try {
        assertTransition({
          from: 'running',
          to: 'ready',
          actor: 'system',
          stageOnSuccess: stage?.onSuccess === 'wait_human' ? 'stay' : (stage?.onSuccess ?? 'stay'),
          autoClose: stage?.autoClose,
        })
        updateTicket(db, ticket.id, ticket.version, { status: 'ready' })
        recordActivity(
          db,
          ticket.id,
          'system',
          'system',
          'status_changed',
          'status',
          'running',
          'ready',
        )
      } catch (err) {
        this.log('taskboard reap transition failed', { ticketId: ticket.id, err: String(err) })
      }
    }
    return reaped.length
  }

  private collectCandidates(
    db: TaskboardDb,
    stage: PipelineStage,
    settings: TaskboardSettings,
    now: number,
  ): { runnable: Ticket[]; skipped: number } {
    if (stage.kind !== 'ai') return { runnable: [], skipped: 0 }
    const listed = listTickets(db, { status: 'ready', stageId: stage.id, limit: 200, offset: 0 })
    const runnable: Ticket[] = []
    let skipped = 0
    for (const ticket of listed.items) {
      const reason = this.classifySkip(db, ticket, stage, settings, now)
      if (reason) {
        skipped += this.recordSkip(db, ticket, stage, reason) ? 1 : 0
        if (reason === 'loop_guard') {
          this.forceBlocked(db, ticket, stage, settings, '单卡循环超过上限,强制受阻')
        }
        continue
      }
      runnable.push(ticket)
    }
    runnable.sort((a, b) => {
      const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (pr !== 0) return pr
      return a.createdAt - b.createdAt
    })
    return { runnable, skipped }
  }

  private classifySkip(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    settings: TaskboardSettings,
    now: number,
  ): RunSkipReason | null {
    if (hasOpenBlockers(db, ticket.id)) return 'blocked_by_dependency'
    if (countTicketStageRunsToday(db, ticket.id, stage.id, now) >= stage.maxRunsPerDay) {
      return 'daily_quota'
    }
    if (getActiveLease(db, ticket.id, now)) return 'lease_held'
    const loop = checkStageLoop(ticket.stageLoopCount, settings.maxStageLoops, ticket.id, stage.id)
    if (!loop.ok) {
      emitGuardrailAlert(this.onAlert, loop.alert)
      return 'loop_guard'
    }
    if (!entrySatisfied(db, ticket, stage)) return 'entry_condition'
    return null
  }

  private claimTicket(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    now: number,
  ): TicketRun {
    const owner = stage.agentId ? `agent:${stage.agentId}` : 'agent:taskboard'
    assertTransition({
      from: ticket.status,
      to: 'running',
      actor: 'agent',
      hasLease: true,
      autoClose: stage.autoClose,
    })
    const run = acquireLease(db, ticket.id, stage.id, owner, GUARDRAIL_DEFAULTS.leaseTtlMs, {
      agentId: stage.agentId,
      trigger: 'patrol',
      now,
    })
    const agentId = run.agentId ?? stage.agentId ?? 'unknown'
    const sessionKey = buildPatrolSessionKey(agentId, ticket.id, stage.id, run.id)
    const withKey = updateRun(db, run.id, { sessionKey })
    updateTicket(db, ticket.id, ticket.version, { status: 'running' })
    recordActivity(
      db,
      ticket.id,
      'agent',
      owner,
      'status_changed',
      'status',
      ticket.status,
      'running',
    )
    return withKey
  }

  private async runClaimed(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    run: TicketRun,
    settings: TaskboardSettings,
  ): Promise<void> {
    const agentId = run.agentId ?? stage.agentId ?? 'unknown'
    const sessionKey = run.sessionKey ?? buildPatrolSessionKey(agentId, ticket.id, stage.id, run.id)
    if (!run.sessionKey) updateRun(db, run.id, { sessionKey })

    const comments = listComments(db, ticket.id, { limit: 200, offset: 0 })
    const lastRun = latestSettledRun(db, ticket.id, run.id)
    let prompt: string
    try {
      prompt = renderPrompt({
        template: stage.promptTemplate,
        ticket,
        stage,
        lastRun,
        comments,
      }).prompt
    } catch (err) {
      await this.finishRun(db, ticket, stage, run, settings, {
        ok: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    let result: PatrolDelegateResult
    try {
      result = await this.delegate({
        agentId,
        goal: prompt,
        toolsets: stage.toolsets,
        effort: stage.effort,
        sessionKey,
        timeoutSec: stage.timeoutSec,
      })
    } catch (err) {
      result = {
        ok: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    await this.finishRun(db, ticket, stage, run, settings, result)
  }

  private async finishRun(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    run: TicketRun,
    settings: TaskboardSettings,
    result: PatrolDelegateResult,
  ): Promise<void> {
    const now = this.nowFn()
    const timedOut = result.timedOut === true
    const ok = result.ok && !timedOut && !result.error
    const output = result.output ?? ''
    const summary = summarize(output)
    const status = timedOut ? 'timeout' : ok ? 'succeeded' : 'failed'
    const error = timedOut
      ? (result.error ?? 'delegate timed out')
      : ok
        ? null
        : (result.error ?? 'delegate failed')

    try {
      releaseLease(db, run.id)
    } catch {
      /* 已过期或已释放 */
    }
    updateRun(db, run.id, {
      status,
      summary,
      outputMd: output || null,
      error,
      finishedAt: now,
      durationMs: run.startedAt != null ? now - run.startedAt : null,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      costUsd: result.costUsd ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })

    if (summary) {
      createComment(db, {
        ticketId: ticket.id,
        authorKind: 'agent',
        author: run.agentId ? `agent:${run.agentId}` : 'agent:taskboard',
        body: summary,
        runId: run.id,
      })
    }

    const current = getTicket(db, ticket.id)
    if (!current || current.status !== 'running') return

    if (ok) {
      this.applySuccess(db, current, stage, settings, run)
    } else {
      this.applyFailure(db, current, stage, settings, error ?? 'failed', run)
    }
  }

  private applySuccess(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    settings: TaskboardSettings,
    run: TicketRun,
  ): void {
    const nxt = nextStageOf(db, stage)
    if (stage.onSuccess === 'wait_human') {
      this.transition(db, ticket, 'waiting_human', 'agent', stage, { stageId: ticket.stageId }, run)
      return
    }
    if (stage.onSuccess === 'stay') {
      const loops = nextStageLoopCount(ticket.stageLoopCount, true)
      if (!this.guardLoop(db, ticket, stage, settings, loops)) return
      this.transition(db, ticket, 'ready', 'agent', stage, {
        stageId: ticket.stageId,
        stageLoopCount: loops,
        stageOnSuccess: 'stay',
      })
      return
    }
    // advance
    if (!nxt) {
      if (stage.autoClose) {
        this.transition(db, ticket, 'done', 'agent', stage, { closedAt: this.nowFn() })
        return
      }
      this.transition(db, ticket, 'waiting_human', 'agent', stage, {}, run)
      return
    }
    if (nxt.kind !== 'ai') {
      this.transition(
        db,
        ticket,
        'waiting_human',
        'agent',
        stage,
        {
          stageId: nxt.id,
          stageLoopCount: 0,
        },
        run,
      )
      return
    }
    this.transition(db, ticket, 'ready', 'agent', stage, {
      stageId: nxt.id,
      stageLoopCount: 0,
    })
  }

  private applyFailure(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    settings: TaskboardSettings,
    error: string,
    run: TicketRun,
  ): void {
    const threshold = stage.circuitBreakerThreshold || settings.circuitBreakerThreshold
    const fails = countConsecutiveStageFailures(db, stage.id)
    const circuit = checkCircuitBreaker(fails, threshold, stage.id, this.nowFn())
    if (!circuit.ok) this.tripCircuit(db, stage, circuit.alert)

    if (stage.onFailure === 'wait_human') {
      this.transition(db, ticket, 'waiting_human', 'agent', stage, {}, run)
      return
    }
    if (stage.onFailure === 'retry') {
      const loops = nextStageLoopCount(ticket.stageLoopCount, true)
      if (!this.guardLoop(db, ticket, stage, settings, loops)) return
      this.transition(db, ticket, 'ready', 'agent', stage, {
        stageId: ticket.stageId,
        stageLoopCount: loops,
        stageOnSuccess: 'stay',
      })
      return
    }
    this.transition(db, ticket, 'blocked', 'agent', stage, { blockedReason: error })
  }

  private guardLoop(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    settings: TaskboardSettings,
    loops: number,
  ): boolean {
    const check = checkStageLoop(loops, settings.maxStageLoops, ticket.id, stage.id)
    if (check.ok) return true
    emitGuardrailAlert(this.onAlert, check.alert)
    this.forceBlocked(db, ticket, stage, settings, check.alert.message)
    return false
  }

  private forceBlocked(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    _settings: TaskboardSettings,
    reason: string,
  ): void {
    const current = getTicket(db, ticket.id) ?? ticket
    if (current.status === 'blocked' || TERMINAL.has(current.status)) return
    try {
      assertTransition({
        from: current.status,
        to: 'blocked',
        actor: 'system',
        autoClose: stage.autoClose,
        stageOnSuccess: stage.onSuccess,
      })
      updateTicket(db, current.id, current.version, { status: 'blocked', blockedReason: reason })
      recordActivity(
        db,
        current.id,
        'system',
        'system',
        'status_changed',
        'status',
        current.status,
        'blocked',
      )
    } catch (err) {
      this.log('taskboard force-block failed', { ticketId: current.id, err: String(err) })
    }
  }

  private tripCircuit(db: TaskboardDb, stage: PipelineStage, alert: GuardrailAlert): void {
    emitGuardrailAlert(this.onAlert, alert)
    if (stage.patrolEnabled) {
      updateStage(db, stage.id, { patrolEnabled: false })
    }
  }

  private transition(
    db: TaskboardDb,
    ticket: Ticket,
    to: TicketStatus,
    actor: Actor,
    stage: PipelineStage,
    patch: {
      stageId?: string | null
      stageLoopCount?: number
      blockedReason?: string | null
      closedAt?: number | null
      /** 失败重试 / stay 必须显式传 stay,不能借用 stage.onSuccess=wait_human。 */
      stageOnSuccess?: import('./domain.js').OnSuccessAction
    },
    run?: TicketRun,
  ): void {
    const current = getTicket(db, ticket.id) ?? ticket
    const { stageOnSuccess, ...ticketPatch } = patch
    assertTransition({
      from: current.status,
      to,
      actor,
      stageOnSuccess: stageOnSuccess ?? stage.onSuccess,
      autoClose: stage.autoClose,
    })
    updateTicket(db, current.id, current.version, { status: to, ...ticketPatch })
    recordActivity(
      db,
      current.id,
      actor,
      actor === 'agent' ? (stage.agentId ? `agent:${stage.agentId}` : 'agent:taskboard') : 'system',
      to === 'ready' && patch.stageId && patch.stageId !== current.stageId
        ? 'stage_advanced'
        : 'status_changed',
      'status',
      current.status,
      to,
    )
    if (to === 'waiting_human' && run) {
      const fresh = getTicket(db, current.id) ?? { ...current, status: to }
      fireNotify(
        () => this.notify?.onWaitingHuman({ ticket: fresh, run, stage }),
        this.log,
        'taskboard await notify failed',
        { ticketId: current.id, runId: run.id },
      )
    }
  }

  private skipReadyTickets(
    db: TaskboardDb,
    stage: PipelineStage,
    reason: RunSkipReason,
    _now: number,
  ): number {
    const listed = listTickets(db, { status: 'ready', stageId: stage.id, limit: 200, offset: 0 })
    let n = 0
    for (const ticket of listed.items) {
      if (this.recordSkip(db, ticket, stage, reason)) n += 1
    }
    return n
  }

  private recordSkip(
    db: TaskboardDb,
    ticket: Ticket,
    stage: PipelineStage,
    reason: RunSkipReason,
    trigger: RunTrigger = 'patrol',
  ): boolean {
    if (hasSkippedRunToday(db, ticket.id, stage.id, reason, this.nowFn())) return false
    insertRun(db, {
      ticketId: ticket.id,
      stageId: stage.id,
      agentId: stage.agentId,
      trigger,
      status: 'skipped',
      skipReason: reason,
      startedAt: this.nowFn(),
    })
    return true
  }
}

function listPatrolEnabledStages(db: TaskboardDb): PipelineStage[] {
  const rows = db.prepare('SELECT id FROM tb_pipeline_stage WHERE patrol_enabled = 1').all() as {
    id: string
  }[]
  const out: PipelineStage[] = []
  for (const row of rows) {
    const stage = getStage(db, row.id)
    if (stage) out.push(stage)
  }
  return out
}

function nextStageOf(db: TaskboardDb, stage: PipelineStage): PipelineStage | null {
  const stages = listStages(db, stage.pipelineId)
  return stages.find((s) => s.ordinal > stage.ordinal) ?? null
}

/** A blocks B ⇒ from=A to=B。B 在 A 未终态时被挡住。 */
export function hasOpenBlockers(db: TaskboardDb, ticketId: string): boolean {
  const rels = listRelations(db, ticketId)
  for (const rel of rels) {
    if (rel.kind !== 'blocks' || rel.toTicketId !== ticketId) continue
    const blocker = getTicket(db, rel.fromTicketId)
    if (blocker && !TERMINAL.has(blocker.status)) return true
  }
  return false
}

function entrySatisfied(db: TaskboardDb, ticket: Ticket, stage: PipelineStage): boolean {
  const parsed = parseEntryCondition(stage.entryCondition)
  if (!parsed.ok) return false
  const comments = listComments(db, ticket.id, { limit: 200, offset: 0 })
  const kinds = [...new Set(comments.map((c: TicketComment) => c.authorKind))]
  const last = latestSettledRun(db, ticket.id)
  return evaluateEntryCondition(parsed.ast, {
    body: ticket.body,
    labels: ticket.labels,
    hasOpenBlockers: hasOpenBlockers(db, ticket.id),
    commentAuthorKinds: kinds,
    priority: ticket.priority,
    lastRunSucceeded: last ? last.status === 'succeeded' : null,
  })
}

function latestSettledRun(db: TaskboardDb, ticketId: string, exceptId?: string): TicketRun | null {
  const { items } = listRuns(db, { ticketId, limit: 20, offset: 0 })
  return (
    items.find(
      (r) =>
        r.id !== exceptId &&
        (r.status === 'succeeded' || r.status === 'failed' || r.status === 'timeout'),
    ) ?? null
  )
}

function summarize(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return '（无文本产出）'
  const firstPara = trimmed
    .split(/\n{2,}/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (firstPara.length <= SUMMARY_MAX) return firstPara
  return `${firstPara.slice(0, SUMMARY_MAX)}…`
}

function recordActivity(
  db: TaskboardDb,
  ticketId: string,
  actor: Actor,
  actorId: string,
  action: string,
  field?: string | null,
  fromValue?: string | null,
  toValue?: string | null,
): void {
  createActivity(db, { ticketId, actor, actorId, action, field, fromValue, toValue })
}
