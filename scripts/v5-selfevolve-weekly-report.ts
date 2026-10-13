#!/usr/bin/env -S npx tsx
/**
 * v5-selfevolve-weekly-report.ts — 自进化周报（OCV5-403 P0-2）。只读 PG，只输出有界元数据。
 *
 * 宿主 cron 跑；不进 master 进程，不开单、不写任何业务表。报告不含会话原文、评价备注、
 * 记忆内容或查询文本：只有计数、比率、模型名、技能 slug、错误码和截断的 trace 前缀。
 *
 *   npx tsx scripts/v5-selfevolve-weekly-report.ts [--dry-run] [--days 7] [--date YYYY-MM-DD]
 *     [--out-dir DIR] [--env-file /etc/openclaude/commercial-v5-selfhost.env]
 *
 * 退出码: 0 成功; 2 PG 失败(不写文件); 4 参数错误。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const { Client } = pg

export const EXIT = { ok: 0, pg: 2, usage: 4 } as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_ENV_FILE = '/etc/openclaude/commercial-v5-selfhost.env'
const DEFAULT_OUT_DIR = '/opt/openclaude/var/selfevolve-report'
const TOP_N = 10
/** Same thresholds as packages/commercial/src/analytics/telemetryReadiness.ts (report only, never a gate). */
const READINESS_LINK_TARGET = 0.95
const READINESS_VERSION_TARGET = 0.9

export interface CliOptions {
  days: number
  dryRun: boolean
  outDir: string
  date: string
  envFile: string
  help: boolean
}

export interface CountRow {
  key: string
  n: number
}

export interface CoverageRow {
  /** "conn" = browser connection owned; "cron" = cron-origin; "other" = anything else. */
  origin: string
  completed: number
  linked: number
  runtime: number
  control: number
  bundle: number
  client: number
  firstVisible: number
}

export interface RatingModelRow {
  model: string
  up: number
  downExplicit: number
  downImplicit: number
}

export interface ReadinessRow {
  userId: string
  evaluations: number
  ready: number
  latestBlockers: string[]
}

export interface FrictionRow {
  stage: string
  code: string
  outcome: string
  n: number
  users: number
}

export interface SkillRow {
  slug: string
  layer: string
  uses: number
  users: number
  downLinked: number
}

export interface ReportAgg {
  date: string
  days: number
  outcomes: CountRow[]
  outcomesByModel: Array<{ model: string; completed: number; failed: number }>
  coverage: CoverageRow[]
  traceNoise: { tracesTotal: number; tracesWithoutDispatch: number; topSessions: CountRow[] }
  ratings: {
    up: number
    downExplicit: number
    downImplicitByTag: CountRow[]
    nudgeExposures: number
    nudgeRated: number
    byModel: RatingModelRow[]
  }
  readiness: ReadinessRow[]
  friction: FrictionRow[]
  skills: { rows: SkillRow[]; shadowEvents: number }
  memory: CountRow[]
  autoDream: { receipts: CountRow[]; openFindings: number; findingsBySeverity: CountRow[] }
}

