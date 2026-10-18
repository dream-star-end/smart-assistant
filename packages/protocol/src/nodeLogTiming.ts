import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { takeLogWriteTimingSnapshot } from './logWriteTiming.js'
export interface LogTimingLogger { info(msg: string, fields?: Record<string, unknown>): void }

type Histogram = Pick<IntervalHistogram, 'count' | 'max' | 'percentile' | 'reset'>
/** Reset before emitting: the summary's own write belongs to the next window. */
export function reportLogTiming(log: LogTimingLogger, histogram: Histogram): void {
  const fields = takeLogWriteTimingSnapshot()
  const samples = histogram.count
  const lag = {
    eventLoopResolutionMs: 100,
    eventLoopSamples: samples,
    eventLoopP50Ms: samples ? histogram.percentile(50) / 1e6 : null,
    eventLoopP99Ms: samples ? histogram.percentile(99) / 1e6 : null,
    eventLoopMaxMs: samples ? histogram.max / 1e6 : null,
  }
  histogram.reset()
  log.info('log_io_timing', { ...fields, ...lag, nominalWindowMs: 30_000 })
}

let shared: { refs: number; stop: () => void } | undefined
/** One process-wide reporter for gateway, commercial and egress clients. No import side effects. */
export function startLogTimingReporter(log: LogTimingLogger): () => void {
  if (!shared) {
    const histogram = monitorEventLoopDelay({ resolution: 100 })
    histogram.enable()
    const timer = setInterval(() => reportLogTiming(log, histogram), 30_000)
    timer.unref()
    shared = { refs: 0, stop: () => { clearInterval(timer); histogram.disable() } }
  }
  const lease = shared
  lease.refs++
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--lease.refs === 0) {
      lease.stop()
      if (shared === lease) shared = undefined
    }
  }
}
