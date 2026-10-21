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
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText } from '../packages/kernel/src/redact.ts'
import {
  RETENTION_DAYS,
  type Source,
  type TraceEvent,
  collapseRuns,
  eventFromLogLine,
  eventsFromRows,
  firstError,
  parseCsv,
  pastRetention,
  timeline,
} from './lib/ocTraceLib.ts'

const ROW_CAP = 200
const LOG_LINE_CAP = 5000 // raw matching lines read; the timeline is collapsed and capped after
const EVENT_CAP = 400
const DB = process.env.OC_TRACE_DB ?? 'openclaude_v5_selfhost'
const LOG_DIR = process.env.OC_TRACE_LOG_DIR ?? '/var/log'
const LOGS: [Source, RegExp][] = [
  ['master-log', /^openclaude-v5-selfhost\.log(\.\d+(\.gz)?)?$/],
  ['egress-log', /^openclaude-v5-selfhost-egress\.log(\.\d+(\.gz)?)?$/],
]
const ID_RE = /^[0-9A-Za-z_-]{8,128}$/

function psql(sql: string, vars: Record<string, string>): Record<string, string>[] {
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
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000',
    },
    maxBuffer: 1 << 26,
  })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').trim().split('\n')[0]}`)
  return parseCsv(r.stdout)
}

const asArray = (ids: Iterable<string>) => `{${[...ids].map((s) => `"${s}"`).join(',')}}`

interface Found {
  ids: Set<string>
  rows: Partial<Record<Source, Record<string, string>[]>>
  truncated: Source[]
}

/** Collect every id reachable from the input through traces and dispatches (bounded rounds). */
function collect(input: string): Found {
  const ids = new Set([input])
  const rows: Found['rows'] = {}
  const truncated: Source[] = []
  const q = (source: Source, sql: string) => {
    const r = psql(`${sql} LIMIT ${ROW_CAP + 1}`, { ids: asArray(ids) })
    if (r.length > ROW_CAP) truncated.push(source)
    rows[source] = r.slice(0, ROW_CAP)
    return rows[source]!
  }
  for (let round = 0; round < 3; round++) {
    const before = ids.size
    const tr = q(
      'turn_traces',
      `SELECT trace_id, dispatch_id, request_id, user_id, session_key, runtime_container_id, model, created_at, first_visible_at, first_visible_kind, runtime_observed_at
         FROM turn_traces WHERE trace_id = ANY(:'ids'::text[]) OR request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[])`,
    )
    const di = q(
      'turn_dispatches',
      `SELECT dispatch_id, user_id, session_id, billing_request_id, attempt_no, status, outcome, failure_code, model, agent_container_id, admitted_at, accepted_at, last_attempt_at, terminal_at
         FROM turn_dispatches WHERE dispatch_id::text = ANY(:'ids'::text[]) OR billing_request_id = ANY(:'ids'::text[])`,
    )
    for (const r of [...tr, ...di])
      for (const k of ['trace_id', 'dispatch_id', 'request_id', 'billing_request_id'])
        if (r[k] && ID_RE.test(r[k])) ids.add(r[k])
    if (ids.size === before) break
  }
  q(
    'request_finalize_journal',
    `SELECT request_id, dispatch_id, attempt_no, state, failure_code, error_msg IS NOT NULL AS has_error, created_at, updated_at
       FROM request_finalize_journal WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[])`,
  )
  q(
    'usage_records',
    `SELECT request_id, dispatch_id, attempt_no, status, model, cost_credits, error_msg IS NOT NULL AS has_error, created_at
       FROM usage_records WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[])`,
  )
  q(
    'turn_upstream_performance',
    `SELECT request_id, dispatch_id, model, ttft_ms, stream_ms, outcome, observed_at
       FROM turn_upstream_performance WHERE request_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[])`,
  )
  q(
    'turn_runtime_observations',
    `SELECT trace_id, dispatch_id, session_key, duration_ms, tool_calls, observed_at
       FROM turn_runtime_observations WHERE trace_id = ANY(:'ids'::text[]) OR dispatch_id::text = ANY(:'ids'::text[])`,
  )
  return { ids, rows, truncated }
}