export function safeDate(value: string | undefined, now = new Date()): string {
  if (value === undefined) return now.toISOString().slice(0, 10)
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(value)}`)
  }
  return value
}

export function parseDays(value: string): number {
  if (!/^\d{1,2}$/.test(value))
    throw new Error(`--days must be 1..31, got ${JSON.stringify(value)}`)
  const n = Number(value)
  if (n < 1 || n > 31) throw new Error(`--days must be 1..31, got ${n}`)
  return n
}

export function parseArgs(argv: string[], now = new Date()): CliOptions {
  const opts: CliOptions = {
    days: 7,
    dryRun: false,
    outDir: DEFAULT_OUT_DIR,
    date: safeDate(undefined, now),
    envFile: DEFAULT_ENV_FILE,
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
        opts.date = safeDate(next())
        break
      case '--out-dir':
        opts.outDir = next()
        break
      case '--env-file':
        opts.envFile = next()
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

export function readDatabaseUrl(
  envFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.DATABASE_URL?.trim()
  if (fromEnv) return fromEnv
  if (!envFile || !existsSync(envFile)) return undefined
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.*)$/)
    if (!m) continue
    let v = m[1]!.trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1)
    }
    return v || undefined
  }
  return undefined
}

export function ratio(value: number, total: number): number | null {
  return total > 0 ? value / total : null
}

export function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

/** Totals across origins; the readiness gate counts every completed dispatch. */
export function coverageTotal(rows: CoverageRow[]): CoverageRow {
  const total: CoverageRow = {
    origin: 'all',
    completed: 0,
    linked: 0,
    runtime: 0,
    control: 0,
    bundle: 0,
    client: 0,
    firstVisible: 0,
  }
  for (const r of rows) {
    total.completed += r.completed
    total.linked += r.linked
    total.runtime += r.runtime
    total.control += r.control
    total.bundle += r.bundle
    total.client += r.client
    total.firstVisible += r.firstVisible
  }
  return total
}

/** Observations worth a human look; wording only, nothing is opened or changed. */
export function findings(agg: ReportAgg): string[] {
  const out: string[] = []
  const total = coverageTotal(agg.coverage)
  const link = ratio(total.linked, total.completed)
  if (link !== null && link < READINESS_LINK_TARGET) {
    const worst = agg.coverage
      .filter((r) => r.completed > 0)
      .sort((a, b) => (ratio(a.linked, a.completed) ?? 1) - (ratio(b.linked, b.completed) ?? 1))[0]
    const weakest = worst
      ? `；最低来源 ${worst.origin} ${pct(ratio(worst.linked, worst.completed))}`
      : ''
    out.push(`trace↔dispatch 关联 ${pct(link)} 低于 ${pct(READINESS_LINK_TARGET)}${weakest}`)
  }
  const client = ratio(total.client, total.completed)
  if (client !== null && client < READINESS_VERSION_TARGET) {
    out.push(
      `client_build 覆盖 ${pct(client)} 低于 ${pct(READINESS_VERSION_TARGET)}（脚本型会话不发 oc-build 时也会拉低）`,
    )
  }
  if (agg.ratings.up + agg.ratings.downExplicit < 3) {
    out.push(`显式评价只有 ${agg.ratings.up + agg.ratings.downExplicit} 条，不足以作为调优信号`)
  }
  const noise = ratio(agg.traceNoise.tracesWithoutDispatch, agg.traceNoise.tracesTotal)
  if (noise !== null && noise > 0.5) {
    out.push(`${pct(noise)} 的 trace 没有 dispatch（多为重复重放），trace 级统计须按 dispatch 过滤`)
  }
  if (agg.readiness.length > 0 && agg.readiness.every((r) => r.ready === 0)) {
    out.push('遥测就绪门本期没有一次放行')
  }
  return out
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '（无数据）\n'
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const r of rows)
    lines.push(`| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)
  return `${lines.join('\n')}\n`
}

