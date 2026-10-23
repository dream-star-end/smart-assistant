/**
 * oc-trace (phase 3 plan v3.6 §7.7, P2, OCV5-566): one read-only command for a turn's path.
 *
 *   npx tsx scripts/oc-trace.ts <traceId | dispatchId | requestId> [--verbose] [--json]
 *   npx tsx scripts/oc-trace.ts --drill 20      the 20 latest failed dispatches: first error + seconds
 *
 * Root on v5-dev only. Database access is the local postgres role over the Unix socket (peer auth;
 * no DSN or password anywhere) in a read-only session with a 5 s statement timeout; every query is
 * by id with psql variables (never interpolated), one table at a time (no fan-out joins), capped at
 * ROW_CAP rows. Host logs (master, egress, rotated and .gz) are searched for every id found, by
 * fixed string. Output: one UTC timeline, the first error with its stage, and which evidence is past
 * its retention. Default output has ids, events, codes and times only; --verbose adds the log
 * message. Everything printed goes through the kernel's redactText.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText } from '../packages/kernel/src/redact.ts'
import {
  JOURNAL_RETENTION_POLICY,
  RETENTION_DAYS,
  type Source,
  collapseRuns,
  eventsFromRows,
  firstError,
  idsFromRows,
  parseCsv,
  pastRetention,
  timeline,
} from './lib/ocTraceLib.ts'

import { type LogLocation, type LogReadResult, readLogEvents } from './lib/ocTraceLogs.ts'

const ROW_CAP = 200
const ID_CAP = 256
const DISCOVERY_ROUNDS = 4
const TRACE_BUDGET_MS = 50_000
const LOG_LINE_CAP = 5000 // raw matching lines read; the timeline is collapsed and capped after
const EVENT_CAP = 400
const DB = process.env.OC_TRACE_DB ?? 'openclaude_v5_selfhost'
const LOG_DIR = process.env.OC_TRACE_LOG_DIR ?? '/var/log'
const CONTAINER_LOG_DIR =
  process.env.OC_TRACE_CONTAINER_LOG_DIR ?? '/var/log/openclaude-v5-containers'
const LOGS: LogLocation[] = [
  {
    source: 'master-log',
    dir: LOG_DIR,
    pattern: /^openclaude-v5-selfhost\.log(\.\d+(\.gz)?)?$/,
  },
  {
    source: 'egress-log',
    dir: LOG_DIR,
    pattern: /^openclaude-v5-selfhost-egress\.log(\.\d+(\.gz)?)?$/,
  },
  // saved before each turn-runtime container removal (OCV5-568, plan §7.5)
  { source: 'container-log', dir: CONTAINER_LOG_DIR, pattern: /\.log$/ },
]
const ID_RE = /^[0-9A-Za-z_-]{8,128}$/

function psql(
  sql: string,
  vars: Record<string, string>,
  timeoutMs = 5000,
): Record<string, string>[] {
  const args = [
    '-n',
    '-u',
    'postgres',
    '--preserve-env=PGOPTIONS',
    'psql',
    '-d',
    DB,
    '-X',
    '-q',
    '--csv',
    '-v',
    'ON_ERROR_STOP=1',
  ]
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('sudo', args, {
    input: sql,
    encoding: 'utf8',
    env: {
      ...process.env,
      PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs}`,
    },
    maxBuffer: 1 << 26,
    timeout: timeoutMs,
  })
  if (r.status !== 0) throw new Error('database-read-failed')
  return parseCsv(r.stdout)
}

const asArray = (ids: Iterable<string>) => `{${[...ids].map((s) => `"${s}"`).join(',')}}`

interface Found {
  ids: Set<string>
  rows: Partial<Record<Source, Record<string, string>[]>>
  truncated: Source[]
  incomplete: string[]
}

/** Collect every id reachable from the input through traces and dispatches (bounded rounds). */
function collect(seed: Iterable<string>, query: typeof psql, deadline: number): Found {
  const ids = new Set(seed)
  const rows: Found['rows'] = {}
  const truncated: Source[] = []
  const incomplete: string[] = []
  const q = (source: Source, sql: string) => {
    const remaining = Math.min(5000, deadline - Date.now())
    if (remaining <= 0) {
      incomplete.push('trace-deadline')
      return rows[source] ?? []
    }
    let r: Record<string, string>[]
    try {
      r = query(`${sql} LIMIT ${ROW_CAP + 1}`, { ids: asArray(ids) }, remaining)
    } catch {
      incomplete.push(`${source}:database-read-failed`)
      return rows[source] ?? []
    }
    if (r.length > ROW_CAP) truncated.push(source)
    rows[source] = r.slice(0, ROW_CAP)
    return rows[source]!
  }
  // Every table can contribute ids (an upstream request id may appear only in the finalize journal
  // or upstream rows, and the egress log lines carry only that id), so all six are queried each
  // round until the id set stops growing.
  for (let round = 0; round < 4; round++) {
    truncated.length = 0
    const before = ids.size
    q(
      'turn_traces',
      `SELECT trace_id, dispatch_id, request_id, user_id, session_key, runtime_container_id, model, created_at, first_visible_at, first_visible_kind, runtime_observed_at
         FROM turn_traces WHERE trace_id = ANY(:'ids'::text[]) OR request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) ORDER BY created_at, trace_id`,
    )
    q(
      'turn_dispatches',
      `SELECT trace_id, dispatch_id, user_id, session_id, billing_request_id, attempt_no, status, outcome, failure_code, model, agent_container_id, admitted_at, accepted_at, last_attempt_at, terminal_at
         FROM turn_dispatches WHERE trace_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) OR billing_request_id = ANY(:'ids'::text[]) ORDER BY admitted_at, dispatch_id`,
    )
    q(
      'request_finalize_journal',
      `SELECT request_id, dispatch_id, attempt_no, state, failure_code, error_msg IS NOT NULL AS has_error, created_at, updated_at
         FROM request_finalize_journal WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) ORDER BY created_at, request_id`,
    )
    q(
      'usage_records',
      `SELECT request_id, dispatch_id, attempt_no, status, model, cost_credits, error_msg IS NOT NULL AS has_error, created_at
         FROM usage_records WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) ORDER BY created_at, request_id`,
    )
    q(
      'turn_upstream_performance',
      `SELECT request_id, dispatch_id, model, ttft_ms, stream_ms, outcome, observed_at
         FROM turn_upstream_performance WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) ORDER BY observed_at, request_id`,
    )
    q(
      'turn_runtime_observations',
      `SELECT trace_id, dispatch_id, session_key, duration_ms, tool_calls, observed_at
         FROM turn_runtime_observations WHERE trace_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[]) ORDER BY observed_at, event_id`,
    )
    for (const id of idsFromRows(rows)) {
      if (!ID_RE.test(id) || ids.has(id)) continue
      if (ids.size >= ID_CAP) incomplete.push('id-cap')
      else ids.add(id)
    }
    if (ids.size === before) break
    if (round === 3) incomplete.push('database-closure-incomplete')
  }
  return { ids, rows, truncated, incomplete }
}