function logEvents(ids: Set<string>): { events: TraceEvent[]; truncated: boolean } {
  const events: TraceEvent[] = []
  let truncated = false
  const patterns = [...ids].filter((i) => i.length >= 16).join('\n')
  if (!patterns || !existsSync(LOG_DIR)) return { events, truncated }
  for (const [source, re] of LOGS) {
    for (const f of readdirSync(LOG_DIR).filter((n) => re.test(n))) {
      const file = path.join(LOG_DIR, f)
      const r = spawnSync(f.endsWith('.gz') ? 'zgrep' : 'grep', ['-h', '-F', '-f', '-', file], {
        input: patterns,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      })
      for (const line of (r.stdout || '').split('\n')) {
        if (!line) continue
        if (events.length >= LOG_LINE_CAP) {
          truncated = true
          break
        }
        const e = eventFromLogLine(source, line)
        if (e) events.push(e)
      }
    }
  }
  return { events, truncated }
}

export function trace(input: string) {
  if (!ID_RE.test(input)) throw new Error(`not an id: ${JSON.stringify(input)}`)
  const t0 = Date.now()
  const found = collect(input)
  const dbEvents = (Object.entries(found.rows) as [Source, Record<string, string>[]][]).flatMap(
    ([s, r]) => eventsFromRows(s, r),
  )
  const logs = logEvents(found.ids)
  const all = collapseRuns([...dbEvents, ...logs.events])
  const events = all.slice(0, EVENT_CAP)
  const first = firstError(all)
  const start = events[0]?.at
  return {
    input,
    ids: [...found.ids],
    events,
    firstError: first,
    pastRetention: start ? pastRetention(start, new Date()) : [],
    truncated: [
      ...found.truncated,
      ...(logs.truncated ? (['logs'] as const) : []),
      ...(all.length > EVENT_CAP ? (['timeline'] as const) : []),
    ],
    containerLogs:
      'not retained (container stdout is lost when the container is removed until plan §7.5, P2-g)',
    seconds: (Date.now() - t0) / 1000,
  }
}

function print(r: ReturnType<typeof trace>, verbose: boolean) {
  const out: string[] = []
  out.push(`oc-trace ${r.input}  ids: ${r.ids.join(' ')}`)
  if (!r.events.length)
    out.push('  no events found (check the id, or it is past every retention window)')
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
    f ? `first error: ${f.code ?? f.event} at ${f.source} (${f.at})` : 'first error: none found',
  )
  if (r.pastRetention.length)
    out.push(`past retention (missing events expected): ${r.pastRetention.join(', ')}`)
  if (r.truncated.length)
    out.push(
      `truncated: ${r.truncated.join(', ')} (row cap ${ROW_CAP} / log lines ${LOG_LINE_CAP} / timeline ${EVENT_CAP})`,
    )
  out.push(`container logs: ${r.containerLogs}`)
  out.push(
    `retention (days; durable = -): ${Object.entries(RETENTION_DAYS)
      .map(([s, d]) => `${s} ${d ?? '-'}`)
      .join(', ')}`,
  )
  out.push(`took ${r.seconds.toFixed(1)} s`)
  console.log(redactText(out.join('\n'), 1 << 20))
}

function drill(n: number, json: boolean) {
  const rows = psql(
    `SELECT dispatch_id, failure_code FROM turn_dispatches WHERE failure_code IS NOT NULL AND terminal_at IS NOT NULL
      ORDER BY terminal_at DESC LIMIT :n`,
    { n: String(n) },
  )
  const results = rows.map((r) => {
    const t = trace(r.dispatch_id!)
    return {
      dispatchId: r.dispatch_id,
      failureCode: r.failure_code,
      firstError: t.firstError
        ? `${t.firstError.code ?? t.firstError.event} @ ${t.firstError.source}`
        : null,
      events: t.events.length,
      logEvents: t.events.filter((e) => e.source.endsWith('-log')).length,
      seconds: Number(t.seconds.toFixed(1)),
    }
  })
  if (json) console.log(JSON.stringify(results, null, 1))
  else
    for (const x of results)
      console.log(
        redactText(
          `${x.dispatchId}  ${String(x.failureCode).padEnd(28)} first=${x.firstError ?? '-'}  events=${x.events} logs=${x.logEvents}  ${x.seconds}s`,
        ),
      )
  const within = results.filter((x) => x.firstError && x.seconds <= 60).length
  console.log(
    `drill: ${within}/${results.length} with a first error within 60 s; ${results.filter((x) => x.logEvents === 0).length} with no host-log evidence`,
  )
}

function main() {
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
  const r = trace(id)
  if (json) console.log(redactText(JSON.stringify(r, null, 1), 1 << 22))
  else print(r, argv.includes('--verbose'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    console.error(`[oc-trace] ${(e as Error).message}`)
    process.exit(2)
  }
}
