/**
 * contextScorecardSql.ts — Protocol parsers and read-only PostgreSQL collectors
 * for T-Canary context release scorecards (OCV5-885).
 */
import type pg from 'pg'
import {
  type AntigravityRelayRow,
  type ArmDataset,
  type CliOptions,
  type ContextEvalTelemetry,
  FLASH_LITE_UPSTREAM_MODEL,
  type PromptDecisionSummary,
  type ProtocolTurnRow,
  REWRITE_RESEND_TAG,
  type ResolvedArmFilter,
  type ScorecardReport,
  type TurnFactRow,
  evaluateScorecardVerdict,
} from './contextScorecardStats.js'

export type QueryFn = <T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>

const MAX_OPTIONS_QUESTIONS_PER_BLOCK = 6
const MIN_ACTIVE_COMMIT_OBS = 3

export const PROMPT_DECISION_REUSE = new Set([
  'elide_resumed',
  'reuse',
  'reused',
  'prompt_freeze_reuse',
])
export const PROMPT_DECISION_NON_REUSE = new Set([
  'full_inject',
  'fresh_inputs',
  'prompt_freeze_fresh_inputs',
  'expired',
  'prompt_freeze_expired',
])
export const PROMPT_DECISION_FIRST_TURN = new Set([
  'fresh_first',
  'prompt_freeze_fresh_first',
  'fresh_conversation',
])

export type PromptDecisionBucket = 'reuse' | 'non_reuse' | 'first_turn_excluded' | 'other'

export function classifyPromptDecision(
  decision: string,
  reason?: string | null,
): PromptDecisionBucket {
  if (reason && PROMPT_DECISION_FIRST_TURN.has(reason)) return 'first_turn_excluded'
  if (PROMPT_DECISION_FIRST_TURN.has(decision)) return 'first_turn_excluded'
  if (PROMPT_DECISION_REUSE.has(decision)) return 'reuse'
  if (PROMPT_DECISION_NON_REUSE.has(decision)) return 'non_reuse'
  return 'other'
}

export function summarizePromptDecisionRows(
  decRows: Array<{ decision: string; reason?: string | null; n: string | number }>,
  slotRows: Array<{ slot: string; n: string | number }>,
): PromptDecisionSummary {
  let total = 0
  let reuse = 0
  let nonReuse = 0
  let firstTurnExcluded = 0
  const decisionCounts = new Map<string, number>()
  for (const r of decRows) {
    const count = num(r.n)
    total += count
    decisionCounts.set(r.decision, (decisionCounts.get(r.decision) ?? 0) + count)
    const bucket = classifyPromptDecision(r.decision, r.reason)
    if (bucket === 'reuse') reuse += count
    else if (bucket === 'non_reuse') nonReuse += count
    else if (bucket === 'first_turn_excluded') firstTurnExcluded += count
  }
  const byDecision = Array.from(decisionCounts.entries())
    .map(([decision, count]) => ({ decision, count }))
    .sort((a, b) => b.count - a.count)
  const eligibleCount = reuse + nonReuse
  return {
    eventCount: total,
    eligibleCount,
    firstTurnExcludedCount: firstTurnExcluded,
    elideOrReuseCount: reuse,
    nonReuseCount: nonReuse,
    elideOrReuseRate: eligibleCount > 0 ? reuse / eligibleCount : null,
    byDecision,
    topChangedSlots: slotRows.map((r) => ({
      slot: r.slot,
      count: num(r.n),
      share: eligibleCount > 0 ? num(r.n) / eligibleCount : total > 0 ? num(r.n) / total : 0,
    })),
  }
}

// ---------------------------------------------------------------------------
// Implicit Protocol Parsers (aligned with RichBlocks.tsx)
// ---------------------------------------------------------------------------

function extractFirstJsonValue(src: string): { json: string; rest: string } | null {
  const trimmedStart = src.trimStart()
  if (!trimmedStart.startsWith('{') && !trimmedStart.startsWith('[')) return null
  const open = trimmedStart[0]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < trimmedStart.length; i++) {
    const ch = trimmedStart[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        return { json: trimmedStart.slice(0, i + 1), rest: trimmedStart.slice(i + 1) }
      }
    }
  }
  return null
}

function isValidOptionEntry(entry: unknown): boolean {
  if (typeof entry === 'string') return entry.trim().length > 0
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const rec = entry as Record<string, unknown>
  for (const k of ['label', 'title', 'text', 'value', 'name']) {
    if (typeof rec[k] === 'string' && (rec[k] as string).trim().length > 0) return true
  }
  return false
}

function isValidSingleOptionsItem(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const rec = raw as Record<string, unknown>
  const list = Array.isArray(rec.options)
    ? rec.options
    : Array.isArray(rec.choices)
      ? rec.choices
      : Array.isArray(rec.items)
        ? rec.items
        : null
  if (!list) return false
  let validCount = 0
  for (const item of list) if (isValidOptionEntry(item)) validCount++
  return validCount > 0 && validCount <= 12
}

