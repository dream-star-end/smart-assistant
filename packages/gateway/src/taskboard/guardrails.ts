// Taskboard 巡检护栏 —— 并发槽 / 预算 / 静默 / 熔断 / 循环 / 降频 / 急停。
//
// 设计意图:
//   没有这些,统一 tick 会在无人看着的时候安静烧钱。默认值全部读
//   GUARDRAIL_DEFAULTS,运行时被 tb_settings 覆盖;stage 上的
//   circuitBreakerThreshold / maxRunsPerDay / quietHours* 再覆盖全局。
//
//   七项护栏与实现入口:
//     1. 独立并发槽     tryAcquireSlot / releaseSlot / getActiveSlots
//     2. 每日预算       checkDailyBudget
//     3. 静默时段       checkQuietHours → patrolWindow.isInQuietHours
//     4. 连败熔断       evaluateCircuit / checkCircuitBreaker（半开自愈,不永久关巡检）
//     5. 单卡循环检测   checkStageLoop
//     6. 空转降频       IdleBackoffState.record / snapshot(给 shouldPatrol)
//     7. 全局急停       checkPatrolPaused
//
// 坑:
//   - 并发槽必须是**进程内计数器**,不能复用 delegate 全局 4 槽
//     (CORRECTIONS §2.3)。taskboard 默认 2,避免把用户对话饿死。
//   - 槽在 run 开始时 +1、finally -1;崩溃靠 lease 回收,槽会漏计到进程重启,
//     这是可接受的(进程都没了槽自然归零)。
//   - 预算触顶 / 熔断只**发出通知意图**,不在这里推微信。T10 接 onGuardrailAlert。
//   - 循环计数用 Ticket.stageLoopCount:每次 running→ready 且仍留在同一 stage
//     就 +1;换 stage 清零。超过 maxStageLoops → 强制 blocked,actor='system'。

import type { TaskboardSettings, TaskboardUsage } from './db/settings.js'
import { GUARDRAIL_DEFAULTS, type RunSkipReason, type TicketStatus } from './domain.js'
import { isInQuietHours } from './patrolWindow.js'

export type GuardrailAlertKind =
  | 'budget_exhausted'
  | 'circuit_open'
  | 'loop_guard'
  | 'patrol_paused'

/**
 * 护栏告警。T10 负责投递(微信 / 站内信瀑布);本层只构造稳定 outboundId。
 * 键约定见 CORRECTIONS §1.5:相同 outboundId 幂等,换 id 会双推。
 */
export interface GuardrailAlert {
  kind: GuardrailAlertKind
  outboundId: string
  message: string
  stageId?: string
  ticketId?: string
}

export type GuardrailAlertHandler = (alert: GuardrailAlert) => void

export function settingsFromDefaults(over: Partial<TaskboardSettings> = {}): TaskboardSettings {
  return {
    maxConcurrentRuns: over.maxConcurrentRuns ?? GUARDRAIL_DEFAULTS.maxConcurrentRuns,
    maxRunsPerDay: over.maxRunsPerDay ?? GUARDRAIL_DEFAULTS.maxRunsPerDay,
    maxCostPerDayUsd:
      over.maxCostPerDayUsd === undefined
        ? GUARDRAIL_DEFAULTS.maxCostPerDayUsd
        : over.maxCostPerDayUsd,
    quietHoursStart: over.quietHoursStart ?? GUARDRAIL_DEFAULTS.quietHoursStart,
    quietHoursEnd: over.quietHoursEnd ?? GUARDRAIL_DEFAULTS.quietHoursEnd,
    circuitBreakerThreshold:
      over.circuitBreakerThreshold ?? GUARDRAIL_DEFAULTS.circuitBreakerThreshold,
    maxStageLoops: over.maxStageLoops ?? GUARDRAIL_DEFAULTS.maxStageLoops,
    maxRunsPerTick: over.maxRunsPerTick ?? GUARDRAIL_DEFAULTS.maxRunsPerTick,
    patrolPaused: over.patrolPaused ?? false,
  }
}

function ymd(now: number): string {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── 1. 独立并发槽 ───────────────────────────────────────────────────────────

/**
 * taskboard 自建的进程内并发计数器。与 delegate 全局 4 槽无关。
 * 默认上限 2,可被 settings.maxConcurrentRuns 覆盖。
 */
export class PatrolSlotCounter {
  private active = 0
  constructor(private limit: number) {}

  getActive(): number {
    return this.active
  }

  getLimit(): number {
    return this.limit
  }

  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.trunc(limit))
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active += 1
    return true
  }

  release(): void {
    if (this.active > 0) this.active -= 1
  }

  /** 测试用:直接拨到指定占用。 */
  reset(active = 0): void {
    this.active = Math.max(0, active)
  }
}

