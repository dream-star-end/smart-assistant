/**
 * 会话回收站周期清理(session trash bin sweeper)。
 *
 * 用户删除会话 = 软删进回收站(deleteClientSession 只置 deleted_at,内容保留可还原);
 * 超过保留期(sessionTrashRetentionMs,默认 3 天)的行由本 sweeper 周期硬删
 * (sweepTrashedClientSessions,含全部级联)。模式对齐 eventPersist.ts 的 startRetention():
 * 启动即跑一次(fire-and-forget)→ setInterval(...).unref() → 每次 sweep(now() - retentionMs)。
 *
 * - 只在 purged>0 时打 info(零清理不刷日志)
 * - 出错只 warn,永不 throw(清理性任务不允许拖垮宿主流程)
 * - single-flight:上一轮还在飞就跳过,防慢库下定时器重入堆叠
 *
 * Wire:Gateway.start() 里 startSessionTrashSweeper(),shutdown Stage 2 里 .stop()。
 * env `OC_SESSION_TRASH_SWEEP_MS` 可缩短周期(供 e2e/测试)。
 */
import { sessionTrashRetentionMs, sweepTrashedClientSessions } from '@openclaude/storage'

import { createLogger } from './logger.js'

export interface SessionTrashSweeperOptions {
  /** 实际执行清理的函数;默认 sweepTrashedClientSessions(测试注入 fake)。 */
  sweep?: (cutoffMs: number) => Promise<{ purged: number }>
  /** 回收站保留期;默认 sessionTrashRetentionMs()(env OC_SESSION_TRASH_RETENTION_MS 可覆盖)。 */
  retentionMs?: number
  /** 周期;默认 env OC_SESSION_TRASH_SWEEP_MS 或 1 小时。 */
  intervalMs?: number
  /** 时钟注入(测试)。 */
  now?: () => number
  /** 日志注入(测试);形状对齐 gateway Logger 的 info/warn。 */
  log?: {
    info(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>, err?: unknown): void
  }
}

export interface SessionTrashSweeperHandle {
  /** 停掉周期定时器(进行中的一轮不会被中断)。幂等。 */
  stop(): void
  /** 手动触发一轮(测试/运维);上一轮在飞时立即返回 {purged:0}(skip)。永不 reject。 */
  runOnce(): Promise<{ purged: number }>
}

const DEFAULT_INTERVAL_MS = 60 * 60_000

export function startSessionTrashSweeper(
  opts: SessionTrashSweeperOptions = {},
): SessionTrashSweeperHandle {
  const sweep = opts.sweep ?? sweepTrashedClientSessions
  const retentionMs = opts.retentionMs ?? sessionTrashRetentionMs()
  const envInterval = Number(process.env.OC_SESSION_TRASH_SWEEP_MS)
  const intervalMs = opts.intervalMs
    ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS)
  const now = opts.now ?? Date.now
  const fallbackLog = createLogger({ module: 'sessionTrashSweeper' })
  const log = opts.log ?? fallbackLog

  let inFlight = false
  let timer: ReturnType<typeof setInterval> | null = null

  const runOnce = async (): Promise<{ purged: number }> => {
    if (inFlight) return { purged: 0 }
    inFlight = true
    try {
      const { purged } = await sweep(now() - retentionMs)
      if (purged > 0) log.info('session trash sweep', { purged })
      return { purged }
    } catch (err) {
      log.warn('session trash sweep failed', {}, err)
      return { purged: 0 }
    } finally {
      inFlight = false
    }
  }

  // 启动即跑一次(fire-and-forget,失败只 warn)。
  void runOnce()
  timer = setInterval(() => void runOnce(), intervalMs)
  timer.unref?.()

  return {
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    runOnce,
  }
}
