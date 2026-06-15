/**
 * B7 — account-pool per-slot 租约泄漏回收 sweeper。
 *
 * 设计(镜像 pendingOrdersExpirer 的 SweeperHandle 模式):
 *   - 60s interval setInterval,timer.unref() 不阻止进程退出
 *   - 每 tick 调 scheduler.reapExpiredSlots() —— 回收 acquiredAt 早于 now-TTL 的租约
 *   - 同步、纯进程内,无 DB/网络;失败(理论不会)console.warn 不抛
 *   - 回收数 > 0 时 log `account_slot_reaped`(ops 监测泄漏率)
 *   - runOnStart 默认 false:slots Map 在 boot 时为空,无历史脏态可清(与
 *     pendingOrdersExpirer 不同 —— 那个要清 DB 历史脏单)
 *
 * 修复对象:
 *   Claude 聊天代理路径在进程存活期间若某次 release 路径丢失/未执行(abort 漏接、
 *   finalizer 异常吞掉等),该 slot 永不自愈 → 账号被误判 per-account cap → 虚假 429。
 *   Codex 侧已有 bridge 600s timer 兜底,本 reaper 是统一二级网(两路通用)。
 *   TTL 下界 max(CODEX_SESSION_MAX_MS,30min) 保证不抢在 Codex bridge timer 之前
 *   误回收活跃 turn。详见 docs/B6B7_ACCOUNT_SLOT_LEASE_DESIGN.md。
 */

export const DEFAULT_INTERVAL_MS = 60_000
export const MIN_INTERVAL_MS = 1000

/** 本 sweeper 只依赖 scheduler 的 reapExpiredSlots —— 窄接口便于测试注入。 */
export interface SlotReapable {
  reapExpiredSlots(nowMs?: number): number
}

export interface SlotReaperHandle {
  stop(): void
  /** 测试用:立即跑一次回收,返回回收的 slot 数。 */
  runNow(): number
}

export interface SlotReaperOptions {
  scheduler: SlotReapable
  intervalMs?: number
  /** 默认 false:boot 时 slots 为空,无需立即跑。 */
  runOnStart?: boolean
  onError?: (err: unknown) => void
  /** 注入 logger(默认 console.log JSON 行)。 */
  log?: (reaped: number) => void
}

function defaultLog(reaped: number): void {
  // eslint-disable-next-line no-console -- ops scrape 关键字 account_slot_reaped
  console.log(JSON.stringify({ evt: 'account_slot_reaped', reaped }))
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[accountSlotReaper] reap failed:', err)
}

/**
 * 启动 slot reaper sweeper。返回 handle 可调 stop()。
 */
export function startAccountSlotReaper(opts: SlotReaperOptions): SlotReaperHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  const onError = opts.onError ?? defaultOnError
  const log = opts.log ?? defaultLog
  const runOnStart = opts.runOnStart ?? false
  let stopped = false

  function runOneTick(): number {
    try {
      const reaped = opts.scheduler.reapExpiredSlots()
      if (reaped > 0) log(reaped)
      return reaped
    } catch (err) {
      onError(err)
      return 0
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    runOneTick()
  }, interval)
  if (typeof timer.unref === 'function') timer.unref()

  if (runOnStart) runOneTick()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