export function checkConcurrency(
  slots: PatrolSlotCounter,
): { ok: true } | { ok: false; skipReason: RunSkipReason } {
  if (slots.getActive() >= slots.getLimit()) {
    return { ok: false, skipReason: 'concurrency_full' }
  }
  return { ok: true }
}

/** 进程内单例。tick 与 HTTP 手动巡检共用,测试用 resetSharedPatrolSlots 清零。 */
const sharedSlots = new PatrolSlotCounter(GUARDRAIL_DEFAULTS.maxConcurrentRuns)

export function getSharedPatrolSlots(): PatrolSlotCounter {
  return sharedSlots
}

export function resetSharedPatrolSlots(): void {
  sharedSlots.reset(0)
  sharedSlots.setLimit(GUARDRAIL_DEFAULTS.maxConcurrentRuns)
}

// ── 2. 每日预算 ─────────────────────────────────────────────────────────────

export function checkDailyBudget(
  usage: TaskboardUsage,
  settings: TaskboardSettings,
  now = Date.now(),
): { ok: true } | { ok: false; skipReason: RunSkipReason; alert: GuardrailAlert } {
  const runsHit = usage.runsToday >= settings.maxRunsPerDay
  const costHit =
    settings.maxCostPerDayUsd != null && usage.costTodayUsd >= settings.maxCostPerDayUsd
  if (!runsHit && !costHit) return { ok: true }
  const why = runsHit
    ? `今日 run 数 ${usage.runsToday} 已达上限 ${settings.maxRunsPerDay}`
    : `今日成本 $${usage.costTodayUsd.toFixed(4)} 已达上限 $${settings.maxCostPerDayUsd}`
  return {
    ok: false,
    skipReason: 'budget_exhausted',
    alert: {
      kind: 'budget_exhausted',
      outboundId: `taskboard-budget:${ymd(now)}`,
      message: `任务面板每日预算触顶,已自动暂停巡检。${why}。`,
    },
  }
}

// ── 3. 静默时段 ─────────────────────────────────────────────────────────────

export function checkQuietHours(
  at: Date,
  timezone: string,
  startHour: number,
  endHour: number,
): { ok: true } | { ok: false; skipReason: RunSkipReason } {
  if (isInQuietHours(at, timezone, startHour, endHour)) {
    return { ok: false, skipReason: 'outside_window' }
  }
  return { ok: true }
}

// ── 4. 连败熔断(闭路 / 开路 / 半开)─────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface EvaluateCircuitInput {
  consecutiveFailures: number
  threshold: number
  stageId: string
  now?: number
  /** 最近一次失败/超时的完成时刻。缺省视为刚刚失败。 */
  lastFailureAt?: number | null
  cooldownMs?: number
  /** 已有半开试探 run 在跑时,不再派第二条。 */
  halfOpenInFlight?: boolean
}

export type CircuitVerdict =
  | { ok: true; state: CircuitState }
  | { ok: false; state: CircuitState; skipReason: RunSkipReason; alert?: GuardrailAlert }

export function resolveCircuitCooldownMs(over?: number): number {
  if (typeof over === 'number' && Number.isFinite(over) && over >= 0) return over
  const raw = process.env.OPENCLAUDE_TASKBOARD_CIRCUIT_COOLDOWN_MS
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return GUARDRAIL_DEFAULTS.circuitCooldownMs
}

function circuitAlert(
  stageId: string,
  consecutiveFailures: number,
  threshold: number,
  now: number,
): GuardrailAlert {
  return {
    kind: 'circuit_open',
    outboundId: `taskboard-fuse:${stageId}:${ymd(now)}`,
    message: `阶段 ${stageId} 连续失败 ${consecutiveFailures} 次,已达到熔断阈值 ${threshold}。巡检已熔断,冷却后将自动试探恢复。`,
    stageId,
  }
}

/**
 * 半开熔断:
 *   closed    连败未达阈值,放行
 *   open      已跳闸且仍在冷却,拒绝新 run
 *   half_open 冷却到期:无在途试探则放行恰好 1 次;已有在途试探则继续挡住
 * 成功一次即闭合(连败计数归零);试探失败则 lastFailureAt 刷新,重新冷却。
 */
export function evaluateCircuit(input: EvaluateCircuitInput): CircuitVerdict {
  const now = input.now ?? Date.now()
  if (input.consecutiveFailures < input.threshold) {
    return { ok: true, state: 'closed' }
  }
  const cooldownMs = resolveCircuitCooldownMs(input.cooldownMs)
  const failedAt = input.lastFailureAt ?? now
  const elapsed = now - failedAt
  if (elapsed < cooldownMs) {
    return {
      ok: false,
      state: 'open',
      skipReason: 'circuit_open',
      alert: circuitAlert(input.stageId, input.consecutiveFailures, input.threshold, now),
    }
  }
  if (input.halfOpenInFlight) {
    return { ok: false, state: 'half_open', skipReason: 'circuit_open' }
  }
  return { ok: true, state: 'half_open' }
}