export interface TraceIo {
  query?: typeof psql
  readLogs?: (ids: Set<string>, deadline: number) => Promise<LogReadResult>
}

export async function trace(input: string, io: TraceIo = {}) {
  if (!ID_RE.test(input)) throw new Error(`not an id: ${JSON.stringify(input)}`)
  const t0 = Date.now()
  const deadline = t0 + TRACE_BUDGET_MS
  const query = io.query ?? psql
  const readLogs = io.readLogs ?? ((ids, until) => readLogEvents(ids, LOGS, until, LOG_LINE_CAP))
  let found = collect([input], query, deadline)
  let logs: LogReadResult = {
    events: [],
    truncated: false,
    errors: [],
    windows: [],
  }
  const incomplete = new Set(found.incomplete)
  const clientCandidates = new Set<string>()
  for (let round = 0; round < DISCOVERY_ROUNDS; round++) {
    logs = await readLogs(found.ids, deadline)
    for (const error of logs.errors) incomplete.add(error)
    const extra = new Set(found.ids)
    for (const event of logs.events) {
      if (!Object.entries(event.ids).some(([key, id]) => key !== 'sessionKey' && found.ids.has(id)))
        continue
      if (event.ids.clientTraceId === input && event.ids.traceId)
        clientCandidates.add(event.ids.traceId)
      // Do not follow a canonical id back through a potentially reused client id or session key.
      for (const key of [
        'traceId',
        'dispatchId',
        'requestId',
        'parentTraceId',
        'turnRequestId',
        'billingRequestId',
        'dispatchTraceId',
      ]) {
        const id = event.ids[key]
        if (!id || !ID_RE.test(id) || extra.has(id)) continue
        if (extra.size >= ID_CAP) incomplete.add('id-cap')
        else extra.add(id)
      }
    }
    if (extra.size === found.ids.size) break
    if (round === DISCOVERY_ROUNDS - 1) {
      incomplete.add('log-closure-incomplete')
      break
    }
    found = collect(extra, query, deadline)
    for (const error of found.incomplete) incomplete.add(error)
  }
  if (clientCandidates.size > 1) incomplete.add('ambiguous-client-trace-id')
  const dbEvents = (Object.entries(found.rows) as [Source, Record<string, string>[]][]).flatMap(
    ([source, rows]) => eventsFromRows(source, rows),
  )
  const all = collapseRuns([...dbEvents, ...logs.events])
  const events = all.slice(0, EVENT_CAP)
  const first = firstError(all)
  const firstUncodedError = timeline(all).find((e) => e.level === 'error' && !e.code)
  const start = events[0]?.at
  const truncated = [
    ...found.truncated,
    ...(logs.truncated ? ['logs'] : []),
    ...(all.length > EVENT_CAP ? ['timeline'] : []),
  ]
  return {
    input,
    ids: [...found.ids],
    events,
    firstError: first,
    firstUncodedError,
    clientCandidates: [...clientCandidates],
    pastRetention: start ? pastRetention(start, new Date()) : [],
    retentionNote: 'nominal policies are not proof of deletion; see observed log windows',
    journalRetention: JOURNAL_RETENTION_POLICY,
    logWindows: logs.windows,
    incomplete: [...incomplete],
    truncated,
    containerLogs: `${CONTAINER_LOG_DIR} (tail 20000 lines / 8 MiB; pruned at 14 days or 1 GiB; removed before OCV5-568 left nothing)`,
    seconds: (Date.now() - t0) / 1000,
  }
}