export function renderReport(agg: ReportAgg): string {
  const total = coverageTotal(agg.coverage)
  const parts: string[] = []
  parts.push(`# 自进化周报 ${agg.date}（近 ${agg.days} 天，个人版）\n\n`)
  parts.push('只读统计，只含计数和元数据，不含会话原文、评价备注或记忆内容。\n\n')
  const notes = findings(agg)
  parts.push('## 需要注意\n\n')
  parts.push(notes.length > 0 ? `${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '- 无\n\n')

  parts.push('## 1. 回合结局\n\n')
  parts.push(
    table(
      ['结局', '数量'],
      agg.outcomes.map((r) => [r.key, r.n]),
    ),
  )
  parts.push('\n按模型（completed / 非 completed）：\n\n')
  parts.push(
    table(
      ['模型', 'completed', '其它'],
      agg.outcomesByModel.map((r) => [r.model, r.completed, r.failed]),
    ),
  )

  parts.push('\n## 2. 信号归因（completed 回合）\n\n')
  parts.push(
    table(
      [
        '来源',
        '回合',
        'trace 关联',
        'runtime 版本',
        'control 版本',
        'bundle',
        'client_build',
        '首个可见',
      ],
      [...agg.coverage, total].map((r) => [
        r.origin,
        r.completed,
        pct(ratio(r.linked, r.completed)),
        pct(ratio(r.runtime, r.completed)),
        pct(ratio(r.control, r.completed)),
        pct(ratio(r.bundle, r.completed)),
        pct(ratio(r.client, r.completed)),
        pct(ratio(r.firstVisible, r.completed)),
      ]),
    ),
  )
  parts.push(
    `\ntrace 总数 ${agg.traceNoise.tracesTotal}，其中无 dispatch ${agg.traceNoise.tracesWithoutDispatch}` +
      `（${pct(ratio(agg.traceNoise.tracesWithoutDispatch, agg.traceNoise.tracesTotal))}）。无 dispatch 最多的会话：\n\n`,
  )
  parts.push(
    table(
      ['会话（前 12 位）', 'trace 数'],
      agg.traceNoise.topSessions.map((r) => [r.key, r.n]),
    ),
  )

  parts.push('\n## 3. 评价\n\n')
  parts.push(`- 显式：赞 ${agg.ratings.up}，踩 ${agg.ratings.downExplicit}\n`)
  parts.push(
    `- 隐式踩：${agg.ratings.downImplicitByTag.map((r) => `${r.key} ${r.n}`).join('，') || '0'}\n`,
  )
  parts.push(`- 引导曝光 ${agg.ratings.nudgeExposures}，其中被评价 ${agg.ratings.nudgeRated}\n\n`)
  parts.push(
    table(
      ['模型', '赞', '显式踩', '隐式踩'],
      agg.ratings.byModel.map((r) => [r.model, r.up, r.downExplicit, r.downImplicit]),
    ),
  )

  parts.push('\n## 4. 遥测就绪门\n\n')
  parts.push(
    table(
      ['用户', '判定次数', '放行次数', '最近一次 blocker'],
      agg.readiness.map((r) => [
        r.userId,
        r.evaluations,
        r.ready,
        r.latestBlockers.join(', ') || '—',
      ]),
    ),
  )

  parts.push(`\n## 5. 摩擦（失败类，前 ${TOP_N}）\n\n`)
  parts.push(
    table(
      ['stage', 'code', 'outcome', '次数', '用户数'],
      agg.friction.map((r) => [r.stage, r.code, r.outcome, r.n, r.users]),
    ),
  )

  parts.push(`\n## 6. 技能（前 ${TOP_N}）\n\n`)
  parts.push(
    table(
      ['技能', '层', '使用', '用户数', '关联差评'],
      agg.skills.rows.map((r) => [r.slug, r.layer, r.uses, r.users, r.downLinked]),
    ),
  )
  parts.push(`\n检索影子事件 ${agg.skills.shadowEvents}。\n`)

  parts.push('\n## 7. 记忆使用\n\n')
  parts.push(
    table(
      ['操作/结果', '次数'],
      agg.memory.map((r) => [r.key, r.n]),
    ),
  )

  parts.push('\n## 8. auto-dream\n\n')
  parts.push(
    table(
      ['回执状态', '数量'],
      agg.autoDream.receipts.map((r) => [r.key, r.n]),
    ),
  )
  parts.push(
    `\n未关闭的平台发现 ${agg.autoDream.openFindings}：` +
      `${agg.autoDream.findingsBySeverity.map((r) => `${r.key} ${r.n}`).join('，') || '无'}。\n`,
  )
  return parts.join('')
}

type Q = <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>

const num = (v: unknown): number => Number(v ?? 0)

export async function collect(q: Q, days: number, date: string): Promise<ReportAgg> {
  // Window ends at the end of `date` (UTC) so a re-run for a past date is reproducible.
  const p = [String(days), date]
  const W = (col: string): string =>
    `${col} >= ($2::date + 1) - ($1::text || ' days')::interval AND ${col} < ($2::date + 1)`

  const outcomes = await q<{ key: string | null; n: string }>(
    `SELECT COALESCE(outcome, status) AS key, COUNT(*) AS n FROM turn_dispatches
      WHERE ${W('admitted_at')} GROUP BY 1 ORDER BY 2 DESC`,
    p,
  )
  const outcomesByModel = await q<{ model: string | null; completed: string; failed: string }>(
    `SELECT COALESCE(model,'(default)') AS model,
            COUNT(*) FILTER (WHERE outcome='completed') AS completed,
            COUNT(*) FILTER (WHERE outcome IS DISTINCT FROM 'completed') AS failed
       FROM turn_dispatches WHERE ${W('admitted_at')}
      GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT ${TOP_N}`,
    p,
  )
  const coverage = await q<Record<string, string>>(
    `SELECT CASE WHEN d.owner_id LIKE 'cron-origin:%' THEN 'cron'
                 WHEN d.owner_id ~ '^[0-9a-f-]{36}$' THEN 'conn' ELSE 'other' END AS origin,
            COUNT(*) AS completed,
            COUNT(t.trace_id) AS linked,
            COUNT(*) FILTER (WHERE t.runtime_source_commit IS NOT NULL AND t.runtime_boot_hash IS NOT NULL) AS runtime,
            COUNT(*) FILTER (WHERE t.control_plane_release IS NOT NULL AND t.control_plane_commit IS NOT NULL) AS control,
            COUNT(t.bundle_rev) AS bundle,
            COUNT(t.client_build) AS client,
            COUNT(t.first_visible_at) AS first_visible
       FROM turn_dispatches d
       LEFT JOIN LATERAL (
         -- One trace per dispatch: a resent frame may link a second trace row.
         SELECT * FROM turn_traces x WHERE x.dispatch_id=d.dispatch_id ORDER BY x.created_at LIMIT 1
       ) t ON true
      WHERE d.outcome='completed' AND ${W('d.terminal_at')}
      GROUP BY 1 ORDER BY 1`,
    p,
  )
  const noise = await q<{ total: string; without: string }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE dispatch_id IS NULL) AS without
       FROM turn_traces WHERE ${W('created_at')}`,
    p,
  )
  const noiseTop = await q<{ key: string; n: string }>(
    `SELECT left(md5(session_key),12) AS key, COUNT(*) AS n FROM turn_traces
      WHERE dispatch_id IS NULL AND ${W('created_at')} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
    p,
  )
  const ratingRows = await q<{
    model: string | null
    up: string
    down_explicit: string
    down_implicit: string
  }>(
    `SELECT COALESCE(model,'(unknown)') AS model,
            COUNT(*) FILTER (WHERE rating='up') AS up,
            COUNT(*) FILTER (WHERE rating='down' AND NOT ('implicit'=ANY(tags))) AS down_explicit,
            COUNT(*) FILTER (WHERE rating='down' AND 'implicit'=ANY(tags)) AS down_implicit
       FROM response_rating WHERE ${W('created_at')} GROUP BY 1 ORDER BY COUNT(*) DESC, 1`,
    p,
  )
  const implicitTags = await q<{ key: string; n: string }>(
    `SELECT tag AS key, COUNT(*) AS n
       FROM response_rating, unnest(tags) AS tag
      WHERE 'implicit'=ANY(tags) AND tag <> 'implicit' AND ${W('created_at')}
      GROUP BY 1 ORDER BY 2 DESC`,
    p,
  )
  const nudges = await q<{ exposed: string; rated: string }>(
    `SELECT COUNT(*) AS exposed, COUNT(rated_at) AS rated FROM response_rating_nudges WHERE ${W('exposed_at')}`,
    p,
  )
  const readiness = await q<{
    user_id: string
    evaluations: string
    ready: string
    blockers: string[] | null
  }>(
    `SELECT e.user_id::text AS user_id, COUNT(*) AS evaluations, COUNT(*) FILTER (WHERE e.ready) AS ready,
            (SELECT l.blockers FROM telemetry_readiness_evidence l
              WHERE l.user_id=e.user_id ORDER BY l.created_at DESC LIMIT 1) AS blockers
       FROM telemetry_readiness_evidence e WHERE ${W('e.created_at')} GROUP BY e.user_id ORDER BY 1`,
    p,
  )
  const friction = await q<{
    stage: string
    code: string | null
    outcome: string
    n: string
    users: string
  }>(
    `SELECT stage, COALESCE(code,'') AS code, outcome, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users
       FROM product_friction_events
      WHERE outcome NOT IN ('succeeded','recovered') AND ${W('created_at')}
      GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT ${TOP_N}`,
    p,
  )
  const skills = await q<{
    slug: string
    layer: string | null
    uses: string
    users: string
    down_linked: string
  }>(
    `SELECT u.slug, COALESCE(u.layer,'') AS layer, COUNT(*) AS uses, COUNT(DISTINCT u.user_id) AS users,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM response_rating r
               WHERE r.trace_id=u.trace_id AND r.user_id=u.user_id AND r.rating='down')) AS down_linked
       FROM marketplace_skill_usage_events u WHERE ${W('u.created_at')}
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT ${TOP_N}`,
    p,
  )
  const shadow = await q<{ n: string }>(
    `SELECT COUNT(*) AS n FROM skill_retrieval_shadow_events WHERE ${W('created_at')}`,
    p,
  )
  const memory = await q<{ key: string; n: string }>(
    `SELECT operation || '/' || outcome AS key, COUNT(*) AS n FROM memory_usage_events
      WHERE ${W('created_at')} GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP_N}`,
    p,
  )
  const receipts = await q<{ key: string; n: string }>(
    `SELECT state AS key, COUNT(*) AS n FROM auto_dream_action_receipts WHERE ${W('created_at')} GROUP BY 1 ORDER BY 2 DESC`,
    p,
  )
  const findingsRows = await q<{ key: string; n: string }>(
    `SELECT severity AS key, COUNT(*) AS n FROM auto_dream_platform_findings
      WHERE status NOT IN ('resolved','dismissed','closed') GROUP BY 1 ORDER BY 2 DESC`,
  )

  const byModel = ratingRows.map((r) => ({
    model: r.model ?? '(unknown)',
    up: num(r.up),
    downExplicit: num(r.down_explicit),
    downImplicit: num(r.down_implicit),
  }))
  return {
    date,
    days,
    outcomes: outcomes.map((r) => ({ key: r.key ?? '(open)', n: num(r.n) })),
    outcomesByModel: outcomesByModel.map((r) => ({
      model: r.model ?? '(default)',
      completed: num(r.completed),
      failed: num(r.failed),
    })),
    coverage: coverage.map((r) => ({
      origin: r.origin!,
      completed: num(r.completed),
      linked: num(r.linked),
      runtime: num(r.runtime),
      control: num(r.control),
      bundle: num(r.bundle),
      client: num(r.client),
      firstVisible: num(r.first_visible),
    })),
    traceNoise: {
      tracesTotal: num(noise[0]?.total),
      tracesWithoutDispatch: num(noise[0]?.without),
      topSessions: noiseTop.map((r) => ({ key: r.key, n: num(r.n) })),
    },
    ratings: {
      up: byModel.reduce((s, r) => s + r.up, 0),
      downExplicit: byModel.reduce((s, r) => s + r.downExplicit, 0),
      downImplicitByTag: implicitTags.map((r) => ({ key: r.key, n: num(r.n) })),
      nudgeExposures: num(nudges[0]?.exposed),
      nudgeRated: num(nudges[0]?.rated),
      byModel,
    },
    readiness: readiness.map((r) => ({
      userId: r.user_id,
      evaluations: num(r.evaluations),
      ready: num(r.ready),
      latestBlockers: r.blockers ?? [],
    })),
    friction: friction.map((r) => ({
      stage: r.stage,
      code: r.code ?? '',
      outcome: r.outcome,
      n: num(r.n),
      users: num(r.users),
    })),
    skills: {
      rows: skills.map((r) => ({
        slug: r.slug,
        layer: r.layer ?? '',
        uses: num(r.uses),
        users: num(r.users),
        downLinked: num(r.down_linked),
      })),
      shadowEvents: num(shadow[0]?.n),
    },
    memory: memory.map((r) => ({ key: r.key, n: num(r.n) })),
    autoDream: {
      receipts: receipts.map((r) => ({ key: r.key, n: num(r.n) })),
      openFindings: findingsRows.reduce((s, r) => s + num(r.n), 0),
      findingsBySeverity: findingsRows.map((r) => ({ key: r.key, n: num(r.n) })),
    },
  }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

