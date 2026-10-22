/**
 * Literature Plugin call observability (OCV5-585).
 *
 * One structured line per plugin call (`literature_plugin_call`) and per PDF artifact lifecycle
 * event (`literature_artifact`), written through the commercial kernel logger (which redacts on
 * top of this). Fields are an allow-list of codes, counters and durations: never the query,
 * title, documentId, artifactId, filename, URL or any cookie. `uid` is only used for distinct-user
 * counts by the aggregator, which never prints per-user rows.
 *
 * `aggregateLiteratureLogLines` turns those lines into 7/14-day windows: calls, success rate,
 * error-code distribution, p50/p95, download/save results and proxy fallback ratio. Client mistakes
 * (expired/invalid documentId, bad params) are counted separately and excluded from the success
 * denominator, and test-account uids are excluded entirely, so manual negative tests do not count
 * as upstream failures.
 */

export const LITERATURE_CALL_LOG_MSG = 'literature_plugin_call'
export const LITERATURE_ARTIFACT_LOG_MSG = 'literature_artifact'

export type LiteratureErrClass = 'client' | 'upstream' | 'capacity' | 'session' | 'platform'

const CLIENT_CODES = new Set([
  'DOCUMENT_EXPIRED',
  'INVALID_INPUT',
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'PLUGIN_DISABLED',
  'TARGET_NOT_FOUND',
  'WRITE_REQUIRES_CONFIRMATION',
])
const UPSTREAM_CODES = new Set([
  'LITERATURE_NO_ACCESS',
  'LITERATURE_UPSTREAM_RATE_LIMITED',
  'LITERATURE_UPSTREAM_CHALLENGE',
  'LITERATURE_UPSTREAM_CHANGED',
  'RESPONSE_INVALID',
  'RESPONSE_TOO_LARGE',
  'TIMEOUT',
  'OUTBOUND_BLOCKED',
])
const SESSION_CODES = new Set(['RELINK_REQUIRED', 'SESSION_EXPIRED'])

export function literatureErrorClass(code: string): LiteratureErrClass {
  if (CLIENT_CODES.has(code)) return 'client'
  if (UPSTREAM_CODES.has(code)) return 'upstream'
  if (SESSION_CODES.has(code)) return 'session'
  if (code === 'LITERATURE_ARTIFACT_CAPACITY') return 'capacity'
  return 'platform'
}

export type LiteratureCallPhase = 'lease' | 'relogin' | 'session' | 'upstream' | 'stage' | 'commit'
export type LiteratureFallbackReason = 'timeout' | 'status_5xx' | 'error'
export interface LiteratureEgressHop {
  readonly via: 'proxy' | 'direct'
  /** Set when a proxy attempt was abandoned and the request went direct. */
  readonly fallback?: LiteratureFallbackReason
}

export interface LiteratureCallEvent {
  plugin: 'literature-db'
  action: string
  outcome: 'ok' | 'error'
  code: string
  errClass: LiteratureErrClass | null
  uid: number
  totalMs: number
  leaseMs?: number
  reloginMs?: number
  sessionMs?: number
  upstreamMs?: number
  stageMs?: number
  commitMs?: number
  route?: 'zh' | 'en'
  items?: number
  zeroResult?: boolean
  bytes?: number
  pdfValid?: boolean
  reused?: boolean
  relogin?: 'ok' | 'failed'
  egressProxy: number
  egressFallback: number
  egressDirect: number
  fallbackReasons?: string
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'INTERNAL'
}

/** Mutable per-call recorder threaded through the runtime and executor. */
export class LiteratureCallTrace {
  route?: 'zh' | 'en'
  items?: number
  zeroResult?: boolean
  download?: { bytes?: number; pdfValid?: boolean; reused?: boolean }
  relogin?: 'ok' | 'failed'
  private readonly startedAt: number
  private lastMark: number
  private readonly phases = new Map<LiteratureCallPhase, number>()
  private proxy = 0
  private fallback = 0
  private direct = 0
  private readonly reasons = new Map<LiteratureFallbackReason, number>()

  constructor(
    readonly action: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now()
    this.lastMark = this.startedAt
  }

  /** Attributes the time since the previous mark to `name` (accumulates on repeats). */
  phase(name: LiteratureCallPhase): void {
    const at = this.now()
    this.phases.set(name, (this.phases.get(name) ?? 0) + Math.max(0, at - this.lastMark))
    this.lastMark = at
  }

  recordHop(hop: LiteratureEgressHop): void {
    if (hop.via === 'proxy') {
      this.proxy++
      if (hop.fallback) {
        this.fallback++
        this.reasons.set(hop.fallback, (this.reasons.get(hop.fallback) ?? 0) + 1)
      }
    } else {
      this.direct++
    }
  }

