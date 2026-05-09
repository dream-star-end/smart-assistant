/**
 * cooldownRecoveryActor — 周期性把已过冷却期的账号从 cooldown 半开恢复到 active。
 *
 * **背景**:`AccountHealthTracker.halfOpen()` 写好了恢复路径(扫
 * `claude_accounts WHERE status='cooldown' AND cooldown_until < NOW()` →
 * `status='active' + health=50 + clear cooldown_until`),但全仓没有任何代码周期性
 * 调用它。结果:连续失败把账号烧到 cooldown 后,只能靠 admin `recoverFromCooldown`
 * 手工救,或 manualEnable 兜底 —— 自动恢复路径事实缺失。本 actor 补这个调度。
 *
 * **设计**(完全照 codexAccountActor.ts 的形态):
 *   - setInterval 5min(默认),env `COMMERCIAL_COOLDOWN_RECOVERY_INTERVAL_MS` 覆盖
 *   - 每 tick 调 `tracker.halfOpen()`,把恢复数计入 stats
 *   - 单进程独占(commercial 单进程 invariant),无分布式锁
 *   - timer 句柄 .unref() —— 不阻塞 process exit
 *   - 错误:tracker.halfOpen 抛 → onError(默认 console.warn)+ 本 tick 跳过,下 tick 重试
 *
 * **为什么 5min**:cooldown 默认 10min;每 5min 扫一次保证 cooldown 过期后**最多**等 5min
 * 就被恢复,且不会过频烧 DB(一个 UPDATE,只动 cooldown 行,通常 0)。
 *
 * **不做什么**:
 *   - 不做主动 health probe(不调上游 API 探活)—— 那是另一个独立工作
 *   - 不动 disabled / banned 账号(halfOpen 的 SQL guard 已限只动 cooldown)
 *   - 不重置 admin 手工 NULL 掉 cooldown_until 的 cooldown 行 —— 那是
 *     `recoverFromCooldown` 单账号路径的领地,actor 不越权
 */

import type { AccountHealth, AccountHealthTracker } from './health.js'

/** 默认 tick 间隔 —— 5min。 */
export const DEFAULT_COOLDOWN_RECOVERY_INTERVAL_MS = 5 * 60 * 1000

export interface CooldownRecoveryActorDeps {
  /** AccountHealthTracker 实例。生产从 index.ts `healthTracker` 透传。 */
  tracker: AccountHealthTracker
  /** Tick 间隔 ms(默认 5min,下限 1s 防 typo 把 DB 打穿)。 */
  intervalMs?: number
  /** 测试用:首次启动立即跑一次 tick(默认 false)。 */
  runOnStart?: boolean
  /** 错误日志注入(默认 console.warn)。 */
  onError?: (msg: string, err: unknown) => void
}

export interface CooldownRecoveryActorHandle {
  /** 优雅停止:clearInterval + 设 stopped flag。 */
  stop(): void
  /** 测试用:立即跑一次 tick,返回本次恢复的账号列表(可能为空)。 */
  runNow(): Promise<AccountHealth[]>
}

function defaultOnError(msg: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[cooldownRecoveryActor] ${msg}:`, err)
}

/**
 * 启动 cooldown 半开恢复 actor。返回 handle 可调 stop()。
 *
 * **副作用**:setInterval 句柄 .unref(),不阻止 process exit。
 */
export function startCooldownRecoveryActor(
  deps: CooldownRecoveryActorDeps,
): CooldownRecoveryActorHandle {
  const intervalMs = Math.max(1000, deps.intervalMs ?? DEFAULT_COOLDOWN_RECOVERY_INTERVAL_MS)
  const onError = deps.onError ?? defaultOnError
  const tracker = deps.tracker

  let stopped = false

  async function runOneTick(): Promise<AccountHealth[]> {
    if (stopped) return []
    try {
      const recovered = await tracker.halfOpen()
      return recovered
    } catch (err) {
      onError('halfOpen tick failed', err)
      return []
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    void runOneTick().catch((err) => onError('tick handler crashed', err))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  if (deps.runOnStart) {
    void runOneTick().catch((err) => onError('initial tick crashed', err))
  }

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
