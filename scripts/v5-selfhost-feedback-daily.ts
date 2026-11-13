#!/usr/bin/env -S npx tsx
/**
 * v5-selfhost-feedback-daily.ts — 个人版只读反馈日报。
 *
 * 宿主上手工或 cron 跑。不进 master 进程，不发站内信，不开单，不写业务表，不改 crontab。
 * 连接只走本机 postgres peer。不读连接串。
 *
 *   npx tsx scripts/v5-selfhost-feedback-daily.ts [--dry-run] [--days 7] [--date YYYY-MM-DD] [--include-765]
 *
 * 退出码: 0 成功; 2 PG 失败（不写文件）; 4 参数错误。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXIT = { ok: 0, pg: 2, usage: 4 } as const
export const OUT_DIR = '/opt/openclaude/var/feedback-daily'
export const TRACE_RE = /^[A-Za-z0-9_-]{8,128}$/
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SQL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08$/

const USAGE = `用法: npx tsx scripts/v5-selfhost-feedback-daily.ts [选项]
  --dry-run       只把 markdown 打到 stdout，不写文件
  --days N        窗口天数（1..366，默认 7）
  --date YYYY-MM-DD  CST 截止日期，窗口到该日 23:59:59+08
  --include-765   主体计入验收号 765（默认排除）
`

export interface CliOptions {
  days: number
  dryRun: boolean
  date: string
  include765: boolean
  help: boolean
}

export interface Sample {
  traceIds: string[]
  sessionIds: string[]
}

export interface Report {
  date: string
  days: number
  windowStart: string
  windowEnd: string
  include765: boolean
  daily: Array<{ day: string; completed: number; other: number }>
  nonComplete: Array<{ failureCode: string; outcome: string; n: number; traceIds: string[] }>
  models: Array<{ model: string; completed: number; other: number; topFailureCode: string; traceIds: string[] }>
  tools: {
    buckets: Array<{ outcome: string; failureKind: string; calls: number }>
    totalCalls: number
    failedCalls: number
    timeoutCalls: number
    top: Array<{ tool: string; failures: number; traceIds: string[] }>
    timeoutTraceIds: string[]
  }
  recovery: {
    groups: Array<{ status: string; errorCode: string; outcome: string; n: number; traceIds: string[] }>
    joinedNotCompleted: number
    noDispatch: number
  }
  stops: {
    groups: Array<{ status: string; errorCode: string; n: number }>
    userCancelledTraceIds: string[]
  }
  ratings: {
    explicitUp: number
    explicitDown: number
    implicitInterrupt: number
    implicitRewrite: number
    implicitOther: number
    samples: {
      explicitUp: Sample
      explicitDown: Sample
      implicitInterrupt: Sample
      implicitRewrite: Sample
      implicitOther: Sample
    }
    nudges: { exposed: number; rated: number; dismissed: number; sample: Sample }
  }
  sameAsk: {
    groups: number
    turns: number
    pairs10m: number
    laterGroupTraceIds: string[]
    laterPairTraceIds: string[]
  }
  abandoned: { total: number; interrupted: number; traceIds: string[] }
  modelSwitch: { n: number; traceIds: string[] }
  friction: Array<{ code: string; rows: number; sessions: number; distinctTraces: number; traceIds: string[] }>
  journal: Array<{ failureCode: string; rows: number }>
  serviceRestart: {
    n: number
    p50Seconds: number | null
    maxSeconds: number | null
    ge1800: number
    traceIds: string[]
  }
  trains: { missing: true } | { missing: false; finalTrue: number; finalFalse: number }
}

export interface WindowBounds {
  startMs: number
  endMs: number
  endExclusiveMs: number
  startText: string
  endText: string
  startSql: string
  endExclusiveSql: string
}

export function redact(text: string): string {
  return text.replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://<redacted>')
}

/** Asia/Shanghai is UTC+8 with no daylight-saving shift. */
export function formatCst(d: Date): string {
  const shifted = new Date(d.getTime() + 8 * 3_600_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}+08`
}

export function cstDate(now = new Date()): string {
  return formatCst(now).slice(0, 10)
}

export function assertDate(value: string): string {
  if (!DATE_RE.test(value)) throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(value)}`)
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(value)}`)
  }
  return value
}

export function parseDays(value: string): number {
  if (!/^\d{1,3}$/.test(value)) throw new Error(`--days must be 1..366, got ${JSON.stringify(value)}`)
  const n = Number(value)
  if (n < 1 || n > 366) throw new Error(`--days must be 1..366, got ${n}`)
  return n
}

export function parseArgs(argv: string[], now = new Date()): CliOptions {
  const opts: CliOptions = {
    days: 7,
    dryRun: false,
    date: cstDate(now),
    include765: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true
        break
      case '--days':
        opts.days = parseDays(next())
        break
      case '--date':
        opts.date = assertDate(next())
        break
      case '--include-765':
        opts.include765 = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  return opts
}

export function windowBounds(date: string, days: number): WindowBounds {
  const end = new Date(`${assertDate(date)}T23:59:59+08:00`)
  if (Number.isNaN(end.getTime())) throw new Error(`bad date ${date}`)
  const start = new Date(end.getTime() - days * 86_400_000)
  const endExclusive = new Date(end.getTime() + 1000)
  const startSql = formatCst(start)
  const endExclusiveSql = formatCst(endExclusive)
  if (!SQL_TS_RE.test(startSql) || !SQL_TS_RE.test(endExclusiveSql)) {
    throw new Error('window timestamp failed to format')
  }
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    endExclusiveMs: endExclusive.getTime(),
    startText: formatCst(start),
    endText: formatCst(end),
    startSql,
    endExclusiveSql,
  }
}

/** Subject cohort. include765 omits the acceptance-account predicate entirely. */
export function userPredicate(include765: boolean, alias = ''): string {
  if (include765) return 'TRUE'
  const p = alias ? `${alias}.` : ''
  return `${p}user_id <> 765`
}

export function hPredicate(include765: boolean, alias = '', cmid = 'client_message_id'): string {
  const p = alias ? `${alias}.` : ''
  return [
    userPredicate(include765, alias),
    `${p}session_id LIKE 'web%'`,
    `${p}${cmid} LIKE 'm-%'`,
    `${p}${cmid} NOT LIKE 'm-recover-%'`,
  ].join(' AND ')
}

export function webUserPredicate(include765: boolean, alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return `${userPredicate(include765, alias)} AND ${p}session_id LIKE 'web%'`
}

export function cohortLines(include765: boolean): { h: string; ex: string } {
  if (include765) {
    return {
      h: "H：含验收号 765，session_id LIKE 'web%'，client_message_id LIKE 'm-%'，client_message_id NOT LIKE 'm-recover-%'。时间列默认 admitted_at。",
      ex: 'ex765：--include-765，主体含验收号 765。工具、评分、摩擦、引导与回合用同一人群。',
    }
  }
  return {
    h: "H：user_id <> 765，session_id LIKE 'web%'，client_message_id LIKE 'm-%'，client_message_id NOT LIKE 'm-recover-%'。时间列默认 admitted_at。",
    ex: 'ex765：user_id <> 765。工具、评分、摩擦、引导用 ex765，不用 H 的 client_message_id 条件。',
  }
}

export function traceCommands(ids: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!TRACE_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(`npx tsx scripts/oc-trace.ts ${id}`)
    if (out.length >= 3) break
  }
  return out
}

/** Integer comparison so 20% and 50% do not depend on binary fractions. */
export function modelHot(completed: number, other: number): boolean {
  const n = completed + other
  if (n >= 5 && other * 2 >= n) return true
  if (n >= 10 && other * 5 >= n) return true
  return false
}

function win(column: string, bounds: WindowBounds): string {
  return `${column} >= timestamptz '${bounds.startSql}' AND ${column} < timestamptz '${bounds.endExclusiveSql}'`
}

function section(name: string, dataSql: string): string {
  return `SELECT json_build_object('section', '${name}', 'data', ${dataSql});\n`
}

const FAILED_CALL = `(c.outcome IS DISTINCT FROM 'success' OR COALESCE(c.failure_kind, 'none') IS DISTINCT FROM 'none')`

const RATING = {
  explicitUp: `rating = 'up' AND NOT ('implicit' = ANY(COALESCE(tags, ARRAY[]::text[])))`,
  explicitDown: `rating = 'down' AND NOT ('implicit' = ANY(COALESCE(tags, ARRAY[]::text[])))`,
  interrupt: `'implicit' = ANY(COALESCE(tags, ARRAY[]::text[])) AND '中途打断' = ANY(COALESCE(tags, ARRAY[]::text[]))`,
  rewrite: `'implicit' = ANY(COALESCE(tags, ARRAY[]::text[])) AND '改写重发' = ANY(COALESCE(tags, ARRAY[]::text[]))`,
  other: `'implicit' = ANY(COALESCE(tags, ARRAY[]::text[])) AND NOT ('中途打断' = ANY(COALESCE(tags, ARRAY[]::text[]))) AND NOT ('改写重发' = ANY(COALESCE(tags, ARRAY[]::text[])))`,
} as const

function ratingSample(where: string, user: string, window: string): string {
  return `COALESCE((
    SELECT json_agg(json_build_object('traceId', trace_id, 'sessionId', session_id) ORDER BY created_at DESC)
    FROM (
      SELECT trace_id, session_id, created_at
      FROM response_rating
      WHERE ${user} AND ${window} AND ${where}
      ORDER BY created_at DESC
      LIMIT 8
    ) s
  ), '[]'::json)`
}

export function buildFeedbackSql(opts: Pick<CliOptions, 'date' | 'days' | 'include765'>): string {
  const bounds = windowBounds(opts.date, opts.days)
  const inc = opts.include765
  const h = hPredicate(inc)
  const hd = hPredicate(inc, 'd')
  const hx = hPredicate(inc, 'x')
  const stop = hPredicate(inc, 'c', 'root_client_message_id')
  const ex = userPredicate(inc)
  const exa = userPredicate(inc, 'a')
  const exr = userPredicate(inc, 'r')
  const exj = webUserPredicate(inc, 'j')
  const wAdmitted = win('admitted_at', bounds)
  const wAdmittedD = win('d.admitted_at', bounds)
  const wAdmittedX = win('x.admitted_at', bounds)
  const wTerminal = win('terminal_at', bounds)
  const wWindow = win('r.window_ended_at', bounds)
  const wOccurred = win('a.occurred_at', bounds)
  const wCreatedJ = win('j.created_at', bounds)
  const wCreatedC = win('c.created_at', bounds)
  const wRating = win('created_at', bounds)
  const wExposed = win('exposed_at', bounds)
  const wFriction = win('created_at', bounds)
  const wJournal = win('j.updated_at', bounds)
  const parts: string[] = []
  parts.push('BEGIN READ ONLY;\n')
  parts.push("SET LOCAL statement_timeout = '20s';\n")
  parts.push("SET LOCAL TIME ZONE 'Asia/Shanghai';\n")
  parts.push('SET LOCAL default_transaction_read_only = on;\n')

  parts.push(
    section(
      'daily',
      `COALESCE((
        SELECT json_agg(json_build_object('day', day, 'completed', completed, 'other', other) ORDER BY day)
        FROM (
          SELECT to_char((admitted_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
                 COUNT(*) FILTER (WHERE outcome = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE outcome IS DISTINCT FROM 'completed') AS other
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted}
          GROUP BY 1
          ORDER BY 1
          LIMIT 400
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'nonComplete',
      `COALESCE((
        SELECT json_agg(json_build_object('failureCode', failure_code, 'outcome', outcome, 'n', n) ORDER BY n DESC, failure_code, outcome)
        FROM (
          SELECT COALESCE(failure_code, '') AS failure_code,
                 COALESCE(outcome, '') AS outcome,
                 COUNT(*) AS n
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted} AND outcome IS DISTINCT FROM 'completed'
          GROUP BY 1, 2
          ORDER BY n DESC, 1, 2
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'nonCompleteTraces',
      `COALESCE((
        SELECT json_agg(json_build_object('failureCode', failure_code, 'outcome', outcome, 'traceId', trace_id))
        FROM (
          SELECT failure_code, outcome, trace_id
          FROM (
            SELECT COALESCE(failure_code, '') AS failure_code,
                   COALESCE(outcome, '') AS outcome,
                   trace_id,
                   row_number() OVER (
                     PARTITION BY COALESCE(failure_code, ''), COALESCE(outcome, '')
                     ORDER BY admitted_at DESC
                   ) AS rn
            FROM turn_dispatches
            WHERE ${h} AND ${wAdmitted}
              AND outcome IS DISTINCT FROM 'completed'
              AND trace_id IS NOT NULL
          ) s
          WHERE rn <= 5
          LIMIT 200
        ) z
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'models',
      `COALESCE((
        SELECT json_agg(json_build_object(
          'model', model, 'completed', completed, 'other', other, 'topFailureCode', top_failure
        ) ORDER BY other DESC, n DESC, model)
        FROM (
          SELECT COALESCE(d.model, '') AS model,
                 COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE d.outcome = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE d.outcome IS DISTINCT FROM 'completed') AS other,
                 COALESCE((
                   SELECT COALESCE(x.failure_code, '')
                   FROM turn_dispatches x
                   WHERE ${hx} AND ${wAdmittedX}
                     AND COALESCE(x.model, '') = COALESCE(d.model, '')
                     AND x.outcome IS DISTINCT FROM 'completed'
                   GROUP BY COALESCE(x.failure_code, '')
                   ORDER BY COUNT(*) DESC, COALESCE(x.failure_code, '')
                   LIMIT 1
                 ), '') AS top_failure
          FROM turn_dispatches d
          WHERE ${hd} AND ${wAdmittedD}
          GROUP BY d.model
          HAVING COUNT(*) >= 5
          ORDER BY COUNT(*) FILTER (WHERE d.outcome IS DISTINCT FROM 'completed') DESC, COUNT(*) DESC
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'modelTraces',
      `COALESCE((
        SELECT json_agg(json_build_object('model', model, 'traceId', trace_id))
        FROM (
          SELECT model, trace_id
          FROM (
            SELECT COALESCE(model, '') AS model,
                   trace_id,
                   row_number() OVER (PARTITION BY COALESCE(model, '') ORDER BY admitted_at DESC) AS rn
            FROM turn_dispatches
            WHERE ${h} AND ${wAdmitted}
              AND outcome IS DISTINCT FROM 'completed'
              AND trace_id IS NOT NULL
          ) s
          WHERE rn <= 5
          LIMIT 200
        ) z
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'toolBuckets',
      `COALESCE((
        SELECT json_agg(json_build_object('outcome', outcome, 'failureKind', failure_kind, 'calls', calls) ORDER BY calls DESC)
        FROM (
          SELECT COALESCE(c.outcome, '') AS outcome,
                 COALESCE(c.failure_kind, '') AS failure_kind,
                 SUM(c.call_count) AS calls
          FROM agent_tool_rollup_counts c
          JOIN agent_tool_rollup_reports r ON r.report_id = c.report_id
          WHERE ${exr} AND ${wWindow}
          GROUP BY 1, 2
          ORDER BY SUM(c.call_count) DESC
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'toolTotals',
      `(
        SELECT json_build_object(
          'total', COALESCE(SUM(c.call_count), 0),
          'failed', COALESCE(SUM(c.call_count) FILTER (WHERE ${FAILED_CALL}), 0),
          'timeout', COALESCE(SUM(c.call_count) FILTER (WHERE c.failure_kind = 'timeout'), 0)
        )
        FROM agent_tool_rollup_counts c
        JOIN agent_tool_rollup_reports r ON r.report_id = c.report_id
        WHERE ${exr} AND ${wWindow}
      )`,
    ),
  )

  parts.push(
    section(
      'toolTop',
      `COALESCE((
        SELECT json_agg(json_build_object('tool', tool, 'failures', failures) ORDER BY failures DESC, tool)
        FROM (
          SELECT c.tool AS tool,
                 COALESCE(SUM(c.call_count) FILTER (WHERE ${FAILED_CALL}), 0) AS failures
          FROM agent_tool_rollup_counts c
          JOIN agent_tool_rollup_reports r ON r.report_id = c.report_id
          WHERE ${exr} AND ${wWindow}
          GROUP BY c.tool
          HAVING COALESCE(SUM(c.call_count) FILTER (WHERE ${FAILED_CALL}), 0) > 0
          ORDER BY failures DESC, c.tool
          LIMIT 10
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'toolTimeout',
      `COALESCE((
        SELECT json_agg(tool ORDER BY tool)
        FROM (
          SELECT c.tool AS tool
          FROM agent_tool_rollup_counts c
          JOIN agent_tool_rollup_reports r ON r.report_id = c.report_id
          WHERE ${exr} AND ${wWindow} AND c.failure_kind = 'timeout'
          GROUP BY c.tool
          ORDER BY c.tool
          LIMIT 20
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'auditTraces',
      `COALESCE((
        SELECT json_agg(json_build_object('tool', tool, 'traceId', trace_id))
        FROM (
          SELECT tool, trace_id
          FROM (
            SELECT a.tool AS tool,
                   a.trace_id AS trace_id,
                   row_number() OVER (PARTITION BY a.tool ORDER BY a.occurred_at DESC) AS rn
            FROM agent_audit a
            WHERE ${exa} AND ${wOccurred} AND a.success = false AND a.trace_id IS NOT NULL AND a.trace_id <> ''
          ) s
          WHERE rn <= 5
          LIMIT 500
        ) z
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'recoveryGroups',
      `COALESCE((
        SELECT json_agg(json_build_object('status', status, 'errorCode', error_code, 'outcome', outcome, 'n', n) ORDER BY n DESC, status, error_code, outcome)
        FROM (
          SELECT COALESCE(j.status, '') AS status,
                 COALESCE(j.error_code, '') AS error_code,
                 CASE WHEN j.dispatch_id IS NULL THEN '（无 dispatch）' ELSE COALESCE(d.outcome, '（无回合）') END AS outcome,
                 COUNT(*) AS n
          FROM turn_recovery_jobs j
          LEFT JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
          WHERE ${exj} AND ${wCreatedJ}
          GROUP BY 1, 2, 3
          ORDER BY n DESC, 1, 2, 3
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'recoveryTotals',
      `(
        SELECT json_build_object(
          'joinedNotCompleted', COUNT(*) FILTER (
            WHERE j.dispatch_id IS NOT NULL AND d.outcome IS DISTINCT FROM 'completed'
          ),
          'noDispatch', COUNT(*) FILTER (WHERE j.dispatch_id IS NULL)
        )
        FROM turn_recovery_jobs j
        LEFT JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
        WHERE ${exj} AND ${wCreatedJ}
      )`,
    ),
  )

  parts.push(
    section(
      'recoveryTraces',
      `COALESCE((
        SELECT json_agg(json_build_object('status', status, 'errorCode', error_code, 'outcome', outcome, 'traceId', trace_id))
        FROM (
          SELECT COALESCE(j.status, '') AS status,
                 COALESCE(j.error_code, '') AS error_code,
                 CASE WHEN j.dispatch_id IS NULL THEN '（无 dispatch）' ELSE COALESCE(d.outcome, '（无回合）') END AS outcome,
                 d.trace_id AS trace_id
          FROM turn_recovery_jobs j
          LEFT JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
          WHERE ${exj} AND ${wCreatedJ} AND d.trace_id IS NOT NULL
          ORDER BY j.created_at DESC
          LIMIT 200
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'stops',
      `COALESCE((
        SELECT json_agg(json_build_object('status', status, 'errorCode', error_code, 'n', n) ORDER BY n DESC, status, error_code)
        FROM (
          SELECT COALESCE(c.status, '') AS status,
                 COALESCE(c.error_code, '') AS error_code,
                 COUNT(*) AS n
          FROM turn_control_requests c
          WHERE c.kind = 'stop' AND ${stop} AND ${wCreatedC}
          GROUP BY 1, 2
          ORDER BY n DESC, 1, 2
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'cancelled',
      `COALESCE((
        SELECT json_agg(trace_id ORDER BY admitted_at DESC)
        FROM (
          SELECT trace_id, admitted_at
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted} AND failure_code = 'USER_CANCELLED' AND trace_id IS NOT NULL
          ORDER BY admitted_at DESC
          LIMIT 8
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'ratingCounts',
      `(
        SELECT json_build_object(
          'explicitUp', COUNT(*) FILTER (WHERE ${RATING.explicitUp}),
          'explicitDown', COUNT(*) FILTER (WHERE ${RATING.explicitDown}),
          'implicitInterrupt', COUNT(*) FILTER (WHERE ${RATING.interrupt}),
          'implicitRewrite', COUNT(*) FILTER (WHERE ${RATING.rewrite}),
          'implicitOther', COUNT(*) FILTER (WHERE ${RATING.other})
        )
        FROM response_rating
        WHERE ${ex} AND ${wRating}
      )`,
    ),
  )

  parts.push(
    section(
      'ratingSamples',
      `json_build_object(
        'explicitUp', ${ratingSample(RATING.explicitUp, ex, wRating)},
        'explicitDown', ${ratingSample(RATING.explicitDown, ex, wRating)},
        'implicitInterrupt', ${ratingSample(RATING.interrupt, ex, wRating)},
        'implicitRewrite', ${ratingSample(RATING.rewrite, ex, wRating)},
        'implicitOther', ${ratingSample(RATING.other, ex, wRating)}
      )`,
    ),
  )

  parts.push(
    section(
      'nudgeCounts',
      `(
        SELECT json_build_object(
          'exposed', COUNT(*),
          'rated', COUNT(rated_at),
          'dismissed', COUNT(dismissed_at)
        )
        FROM response_rating_nudges
        WHERE ${ex} AND ${wExposed}
      )`,
    ),
  )

  parts.push(
    section(
      'nudgeSamples',
      `COALESCE((
        SELECT json_agg(json_build_object('traceId', trace_id, 'sessionId', session_id) ORDER BY exposed_at DESC)
        FROM (
          SELECT trace_id, session_id, exposed_at
          FROM response_rating_nudges
          WHERE ${ex} AND ${wExposed}
          ORDER BY exposed_at DESC
          LIMIT 8
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'sameAsk',
      `(
        WITH h AS (
          SELECT dispatch_id, trace_id, request_hash, admitted_at
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted} AND request_hash IS NOT NULL
        ),
        dup AS (
          SELECT request_hash
          FROM h
          GROUP BY request_hash
          HAVING COUNT(*) >= 2
        )
        SELECT json_build_object(
          'groups', (SELECT COUNT(*) FROM dup),
          'turns', (
            SELECT COUNT(*)
            FROM h
            JOIN dup d ON d.request_hash = h.request_hash
          ),
          'pairs', (
            SELECT COUNT(*)
            FROM h a
            JOIN h b ON a.request_hash = b.request_hash
              AND b.admitted_at > a.admitted_at
              AND b.admitted_at <= a.admitted_at + interval '10 minutes'
          ),
          'groupTraces', COALESCE((
            SELECT json_agg(trace_id ORDER BY admitted_at DESC)
            FROM (
              SELECT h.trace_id AS trace_id, h.admitted_at
              FROM h
              JOIN dup d ON d.request_hash = h.request_hash
              WHERE h.trace_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM h h2
                  WHERE h2.request_hash = h.request_hash
                    AND (h2.admitted_at > h.admitted_at
                      OR (h2.admitted_at = h.admitted_at AND h2.dispatch_id > h.dispatch_id))
                )
              ORDER BY h.admitted_at DESC
              LIMIT 8
            ) s
          ), '[]'::json),
          'pairTraces', COALESCE((
            SELECT json_agg(trace_id ORDER BY admitted_at DESC)
            FROM (
              SELECT b.trace_id AS trace_id, b.admitted_at
              FROM h a
              JOIN h b ON a.request_hash = b.request_hash
                AND b.admitted_at > a.admitted_at
                AND b.admitted_at <= a.admitted_at + interval '10 minutes'
              WHERE b.trace_id IS NOT NULL
              ORDER BY b.admitted_at DESC
              LIMIT 8
            ) s
          ), '[]'::json)
        )
      )`,
    ),
  )

  parts.push(
    section(
      'abandoned',
      `(
        WITH h AS (
          SELECT dispatch_id, admitted_at, outcome, trace_id,
                 lead(admitted_at) OVER (
                   PARTITION BY user_id, session_id
                   ORDER BY admitted_at, dispatch_id
                 ) AS next_at
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted}
        ),
        gone AS (
          SELECT admitted_at, outcome, trace_id
          FROM h
          WHERE outcome IS DISTINCT FROM 'completed'
            AND (next_at IS NULL OR next_at > admitted_at + interval '30 minutes')
        )
        SELECT json_build_object(
          'total', (SELECT COUNT(*) FROM gone),
          'interrupted', (SELECT COUNT(*) FROM gone WHERE outcome = 'interrupted'),
          'traces', COALESCE((
            SELECT json_agg(trace_id ORDER BY admitted_at DESC)
            FROM (
              SELECT trace_id, admitted_at
              FROM gone
              WHERE trace_id IS NOT NULL
              ORDER BY admitted_at DESC
              LIMIT 8
            ) s
          ), '[]'::json)
        )
      )`,
    ),
  )

  parts.push(
    section(
      'switches',
      `(
        WITH h AS (
          SELECT admitted_at, model, trace_id,
                 lag(model) OVER (
                   PARTITION BY user_id, session_id
                   ORDER BY admitted_at, dispatch_id
                 ) AS prev_model
          FROM turn_dispatches
          WHERE ${h} AND ${wAdmitted}
        ),
        switched AS (
          SELECT admitted_at, trace_id
          FROM h
          WHERE prev_model IS NOT NULL AND prev_model IS DISTINCT FROM model
        )
        SELECT json_build_object(
          'n', (SELECT COUNT(*) FROM switched),
          'traces', COALESCE((
            SELECT json_agg(trace_id ORDER BY admitted_at DESC)
            FROM (
              SELECT trace_id, admitted_at
              FROM switched
              WHERE trace_id IS NOT NULL
              ORDER BY admitted_at DESC
              LIMIT 8
            ) s
          ), '[]'::json)
        )
      )`,
    ),
  )

  parts.push(
    section(
      'friction',
      `COALESCE((
        SELECT json_agg(json_build_object(
          'code', code, 'rows', rows, 'sessions', sessions, 'distinctTraces', distinct_traces
        ) ORDER BY rows DESC, code)
        FROM (
          SELECT COALESCE(code, '') AS code,
                 COUNT(*) AS rows,
                 COUNT(DISTINCT session_id) AS sessions,
                 COUNT(DISTINCT trace_id) AS distinct_traces
          FROM product_friction_events
          WHERE ${ex} AND ${wFriction}
          GROUP BY 1
          ORDER BY COUNT(*) DESC, 1
          LIMIT 15
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'frictionTraces',
      `COALESCE((
        SELECT json_agg(json_build_object('code', code, 'traceId', trace_id))
        FROM (
          SELECT code, trace_id
          FROM (
            SELECT COALESCE(code, '') AS code,
                   trace_id,
                   row_number() OVER (PARTITION BY COALESCE(code, '') ORDER BY created_at DESC) AS rn
            FROM product_friction_events
            WHERE ${ex} AND ${wFriction} AND trace_id IS NOT NULL AND trace_id <> ''
          ) s
          WHERE rn <= 5
          LIMIT 200
        ) z
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'journal',
      `COALESCE((
        SELECT json_agg(json_build_object('failureCode', failure_code, 'rows', n) ORDER BY n DESC, failure_code)
        FROM (
          SELECT COALESCE(j.failure_code, '') AS failure_code,
                 COUNT(*) AS n
          FROM request_finalize_journal j
          JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
          WHERE j.state = 'aborted' AND ${wJournal} AND ${hd}
          GROUP BY 1
          ORDER BY n DESC, 1
          LIMIT 50
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push(
    section(
      'restart',
      `(
        SELECT json_build_object(
          'n', COUNT(*),
          'p50', percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (terminal_at - COALESCE(accepted_at, admitted_at)))
          ),
          'max', MAX(EXTRACT(EPOCH FROM (terminal_at - COALESCE(accepted_at, admitted_at)))),
          'ge1800', COUNT(*) FILTER (
            WHERE EXTRACT(EPOCH FROM (terminal_at - COALESCE(accepted_at, admitted_at))) >= 1800
          )
        )
        FROM turn_dispatches
        WHERE ${h} AND failure_code = 'SERVICE_RESTART' AND ${wTerminal}
      )`,
    ),
  )

  parts.push(
    section(
      'restartTraces',
      `COALESCE((
        SELECT json_agg(trace_id ORDER BY dur DESC)
        FROM (
          SELECT trace_id,
                 EXTRACT(EPOCH FROM (terminal_at - COALESCE(accepted_at, admitted_at))) AS dur
          FROM turn_dispatches
          WHERE ${h} AND failure_code = 'SERVICE_RESTART' AND ${wTerminal} AND trace_id IS NOT NULL
          ORDER BY (terminal_at - COALESCE(accepted_at, admitted_at)) DESC NULLS LAST
          LIMIT 8
        ) s
      ), '[]'::json)`,
    ),
  )

  parts.push('ROLLBACK;\n')
  return parts.join('')
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => str(item)).filter((item) => item.length > 0)
}

function round1(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 10) / 10
}

function takeValid(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!TRACE_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= 3) break
  }
  return out
}

function sampleOf(value: unknown): Sample {
  const traces: string[] = []
  const sessions: string[] = []
  for (const row of rowsOf(value)) {
    const traceId = str(row.traceId)
    const sessionId = str(row.sessionId)
    if (traceId) traces.push(traceId)
    if (sessionId) sessions.push(sessionId)
  }
  const traceIds = takeValid(traces)
  if (traceIds.length > 0) return { traceIds, sessionIds: [] }
  const sessionIds: string[] = []
  const seen = new Set<string>()
  for (const id of sessions) {
    if (!SESSION_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    sessionIds.push(id)
    if (sessionIds.length >= 3) break
  }
  return { traceIds: [], sessionIds }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const REQUIRED_SECTIONS = [
  'daily',
  'nonComplete',
  'nonCompleteTraces',
  'models',
  'modelTraces',
  'toolBuckets',
  'toolTotals',
  'toolTop',
  'toolTimeout',
  'auditTraces',
  'recoveryGroups',
  'recoveryTotals',
  'recoveryTraces',
  'stops',
  'cancelled',
  'ratingCounts',
  'ratingSamples',
  'nudgeCounts',
  'nudgeSamples',
  'sameAsk',
  'abandoned',
  'switches',
  'friction',
  'frictionTraces',
  'journal',
  'restart',
  'restartTraces',
] as const

export function parseSections(stdout: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    const parsed = JSON.parse(trimmed) as { section?: unknown; data?: unknown }
    const name = str(parsed.section)
    if (!name) throw new Error('missing section')
    out[name] = parsed.data ?? null
  }
  const missing = REQUIRED_SECTIONS.filter((name) => !(name in out))
  if (missing.length > 0) throw new Error(`missing section ${missing.join(',')}`)
  return out
}

function tracesBy(rows: Array<Record<string, unknown>>, key: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const id = str(row[key])
    const traceId = str(row.traceId)
    const list = map.get(id) ?? []
    list.push(traceId)
    map.set(id, list)
  }
  return map
}

export function mapSections(
  sections: Record<string, unknown>,
  opts: Pick<CliOptions, 'date' | 'days' | 'include765'>,
  trains: Report['trains'],
): Report {
  const bounds = windowBounds(opts.date, opts.days)
  const nonRows = rowsOf(sections.nonComplete)
  const nonTraceRows = rowsOf(sections.nonCompleteTraces)
  const perCode = new Map<string, string[]>()
  const nonComplete = nonRows.map((row) => {
    const failureCode = str(row.failureCode)
    const outcome = str(row.outcome)
    const have = perCode.get(failureCode) ?? []
    const found = nonTraceRows
      .filter((item) => str(item.failureCode) === failureCode && str(item.outcome) === outcome)
      .map((item) => str(item.traceId))
    const traceIds: string[] = []
    for (const id of found) {
      if (have.length >= 3) break
      if (!TRACE_RE.test(id) || have.includes(id)) continue
      have.push(id)
      traceIds.push(id)
    }
    perCode.set(failureCode, have)
    return { failureCode, outcome, n: num(row.n), traceIds }
  })

  const modelTraceMap = tracesBy(rowsOf(sections.modelTraces), 'model')
  const models = rowsOf(sections.models).map((row) => {
    const model = str(row.model)
    return {
      model,
      completed: num(row.completed),
      other: num(row.other),
      topFailureCode: str(row.topFailureCode),
      traceIds: takeValid(modelTraceMap.get(model) ?? []),
    }
  })

  const auditMap = tracesBy(rowsOf(sections.auditTraces), 'tool')
  const timeoutTools = new Set(idsOf(sections.toolTimeout))
  const timeoutTraceIds = takeValid(
    [...timeoutTools].flatMap((tool) => auditMap.get(tool) ?? []),
  )
  const totals = obj(sections.toolTotals)
  const tools = {
    buckets: rowsOf(sections.toolBuckets).map((row) => ({
      outcome: str(row.outcome),
      failureKind: str(row.failureKind),
      calls: num(row.calls),
    })),
    totalCalls: num(totals.total),
    failedCalls: num(totals.failed),
    timeoutCalls: num(totals.timeout),
    top: rowsOf(sections.toolTop).map((row) => ({
      tool: str(row.tool),
      failures: num(row.failures),
      traceIds: takeValid(auditMap.get(str(row.tool)) ?? []),
    })),
    timeoutTraceIds,
  }

  const recoveryTraceRows = rowsOf(sections.recoveryTraces)
  const recoveryTaken = new Map<string, string[]>()
  const recoveryGroups = rowsOf(sections.recoveryGroups).map((row) => {
    const status = str(row.status)
    const errorCode = str(row.errorCode)
    const outcome = str(row.outcome)
    const key = `${status}\0${errorCode}\0${outcome}`
    const have = recoveryTaken.get(key) ?? []
    const found = recoveryTraceRows
      .filter((item) => str(item.status) === status && str(item.errorCode) === errorCode && str(item.outcome) === outcome)
      .map((item) => str(item.traceId))
    const traceIds: string[] = []
    for (const id of found) {
      if (have.length >= 3) break
      if (!TRACE_RE.test(id) || have.includes(id)) continue
      have.push(id)
      traceIds.push(id)
    }
    recoveryTaken.set(key, have)
    return { status, errorCode, outcome, n: num(row.n), traceIds }
  })
  const recoveryTotals = obj(sections.recoveryTotals)
  const ratingCounts = obj(sections.ratingCounts)
  const ratingSamples = obj(sections.ratingSamples)
  const nudgeCounts = obj(sections.nudgeCounts)
  const same = obj(sections.sameAsk)
  const abandoned = obj(sections.abandoned)
  const switches = obj(sections.switches)
  const frictionTraceMap = tracesBy(rowsOf(sections.frictionTraces), 'code')
  const restart = obj(sections.restart)

  return {
    date: opts.date,
    days: opts.days,
    windowStart: bounds.startText,
    windowEnd: bounds.endText,
    include765: opts.include765,
    daily: rowsOf(sections.daily).map((row) => ({
      day: str(row.day),
      completed: num(row.completed),
      other: num(row.other),
    })),
    nonComplete,
    models,
    tools,
    recovery: {
      groups: recoveryGroups,
      joinedNotCompleted: num(recoveryTotals.joinedNotCompleted),
      noDispatch: num(recoveryTotals.noDispatch),
    },
    stops: {
      groups: rowsOf(sections.stops).map((row) => ({
        status: str(row.status),
        errorCode: str(row.errorCode),
        n: num(row.n),
      })),
      userCancelledTraceIds: takeValid(idsOf(sections.cancelled)),
    },
    ratings: {
      explicitUp: num(ratingCounts.explicitUp),
      explicitDown: num(ratingCounts.explicitDown),
      implicitInterrupt: num(ratingCounts.implicitInterrupt),
      implicitRewrite: num(ratingCounts.implicitRewrite),
      implicitOther: num(ratingCounts.implicitOther),
      samples: {
        explicitUp: sampleOf(ratingSamples.explicitUp),
        explicitDown: sampleOf(ratingSamples.explicitDown),
        implicitInterrupt: sampleOf(ratingSamples.implicitInterrupt),
        implicitRewrite: sampleOf(ratingSamples.implicitRewrite),
        implicitOther: sampleOf(ratingSamples.implicitOther),
      },
      nudges: {
        exposed: num(nudgeCounts.exposed),
        rated: num(nudgeCounts.rated),
        dismissed: num(nudgeCounts.dismissed),
        sample: sampleOf(sections.nudgeSamples),
      },
    },
    sameAsk: {
      groups: num(same.groups),
      turns: num(same.turns),
      pairs10m: num(same.pairs),
      laterGroupTraceIds: takeValid(idsOf(same.groupTraces)),
      laterPairTraceIds: takeValid(idsOf(same.pairTraces)),
    },
    abandoned: {
      total: num(abandoned.total),
      interrupted: num(abandoned.interrupted),
      traceIds: takeValid(idsOf(abandoned.traces)),
    },
    modelSwitch: {
      n: num(switches.n),
      traceIds: takeValid(idsOf(switches.traces)),
    },
    friction: rowsOf(sections.friction).map((row) => ({
      code: str(row.code),
      rows: num(row.rows),
      sessions: num(row.sessions),
      distinctTraces: num(row.distinctTraces),
      traceIds: takeValid(frictionTraceMap.get(str(row.code)) ?? []),
    })),
    journal: rowsOf(sections.journal).map((row) => ({
      failureCode: str(row.failureCode),
      rows: num(row.rows),
    })),
    serviceRestart: {
      n: num(restart.n),
      p50Seconds: round1(restart.p50),
      maxSeconds: round1(restart.max),
      ge1800: num(restart.ge1800),
      traceIds: takeValid(idsOf(sections.restartTraces)),
    },
    trains,
  }
}

function blank(value: string): string {
  return value === '' ? '（空）' : value
}

function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '（无数据）\n'
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const row of rows) lines.push(`| ${row.map((item) => cell(item)).join(' | ')} |`)
  return `${lines.join('\n')}\n`
}

function commandBlock(ids: readonly string[]): string {
  const cmds = traceCommands(ids)
  return cmds.length > 0 ? `${cmds.join('\n')}\n` : ''
}

function sampleBlock(sample: Sample): string {
  const cmds = traceCommands(sample.traceIds)
  if (cmds.length > 0) return `${cmds.join('\n')}\n`
  if (sample.sessionIds.length === 0) return '无 trace\n'
  return `${sample.sessionIds.map((id) => `${id} 无 trace`).join('\n')}\n`
}

export function attentionLines(report: Report): string[] {
  const lines: string[] = []
  for (const model of report.models) {
    if (!modelHot(model.completed, model.other)) continue
    const n = model.completed + model.other
    const pct = Math.round((model.other / n) * 100)
    lines.push(`模型 ${blank(model.model)}：n=${n}，非完成 ${model.other}（${pct}%）。`)
    lines.push(...traceCommands(model.traceIds))
  }
  const hotTools = report.tools.top.filter((tool) => tool.failures >= 10)
  if (hotTools.length > 0) {
    const bits = hotTools.slice(0, 3).map((tool) => `${blank(tool.tool)} ${tool.failures} 次`)
    lines.push(`工具失败次数达到 10：${bits.join('，')}。`)
    lines.push(...traceCommands(hotTools.flatMap((tool) => tool.traceIds)))
  }
  if (report.tools.timeoutCalls >= 1) {
    lines.push(`failure_kind=timeout 的调用 ${report.tools.timeoutCalls}。`)
    lines.push(...traceCommands(report.tools.timeoutTraceIds))
  }
  if (report.recovery.joinedNotCompleted + report.recovery.noDispatch >= 1) {
    lines.push(
      `恢复作业 join 到回合后 outcome 不是 completed 的 ${report.recovery.joinedNotCompleted} 行，没有 dispatch_id 的 ${report.recovery.noDispatch} 行。作业 status 照记。`,
    )
    const ids = report.recovery.groups
      .filter((group) => group.outcome !== 'completed')
      .flatMap((group) => group.traceIds)
    lines.push(...traceCommands(ids))
  }
  if (report.serviceRestart.ge1800 >= 1) {
    const max = report.serviceRestart.maxSeconds == null ? '—' : String(report.serviceRestart.maxSeconds)
    lines.push(`SERVICE_RESTART 时长达到 1800 秒的回合 ${report.serviceRestart.ge1800}，最大 ${max} 秒。`)
    lines.push(...traceCommands(report.serviceRestart.traceIds))
  }
  const explicit = report.ratings.explicitUp + report.ratings.explicitDown
  if (report.ratings.nudges.exposed >= 20 && explicit === 0) {
    lines.push(`引导曝光 ${report.ratings.nudges.exposed}，显式评分 0。`)
  }
  return lines
}

export function renderReport(report: Report): string {
  const lines = cohortLines(report.include765)
  const parts: string[] = []
  parts.push(`# 反馈日报 ${report.date}（${report.days} 天）\n\n`)
  parts.push(`窗口：${report.windowStart} 至 ${report.windowEnd}。\n`)
  parts.push(`${lines.h}\n`)
  parts.push(`${lines.ex}\n`)
  parts.push('只读计数。不发站内信，不开单，不写业务表。\n\n')
  parts.push('## 需要注意\n\n')
  const notes = attentionLines(report)
  parts.push(notes.length > 0 ? `${notes.join('\n')}\n\n` : '无\n\n')

  parts.push('## H 逐日\n\n')
  parts.push(table(['日', '完成', '非完成'], report.daily.map((row) => [row.day, row.completed, row.other])))
  parts.push('\n## H 非完成\n\n')
  parts.push(
    table(
      ['failure_code', 'outcome', '次数'],
      report.nonComplete.map((row) => [blank(row.failureCode), blank(row.outcome), row.n]),
    ),
  )
  const seenCodes = new Set<string>()
  for (const row of report.nonComplete) {
    if (seenCodes.has(row.failureCode)) continue
    seenCodes.add(row.failureCode)
    const ids = report.nonComplete
      .filter((item) => item.failureCode === row.failureCode)
      .flatMap((item) => item.traceIds)
    const block = commandBlock(ids)
    if (block) parts.push(`\n${blank(row.failureCode)}：\n${block}`)
  }

  parts.push('\n## H 各模型\n\nn≥5。\n\n')
  parts.push(
    table(
      ['model', '完成', '非完成', '最多的 failure_code'],
      report.models.map((row) => [blank(row.model), row.completed, row.other, blank(row.topFailureCode)]),
    ),
  )

  const rate = report.tools.totalCalls > 0 ? report.tools.failedCalls / report.tools.totalCalls : null
  const rateText = rate == null ? '—' : `${(rate * 100).toFixed(1)}%`
  parts.push(`\n## 工具\n\n失败率 ${rateText}（${report.tools.failedCalls}/${report.tools.totalCalls}）。失败调用 / 全部调用。分母来自 rollup，不用 agent_audit。\n\n`)
  parts.push(
    table(
      ['outcome', 'failure_kind', 'call_count'],
      report.tools.buckets.map((row) => [blank(row.outcome), blank(row.failureKind), row.calls]),
    ),
  )
  parts.push('\n失败次数最高的 10 个工具：\n\n')
  parts.push(table(['tool', '失败次数'], report.tools.top.map((row) => [blank(row.tool), row.failures])))
  for (const tool of report.tools.top) {
    const block = commandBlock(tool.traceIds)
    if (block) parts.push(`\n${blank(tool.tool)}：\n${block}`)
  }

  parts.push('\n## 恢复\n\n作业 status=completed 是作业行的 status，不是回合完成。\n\n')
  parts.push(
    table(
      ['status', 'error_code', '回合 outcome', '次数'],
      report.recovery.groups.map((row) => [blank(row.status), blank(row.errorCode), blank(row.outcome), row.n]),
    ),
  )
  for (const group of report.recovery.groups) {
    const block = commandBlock(group.traceIds)
    if (block) {
      parts.push(`\n${blank(group.status)} / ${blank(group.errorCode)} / ${blank(group.outcome)}：\n${block}`)
    }
  }

  parts.push('\n## 停止\n\nH 条件里的 client_message_id 在这张表上取 root_client_message_id。\n\n')
  parts.push(
    table(
      ['status', 'error_code', '次数'],
      report.stops.groups.map((row) => [blank(row.status), blank(row.errorCode), row.n]),
    ),
  )
  parts.push('\nUSER_CANCELLED：\n')
  const cancelled = commandBlock(report.stops.userCancelledTraceIds)
  parts.push(cancelled || '（无 trace）\n')

  const ratings = report.ratings
  parts.push('\n## 评分\n\n')
  parts.push(`- 显式 up ${ratings.explicitUp}\n`)
  parts.push(sampleBlock(ratings.samples.explicitUp))
  parts.push(`- 显式 down ${ratings.explicitDown}\n`)
  parts.push(sampleBlock(ratings.samples.explicitDown))
  parts.push(`- 隐式且含中途打断 ${ratings.implicitInterrupt}\n`)
  parts.push(sampleBlock(ratings.samples.implicitInterrupt))
  parts.push(`- 隐式且含改写重发 ${ratings.implicitRewrite}\n`)
  parts.push(sampleBlock(ratings.samples.implicitRewrite))
  parts.push(`- 其余隐式 ${ratings.implicitOther}\n`)
  parts.push(sampleBlock(ratings.samples.implicitOther))
  parts.push(
    `- 引导曝光 ${ratings.nudges.exposed}，rated_at 非空 ${ratings.nudges.rated}，dismissed_at 非空 ${ratings.nudges.dismissed}\n`,
  )
  parts.push(sampleBlock(ratings.nudges.sample))

  parts.push('\n## 同问\n\n')
  parts.push(`组数 ${report.sameAsk.groups}，组内回合 ${report.sameAsk.turns}。\n`)
  parts.push(`10 分钟内较晚回合相对较早回合的对数 ${report.sameAsk.pairs10m}。\n`)
  parts.push('\n组内较晚回合：\n')
  parts.push(commandBlock(report.sameAsk.laterGroupTraceIds) || '（无 trace）\n')
  parts.push('\n10 分钟内较晚回合：\n')
  parts.push(commandBlock(report.sameAsk.laterPairTraceIds) || '（无 trace）\n')

  parts.push('\n## 放弃代理\n\n')
  parts.push(`总数 ${report.abandoned.total}，其中 interrupted ${report.abandoned.interrupted}。\n`)
  parts.push(commandBlock(report.abandoned.traceIds) || '（无 trace）\n')

  parts.push('\n## 换模型代理\n\n')
  parts.push(`次数 ${report.modelSwitch.n}。\n`)
  parts.push(commandBlock(report.modelSwitch.traceIds) || '（无 trace）\n')

  parts.push('\n## 摩擦\n\n行数是事件行，不是回合数。\n\n')
  parts.push(
    table(
      ['code', '行数', '会话数', '不同 trace'],
      report.friction.map((row) => [blank(row.code), row.rows, row.sessions, row.distinctTraces]),
    ),
  )
  for (const row of report.friction) {
    const block = commandBlock(row.traceIds)
    if (block) parts.push(`\n${blank(row.code)}：\n${block}`)
  }

  parts.push('\n## Journal\n\naborted 行数，按 failure_code。不是回合数。\n\n')
  parts.push(table(['failure_code', '行数'], report.journal.map((row) => [blank(row.failureCode), row.rows])))

  const restart = report.serviceRestart
  parts.push('\n## SERVICE_RESTART\n\n')
  parts.push(
    `回合数 ${restart.n}，p50 秒 ${restart.p50Seconds == null ? '—' : restart.p50Seconds}，最大秒 ${restart.maxSeconds == null ? '—' : restart.maxSeconds}。\n`,
  )
  parts.push('时长用 terminal_at - coalesce(accepted_at, admitted_at)，terminal_at 落入窗口。\n')
  parts.push(commandBlock(restart.traceIds) || '（无 trace）\n')

  parts.push('\n## 列车\n\n')
  if (report.trains.missing) parts.push('未找到\n')
  else parts.push(`final 为 true 的文件 ${report.trains.finalTrue} 个，final 为 false 的文件 ${report.trains.finalFalse} 个。\n`)
  return parts.join('')
}

function assertNoHashKey(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoHashKey(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'request_hash') throw new Error('hash key leaked')
      assertNoHashKey(item)
    }
  }
}

export function toPublicJson(report: Report): Record<string, unknown> {
  const notes = attentionLines(report)
  const out = {
    窗口: { 起: report.windowStart, 止: report.windowEnd, 天数: report.days },
    人群: { 含765: report.include765 },
    需要注意: notes,
    H逐日: report.daily.map((row) => ({ 日: row.day, 完成: row.completed, 非完成: row.other })),
    H非完成: report.nonComplete.map((row) => ({
      failure_code: row.failureCode,
      outcome: row.outcome,
      次数: row.n,
      trace_id: row.traceIds,
    })),
    H各模型: report.models.map((row) => ({
      model: row.model,
      完成: row.completed,
      非完成: row.other,
      failure_code: row.topFailureCode,
      trace_id: row.traceIds,
    })),
    工具: {
      汇总: report.tools.buckets.map((row) => ({
        outcome: row.outcome,
        failure_kind: row.failureKind,
        call_count: row.calls,
      })),
      失败调用: report.tools.failedCalls,
      全部调用: report.tools.totalCalls,
      失败最多: report.tools.top.map((row) => ({
        tool: row.tool,
        失败次数: row.failures,
        trace_id: row.traceIds,
      })),
      timeout调用: report.tools.timeoutCalls,
      timeout_trace_id: report.tools.timeoutTraceIds,
    },
    恢复: {
      分组: report.recovery.groups.map((row) => ({
        status: row.status,
        error_code: row.errorCode,
        outcome: row.outcome,
        次数: row.n,
        trace_id: row.traceIds,
      })),
      join后回合不是completed: report.recovery.joinedNotCompleted,
      无dispatch: report.recovery.noDispatch,
    },
    停止: {
      分组: report.stops.groups.map((row) => ({
        status: row.status,
        error_code: row.errorCode,
        次数: row.n,
      })),
      USER_CANCELLED_trace_id: report.stops.userCancelledTraceIds,
    },
    评分: {
      显式up: report.ratings.explicitUp,
      显式down: report.ratings.explicitDown,
      隐式中途打断: report.ratings.implicitInterrupt,
      隐式改写重发: report.ratings.implicitRewrite,
      其余隐式: report.ratings.implicitOther,
      引导曝光: report.ratings.nudges.exposed,
      引导已评: report.ratings.nudges.rated,
      引导关掉: report.ratings.nudges.dismissed,
      trace_id: {
        显式up: report.ratings.samples.explicitUp.traceIds,
        显式down: report.ratings.samples.explicitDown.traceIds,
        隐式中途打断: report.ratings.samples.implicitInterrupt.traceIds,
        隐式改写重发: report.ratings.samples.implicitRewrite.traceIds,
        其余隐式: report.ratings.samples.implicitOther.traceIds,
        引导: report.ratings.nudges.sample.traceIds,
      },
      session_id: {
        显式up: report.ratings.samples.explicitUp.sessionIds,
        显式down: report.ratings.samples.explicitDown.sessionIds,
        隐式中途打断: report.ratings.samples.implicitInterrupt.sessionIds,
        隐式改写重发: report.ratings.samples.implicitRewrite.sessionIds,
        其余隐式: report.ratings.samples.implicitOther.sessionIds,
        引导: report.ratings.nudges.sample.sessionIds,
      },
    },
    同问: {
      组数: report.sameAsk.groups,
      回合数: report.sameAsk.turns,
      十分钟对数: report.sameAsk.pairs10m,
      组内较晚trace_id: report.sameAsk.laterGroupTraceIds,
      十分钟较晚trace_id: report.sameAsk.laterPairTraceIds,
    },
    放弃代理: {
      总数: report.abandoned.total,
      interrupted: report.abandoned.interrupted,
      trace_id: report.abandoned.traceIds,
    },
    换模型代理: { 次数: report.modelSwitch.n, trace_id: report.modelSwitch.traceIds },
    摩擦: report.friction.map((row) => ({
      code: row.code,
      行数: row.rows,
      会话数: row.sessions,
      不同trace: row.distinctTraces,
      trace_id: row.traceIds,
    })),
    Journal: report.journal.map((row) => ({ failure_code: row.failureCode, 行数: row.rows })),
    SERVICE_RESTART: {
      回合数: report.serviceRestart.n,
      p50秒: report.serviceRestart.p50Seconds,
      最大秒: report.serviceRestart.maxSeconds,
      达到1800秒: report.serviceRestart.ge1800,
      trace_id: report.serviceRestart.traceIds,
    },
    列车: report.trains.missing
      ? { 未找到: true }
      : { finalTrue: report.trains.finalTrue, finalFalse: report.trains.finalFalse },
  }
  assertNoHashKey(out)
  return out
}

export function trainDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.OC_V5_TRAIN_SUMMARY_DIR || env.OC_V5_LEASE_LOG_DIR || '/opt/openclaude/tmp/lease-trains'
}

export function trainSectionFromDir(dir: string, startMs: number, endMs: number): Report['trains'] {
  if (!existsSync(dir)) return { missing: true }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { missing: true }
  }
  let finalTrue = 0
  let finalFalse = 0
  for (const name of names) {
    if (!name.endsWith('.summary.json')) continue
    const full = path.join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs < startMs || mtimeMs >= endMs) continue
    let final: unknown
    try {
      final = (JSON.parse(readFileSync(full, 'utf8')) as { final?: unknown }).final
    } catch {
      continue
    }
    if (final === true) finalTrue += 1
    else if (final === false) finalFalse += 1
  }
  return { missing: false, finalTrue, finalFalse }
}

function runPsql(sql: string): string {
  const result = spawnSync(
    'sudo',
    [
      '-n',
      '-u',
      'postgres',
      'env',
      'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000',
      'PGCLIENTENCODING=UTF8',
      'psql',
      '-d',
      'openclaude_v5_selfhost',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8', timeout: 120_000 },
  )
  if (result.error || result.status !== 0) {
    const detail = redact((result.stderr || result.stdout || result.error?.message || 'psql failed').trim())
    throw new Error(detail.slice(0, 500))
  }
  return result.stdout ?? ''
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* the temp file is not part of the report */
    }
    throw err
  }
}

export function runReport(argv: string[] = process.argv.slice(2)): number {
  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(redact((err as Error).message))
    console.error(USAGE)
    return EXIT.usage
  }
  if (opts.help) {
    console.log(USAGE)
    return EXIT.ok
  }
  let stdout = ''
  try {
    stdout = runPsql(buildFeedbackSql(opts))
  } catch (err) {
    console.error(`pg failed: ${redact((err as Error).message)}`)
    return EXIT.pg
  }
  let report: Report
  try {
    const sections = parseSections(stdout)
    const bounds = windowBounds(opts.date, opts.days)
    let trains: Report['trains'] = { missing: true }
    try {
      trains = trainSectionFromDir(trainDirFromEnv(), bounds.startMs, bounds.endExclusiveMs)
    } catch {
      trains = { missing: true }
    }
    report = mapSections(sections, opts, trains)
  } catch (err) {
    console.error(`pg failed: ${redact((err as Error).message)}`)
    return EXIT.pg
  }
  const markdown = renderReport(report)
  if (opts.dryRun) {
    process.stdout.write(markdown)
    return EXIT.ok
  }
  try {
    if (!existsSync(OUT_DIR)) {
      mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })
      chmodSync(OUT_DIR, 0o700)
    }
    atomicWrite(path.join(OUT_DIR, `${opts.date}.md`), markdown)
    atomicWrite(path.join(OUT_DIR, `${opts.date}.json`), `${JSON.stringify(toPublicJson(report), null, 2)}\n`)
  } catch (err) {
    console.error(`write failed: ${redact((err as Error).message)}`)
    return 1
  }
  console.log(JSON.stringify({ date: opts.date, days: opts.days, include765: opts.include765, outDir: OUT_DIR }))
  return EXIT.ok
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isDirectRun() || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  try {
    process.exit(runReport())
  } catch (err) {
    console.error(redact((err as Error).message))
    process.exit(1)
  }
}
