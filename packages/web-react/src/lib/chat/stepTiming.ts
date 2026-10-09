import type { ChatMessage } from './model'

/**
 * OCV5-367: wall-clock time of each step in the process timeline.
 *
 * A step's time runs from the end of the step before it (the turn start for
 * the first step) to its own end. It therefore includes the model writing the
 * step as well as running it, and the steps of one turn add up to the turn's
 * duration. A step that ran entirely inside the previous one (parallel tool
 * calls) falls back to its own span.
 *
 * Ends come only from recorded times: a tool's result arrival (`completedAt`,
 * live) or its durable `ts + durationMs` (turn tape); any other row ends where
 * the next row starts. Nothing is invented — a row without a trustworthy time
 * gets no entry and the UI shows nothing for it.
 */
export type StepTiming =
  | { ms: number; runningSince?: undefined }
  | { ms?: undefined; runningSince: number }

/** Clocks further apart than this are not the same turn (or not the same clock). */
const MAX_TURN_SPAN_MS = 24 * 3600_000

function validTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Rows hydrated from the live-units view are stamped at hydrate time, not event time. */
function rowStart(message: ChatMessage): number | undefined {
  if (message._liveUnit === true) return undefined
  return validTime(message.ts)
}

function toolRunning(message: ChatMessage): boolean {
  return message.role === 'tool' && !message._completed && !message.error && !message._isError
}

function ownEnd(message: ChatMessage, start: number): number | undefined {
  const completedAt = validTime(message.completedAt)
  if (completedAt !== undefined && completedAt >= start) return completedAt
  if (message.role === 'tool') {
    const durationMs = validTime(message.durationMs)
    if (durationMs !== undefined) return start + durationMs
  }
  return undefined
}

export function computeStepTimings(
  rows: readonly ChatMessage[],
  opts: { turnStartedAt?: number | null; turnEndedAt?: number | null; active: boolean },
): Map<string, StepTiming> {
  const out = new Map<string, StepTiming>()
  const starts = rows.map(rowStart)
  const firstStart = starts.find((start) => start !== undefined)
  if (firstStart === undefined) return out
  const turnStartedAt = validTime(opts.turnStartedAt)
  let boundary =
    turnStartedAt !== undefined &&
    turnStartedAt <= firstStart &&
    firstStart - turnStartedAt <= MAX_TURN_SPAN_MS
      ? turnStartedAt
      : firstStart
  const turnEndedAt = validTime(opts.turnEndedAt)
  for (let i = 0; i < rows.length; i += 1) {
    const message = rows[i]!
    const start = starts[i]
    if (start === undefined) continue
    let nextStart: number | undefined
    for (let j = i + 1; j < rows.length && nextStart === undefined; j += 1) nextStart = starts[j]
    if (nextStart === undefined && turnEndedAt !== undefined && turnEndedAt >= start)
      nextStart = turnEndedAt
    // A tool still running has no end yet, even when later rows (parallel
    // calls) have already arrived.
    const end = ownEnd(message, start) ?? (toolRunning(message) ? undefined : nextStart)
    if (end === undefined) {
      if (opts.active && (toolRunning(message) || nextStart === undefined)) {
        out.set(message.id, { runningSince: Math.min(boundary, start) })
      }
      continue
    }
    const ms = end > boundary ? end - boundary : Math.max(0, end - start)
    if (ms <= MAX_TURN_SPAN_MS) out.set(message.id, { ms })
    boundary = Math.max(boundary, end)
  }
  return out
}

/** Several rows drawn as one step (a merged thinking group). */
export function combineStepTimings(
  timings: ReadonlyMap<string, StepTiming> | null,
  ids: readonly string[],
): StepTiming | undefined {
  if (!timings || ids.length === 0) return undefined
  let total = 0
  for (const id of ids) {
    const timing = timings.get(id)
    if (!timing) return undefined
    if (timing.runningSince !== undefined) return { runningSince: timing.runningSince - total }
    total += timing.ms
  }
  return { ms: total }
}

export function stepTimingsSignature(timings: ReadonlyMap<string, StepTiming>): string {
  let sig = ''
  for (const [id, timing] of timings) sig += `${id}:${timing.ms ?? `r${timing.runningSince}`}|`
  return sig
}

/** 0.4 秒 · 12 秒 · 3 分 05 秒 · 1 小时 03 分 */
export function formatStepDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) {
    const seconds = (safe / 1000).toFixed(1)
    return seconds === '0.0' ? '<0.1 秒' : `${seconds} 秒`
  }
  const total = Math.floor(safe / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}