function expandOptionsPayloadValid(val: unknown): number {
  if (Array.isArray(val)) {
    if (val.length === 0) return 0
    if (val.length <= MAX_OPTIONS_QUESTIONS_PER_BLOCK && val.every(isValidSingleOptionsItem)) {
      return val.length
    }
    if (val.length <= 12 && val.every(isValidOptionEntry)) return 1
    return 0
  }
  if (val && typeof val === 'object') {
    const rec = val as Record<string, unknown>
    if (Array.isArray(rec.questions)) {
      if (rec.questions.length === 0 || rec.questions.length > MAX_OPTIONS_QUESTIONS_PER_BLOCK) return 0
      return rec.questions.every(isValidSingleOptionsItem) ? rec.questions.length : 0
    }
  }
  return isValidSingleOptionsItem(val) ? 1 : 0
}

export function validateOptionsBlockJson(body: string): boolean {
  try {
    const first = extractFirstJsonValue(body)
    if (!first) return false
    let count = expandOptionsPayloadValid(JSON.parse(first.json))
    if (count === 0) return false
    let rest = first.rest
    while (count < MAX_OPTIONS_QUESTIONS_PER_BLOCK) {
      const trimmed = rest.trimStart()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) break
      const next = extractFirstJsonValue(trimmed)
      if (!next) break
      const more = expandOptionsPayloadValid(JSON.parse(next.json))
      if (more === 0 || count + more > MAX_OPTIONS_QUESTIONS_PER_BLOCK) break
      count += more
      rest = next.rest
    }
    return count > 0
  } catch {
    return false
  }
}

export function isInputPredictionBlock(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed.type === 'next'
    }
  } catch {
    // Fallback below
  }
  return /"type"\s*:\s*"next"/.test(trimmed)
}

export function extractFencedBlocks(
  text: string,
): Array<{ lang: 'ui' | 'options'; body: string }> {
  const out: Array<{ lang: 'ui' | 'options'; body: string }> = []
  const re = /```(ui|options)[^\r\n]*\r?\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ lang: m[1]!.toLowerCase() as 'ui' | 'options', body: m[2] ?? '' })
  }
  return out
}

export function analyzeAssistantProtocolBlocks(
  uiBlocks: string[],
  optionsBlocks: string[],
  hasNextPattern = false,
): {
  hasRichUi: boolean
  hasInputPrediction: boolean
  optionsBlockCount: number
  optionsValidCount: number
} {
  let hasRichUi = false
  let hasInputPrediction = hasNextPattern
  for (const body of uiBlocks) {
    if (isInputPredictionBlock(body)) hasInputPrediction = true
    else if (body.trim().length > 0) hasRichUi = true
  }
  let optionsValidCount = 0
  for (const body of optionsBlocks) {
    if (validateOptionsBlockJson(body)) optionsValidCount++
  }
  return {
    hasRichUi,
    hasInputPrediction,
    optionsBlockCount: optionsBlocks.length,
    optionsValidCount,
  }
}

export function analyzeAssistantProtocolText(text: string): {
  hasRichUi: boolean
  hasInputPrediction: boolean
  optionsBlockCount: number
  optionsValidCount: number
} {
  const blocks = extractFencedBlocks(text)
  return analyzeAssistantProtocolBlocks(
    blocks.filter((b) => b.lang === 'ui').map((b) => b.body),
    blocks.filter((b) => b.lang === 'options').map((b) => b.body),
    /"type"\s*:\s*"next"/.test(text),
  )
}

// ---------------------------------------------------------------------------
// Read-Only PostgreSQL Collectors
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function extractReleaseSha(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return trimmed.toLowerCase()
  const relMatch = trimmed.match(/\brel-([0-9a-f]{7,40})\b/i)
  if (relMatch) return relMatch[1]!.toLowerCase()
  return null
}

function buildCohortCte(filter: ResolvedArmFilter): { cte: string; params: unknown[] } {
  if (filter.kind === 'commit') {
    const prefix = filter.commitPrefix ?? filter.fullCommit ?? ''
    return {
      cte: `
        cohort AS (
          SELECT DISTINCT ON (o.dispatch_id)
            o.dispatch_id,
            o.user_id,
            o.session_key,
            o.agent_id,
            o.model AS obs_model,
            o.runtime_source_commit,
            o.observed_at
          FROM turn_runtime_observations o
          WHERE o.dispatch_id IS NOT NULL
            AND o.runtime_source_commit LIKE $1 || '%'
          ORDER BY o.dispatch_id, o.observed_at DESC
        )
      `,
      params: [prefix],
    }
  }
  return {
    cte: `
      cohort AS (
        SELECT DISTINCT ON (o.dispatch_id)
          o.dispatch_id,
          o.user_id,
          o.session_key,
          o.agent_id,
          o.model AS obs_model,
          o.runtime_source_commit,
          o.observed_at
        FROM turn_runtime_observations o
        WHERE o.dispatch_id IS NOT NULL
          AND o.observed_at >= $1::timestamptz
          AND o.observed_at < $2::timestamptz
        ORDER BY o.dispatch_id, o.observed_at DESC
      )
    `,
    params: [filter.windowStart, filter.windowEnd],
  }
}

async function probeDeployStateCommits(
  q: QueryFn,
): Promise<{ afterSha: string | null; beforeSha: string | null }> {
  const reg = await q<{ tbl: string | null }>(
    `SELECT to_regclass('public.deploy_state')::text AS tbl`,
  )
  if (!reg[0]?.tbl) return { afterSha: null, beforeSha: null }

  const cols = await q<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'deploy_state'
        AND column_name IN ('committed_sha', 'candidate_release', 'active_release', 'previous_active_release')`,
  )
  const colSet = new Set(cols.map((c) => c.column_name))
  const selectParts: string[] = []
  if (colSet.has('committed_sha')) selectParts.push('committed_sha')
  if (colSet.has('candidate_release')) selectParts.push('candidate_release')
  if (colSet.has('active_release')) selectParts.push('active_release')
  if (colSet.has('previous_active_release')) selectParts.push('previous_active_release')
  if (selectParts.length === 0) return { afterSha: null, beforeSha: null }

  const rows = await q<Record<string, string | null>>(
    `SELECT ${selectParts.join(', ')} FROM deploy_state LIMIT 1`,
  )
  const row = rows[0]
  if (!row) return { afterSha: null, beforeSha: null }

  const afterSha =
    extractReleaseSha(row.committed_sha) ??
    extractReleaseSha(row.candidate_release) ??
    extractReleaseSha(row.active_release)
  const beforeSha = extractReleaseSha(row.previous_active_release)
  return { afterSha, beforeSha }
}

