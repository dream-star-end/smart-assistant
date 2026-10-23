/**
 * oc-trace pure parts (phase 3 plan v3.6 §7.7, OCV5-566): turn the rows of each table and the
 * matching log lines into one UTC event timeline, find the first error, and label what is past its
 * retention. No I/O here; scripts/oc-trace.ts does the queries and file reads.
 */

export type Source =
  | 'turn_traces'
  | 'turn_dispatches'
  | 'request_finalize_journal'
  | 'usage_records'
  | 'turn_upstream_performance'
  | 'turn_runtime_observations'
  | 'master-log'
  | 'egress-log'
  | 'container-log'

export interface TraceEvent {
  at: string // ISO UTC
  source: Source
  event: string
  code?: string
  level?: 'error' | 'warn' | 'info'
  ids: Record<string, string>
  message?: string
  /** A diagnostic code (e.g. user cancellation), rather than a failure. */
  isFailure?: boolean
  /** a run of identical consecutive events collapsed into this one (collapseRuns) */
  count?: number
  until?: string
}

/** Retention of each evidence source (plan §7.7 table), in days; null = durable. */
export const RETENTION_DAYS: Record<Source, number | null> = {
  turn_traces: 90,
  turn_runtime_observations: 90,
  turn_upstream_performance: 90,
  request_finalize_journal: null, // conditional GC by updated_at; see JOURNAL_RETENTION_POLICY
  turn_dispatches: null,
  usage_records: null,
  'master-log': 14, // logrotate daily, rotate 14, maxsize 200M (may be shorter under load)
  'egress-log': 14,
  'container-log': 14, // saved before removal to /var/log/openclaude-v5-containers (§7.5, OCV5-568), pruned at 14 days / 1 GiB
}

/** Age thresholds describe GC eligibility, never proof that a missing row was deleted. */
export const JOURNAL_RETENTION_POLICY = {
  ordinaryTerminal: 'updated_at; default 7 days (runtime-configurable)',
  durableCommitted: 'updated_at; 30 days, only with surviving usage evidence',
  durableAborted: 'updated_at; 90 days',
  excludedFromOrdinaryGc: 'Box recovery v1 and non-terminal rows',
  missingRow: 'not found; cause unknown (retention is only a possible explanation)',
} as const

/** RFC 4180-ish CSV (psql --csv): quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else q = false
      } else field += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [head, ...body] = rows
  if (!head) return []
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

/** psql timestamps ("2026-10-21 22:48:01.123+00") → ISO UTC; '' → undefined. */
export function toIso(ts: string | undefined): string | undefined {
  if (!ts) return undefined
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

const pick = (r: Record<string, string>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => r[k]).map((k) => [k, r[k]!]))

/** psql renders the selected `error_msg IS NOT NULL AS has_error` as t/f. */
const hasError = (r: Record<string, string>) =>
  r.has_error === 't' || r.has_error === 'true' || !!r.error_msg

/** Every trace / dispatch / request id the rows of all tables mention (for the next query round). */
export function idsFromRows(rows: Partial<Record<Source, Record<string, string>[]>>): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(rows))
    for (const r of list ?? [])
      for (const k of ['trace_id', 'dispatch_id', 'request_id', 'billing_request_id'])
        if (r[k]) out.add(r[k]!)
  return out
}

/** Events from one table's rows: every timestamp column that is set becomes one event. */
export function eventsFromRows(source: Source, rows: Record<string, string>[]): TraceEvent[] {
  const out: TraceEvent[] = []
  const add = (
    r: Record<string, string>,
    col: string,
    event: string,
    extra: Partial<TraceEvent> = {},
  ) => {
    const at = toIso(r[col])
    if (at)
      out.push({
        at,
        source,
        event,
        ids: pick(r, [
          'trace_id',
          'dispatch_id',
          'request_id',
          'billing_request_id',
          'session_key',
        ]),
        ...extra,
      })
  }
  for (const r of rows) {
    const code = r.failure_code || undefined
    switch (source) {
      case 'turn_traces':
        add(r, 'created_at', 'trace.created')
        add(
          r,
          'first_visible_at',
          `trace.first_visible${r.first_visible_kind ? `:${r.first_visible_kind}` : ''}`,
        )
        add(r, 'runtime_observed_at', 'trace.runtime_observed')
        break
      case 'turn_dispatches': {
        const failed = /^(crashed|executed_error|not_accepted|failed)$/.test(
          r.outcome || r.status || '',
        )
        const cancelled = code === 'USER_CANCELLED'
        add(r, 'admitted_at', 'dispatch.admitted')
        add(r, 'accepted_at', 'dispatch.accepted')
        add(r, 'last_attempt_at', `dispatch.attempt#${r.attempt_no || '?'}`)
        add(r, 'terminal_at', `dispatch.${r.outcome || r.status || 'terminal'}`, {
          code,
          level: !cancelled && (code || failed) ? 'error' : 'info',
          ...(cancelled ? { isFailure: false } : {}),
        })
        break
      }
      case 'request_finalize_journal':
        add(r, 'created_at', 'finalize.opened')
        add(r, 'updated_at', `finalize.${r.state || 'updated'}`, {
          code: code || (hasError(r) ? 'FINALIZE_ERROR' : undefined),
          level: code || hasError(r) ? 'error' : 'info',
        })
        break
      case 'usage_records':
        add(r, 'created_at', `usage.${r.status || 'recorded'}`, {
          code:
            r.status && r.status !== 'success' && r.status !== 'ok'
              ? `USAGE_${r.status.toUpperCase()}`
              : undefined,
          level: hasError(r) || (r.status && !/^(success|ok)$/.test(r.status)) ? 'error' : 'info',
        })
        break
      case 'turn_upstream_performance':
        add(r, 'observed_at', `upstream.${r.outcome || 'observed'}`, {
          code:
            r.outcome && !/^(ok|success|completed)$/i.test(r.outcome)
              ? `UPSTREAM_${r.outcome.toUpperCase()}`
              : undefined,
          level: r.outcome && !/^(ok|success|completed)$/i.test(r.outcome) ? 'error' : 'info',
        })
        break
      case 'turn_runtime_observations':
        add(r, 'observed_at', 'runtime.observed')
        break
      default:
        break
    }
  }
  return out
}

