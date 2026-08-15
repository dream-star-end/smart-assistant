#!/usr/bin/env -S npx tsx
/**
 * Scan event_log for turns that have activity but no usage_log row, and
 * best-effort backfill those rows (terminal_status='reconciled').
 *
 * Default is --dry-run. Never pointed at production by this script:
 * it only opens the local SQLite sessions.db under --home / --db.
 *
 * Usage:
 *   npx tsx scripts/v5-usage-reconcile.ts --db /path/to/sessions.db
 *   npx tsx scripts/v5-usage-reconcile.ts --home /home/agent/.openclaude --apply
 *   npx tsx scripts/v5-usage-reconcile.ts --db ... --include-inflight
 */
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

type TerminalStatus = 'reconciled'

interface MissingTurn {
  sessionId: string
  agentId: string
  turnIndex: number
  toolCalls: number
  firstTs: number
  lastTs: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  model?: string
  types: string
  inflight: boolean
}

function parseArgs(argv: string[]) {
  let db = ''
  let home = ''
  let apply = false
  let includeInflight = false
  let inflightGraceMs = 15 * 60_000
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--apply') apply = true
    else if (a === '--dry-run') apply = false
    else if (a === '--include-inflight') includeInflight = true
    else if (a === '--db') db = argv[++i] ?? ''
    else if (a === '--home') home = argv[++i] ?? ''
    else if (a === '--inflight-grace-ms') inflightGraceMs = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log(`v5-usage-reconcile.ts
  --db <sessions.db>         SQLite path (sets OPENCLAUDE_HOME to its directory)
  --home <OPENCLAUDE_HOME>   Directory that contains sessions.db
  --dry-run                  Default. Print missing turns, do not write
  --apply                    Insert missing usage_log rows (idempotent)
  --include-inflight         Also backfill turns whose last event is recent
  --inflight-grace-ms <n>    Recency window (default 900000 = 15min)`)
      process.exit(0)
    }
  }
  return { db, home, apply, includeInflight, inflightGraceMs }
}