/**
 * Resolves default Before/After commits strictly by recency (never letting old high-volume
 * commits crowd out a newly deployed SHA):
 * 1. Reads recent `turn_runtime_observations` ordered by `MAX(observed_at) DESC`.
 * 2. Prefers `deploy_state` (`committed_sha` / `candidate_release` / `active_release`) as `after`
 *    if observed; otherwise picks the most recently active commit (`COUNT(*) >= 3`, falling back
 *    to `>= 1` if fewer than 2 commits have `>= 3`).
 * 3. Picks the immediately preceding active commit as `before`.
 */
export async function resolveAutoCommits(
  q: QueryFn,
  lookbackDays: number,
): Promise<{ before: ResolvedArmFilter; after: ResolvedArmFilter }> {
  type CommitRow = {
    commit: string
    obs_count: string
    dispatches: string
    first_at: string
    last_at: string
  }

  const deploy = await probeDeployStateCommits(q)

  let recentRows = await q<CommitRow>(
    `SELECT runtime_source_commit AS commit,
            COUNT(*) AS obs_count,
            COUNT(DISTINCT dispatch_id) AS dispatches,
            MIN(observed_at)::text AS first_at,
            MAX(observed_at)::text AS last_at
       FROM turn_runtime_observations
      WHERE runtime_source_commit IS NOT NULL
        AND dispatch_id IS NOT NULL
        AND observed_at >= NOW() - ($1::text || ' days')::interval
      GROUP BY runtime_source_commit
      ORDER BY MAX(observed_at) DESC
      LIMIT 30`,
    [String(lookbackDays)],
  )

  if (recentRows.length < 2) {
    recentRows = await q<CommitRow>(
      `SELECT runtime_source_commit AS commit,
              COUNT(*) AS obs_count,
              COUNT(DISTINCT dispatch_id) AS dispatches,
              MIN(observed_at)::text AS first_at,
              MAX(observed_at)::text AS last_at
         FROM turn_runtime_observations
        WHERE runtime_source_commit IS NOT NULL
          AND dispatch_id IS NOT NULL
        GROUP BY runtime_source_commit
        ORDER BY MAX(observed_at) DESC
        LIMIT 30`,
    )
  }

  const matchByPrefix = (sha: string | null, list: CommitRow[]): CommitRow | undefined => {
    if (!sha) return undefined
    const lower = sha.toLowerCase()
    return list.find((r) => r.commit.toLowerCase().startsWith(lower))
  }

  const nowIso = new Date().toISOString()
  const synthDeployRow = (sha: string): CommitRow => ({
    commit: sha,
    obs_count: '0',
    first_at: nowIso,
    last_at: nowIso,
  })

  // Filter 1-2 turn local probe noise when >= 2 active commits exist; fallback to >= 1 otherwise.
  const active = recentRows.filter((r) => num(r.obs_count) >= MIN_ACTIVE_COMMIT_OBS)
  const pool = active.length >= 2 ? active : recentRows

  // Anchor `after` to deploy_state even when the newly deployed SHA has 0 observations yet (never skip C for A/B!).
  const afterRow: CommitRow | undefined = deploy.afterSha
    ? (matchByPrefix(deploy.afterSha, recentRows) ?? synthDeployRow(deploy.afterSha))
    : pool[0]

  const isSameCommit = (a: string, b: string): boolean => {
    const la = a.toLowerCase()
    const lb = b.toLowerCase()
    return la === lb || la.startsWith(lb) || lb.startsWith(la)
  }

  // Anchor `before` to deploy_state previous release when distinct (even if 0 obs), else preceding observed commit.
  const deployBeforeCandidate: CommitRow | undefined =
    deploy.beforeSha && (!afterRow || !isSameCommit(deploy.beforeSha, afterRow.commit))
      ? (matchByPrefix(deploy.beforeSha, pool) ??
        matchByPrefix(deploy.beforeSha, recentRows) ??
        synthDeployRow(deploy.beforeSha))
      : undefined

  const beforeRow: CommitRow | undefined =
    deployBeforeCandidate ??
    (afterRow ? pool.find((r) => !isSameCommit(r.commit, afterRow.commit)) : undefined) ??
    (afterRow ? recentRows.find((r) => !isSameCommit(r.commit, afterRow.commit)) : undefined)

  if (!afterRow || !beforeRow) {
    throw new Error(
      `Auto-commit comparison requires at least 2 distinct runtime_source_commit values in deploy_state or turn_runtime_observations (found ${recentRows.length})`,
    )
  }

  return {
    before: {
      kind: 'commit',
      label: beforeRow.commit.slice(0, 12),
      commitPrefix: beforeRow.commit.slice(0, 12),
      fullCommit: beforeRow.commit,
      windowStart: beforeRow.first_at,
      windowEnd: beforeRow.last_at,
    },
    after: {
      kind: 'commit',
      label: afterRow.commit.slice(0, 12),
      commitPrefix: afterRow.commit.slice(0, 12),
      fullCommit: afterRow.commit,
      windowStart: afterRow.first_at,
      windowEnd: afterRow.last_at,
    },
  }
}

