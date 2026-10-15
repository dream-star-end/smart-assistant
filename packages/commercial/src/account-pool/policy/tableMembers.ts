/**
 * OCV5-424 — one persistence path for pool members stored in tables with the
 * standard state columns (status, health_score, backoff_level, cooldown_until,
 * cooldown_reason, next_probe_at, success_count, fail_count, last_error,
 * last_used_at): pool_api_keys, api_relay_credentials and gemini_oauth_accounts
 * (Antigravity Google subscription accounts). claude_accounts keeps
 * its Redis-backed tracker (health.ts) but runs the same decide().
 */

import { query } from '../../db/queries.js'
import { DEFAULT_POLICY, decide, decideProbe, type MemberStatus, type Transition } from './decide.js'
import { recordPoolEvent, type PoolMemberKind } from './events.js'
import { outcomeLabel, type CooldownReason, type PoolOutcome } from './outcome.js'
import type { DueProbe, ProbeResult } from './registry.js'

export type MemberTable = 'pool_api_keys' | 'api_relay_credentials' | 'gemini_oauth_accounts'

interface StateRow {
  id: string
  status: MemberStatus
  health_score: number
  backoff_level: number
  cooldown_until: Date | null
  cooldown_reason: CooldownReason | null
}

export interface TableMemberSpec {
  table: MemberTable
  memberKind: PoolMemberKind
  /** SQL expression for the service name of a row (column or constant). */
  serviceExpr: string
}

export const API_KEY_MEMBERS: TableMemberSpec = { table: 'pool_api_keys', memberKind: 'api_key', serviceExpr: 'service' }
export const RELAY_KEY_MEMBERS: TableMemberSpec = {
  table: 'api_relay_credentials',
  memberKind: 'relay_key',
  serviceExpr: `'codex'`,
}
/** Antigravity Google AI subscription accounts: the gemini pool's subscription members. */
export const GEMINI_OAUTH_MEMBERS: TableMemberSpec = {
  table: 'gemini_oauth_accounts',
  memberKind: 'account',
  serviceExpr: `'gemini'`,
}

const STRIKE_WINDOW_MS = 10 * 60 * 1000
const strikes = new Map<string, { n: number; since: number }>()

function nextStrike(key: string): number {
  const now = Date.now()
  const cur = strikes.get(key)
  const n = cur && now - cur.since < STRIKE_WINDOW_MS ? cur.n + 1 : 1
  strikes.set(key, { n, since: cur && n > 1 ? cur.since : now })
  return n
}