function print(r: Awaited<ReturnType<typeof trace>>, verbose: boolean) {
  const out: string[] = []
  out.push(`oc-trace ${r.input}  ids: ${r.ids.join(' ')}`)
  if (!r.events.length)
    out.push('  no collected events (check the id, incomplete reads and observed evidence windows)')
  for (const e of r.events) {
    const ids = Object.entries(e.ids)
      .map(([k, v]) => `${k}=${v.slice(0, 12)}`)
      .join(' ')
    out.push(
      `  ${e.at}  ${e.source.padEnd(25)} ${e.event}${e.code ? `  [${e.code}]` : ''}${e.count ? `  ×${e.count} until ${e.until}` : ''}${e.level === 'error' ? '  ERROR' : ''}  ${ids}${verbose && e.message ? `  — ${e.message}` : ''}`,
    )
  }
  const f = r.firstError
  out.push(
    f
      ? `first collected error code/event: ${f.code ?? f.event} at ${f.source} (${f.at})`
      : 'first collected error: none found',
  )
  if (r.firstUncodedError && (!f || r.firstUncodedError.at < f.at))
    out.push(`earlier uncoded error: ${r.firstUncodedError.source} (${r.firstUncodedError.at})`)
  if (r.incomplete.length) out.push(`incomplete: ${r.incomplete.join(', ')}`)
  if (r.clientCandidates.length > 1)
    out.push(`ambiguous client id: ${r.clientCandidates.join(' ')}`)
  out.push(`journal GC (by updated_at, not turn age): ${JSON.stringify(r.journalRetention)}`)
  out.push(`observed log windows: ${JSON.stringify(r.logWindows)}`)
  if (r.pastRetention.length)
    out.push(`outside nominal retention (not proof of deletion): ${r.pastRetention.join(', ')}`)
  if (r.truncated.length)
    out.push(
      `truncated: ${r.truncated.join(', ')} (row cap ${ROW_CAP} / log lines ${LOG_LINE_CAP} / timeline ${EVENT_CAP})`,
    )
  out.push(`container logs: ${r.containerLogs}`)
  out.push(
    `nominal retention (days; conditional/durable = -): ${Object.entries(RETENTION_DAYS)
      .map(([s, d]) => `${s} ${d ?? '-'}`)
      .join(', ')}`,
  )
  out.push(`took ${r.seconds.toFixed(1)} s`)
  console.log(redactText(out.join('\n'), 1 << 20))
}

async function drill(n: number, json: boolean) {
  const rows = psql(
    `SELECT dispatch_id, failure_code FROM turn_dispatches WHERE terminal_at IS NOT NULL AND (outcome IN ('crashed', 'executed_error', 'not_accepted') OR (failure_code IS NOT NULL AND failure_code <> 'USER_CANCELLED'))
      ORDER BY terminal_at DESC LIMIT :n`,
    { n: String(n) },
  )
  const results = []
  for (const r of rows) {
    const t = await trace(r.dispatch_id!)
    results.push({
      dispatchId: r.dispatch_id,
      failureCode: r.failure_code,
      firstError: t.firstError
        ? `${t.firstError.code ?? t.firstError.event} @ ${t.firstError.source}`
        : null,
      events: t.events.length,
      logEvents: t.events.filter((e) => e.source.endsWith('-log')).length,
      seconds: Number(t.seconds.toFixed(1)),
      incomplete: t.incomplete,
      truncated: t.truncated,
      hasCode: !!t.firstError?.code,
    })
  }
  if (json) console.log(redactText(JSON.stringify(results, null, 1), 1 << 22))
  else
    for (const x of results)
      console.log(
        redactText(
          `${x.dispatchId}  ${String(x.failureCode).padEnd(28)} first=${x.firstError ?? '-'}  events=${x.events} logs=${x.logEvents}  ${x.seconds}s`,
        ),
      )
  const within = results.filter(
    (x) => x.hasCode && x.seconds <= 60 && !x.incomplete.length && !x.truncated.length,
  ).length
  console.log(
    `drill: ${within}/${results.length} with a first error within 60 s; ${results.filter((x) => x.logEvents === 0).length} with no host-log evidence`,
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const di = argv.indexOf('--drill')
  if (di >= 0) return drill(Math.min(100, Math.max(1, Number(argv[di + 1] ?? 20) || 20)), json)
  const id = argv.find((a) => !a.startsWith('--'))
  if (!id) {
    console.error(
      'usage: oc-trace.ts <traceId|dispatchId|requestId> [--verbose] [--json] | --drill N',
    )
    process.exit(2)
  }
  const r = await trace(id)
  if (json) console.log(redactText(JSON.stringify(r, null, 1), 1 << 22))
  else print(r, argv.includes('--verbose'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[oc-trace] ${(e as Error).message}`)
    process.exit(2)
  })
}