export async function collectContextEvalTelemetry(
  q: QueryFn,
  filter: ResolvedArmFilter,
  tableExists: boolean,
  hasCommitCol = false,
): Promise<ContextEvalTelemetry> {
  if (!tableExists) {
    return {
      status: 'telemetry_pending_0353',
      tableExists: false,
      compaction: null,
      promptDecision: null,
    }
  }

  // Commit mode uses LEFT JOIN turn_runtime_observations + COALESCE(cee.runtime_source_commit, tro.runtime_source_commit)
  // so out-of-turn `dispatch_id IS NULL` checkpoint_reset compactions are NEVER dropped!
  const scopedCte =
    filter.kind === 'commit'
      ? {
          cte: `
            tro_by_dispatch AS (
              SELECT DISTINCT ON (dispatch_id) dispatch_id, runtime_source_commit
                FROM turn_runtime_observations
               WHERE dispatch_id IS NOT NULL
               ORDER BY dispatch_id, observed_at DESC
            ),
            scoped_eval_events AS (
              SELECT e.*,
                     COALESCE(e.dispatch_id, tt_late.dispatch_id) AS eff_dispatch_id
                FROM context_eval_events e
                LEFT JOIN LATERAL (
                  SELECT tt.dispatch_id
                    FROM turn_traces tt
                   WHERE e.dispatch_id IS NULL
                     AND e.trace_id IS NOT NULL
                     AND tt.user_id = e.user_id
                     AND tt.trace_id = e.trace_id
                   LIMIT 1
                ) tt_late ON true
                LEFT JOIN tro_by_dispatch tro ON tro.dispatch_id = COALESCE(e.dispatch_id, tt_late.dispatch_id)
               WHERE ${
                 hasCommitCol
                   ? "COALESCE(e.runtime_source_commit, tro.runtime_source_commit) LIKE $1 || '%'"
                   : "tro.runtime_source_commit LIKE $1 || '%'"
               }
            )
          `,
          params: [filter.commitPrefix ?? filter.fullCommit ?? ''],
        }
      : {
          cte: `
            scoped_eval_events AS (
              SELECT e.*,
                     COALESCE(e.dispatch_id, tt_late.dispatch_id) AS eff_dispatch_id
                FROM context_eval_events e
                LEFT JOIN LATERAL (
                  SELECT tt.dispatch_id
                    FROM turn_traces tt
                   WHERE e.dispatch_id IS NULL
                     AND e.trace_id IS NOT NULL
                     AND tt.user_id = e.user_id
                     AND tt.trace_id = e.trace_id
                   LIMIT 1
                ) tt_late ON true
               WHERE e.observed_at >= $1::timestamptz
                 AND e.observed_at < $2::timestamptz
            )
          `,
          params: [filter.windowStart, filter.windowEnd],
        }

  const compRows = await q<{
    event_count: string
    distinct_sessions: string
    before_bytes: string
    after_bytes: string
    before_tokens: string
    after_tokens: string
    dropped_entries: string
  }>(
    `WITH ${scopedCte.cte}
     SELECT COUNT(*) AS event_count,
            COUNT(DISTINCT session_key) AS distinct_sessions,
            COALESCE(SUM(before_bytes), 0) AS before_bytes,
            COALESCE(SUM(after_bytes), 0) AS after_bytes,
            COALESCE(SUM(before_tokens), 0) AS before_tokens,
            COALESCE(SUM(after_tokens), 0) AS after_tokens,
            COALESCE(SUM(dropped_entries), 0) AS dropped_entries
       FROM scoped_eval_events
      WHERE event_kind = 'context_compacted'`,
    scopedCte.params,
  )

  const compBreakdown = await q<{ scope: string; strategy: string; n: string }>(
    `WITH ${scopedCte.cte}
     SELECT COALESCE(compaction_scope, '(unknown)') AS scope,
            COALESCE(compaction_strategy, '(unknown)') AS strategy,
            COUNT(*) AS n
       FROM scoped_eval_events
      WHERE event_kind = 'context_compacted'
      GROUP BY 1, 2
      ORDER BY 3 DESC
      LIMIT 10`,
    scopedCte.params,
  )

  // Post-compaction t+1 / t+2 health: supports BOTH dispatch-linked turn_index AND
  // out-of-turn (dispatch_id IS NULL) session_key + temporal-order matching!
  const postCompRows = await q<{
    follow_turns: string
    non_completed: string
    rewrite_resend: string
  }>(
    `WITH ${scopedCte.cte},
     compacted AS (
       SELECT e.event_id, e.user_id, e.session_key, e.turn_index,
              e.eff_dispatch_id AS dispatch_id, e.observed_at,
              td.session_id AS dispatch_session_id
         FROM scoped_eval_events e
         LEFT JOIN turn_dispatches td ON td.dispatch_id = e.eff_dispatch_id
        WHERE e.event_kind = 'context_compacted'
     ),
     next_by_turn_idx AS (
       SELECT DISTINCT ON (cp.event_id, t.dispatch_id)
         cp.event_id,
         t.dispatch_id,
         t.status AS tape_status,
         td2.outcome
       FROM compacted cp
       JOIN client_session_turn_tapes t
         ON t.user_id IN (cp.user_id::text, 'c:' || cp.user_id::text)
        AND t.session_id = cp.dispatch_session_id
        AND cp.turn_index IS NOT NULL
        AND t.turn_index IN (cp.turn_index + 1, cp.turn_index + 2)
       LEFT JOIN turn_dispatches td2 ON td2.dispatch_id = t.dispatch_id
      WHERE cp.dispatch_session_id IS NOT NULL
        AND t.dispatch_id IS NOT NULL
      ORDER BY cp.event_id, t.dispatch_id, t.attempt_no DESC NULLS LAST, t.created_at DESC
     ),
     next_by_session_time AS (
       SELECT
         cp.event_id,
         nt.dispatch_id,
         nt.tape_status,
         nt.outcome
       FROM compacted cp
       JOIN LATERAL (
         SELECT t.dispatch_id, t.status AS tape_status, td2.outcome
           FROM client_session_turn_tapes t
           LEFT JOIN turn_dispatches td2 ON td2.dispatch_id = t.dispatch_id
          WHERE t.user_id IN (cp.user_id::text, 'c:' || cp.user_id::text)
            AND (t.session_id = cp.session_key OR cp.session_key LIKE '%:' || t.session_id)
            AND t.created_at >= (EXTRACT(EPOCH FROM cp.observed_at) * 1000)::bigint
            AND t.dispatch_id IS NOT NULL
            AND (cp.dispatch_id IS NULL OR t.dispatch_id <> cp.dispatch_id)
          ORDER BY t.created_at ASC
          LIMIT 2
       ) nt ON true
      WHERE cp.dispatch_session_id IS NULL OR cp.turn_index IS NULL
     ),
     next_tapes AS (
       SELECT DISTINCT ON (dispatch_id) dispatch_id, tape_status, outcome
         FROM (
           SELECT dispatch_id, tape_status, outcome FROM next_by_turn_idx
           UNION ALL
           SELECT dispatch_id, tape_status, outcome FROM next_by_session_time
         ) all_next
        ORDER BY dispatch_id
     )
     SELECT COUNT(*) AS follow_turns,
            COUNT(*) FILTER (WHERE COALESCE(nt.outcome, nt.tape_status) <> 'completed') AS non_completed,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM response_rating rr
               WHERE rr.dispatch_id = nt.dispatch_id
                 AND rr.rating = 'down'
                 AND '${REWRITE_RESEND_TAG}' = ANY(rr.tags)
            )) AS rewrite_resend
       FROM next_tapes nt`,
    scopedCte.params,
  )

  const decRows = await q<{ decision: string; reason: string | null; n: string }>(
    `WITH ${scopedCte.cte}
     SELECT COALESCE(decision, '(unknown)') AS decision,
            reason,
            COUNT(*) AS n
       FROM scoped_eval_events
      WHERE event_kind = 'prompt_context_decision'
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    scopedCte.params,
  )

  const slotRows = await q<{ slot: string; n: string }>(
    `WITH ${scopedCte.cte}
     SELECT slot, COUNT(*) AS n
       FROM scoped_eval_events e,
       LATERAL unnest(COALESCE(e.changed_slots, '{}'::text[])) AS slot
      WHERE e.event_kind = 'prompt_context_decision'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 10`,
    scopedCte.params,
  )

  const comp0 = compRows[0]
  const beforeBytes = num(comp0?.before_bytes)
  const afterBytes = num(comp0?.after_bytes)
  const beforeTokens = num(comp0?.before_tokens)
  const afterTokens = num(comp0?.after_tokens)
  const postTurns = num(postCompRows[0]?.follow_turns)
  const postNonCompleted = num(postCompRows[0]?.non_completed)
  const postRewrite = num(postCompRows[0]?.rewrite_resend)

  return {
    status: 'available',
    tableExists: true,
    compaction: {
      eventCount: num(comp0?.event_count),
      distinctSessions: num(comp0?.distinct_sessions),
      beforeBytesTotal: beforeBytes,
      afterBytesTotal: afterBytes,
      byteCompressionRatio: beforeBytes > 0 ? afterBytes / beforeBytes : null,
      beforeTokensTotal: beforeTokens,
      afterTokensTotal: afterTokens,
      tokenCompressionRatio: beforeTokens > 0 ? afterTokens / beforeTokens : null,
      droppedEntriesTotal: num(comp0?.dropped_entries),
      postCompactionTurns: postTurns,
      postCompactionNonCompletedRate: postTurns > 0 ? postNonCompleted / postTurns : null,
      postCompactionRewriteRate: postTurns > 0 ? postRewrite / postTurns : null,
      byScopeStrategy: compBreakdown.map((r) => ({
        scope: r.scope,
        strategy: r.strategy,
        count: num(r.n),
      })),
    },
    promptDecision: summarizePromptDecisionRows(decRows, slotRows),
  }
}

export async function collectArmDataset(
  q: QueryFn,
  filter: ResolvedArmFilter,
  evalTableExists: boolean,
  evalHasCommitCol = false,
): Promise<ArmDataset> {
  const { cte, params } = buildCohortCte(filter)

  const turnRows = await q<{
    dispatch_id: string
    session_id: string
    session_key: string
    mode: string | null
    model: string | null
    turn_index: string | null
    outcome: string | null
    tape_status: string | null
    input_tokens: string
    output_tokens: string
    cache_read_tokens: string
    cache_write_tokens: string
    cost_credits: string
    usage_count: string
    usage_errors: string
    is_rewrite_resend: boolean
    explicit_up: string
    explicit_down: string
  }>(
    `WITH ${cte},
     cohort_bounds AS MATERIALIZED (
       SELECT MIN(observed_at) - interval '6 hours' AS min_at,
              MAX(observed_at) + interval '6 hours' AS max_at
         FROM cohort
     ),
     matched_ur AS (
       SELECT c.dispatch_id, ur.id, ur.mode, ur.model, ur.input_tokens, ur.output_tokens,
              ur.cache_read_tokens, ur.cache_write_tokens, ur.cost_credits, ur.status
         FROM usage_records ur
         JOIN cohort c ON ur.dispatch_id = c.dispatch_id
        WHERE ur.created_at >= (SELECT min_at FROM cohort_bounds)
          AND ur.created_at <= (SELECT max_at FROM cohort_bounds)
       UNION
       SELECT c.dispatch_id, ur.id, ur.mode, ur.model, ur.input_tokens, ur.output_tokens,
              ur.cache_read_tokens, ur.cache_write_tokens, ur.cost_credits, ur.status
         FROM cohort c
         JOIN turn_dispatches td ON td.dispatch_id = c.dispatch_id
         JOIN usage_records ur
           ON ur.user_id = td.user_id
          AND ur.request_id = td.billing_request_id
        WHERE td.billing_request_id IS NOT NULL
          AND ur.dispatch_id IS NULL
     ),
     ur_agg AS (
       SELECT
         dispatch_id,
         (ARRAY_AGG(mode ORDER BY id DESC))[1] AS mode,
         (ARRAY_AGG(model ORDER BY id DESC))[1] AS model,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_write_tokens) AS cache_write_tokens,
         SUM(cost_credits) AS cost_credits,
         COUNT(*) AS usage_count,
         COUNT(*) FILTER (WHERE status = 'error') AS usage_errors
       FROM matched_ur
       GROUP BY dispatch_id
     ),
     rr_agg AS (
       SELECT
         rr.dispatch_id,
         BOOL_OR(rr.rating = 'down' AND '${REWRITE_RESEND_TAG}' = ANY(rr.tags)) AS is_rewrite_resend,
         COUNT(*) FILTER (WHERE rr.rating = 'up' AND NOT ('implicit' = ANY(rr.tags))) AS explicit_up,
         COUNT(*) FILTER (WHERE rr.rating = 'down' AND NOT ('implicit' = ANY(rr.tags))) AS explicit_down
       FROM response_rating rr
       JOIN cohort c ON c.dispatch_id = rr.dispatch_id
       GROUP BY rr.dispatch_id
     )
     SELECT
       c.dispatch_id::text AS dispatch_id,
       COALESCE(td.session_id, c.session_key) AS session_id,
       c.session_key,
       COALESCE(u.mode, 'chat') AS mode,
       COALESCE(u.model, td.model, c.obs_model, '(unknown)') AS model,
       t.turn_index::text AS turn_index,
       COALESCE(td.outcome, t.status, 'unknown') AS outcome,
       t.status AS tape_status,
       COALESCE(u.input_tokens, 0)::text AS input_tokens,
       COALESCE(u.output_tokens, 0)::text AS output_tokens,
       COALESCE(u.cache_read_tokens, 0)::text AS cache_read_tokens,
       COALESCE(u.cache_write_tokens, 0)::text AS cache_write_tokens,
       COALESCE(u.cost_credits, 0)::text AS cost_credits,
       COALESCE(u.usage_count, 0)::text AS usage_count,
       COALESCE(u.usage_errors, 0)::text AS usage_errors,
       COALESCE(r.is_rewrite_resend, false) AS is_rewrite_resend,
       COALESCE(r.explicit_up, 0)::text AS explicit_up,
       COALESCE(r.explicit_down, 0)::text AS explicit_down
     FROM cohort c
     LEFT JOIN turn_dispatches td ON td.dispatch_id = c.dispatch_id
     LEFT JOIN LATERAL (
       SELECT turn_index, status
         FROM client_session_turn_tapes tx
        WHERE tx.dispatch_id = c.dispatch_id
        ORDER BY tx.attempt_no DESC NULLS LAST, tx.created_at DESC
        LIMIT 1
     ) t ON true
     LEFT JOIN ur_agg u ON u.dispatch_id = c.dispatch_id
     LEFT JOIN rr_agg r ON r.dispatch_id = c.dispatch_id`,
    params,
  )

  const turns: TurnFactRow[] = turnRows.map((r) => ({
    dispatchId: r.dispatch_id,
    sessionId: r.session_id,
    sessionKey: r.session_key,
    mode: r.mode ?? 'chat',
    model: r.model ?? '(unknown)',
    turnIndex: r.turn_index === null ? null : num(r.turn_index),
    outcome: r.outcome ?? 'unknown',
    tapeStatus: r.tape_status,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    costCredits: num(r.cost_credits),
    hasUsageRecord: num(r.usage_count) > 0,
    hasUsageError: num(r.usage_errors) > 0,
    isRewriteResend: Boolean(r.is_rewrite_resend),
    explicitUp: num(r.explicit_up),
    explicitDown: num(r.explicit_down),
    isWebchat: r.session_key.includes(':webchat:') || r.tape_status !== null,
  }))

  const relayRaw = await q<{
    dispatch_id: string
    session_id: string
    route_model_id: string
    turn_index: string | null
    main_calls: string
    main_prompt_tokens: string
    main_cached_tokens: string
    flash_lite_calls: string
    flash_lite_prompt_tokens: string
    flash_lite_cached_tokens: string
  }>(
    `WITH ${cte}
     SELECT
       c.dispatch_id::text AS dispatch_id,
       COALESCE(td.session_id, c.session_key) AS session_id,
       aru.route_model_id,
       t.turn_index::text AS turn_index,
       COUNT(*) FILTER (WHERE aru.upstream_model <> '${FLASH_LITE_UPSTREAM_MODEL}')::text AS main_calls,
       COALESCE(SUM(aru.prompt_tokens) FILTER (WHERE aru.upstream_model <> '${FLASH_LITE_UPSTREAM_MODEL}'), 0)::text AS main_prompt_tokens,
       COALESCE(SUM(aru.cached_tokens) FILTER (WHERE aru.upstream_model <> '${FLASH_LITE_UPSTREAM_MODEL}'), 0)::text AS main_cached_tokens,
       COUNT(*) FILTER (WHERE aru.upstream_model = '${FLASH_LITE_UPSTREAM_MODEL}')::text AS flash_lite_calls,
       COALESCE(SUM(aru.prompt_tokens) FILTER (WHERE aru.upstream_model = '${FLASH_LITE_UPSTREAM_MODEL}'), 0)::text AS flash_lite_prompt_tokens,
       COALESCE(SUM(aru.cached_tokens) FILTER (WHERE aru.upstream_model = '${FLASH_LITE_UPSTREAM_MODEL}'), 0)::text AS flash_lite_cached_tokens
     FROM cohort c
     JOIN turn_dispatches td ON td.dispatch_id = c.dispatch_id
     JOIN antigravity_relay_usage aru
       ON aru.request_id = td.billing_request_id
      AND aru.user_id = td.user_id
     LEFT JOIN LATERAL (
       SELECT turn_index
         FROM client_session_turn_tapes tx
        WHERE tx.dispatch_id = c.dispatch_id
        ORDER BY tx.attempt_no DESC NULLS LAST, tx.created_at DESC
        LIMIT 1
     ) t ON true
     GROUP BY c.dispatch_id, COALESCE(td.session_id, c.session_key), aru.route_model_id, t.turn_index`,
    params,
  )

  const relayRows: AntigravityRelayRow[] = relayRaw.map((r) => ({
    dispatchId: r.dispatch_id,
    sessionId: r.session_id,
    routeModelId: r.route_model_id,
    turnIndex: r.turn_index === null ? null : num(r.turn_index),
    mainCalls: num(r.main_calls),
    mainPromptTokens: num(r.main_prompt_tokens),
    mainCachedTokens: num(r.main_cached_tokens),
    flashLiteCalls: num(r.flash_lite_calls),
    flashLitePromptTokens: num(r.flash_lite_prompt_tokens),
    flashLiteCachedTokens: num(r.flash_lite_cached_tokens),
  }))

  const protocolRaw = await q<{
    dispatch_id: string
    session_id: string
    has_next_pattern: boolean
    ui_blocks: string[] | null
    options_blocks: string[] | null
  }>(
    `WITH ${cte},
     webchat_tapes AS MATERIALIZED (
       SELECT DISTINCT ON (c.dispatch_id)
         c.dispatch_id,
         COALESCE(td.session_id, c.session_key) AS session_id,
         t.session_id AS tape_session_id,
         t.user_id AS tape_user_id,
         t.tape_id
       FROM cohort c
       LEFT JOIN turn_dispatches td ON td.dispatch_id = c.dispatch_id
       JOIN client_session_turn_tapes t ON t.dispatch_id = c.dispatch_id
       WHERE t.status = 'completed'
       ORDER BY c.dispatch_id, t.attempt_no DESC NULLS LAST, t.created_at DESC
     ),
     assistant_texts AS MATERIALIZED (
       SELECT
         wt.dispatch_id,
         CASE
           WHEN LEFT(LTRIM(convert_from(COALESCE(r.visible_payload, r.payload), 'UTF8')), 1) = '{'
           THEN convert_from(COALESCE(r.visible_payload, r.payload), 'UTF8')::jsonb->>'text'
           ELSE NULL
         END AS txt
       FROM webchat_tapes wt
       JOIN client_session_turn_tape_records r
         ON r.session_id = wt.tape_session_id
        AND r.user_id = wt.tape_user_id
        AND r.tape_id = wt.tape_id
       WHERE r.role = 'assistant'
     ),
     next_agg AS (
       SELECT dispatch_id, BOOL_OR(txt ~ '"type"\\s*:\\s*"next"') AS has_next_pattern
         FROM assistant_texts
        WHERE txt IS NOT NULL
        GROUP BY dispatch_id
     ),
     ui_agg AS (
       SELECT dispatch_id, ARRAY_AGG(body) AS ui_blocks
         FROM (
           SELECT dispatch_id, (regexp_matches(txt, E'\`\`\`ui[^\\r\\n]*\\r?\\n(.*?)\`\`\`', 'g'))[1] AS body
             FROM assistant_texts
            WHERE txt IS NOT NULL AND strpos(txt, '\`\`\`ui') > 0
         ) u
        GROUP BY dispatch_id
     ),
     opt_agg AS (
       SELECT dispatch_id, ARRAY_AGG(body) AS options_blocks
         FROM (
           SELECT dispatch_id, (regexp_matches(txt, E'\`\`\`options[^\\r\\n]*\\r?\\n(.*?)\`\`\`', 'g'))[1] AS body
             FROM assistant_texts
            WHERE txt IS NOT NULL AND strpos(txt, '\`\`\`options') > 0
         ) o
        GROUP BY dispatch_id
     )
     SELECT
       wt.dispatch_id::text AS dispatch_id,
       wt.session_id,
       COALESCE(na.has_next_pattern, false) AS has_next_pattern,
       ua.ui_blocks,
       oa.options_blocks
     FROM webchat_tapes wt
     LEFT JOIN next_agg na ON na.dispatch_id = wt.dispatch_id
     LEFT JOIN ui_agg ua ON ua.dispatch_id = wt.dispatch_id
     LEFT JOIN opt_agg oa ON oa.dispatch_id = wt.dispatch_id`,
    params,
  )

  const protocolTurns: ProtocolTurnRow[] = protocolRaw.map((r) => ({
    dispatchId: r.dispatch_id,
    sessionId: r.session_id,
    ...analyzeAssistantProtocolBlocks(
      r.ui_blocks ?? [],
      r.options_blocks ?? [],
      Boolean(r.has_next_pattern),
    ),
  }))

  const contextEval = await collectContextEvalTelemetry(q, filter, evalTableExists, evalHasCommitCol)

  return { filter, turns, relayRows, protocolTurns, contextEval }
}

export async function collectAndEvaluate(
  q: QueryFn,
  opts: CliOptions,
  now = new Date(),
): Promise<ScorecardReport> {
  const startedAt = Date.now()
  let beforeFilter: ResolvedArmFilter
  let afterFilter: ResolvedArmFilter

  if (opts.spec.kind === 'auto-commit') {
    const resolved = await resolveAutoCommits(q, opts.spec.lookbackDays)
    beforeFilter = resolved.before
    afterFilter = resolved.after
  } else if (opts.spec.kind === 'commit') {
    beforeFilter = { kind: 'commit', label: opts.spec.beforeCommit, commitPrefix: opts.spec.beforeCommit }
    afterFilter = { kind: 'commit', label: opts.spec.afterCommit, commitPrefix: opts.spec.afterCommit }
  } else {
    beforeFilter = {
      kind: 'window',
      label: `${opts.spec.beforeStart}..${opts.spec.beforeEnd}`,
      windowStart: opts.spec.beforeStart,
      windowEnd: opts.spec.beforeEnd,
    }
    afterFilter = {
      kind: 'window',
      label: `${opts.spec.afterStart}..${opts.spec.afterEnd}`,
      windowStart: opts.spec.afterStart,
      windowEnd: opts.spec.afterEnd,
    }
  }

  const regRows = await q<{ tbl: string | null }>(
    `SELECT to_regclass('public.context_eval_events')::text AS tbl`,
  )
  const evalTableExists = Boolean(regRows[0]?.tbl)

  let evalHasCommitCol = false
  if (evalTableExists) {
    const colRows = await q<{ has_col: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'context_eval_events'
            AND column_name = 'runtime_source_commit'
       ) AS has_col`,
    )
    evalHasCommitCol = Boolean(colRows[0]?.has_col)
  }

  const beforeArm = await collectArmDataset(q, beforeFilter, evalTableExists, evalHasCommitCol)
  const afterArm = await collectArmDataset(q, afterFilter, evalTableExists, evalHasCommitCol)

  return evaluateScorecardVerdict(beforeArm, afterArm, {
    minCompletedTurns: opts.minCompletedTurns,
    minDistinctSessions: opts.minDistinctSessions,
    sessionWeightCap: opts.sessionWeightCap,
    comparisonKind: opts.spec.kind,
    queryDurationMs: Date.now() - startedAt,
    readOnlyVerified: true,
    now,
  })
}