function agentIdFromSession(sessionId: string): string {
  const parts = sessionId.split(':')
  return parts[0] === 'agent' && parts[1] ? parts[1] : 'unknown'
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.db) {
    const abs = resolve(opts.db)
    if (!existsSync(abs)) {
      console.error(`sessions.db not found: ${abs}`)
      process.exit(2)
    }
    process.env.OPENCLAUDE_HOME = dirname(abs)
    const filename = abs.split('/').pop()
    if (filename && filename !== 'sessions.db') {
      console.error('getSessionsDb always opens $OPENCLAUDE_HOME/sessions.db.')
      console.error(`Pass --db /path/to/sessions.db (not ${filename}) or --home <dir>.`)
      process.exit(2)
    }
  } else if (opts.home) {
    process.env.OPENCLAUDE_HOME = resolve(opts.home)
  } else if (!process.env.OPENCLAUDE_HOME) {
    console.error('Pass --db <sessions.db> or --home <OPENCLAUDE_HOME>')
    process.exit(2)
  }

  const { getSessionsDb, insertUsageLog } = await import('@openclaude/storage')
  const db = await getSessionsDb()
  const now = Date.now()

  const rows = db.prepare(`
    WITH ev AS (
      SELECT
        session_key AS session_id,
        CAST(json_extract(payload, '$.turnIndex') AS INTEGER) AS turn_index,
        MIN(timestamp) AS first_ts,
        MAX(timestamp) AS last_ts,
        SUM(CASE WHEN type = 'tool.called' THEN 1 ELSE 0 END) AS tool_calls,
        COALESCE(SUM(CASE WHEN type = 'tool.called'
          THEN COALESCE(json_extract(payload, '$.durationMs'), 0) ELSE 0 END), 0) AS tool_dur,
        COALESCE(MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.inputTokens') END), 0) AS input_tokens,
        COALESCE(MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.outputTokens') END), 0) AS output_tokens,
        COALESCE(MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.cacheReadTokens') END), 0) AS cache_read_tokens,
        COALESCE(MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.cacheCreationTokens') END), 0) AS cache_creation_tokens,
        COALESCE(MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.costUsd') END), 0) AS cost_usd,
        MAX(CASE WHEN type = 'turn.completed'
          THEN json_extract(payload, '$.usage.model') END) AS model,
        GROUP_CONCAT(DISTINCT type) AS types
      FROM event_log
      WHERE json_extract(payload, '$.turnIndex') IS NOT NULL
      GROUP BY session_key, CAST(json_extract(payload, '$.turnIndex') AS INTEGER)
    )
    SELECT e.session_id, e.turn_index, e.first_ts, e.last_ts, e.tool_calls, e.tool_dur,
           e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens,
           e.cost_usd, e.model, e.types
      FROM ev e
      LEFT JOIN usage_log u
        ON u.session_id = e.session_id AND u.turn_index = e.turn_index
     WHERE u.id IS NULL
     ORDER BY e.tool_calls DESC, e.last_ts ASC
  `).all() as Array<{
    session_id: string
    turn_index: number
    first_ts: number
    last_ts: number
    tool_calls: number
    tool_dur: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    cost_usd: number
    model: string | null
    types: string
  }>

  const missing: MissingTurn[] = rows.map((r) => {
    const span = Math.max(0, r.last_ts - r.first_ts)
    const durationMs = span > 0 ? span : Math.max(0, Number(r.tool_dur) || 0)
    return {
      sessionId: r.session_id,
      agentId: agentIdFromSession(r.session_id),
      turnIndex: r.turn_index,
      toolCalls: Number(r.tool_calls) || 0,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      durationMs,
      inputTokens: Number(r.input_tokens) || 0,
      outputTokens: Number(r.output_tokens) || 0,
      cacheReadTokens: Number(r.cache_read_tokens) || 0,
      cacheCreationTokens: Number(r.cache_creation_tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      model: r.model ?? undefined,
      types: r.types,
      inflight: now - r.last_ts < opts.inflightGraceMs,
    }
  })

  const actionable = missing.filter((m) => opts.includeInflight || !m.inflight)
  const skippedInflight = missing.filter((m) => m.inflight && !opts.includeInflight)

  const mode = opts.apply ? 'APPLY' : 'DRY-RUN'
  console.log(`v5-usage-reconcile ${mode}`)
  console.log(`home=${process.env.OPENCLAUDE_HOME}`)
  console.log(`missing=${missing.length} actionable=${actionable.length} inflight_skipped=${skippedInflight.length}`)
  console.log('')

  const print = (label: string, items: MissingTurn[]) => {
    if (items.length === 0) return
    console.log(`--- ${label} ---`)
    for (const m of items) {
      const min = (m.durationMs / 60000).toFixed(1)
      console.log(
        `${m.sessionId} turn=${m.turnIndex} tools=${m.toolCalls} duration_min=${min}` +
        ` tokens=${m.inputTokens}/${m.outputTokens} types=${m.types}` +
        `${m.inflight ? ' [inflight]' : ''}`,
      )
    }
    console.log('')
  }
  print('actionable', actionable)
  print('inflight skipped (still running or recently active)', skippedInflight)

  if (!opts.apply) {
    console.log('No writes. Re-run with --apply to insert reconciled usage_log rows.')
    return
  }

  let inserted = 0
  let duplicate = 0
  for (const m of actionable) {
    const result = await insertUsageLog({
      id: `reconciled:${m.sessionId}:${m.turnIndex}`,
      sessionId: m.sessionId,
      agentId: m.agentId,
      turnIndex: m.turnIndex,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      costUsd: m.costUsd,
      durationMs: m.durationMs,
      toolCalls: m.toolCalls,
      timestamp: m.lastTs,
      terminalStatus: 'reconciled' satisfies TerminalStatus,
    })
    if (result.status === 'inserted') inserted += 1
    else duplicate += 1
  }
  console.log(`wrote inserted=${inserted} already_present=${duplicate}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