/** 阈值判定(无冷却)。保留给只关心「连败是否触顶」的调用方。 */
export function checkCircuitBreaker(
  consecutiveFailures: number,
  threshold: number,
  stageId: string,
  now = Date.now(),
): { ok: true } | { ok: false; skipReason: RunSkipReason; alert: GuardrailAlert } {
  const verdict = evaluateCircuit({
    consecutiveFailures,
    threshold,
    stageId,
    now,
    lastFailureAt: now,
    cooldownMs: Number.POSITIVE_INFINITY,
    halfOpenInFlight: false,
  })
  if (verdict.ok) return { ok: true }
  return { ok: false, skipReason: verdict.skipReason, alert: verdict.alert! }
}

// ── 5. 单卡循环检测 ─────────────────────────────────────────────────────────

export function checkStageLoop(
  stageLoopCount: number,
  maxStageLoops: number,
  ticketId: string,
  stageId: string,
): { ok: true } | { ok: false; skipReason: RunSkipReason; alert: GuardrailAlert } {
  if (stageLoopCount < maxStageLoops) return { ok: true }
  return {
    ok: false,
    skipReason: 'loop_guard',
    alert: {
      kind: 'loop_guard',
      outboundId: `taskboard-loop:${ticketId}:${stageId}`,
      message: `单据在阶段 ${stageId} 已循环 ${stageLoopCount} 次,超过上限 ${maxStageLoops},已强制标记受阻。`,
      ticketId,
      stageId,
    },
  }
}

/** running→ready 且仍留在同一 stage 时 +1;换 stage 清零。 */
export function nextStageLoopCount(current: number, stayedOnSameStage: boolean): number {
  return stayedOnSameStage ? current + 1 : 0
}

/**
 * 两条推进路径(HTTP advance / 巡检 applySuccess)共用:
 * 换站清零;留在本站且回到 ready 则 +1;等确认等非 ready 保持原值。
 */
export function stageLoopCountOnProgress(
  currentCount: number,
  fromStageId: string | null,
  toStageId: string | null,
  toStatus: TicketStatus,
): number {
  if (toStageId !== fromStageId) return 0
  if (toStatus === 'ready') return currentCount + 1
  return currentCount
}

// ── 6. 空转降频 ─────────────────────────────────────────────────────────────

export interface IdleSnapshot {
  idleTicks: number
  lastPatrolAt: Date | null
}

/**
 * 每个 stage 一份空转计数。tick 在「本轮 shouldPatrol=true 但零候选」时
 * recordIdle;有候选并实际开跑时 recordBusy(清零)。
 * lastPatrolAt 只在 shouldPatrol 返回 true 时更新,与 patrolWindow 约定一致。
 */
export class IdleBackoffState {
  private readonly byStage = new Map<string, IdleSnapshot>()

  snapshot(stageId: string): IdleSnapshot {
    return this.byStage.get(stageId) ?? { idleTicks: 0, lastPatrolAt: null }
  }

  markPatrolAttempt(stageId: string, at: Date): void {
    const cur = this.snapshot(stageId)
    this.byStage.set(stageId, { idleTicks: cur.idleTicks, lastPatrolAt: at })
  }

  recordIdle(stageId: string, at: Date): IdleSnapshot {
    const cur = this.snapshot(stageId)
    const next = { idleTicks: cur.idleTicks + 1, lastPatrolAt: at }
    this.byStage.set(stageId, next)
    return next
  }

  recordBusy(stageId: string, at: Date): IdleSnapshot {
    const next = { idleTicks: 0, lastPatrolAt: at }
    this.byStage.set(stageId, next)
    return next
  }

  reset(stageId?: string): void {
    if (stageId) this.byStage.delete(stageId)
    else this.byStage.clear()
  }
}

// ── 7. 全局急停 ─────────────────────────────────────────────────────────────

export function checkPatrolPaused(
  settings: TaskboardSettings,
): { ok: true } | { ok: false; skipReason: 'patrol_disabled' } {
  if (settings.patrolPaused) return { ok: false, skipReason: 'patrol_disabled' }
  return { ok: true }
}

/** 发出告警。handler 缺省为空操作(T10 接真实投递)。同一 outboundId 由投递层幂等。 */
export function emitGuardrailAlert(
  handler: GuardrailAlertHandler | undefined,
  alert: GuardrailAlert,
): void {
  try {
    handler?.(alert)
  } catch {
    /* 通知失败不能砸 tick */
  }
}
