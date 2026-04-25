/**
 * M6 / P1-9 — Account refresh events 28 天 retention sweeper。
 *
 * 设计:
 *   - 24h interval setInterval,首次启动后 24h 才跑(避免 boot 风暴)
 *   - timer.unref() — 不阻止进程退出
 *   - 每 tick 调 purgeOlderThan(28),失败 console.warn 不抛
 *   - 单进程:同 v3 单 gateway 部署,不需要分布式锁
 */

import { purgeOlderThan } from './refreshEvents.js'

export const DEFAULT_RETENTION_DAYS = 28
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface SweeperHandle {
  stop(): void
  /** 测试用:立即跑一次 purge,返回删除行数。 */
  runNow(): Promise<number>
}

export interface SweeperOptions {
  retentionDays?: number
  intervalMs?: number
  /** 测试用:首次 boot 立即跑(默认 false,boot 后等 intervalMs)。 */
  runOnStart?: boolean
  onError?: (err: unknown) => void
  /** 测试用注入:覆盖默认的 purgeOlderThan 调用(便于无 DB 单元测试)。 */
  purgeFn?: (days: number) => Promise<number>
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[refreshEventsSweeper] purge failed:', err)
}

/**
 * 启动 sweeper。返回 handle 可调 stop()。
 */
export function startRefreshEventsSweeper(opts: SweeperOptions = {}): SweeperHandle {
  const days = Math.max(1, Math.floor(opts.retentionDays ?? DEFAULT_RETENTION_DAYS))
  const interval = Math.max(1000, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  const onError = opts.onError ?? defaultOnError
  const purgeFn = opts.purgeFn ?? purgeOlderThan
  let stopped = false

  async function runOneTick(): Promise<number> {
    try {
      return await purgeFn(days)
    } catch (err) {
      onError(err)
      return 0
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    void runOneTick()
  }, interval)
  if (typeof timer.unref === 'function') timer.unref()

  if (opts.runOnStart) {
    void runOneTick()
  }

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