/** A JSON log line that mentions one of the ids → an event (non-JSON lines are skipped). */
export function eventFromLogLine(source: Source, line: string): TraceEvent | null {
  let o: Record<string, unknown>
  // saved container logs carry docker's own timestamp in front of each line
  const json = line.startsWith('{') ? line : line.replace(/^\d{4}-\d\d-\d\dT\S+Z /, '')
  try {
    o = JSON.parse(json)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const at = typeof o.ts === 'string' ? toIso(o.ts) : undefined
  if (!at) return null
  const lvl = typeof o.level === 'string' ? o.level.toLowerCase() : 'info'
  const level = lvl === 'error' || lvl === 'fatal' ? 'error' : lvl === 'warn' ? 'warn' : 'info'
  const codeRaw = o.errorCode ?? o.code ?? o.failureCode ?? o.failure_code
  const ids: Record<string, string> = {}
  for (const k of [
    'traceId',
    'dispatchId',
    'requestId',
    'clientTraceId',
    'parentTraceId',
    'turnRequestId',
    'billingRequestId',
    'dispatchTraceId',
    'sessionKey',
  ])
    if (typeof o[k] === 'string') ids[k] = o[k] as string
  return {
    at,
    source,
    event: typeof o.msg === 'string' ? o.msg : 'log',
    code: typeof codeRaw === 'string' ? codeRaw : undefined,
    level,
    ids,
    message: typeof o.error === 'string' ? o.error : undefined,
    ...(level === 'info' && !o.errorCode && !o.failureCode && !o.failure_code
      ? { isFailure: false }
      : {}),
  }
}

export function timeline(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  )
}

/** Client ids are caller-controlled: only the original unresolved input may match that field. */
export function isRelatedLogEvent(
  event: TraceEvent,
  ids: Set<string>,
  clientInput?: string,
): boolean {
  return Object.entries(event.ids).some(([key, id]) =>
    key === 'clientTraceId' ? id === clientInput : key !== 'sessionKey' && ids.has(id),
  )
}

/** The earliest event carrying an error code, else the earliest error-level event. */
export function firstError(events: TraceEvent[]): TraceEvent | undefined {
  const t = timeline(events)
  return t.find((e) => e.code && e.isFailure !== false) ?? t.find((e) => e.level === 'error')
}

/** Sources whose retention window no longer covers `startedAt` (so missing events are expected). */
export function pastRetention(startedAt: string, now: Date): Source[] {
  const ageDays = (now.getTime() - new Date(startedAt).getTime()) / 86_400_000
  return (Object.entries(RETENTION_DAYS) as [Source, number | null][])
    .filter(([, d]) => d !== null && ageDays > d)
    .map(([s]) => s)
}

/**
 * Consecutive events with the same source, event, code and level (e.g. per-chunk relay timing
 * lines) become one event with a count and the time of the last one, so a noisy source cannot
 * push the rest of the evidence past the output cap.
 */
export function collapseRuns(events: TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const e of timeline(events)) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.source === e.source &&
      prev.event === e.event &&
      prev.code === e.code &&
      prev.level === e.level &&
      prev.isFailure === e.isFailure &&
      Object.keys(prev.ids).length === Object.keys(e.ids).length &&
      Object.entries(prev.ids).every(([key, value]) => e.ids[key] === value)
    ) {
      prev.count = (prev.count ?? 1) + 1
      prev.until = e.at
    } else out.push({ ...e })
  }
  return out
}