const USAGE = `用法: npx tsx scripts/v5-selfevolve-weekly-report.ts [选项]
  --dry-run          只打印，不写文件
  --days N           窗口天数（1..31，默认 7）
  --date YYYY-MM-DD  窗口截止日（含当天，UTC，默认今天）
  --out-dir DIR      默认 ${DEFAULT_OUT_DIR}
  --env-file PATH    默认 ${DEFAULT_ENV_FILE}（仅当 DATABASE_URL 未设置）
`

export async function runReport(argv = process.argv.slice(2)): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(String((err as Error).message))
    console.error(USAGE)
    return EXIT.usage
  }
  if (opts.help) {
    console.log(USAGE)
    return EXIT.ok
  }
  const databaseUrl = readDatabaseUrl(opts.envFile)
  if (!databaseUrl) {
    console.error('DATABASE_URL missing (env or --env-file)')
    return EXIT.usage
  }
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 })
  let agg: ReportAgg
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '60s'")
    const q: Q = async (sql, params) => (await client.query(sql, params)).rows
    agg = await collect(q, opts.days, opts.date)
    await client.query('COMMIT')
  } catch (err) {
    // Never print the connection string; pg errors do not include it.
    console.error(`pg failed: ${(err as Error).message}`)
    return EXIT.pg
  } finally {
    await client.end().catch(() => {})
  }
  const markdown = renderReport(agg)
  if (opts.dryRun) {
    console.log(markdown)
    return EXIT.ok
  }
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 })
  atomicWrite(path.join(opts.outDir, `${opts.date}.md`), markdown)
  atomicWrite(path.join(opts.outDir, `${opts.date}.json`), `${JSON.stringify(agg, null, 2)}\n`)
  console.log(
    JSON.stringify({
      date: opts.date,
      days: opts.days,
      findings: findings(agg).length,
      outDir: opts.outDir,
    }),
  )
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
  runReport()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