async function readState(spec: TableMemberSpec, id: string): Promise<(StateRow & { service: string }) | null> {
  const res = await query<StateRow & { service: string }>(
    `SELECT id::text AS id, ${spec.serviceExpr} AS service, status, health_score, backoff_level, cooldown_until, cooldown_reason
       FROM ${spec.table} WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}

async function writeTransition(
  spec: TableMemberSpec,
  row: StateRow,
  tr: Transition,
  errorMsg: string | null,
  touchLastUsed: boolean,
): Promise<boolean> {
  const res = await query(
    `UPDATE ${spec.table}
        SET status = $3,
            health_score = $4,
            backoff_level = $5,
            cooldown_until = CASE WHEN $6::boolean THEN $7::timestamptz ELSE cooldown_until END,
            cooldown_reason = CASE WHEN $6::boolean THEN $8::text ELSE cooldown_reason END,
            next_probe_at = CASE WHEN $6::boolean THEN $9::timestamptz ELSE next_probe_at END,
            success_count = success_count + $10,
            fail_count = fail_count + $11,
            last_error = CASE WHEN $10 = 1 THEN NULL ELSE COALESCE($12, last_error) END,
            last_used_at = CASE WHEN $13::boolean THEN NOW() ELSE last_used_at END,
            updated_at = NOW()
      WHERE id = $1 AND status = $2`,
    [
      row.id,
      row.status,
      tr.status,
      tr.healthScore,
      tr.backoffLevel,
      tr.changed,
      tr.cooldownUntil,
      tr.cooldownReason,
      tr.needsProbe ? tr.cooldownUntil : null,
      tr.successDelta,
      tr.failDelta,
      errorMsg === null ? null : errorMsg.slice(0, 500),
      touchLastUsed,
    ],
  )
  return (res.rowCount ?? 0) > 0
}

/** Report a request outcome for a table member. Returns true when status/cooldown changed. */
export async function applyTableMemberOutcome(
  spec: TableMemberSpec,
  id: string,
  outcome: PoolOutcome,
  errorMsg?: string | null,
): Promise<boolean> {
  const strikeKey = `${spec.table}:${id}`
  const consecutiveFailures = outcome.kind === 'upstream_error' ? nextStrike(strikeKey) : undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await readState(spec, id)
    if (!row) return false
    const tr = decide(
      { status: row.status, healthScore: row.health_score, backoffLevel: row.backoff_level, consecutiveFailures },
      outcome,
      new Date(),
      DEFAULT_POLICY,
    )
    const msg =
      outcome.kind === 'success'
        ? null
        : errorMsg !== undefined
          ? errorMsg
          : outcome.kind === 'client_error' || outcome.kind === 'network'
            ? null
            : outcomeLabel(outcome)
    if (!(await writeTransition(spec, row, tr, msg, true))) continue
    if (tr.resetFailures) strikes.delete(strikeKey)
    if (tr.changed) {
      await recordPoolEvent({
        service: row.service,
        memberKind: spec.memberKind,
        memberId: id,
        outcome: outcomeLabel(outcome),
        fromStatus: row.status,
        toStatus: tr.status,
        reason: tr.cooldownReason,
        until: tr.cooldownUntil,
      })
    }
    return tr.changed
  }
  return false
}

export async function halfOpenTableMembers(spec: TableMemberSpec): Promise<number> {
  const res = await query(
    `UPDATE ${spec.table}
        SET status = 'active', health_score = GREATEST(health_score, 50), cooldown_until = NULL,
            cooldown_reason = NULL, next_probe_at = NULL, updated_at = NOW()
      WHERE status = 'cooldown'
        AND cooldown_until IS NOT NULL AND cooldown_until < NOW()
        AND (cooldown_reason IS NULL OR cooldown_reason NOT IN ('auth', 'credential'))`,
  )
  return res.rowCount ?? 0
}

export async function listDueTableProbes(spec: TableMemberSpec, limit: number): Promise<DueProbe[]> {
  const res = await query<{ id: string; service: string; cooldown_reason: CooldownReason }>(
    `SELECT id::text AS id, ${spec.serviceExpr} AS service, cooldown_reason FROM ${spec.table}
      WHERE status = 'cooldown' AND cooldown_reason IN ('auth', 'credential')
        AND cooldown_until IS NOT NULL AND cooldown_until < NOW()
      ORDER BY cooldown_until LIMIT $1`,
    [limit],
  )
  return res.rows.map((r) => ({ id: r.id, service: r.service, reason: r.cooldown_reason }))
}

/**
 * Probe result for a table member. Same guards as health.applyProbeResult:
 * only rows still in a due auth/credential cooldown are touched.
 */
export async function applyTableProbeResult(spec: TableMemberSpec, m: DueProbe, result: ProbeResult): Promise<boolean> {
  const row = await readState(spec, m.id)
  if (!row || row.status !== 'cooldown' || (row.cooldown_reason !== 'auth' && row.cooldown_reason !== 'credential')) {
    return false
  }
  const now = new Date()
  if (!result.ok && row.cooldown_until !== null && row.cooldown_until.getTime() > now.getTime()) return false
  let tr: Transition
  if (!result.ok && 'transient' in result) {
    tr = {
      status: 'cooldown',
      healthScore: row.health_score,
      backoffLevel: row.backoff_level,
      cooldownUntil: new Date(now.getTime() + DEFAULT_POLICY.authBaseMs),
      cooldownReason: row.cooldown_reason,
      needsProbe: true,
      resetFailures: false,
      successDelta: 0,
      failDelta: 0,
      changed: true,
    }
  } else {
    tr = decideProbe(
      { status: 'cooldown', healthScore: row.health_score, backoffLevel: row.backoff_level, cooldownReason: row.cooldown_reason },
      result.ok,
      now,
    )
  }
  if (!(await writeTransition(spec, row, tr, result.ok ? null : result.detail, false))) return false
  await recordPoolEvent({
    service: row.service,
    memberKind: spec.memberKind,
    memberId: m.id,
    outcome: result.ok ? 'probe_ok' : `probe_${'transient' in result ? 'transient' : 'failed'}:${result.detail}`,
    fromStatus: row.status,
    toStatus: tr.status,
    reason: tr.cooldownReason,
    until: tr.cooldownUntil,
  })
  return true
}