  finish(input: { uid: number; error?: unknown }): LiteratureCallEvent {
    const failed = input.error !== undefined
    const code = failed ? errorCode(input.error) : 'OK'
    const event: LiteratureCallEvent = {
      plugin: 'literature-db',
      action: this.action,
      outcome: failed ? 'error' : 'ok',
      code,
      errClass: failed ? literatureErrorClass(code) : null,
      uid: input.uid,
      totalMs: Math.max(0, this.now() - this.startedAt),
      egressProxy: this.proxy,
      egressFallback: this.fallback,
      egressDirect: this.direct,
    }
    for (const [name, ms] of this.phases)
      (event as unknown as Record<string, number>)[`${name}Ms`] = ms
    if (this.route) event.route = this.route
    if (this.items !== undefined) event.items = this.items
    if (this.zeroResult !== undefined) event.zeroResult = this.zeroResult
    if (this.download?.bytes !== undefined) event.bytes = this.download.bytes
    if (this.download?.pdfValid !== undefined) event.pdfValid = this.download.pdfValid
    if (this.download?.reused !== undefined) event.reused = this.download.reused
    if (this.relogin) event.relogin = this.relogin
    if (this.reasons.size > 0)
      event.fallbackReasons = [...this.reasons].map(([r, n]) => `${r}:${n}`).join(',')
    return event
  }
}

export type LiteratureArtifactEvent =
  | { event: 'get'; outcome: 'ok' | 'not_found'; uid: number; ageMs?: number; bytes?: number }
  | { event: 'evict'; reason: 'saved' | 'own_unsaved'; uid: number; ageMs: number }
  | { event: 'expire'; reason: 'saved' | 'unsaved'; uid: number }
  | { event: 'reuse'; uid: number; ageMs: number }

// ── aggregation ───────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

interface Bucket {
  calls: number
  ok: number
  zeroResults: number
  latencies: number[]
}

export interface LiteratureMetricsWindow {
  days: number
  start: string
  end: string
  calls: number
  excludedTestCalls: number
  users: number
  ok: number
  clientErrors: number
  /** ok / (calls − clientErrors); null when there is nothing to divide. */
  successRate: number | null
  errorCodes: Record<string, number>
  errClasses: Record<string, number>
  byAction: Record<
    string,
    { calls: number; ok: number; zeroResults: number; p50: number | null; p95: number | null }
  >
  latencyMs: { p50: number | null; p95: number | null; okP50: number | null; okP95: number | null }
  download: {
    attempts: number
    ok: number
    successRate: number | null
    pdfInvalid: number
    reused: number
    saved: number
    saveMissing: number
    expiredUnsaved: number
    evicted: Record<string, number>
  }
  egress: {
    proxy: number
    fallback: number
    direct: number
    fallbackRatio: number | null
    fallbackReasons: Record<string, number>
  }
  relogin: { attempts: number; ok: number }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1]!
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyWindow(days: number, startMs: number, endMs: number): LiteratureMetricsWindow {
  return {
    days,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    calls: 0,
    excludedTestCalls: 0,
    users: 0,
    ok: 0,
    clientErrors: 0,
    successRate: null,
    errorCodes: {},
    errClasses: {},
    byAction: {},
    latencyMs: { p50: null, p95: null, okP50: null, okP95: null },
    download: {
      attempts: 0,
      ok: 0,
      successRate: null,
      pdfInvalid: 0,
      reused: 0,
      saved: 0,
      saveMissing: 0,
      expiredUnsaved: 0,
      evicted: {},
    },
    egress: { proxy: 0, fallback: 0, direct: 0, fallbackRatio: null, fallbackReasons: {} },
    relogin: { attempts: 0, ok: 0 },
  }
}

export interface LiteratureMetricsOptions {
  endMs: number
  windowsDays: readonly number[]
  excludeUids?: ReadonlySet<number>
}

export interface LiteratureMetricsReport {
  parsedLines: number
  windows: LiteratureMetricsWindow[]
}

export function aggregateLiteratureLogLines(
  lines: Iterable<string>,
  opts: LiteratureMetricsOptions,
): LiteratureMetricsReport {
  const aggregator = createLiteratureMetricsAggregator(opts)
  for (const line of lines) aggregator.add(line)
  return aggregator.finish()
}

