/**
 * 第三阶段 P1(OCV5-559):master 进程日志级别热改。
 *
 * system_settings.log_level 驱动本进程所有登记过的共享级别(kernel registerLevelRef:gateway、
 * commercial)。"env" = 回到启动时的 env 值;其它值直接覆盖。
 *
 * 生效路径:
 *   - master 启动:startLogLevelSyncPoller 立即读一次并应用
 *   - admin PUT /api/admin/settings/log_level 成功后:handler 直接 applyLogLevelSetting(本机立即)
 *   - 之后每 5 秒轮询一次(只读一行),让漏掉的改动(另一进程写的、PUT 之外的写入)≤5 秒收敛
 *
 * 读失败(PG 抖动)不改当前级别、不抛,下一轮再读;日志级别不是安全开关,fail-open 到"保持现状"。
 */

import { registeredLogLevels, resetLogLevels, setLogLevels } from '@openclaude/kernel'
import type { SystemSettingValue } from '../admin/systemSettings.js'
import { type Logger, rootLogger } from './logger.js'

export type LogLevelSetting = SystemSettingValue<'log_level'>

/** Apply a log_level setting to every registered level; returns the levels now in force. */
export function applyLogLevelSetting(value: LogLevelSetting): Record<string, string> {
  if (value === 'env') resetLogLevels()
  else setLogLevels(value)
  return registeredLogLevels()
}

export interface LogLevelSyncPoller {
  stop(): void
  /** One read + apply now (also what each tick does). Resolves when done; never rejects. */
  tick(): Promise<void>
}

export function startLogLevelSyncPoller(opts: {
  read: () => Promise<LogLevelSetting>
  intervalMs?: number
  log?: Logger
}): LogLevelSyncPoller {
  const log = opts.log ?? rootLogger.child({ subsys: 'logLevelSync' })
  let last: LogLevelSetting | undefined
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const value = await opts.read()
      if (value !== last) {
        const levels = applyLogLevelSetting(value)
        if (last !== undefined || value !== 'env')
          log.info('log level setting applied', { setting: value, levels })
        last = value
      }
    } catch (err) {
      log.warn('log level setting read failed; keeping current levels', { err })
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 5_000)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