/** Streaming form for large log files: add() each line, finish() once. */
export function createLiteratureMetricsAggregator(opts: LiteratureMetricsOptions): {
  add(line: string): void
  finish(): LiteratureMetricsReport
} {
  const exclude = opts.excludeUids ?? new Set<number>()
  const state = opts.windowsDays.map((days) => {
    const startMs = opts.endMs - days * DAY_MS
    return {
      startMs,
      w: emptyWindow(days, startMs, opts.endMs),
      users: new Set<number>(),
      all: [] as number[],
      okLat: [] as number[],
      actions: new Map<string, Bucket>(),
    }
  })
  let parsedLines = 0
  const add = (raw: string): void => {
    if (!raw.includes(LITERATURE_CALL_LOG_MSG) && !raw.includes(LITERATURE_ARTIFACT_LOG_MSG)) return
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (!rec || typeof rec !== 'object') return
    const msg = rec.msg
    if (msg !== LITERATURE_CALL_LOG_MSG && msg !== LITERATURE_ARTIFACT_LOG_MSG) return
    const at = typeof rec.ts === 'string' ? Date.parse(rec.ts) : Number.NaN
    if (!Number.isFinite(at)) return
    parsedLines++
    const uid = num(rec.uid)
    for (const s of state) {
      if (at < s.startMs || at >= opts.endMs) continue
      const w = s.w
      if (exclude.has(uid)) {
        if (msg === LITERATURE_CALL_LOG_MSG) w.excludedTestCalls++
        continue
      }
      if (msg === LITERATURE_ARTIFACT_LOG_MSG) {
        if (rec.event === 'get') {
          if (rec.outcome === 'ok') w.download.saved++
          else w.download.saveMissing++
        } else if (rec.event === 'evict') bump(w.download.evicted, String(rec.reason ?? 'unknown'))
        else if (rec.event === 'expire' && rec.reason === 'unsaved') w.download.expiredUnsaved++
        continue
      }
      const action = typeof rec.action === 'string' ? rec.action : 'unknown'
      const ok = rec.outcome === 'ok'
      const code = typeof rec.code === 'string' ? rec.code : 'INTERNAL'
      const client = !ok && literatureErrorClass(code) === 'client'
      const ms = num(rec.totalMs)
      w.calls++
      s.users.add(uid)
      if (ok) w.ok++
      else {
        bump(w.errorCodes, code)
        bump(w.errClasses, literatureErrorClass(code))
      }
      if (client) w.clientErrors++
      const bucket = s.actions.get(action) ?? { calls: 0, ok: 0, zeroResults: 0, latencies: [] }
      bucket.calls++
      if (ok) bucket.ok++
      if (ok && rec.zeroResult === true) bucket.zeroResults++
      if (!client) {
        bucket.latencies.push(ms)
        s.all.push(ms)
        if (ok) s.okLat.push(ms)
      }
      s.actions.set(action, bucket)
      if (action === 'download' && !client) {
        w.download.attempts++
        if (ok) w.download.ok++
        if (rec.pdfValid === false) w.download.pdfInvalid++
        if (ok && rec.reused === true) w.download.reused++
      }
      w.egress.proxy += num(rec.egressProxy)
      w.egress.fallback += num(rec.egressFallback)
      w.egress.direct += num(rec.egressDirect)
      if (typeof rec.fallbackReasons === 'string') {
        for (const part of rec.fallbackReasons.split(',')) {
          const [reason, count] = part.split(':')
          if (reason && /^[a-z_0-9]{1,32}$/.test(reason))
            bump(w.egress.fallbackReasons, reason, num(Number(count)))
        }
      }
      if (rec.relogin === 'ok' || rec.relogin === 'failed') {
        w.relogin.attempts++
        if (rec.relogin === 'ok') w.relogin.ok++
      }
    }
  }
  const finish = (): LiteratureMetricsReport => {
    for (const s of state) {
      const w = s.w
      w.users = s.users.size
      w.successRate = ratio(w.ok, w.calls - w.clientErrors)
      const all = [...s.all].sort((a, b) => a - b)
      const okLat = [...s.okLat].sort((a, b) => a - b)
      w.latencyMs = {
        p50: percentile(all, 0.5),
        p95: percentile(all, 0.95),
        okP50: percentile(okLat, 0.5),
        okP95: percentile(okLat, 0.95),
      }
      for (const [action, b] of s.actions) {
        const lat = [...b.latencies].sort((a, c) => a - c)
        w.byAction[action] = {
          calls: b.calls,
          ok: b.ok,
          zeroResults: b.zeroResults,
          p50: percentile(lat, 0.5),
          p95: percentile(lat, 0.95),
        }
      }
      w.download.successRate = ratio(w.download.ok, w.download.attempts)
      w.egress.fallbackRatio = ratio(w.egress.fallback, w.egress.proxy)
    }
    return { parsedLines, windows: state.map((s) => s.w) }
  }
  return { add, finish }
}
