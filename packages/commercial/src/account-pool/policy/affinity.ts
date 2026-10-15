/**
 * OCV5-424 — user-level account affinity for every service pool
 * (docs/ocv5-424-user-affinity.md).
 *
 * Sticky key = (service, user). A user's sessions in one pool stay on one
 * member (subscription account or API key) so upstream prefix caches keep
 * hitting and each account sees a coherent, bounded set of users:
 *   - stay     the bound member is selectable → use it, renew the binding;
 *   - spill    it is only temporarily unavailable (short cooldown, slots full,
 *              this model cooling) → use another member for this request only;
 *   - migrate  it is persistently unavailable (auth/credential/quota or a
 *              cooldown > 30 min, disabled/banned, gone) → rebind to the least
 *              loaded member; the new member is the target from now on;
 *   - bind     no live binding → bind to the least loaded member.
 * Pools keep their own candidate rules (status, group, model, concurrency); this
 * module only chooses among the candidates they pass in and owns the binding.
 */

import { query } from '../../db/queries.js'
import { recordPoolEvent, type PoolMemberKind } from './events.js'

export const AFFINITY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Same boundary as the session-pin rule (store.ts PIN_LONG_COOLDOWN_MS). */
export const AFFINITY_LONG_COOLDOWN_MS = 30 * 60 * 1000
/** Renewal writes are throttled per binding. */
export const AFFINITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000
export const AFFINITY_MIGRATION_WINDOW_MS = 10 * 60 * 1000
export const AFFINITY_MAX_MIGRATIONS_PER_WINDOW = 2
/** Default cap of bound users per subscription account (API keys: no cap). */
export const DEFAULT_MAX_USERS_PER_SUBSCRIPTION = 8

export type AffinityAction = 'stay' | 'spill' | 'migrate' | 'bind'
export type Unavailability = 'temporary' | 'persistent'

export interface AffinityCandidate {
  memberKind: PoolMemberKind
  id: string
  /** Relative capacity (health × quota × plan); > 0. */
  capacity: number
  lastUsedAt?: Date | null
}

export interface AffinityBinding {
  memberKind: PoolMemberKind
  memberId: string
  lastUsedAt: Date
  expiresAt: Date
  migrationsRecent: number
  migrationsWindowStart: Date | null
}

/** State of the bound member when it is not among this request's candidates. */
export interface BoundMemberState {
  status: string | null // null = the member no longer exists
  cooldownReason: string | null
  cooldownUntil: Date | null
}

/** Shared temporary/persistent boundary (mirrors isLongCooldownForPin + admin states). */
export function classifyUnavailable(s: BoundMemberState, now: Date): Unavailability {
  if (s.status === null || s.status === 'disabled' || s.status === 'banned') return 'persistent'
  if (s.status === 'cooldown') {
    if (s.cooldownReason === 'auth' || s.cooldownReason === 'credential' || s.cooldownReason === 'quota') {
      return 'persistent'
    }
    if (s.cooldownUntil && s.cooldownUntil.getTime() - now.getTime() > AFFINITY_LONG_COOLDOWN_MS) return 'persistent'
  }
  return 'temporary'
}

/**
 * Least-loaded candidate: fewest live bindings per unit of capacity, members
 * at their user cap only when every candidate is at cap; ties go to the least
 * recently used, then the id (deterministic).
 */
export function chooseByLoad(
  candidates: ReadonlyArray<AffinityCandidate>,
  load: ReadonlyMap<string, number>,
  maxUsers: number | null,
): { member: AffinityCandidate; overCap: boolean } | null {
  if (candidates.length === 0) return null
  const bound = (c: AffinityCandidate) => load.get(c.id) ?? 0
  const underCap = maxUsers === null ? [...candidates] : candidates.filter((c) => bound(c) < maxUsers)
  const pool = underCap.length > 0 ? underCap : [...candidates]
  const score = (c: AffinityCandidate) => (bound(c) + 1) / (Number.isFinite(c.capacity) && c.capacity > 0 ? c.capacity : 0.05)
  pool.sort((a, b) => {
    const d = score(a) - score(b)
    if (Math.abs(d) > 1e-9) return d
    const la = a.lastUsedAt?.getTime() ?? 0
    const lb = b.lastUsedAt?.getTime() ?? 0
    if (la !== lb) return la - lb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return { member: pool[0], overCap: underCap.length === 0 }
}

/** Pure decision (unit-tested); the store functions below apply it. */
export function decideAffinity(args: {
  binding: AffinityBinding | null
  candidates: ReadonlyArray<AffinityCandidate>
  boundState: BoundMemberState | null
  load: ReadonlyMap<string, number>
  maxUsers: number | null
  now: Date
}): { action: AffinityAction; member: AffinityCandidate; overCap: boolean; reason: string | null } | null {
  const { binding, candidates, now } = args
  const live = binding && binding.expiresAt.getTime() > now.getTime() ? binding : null
  if (live) {
    const same = candidates.find((c) => c.memberKind === live.memberKind && c.id === live.memberId)
    if (same) return { action: 'stay', member: same, overCap: false, reason: null }
    const others = candidates
    const pick = chooseByLoad(others, args.load, args.maxUsers)
    if (!pick) return null
    const why = args.boundState ? classifyUnavailable(args.boundState, now) : 'temporary'
    if (why === 'temporary') return { action: 'spill', member: pick.member, overCap: pick.overCap, reason: null }
    const windowOpen =
      live.migrationsWindowStart !== null &&
      now.getTime() - live.migrationsWindowStart.getTime() < AFFINITY_MIGRATION_WINDOW_MS
    if (windowOpen && live.migrationsRecent >= AFFINITY_MAX_MIGRATIONS_PER_WINDOW) {
      return { action: 'spill', member: pick.member, overCap: pick.overCap, reason: 'migration_debounce' }
    }
    return { action: 'migrate', member: pick.member, overCap: pick.overCap, reason: migrateReason(args.boundState) }
  }
  const pick = chooseByLoad(candidates, args.load, args.maxUsers)
  if (!pick) return null
  return { action: 'bind', member: pick.member, overCap: pick.overCap, reason: null }
}

function migrateReason(s: BoundMemberState | null): string {
  if (!s || s.status === null) return 'member_gone'
  if (s.status === 'disabled' || s.status === 'banned') return s.status
  return s.cooldownReason ? `cooldown_${s.cooldownReason}` : 'cooldown_long'
}

// ── store ────────────────────────────────────────────────────────────────

interface BindingRow {
  member_kind: PoolMemberKind
  member_id: string
  last_used_at: Date
  expires_at: Date
  migrations_recent: number
  migrations_window_start: Date | null
}

export async function readAffinity(service: string, userId: bigint | string): Promise<AffinityBinding | null> {
  const r = await query<BindingRow>(
    `SELECT member_kind, member_id, last_used_at, expires_at, migrations_recent, migrations_window_start
       FROM pool_user_affinity WHERE service = $1 AND user_id = $2`,
    [service, String(userId)],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    memberKind: row.member_kind,
    memberId: row.member_id,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    migrationsRecent: row.migrations_recent,
    migrationsWindowStart: row.migrations_window_start,
  }
}

/** Live bindings per member id for one service. */
export async function affinityLoad(service: string): Promise<Map<string, number>> {
  const r = await query<{ member_id: string; n: string }>(
    `SELECT member_id, count(*)::text AS n FROM pool_user_affinity
      WHERE service = $1 AND expires_at > NOW() GROUP BY member_id`,
    [service],
  )
  return new Map(r.rows.map((x) => [x.member_id, Number(x.n)]))
}

const lastTouch = new Map<string, number>()

/** Tests only. */
export function _resetAffinityTouchForTest(): void {
  lastTouch.clear()
}

export interface ResolveAffinityArgs {
  service: string
  userId: bigint | string
  candidates: ReadonlyArray<AffinityCandidate>
  /** State of a bound member that is not a candidate (null = deleted). Only called on a miss. */
  boundState: (b: AffinityBinding) => Promise<BoundMemberState | null>
  maxUsers?: number | null
  now?: () => Date
}

export interface ResolvedAffinity {
  action: AffinityAction
  member: AffinityCandidate
}

/**
 * Choose the member for this request and keep the binding. Returns null when
 * there are no candidates (the pool's own "no member" path applies).
 */
export async function resolveAffinity(a: ResolveAffinityArgs): Promise<ResolvedAffinity | null> {
  if (a.candidates.length === 0) return null
  const now = (a.now ?? (() => new Date()))()
  const uid = String(a.userId)
  const binding = await readAffinity(a.service, uid)
  const live = binding && binding.expiresAt.getTime() > now.getTime() ? binding : null
  const hit = live ? a.candidates.some((c) => c.memberKind === live.memberKind && c.id === live.memberId) : false
  const boundState = live && !hit ? await a.boundState(live) : null
  const load = hit ? new Map<string, number>() : await affinityLoad(a.service)
  const d = decideAffinity({
    binding: live,
    candidates: a.candidates,
    boundState,
    load,
    maxUsers: a.maxUsers === undefined ? null : a.maxUsers,
    now,
  })
  if (!d) return null
  const expires = new Date(now.getTime() + AFFINITY_TTL_MS)
  if (d.action === 'stay') {
    const key = `${a.service}:${uid}`
    const prev = lastTouch.get(key) ?? 0
    if (now.getTime() - prev >= AFFINITY_TOUCH_INTERVAL_MS) {
      lastTouch.set(key, now.getTime())
      await query(
        `UPDATE pool_user_affinity SET last_used_at = $3, expires_at = $4
          WHERE service = $1 AND user_id = $2`,
        [a.service, uid, now, expires],
      )
    }
    return { action: 'stay', member: d.member }
  }
  if (d.action === 'spill') return { action: 'spill', member: d.member }
  if (d.action === 'bind') {
    // First request wins under concurrency; everyone else follows the winner if it is a candidate.
    const ins = await query<{ member_id: string }>(
      `INSERT INTO pool_user_affinity (service, user_id, member_kind, member_id, bound_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT (service, user_id) DO UPDATE
         SET member_kind = EXCLUDED.member_kind, member_id = EXCLUDED.member_id, bound_at = EXCLUDED.bound_at,
             last_used_at = EXCLUDED.last_used_at, expires_at = EXCLUDED.expires_at,
             prev_member_id = NULL, migrated_at = NULL, migrate_reason = NULL,
             migrations_recent = 0, migrations_window_start = NULL
         WHERE pool_user_affinity.expires_at <= $5
       RETURNING member_id`,
      [a.service, uid, d.member.memberKind, d.member.id, now, expires],
    )
    if (ins.rows.length === 0) {
      const winner = await readAffinity(a.service, uid)
      const w = winner && a.candidates.find((c) => c.memberKind === winner.memberKind && c.id === winner.memberId)
      return { action: 'stay', member: w ?? d.member }
    }
    lastTouch.set(`${a.service}:${uid}`, now.getTime())
    await recordAffinityEvent(a.service, d.member, 'affinity_bind', null, d.overCap)
    return { action: 'bind', member: d.member }
  }
  // migrate: only if the binding still points at the member we judged unavailable.
  const windowFresh =
    !live!.migrationsWindowStart || now.getTime() - live!.migrationsWindowStart.getTime() >= AFFINITY_MIGRATION_WINDOW_MS
  const upd = await query(
    `UPDATE pool_user_affinity
        SET prev_member_id = member_id, member_kind = $3, member_id = $4, migrated_at = $5, migrate_reason = $6,
            last_used_at = $5, expires_at = $7,
            migrations_recent = CASE WHEN $8 THEN 1 ELSE migrations_recent + 1 END,
            migrations_window_start = CASE WHEN $8 THEN $5 ELSE migrations_window_start END
      WHERE service = $1 AND user_id = $2 AND member_kind = $9 AND member_id = $10`,
    [a.service, uid, d.member.memberKind, d.member.id, now, d.reason, expires, windowFresh, live!.memberKind, live!.memberId],
  )
  if ((upd.rowCount ?? 0) === 0) {
    // Another request already moved it: follow the new binding when it is a candidate.
    const cur = await readAffinity(a.service, uid)
    const c = cur && a.candidates.find((x) => x.memberKind === cur.memberKind && x.id === cur.memberId)
    return { action: c ? 'stay' : 'spill', member: c ?? d.member }
  }
  lastTouch.set(`${a.service}:${uid}`, now.getTime())
  await recordAffinityEvent(a.service, d.member, 'affinity_migrate', d.reason, d.overCap)
  return { action: 'migrate', member: d.member }
}

async function recordAffinityEvent(
  service: string,
  m: AffinityCandidate,
  outcome: 'affinity_bind' | 'affinity_migrate',
  reason: string | null,
  overCap: boolean,
): Promise<void> {
  await recordPoolEvent({
    service,
    memberKind: m.memberKind,
    memberId: m.id,
    outcome: overCap ? `${outcome}_over_cap` : outcome,
    fromStatus: null,
    toStatus: null,
    reason,
    until: null,
  })
}

/** Admin view: live bound users per member of one service. */
export async function affinityCounts(): Promise<Map<string, number>> {
  const r = await query<{ service: string; member_kind: string; member_id: string; n: string }>(
    `SELECT service, member_kind, member_id, count(*)::text AS n FROM pool_user_affinity
      WHERE expires_at > NOW() GROUP BY 1, 2, 3`,
  )
  return new Map(r.rows.map((x) => [`${x.service}:${x.member_kind}:${x.member_id}`, Number(x.n)]))
}

// ── per-member caps (docs §6): spill, never rebind ─────────────────────────

export interface AffinitySettings {
  maxUsersPerSubscription: number
  ratePerMin: number
  antigravityInflight: number
  antigravityRatePerMin: number
}

export const DEFAULT_AFFINITY_SETTINGS: AffinitySettings = {
  maxUsersPerSubscription: DEFAULT_MAX_USERS_PER_SUBSCRIPTION,
  ratePerMin: 30,
  antigravityInflight: 3,
  antigravityRatePerMin: 20,
}

let settingsCache: { at: number; value: AffinitySettings } | null = null
let settingsLoader: (() => Promise<AffinitySettings>) | null = null

/** Wire the admin system-settings reader (index.ts); tests can inject. */
export function configureAffinitySettings(loader: (() => Promise<AffinitySettings>) | null): void {
  settingsLoader = loader
  settingsCache = null
}

/** Cached 60s; a failed read keeps the defaults (selection must never block on settings). */
export async function affinitySettings(now = Date.now()): Promise<AffinitySettings> {
  if (settingsCache && now - settingsCache.at < 60_000) return settingsCache.value
  let value = DEFAULT_AFFINITY_SETTINGS
  if (settingsLoader) {
    try {
      value = await settingsLoader()
    } catch {
      value = settingsCache?.value ?? DEFAULT_AFFINITY_SETTINGS
    }
  }
  settingsCache = { at: now, value }
  return value
}

const rateWindows = new Map<string, number[]>()

function memberKey(service: string, id: string): string {
  return `${service}:${id}`
}

/** True when the member admitted fewer than `perMin` requests in the last 60s (this process). */
export function underRateCap(service: string, id: string, perMin: number, now = Date.now()): boolean {
  const w = rateWindows.get(memberKey(service, id))
  if (!w) return true
  while (w.length > 0 && now - w[0] >= 60_000) w.shift()
  return w.length < perMin
}

export function noteAdmission(service: string, id: string, now = Date.now()): void {
  const k = memberKey(service, id)
  const w = rateWindows.get(k) ?? []
  while (w.length > 0 && now - w[0] >= 60_000) w.shift()
  w.push(now)
  rateWindows.set(k, w)
}

/** In-flight units per member (e.g. Antigravity turns): token → expiry, so a lost release cannot leak. */
const inflight = new Map<string, Map<string, number>>()
const inflightOwner = new Map<string, string>()
export const INFLIGHT_TTL_MS = 15 * 60 * 1000

export function inflightCount(service: string, id: string, now = Date.now()): number {
  const m = inflight.get(memberKey(service, id))
  if (!m) return 0
  for (const [t, exp] of m) if (exp <= now) { m.delete(t); inflightOwner.delete(t) }
  return m.size
}

export function acquireInflight(service: string, id: string, token: string, now = Date.now(), ttlMs = INFLIGHT_TTL_MS): void {
  const k = memberKey(service, id)
  const m = inflight.get(k) ?? new Map<string, number>()
  m.set(token, now + ttlMs)
  inflight.set(k, m)
  inflightOwner.set(token, k)
}

/**
 * Check-and-reserve with no await in between (atomic in this process): reserve a
 * unit on the first member in `order` under `cap`; when every member is at the
 * cap, reserve on the first anyway (never refuse service). Also counts the
 * admission for the per-minute window. Returns the member id reserved.
 */
export function reserveInflight(
  service: string,
  order: ReadonlyArray<string>,
  token: string,
  cap: number,
  now = Date.now(),
): string | null {
  if (order.length === 0) return null
  const id = order.find((m) => inflightCount(service, m, now) < cap) ?? order[0]
  acquireInflight(service, id, token, now)
  noteAdmission(service, id, now)
  return id
}

export function releaseInflight(token: string): void {
  const k = inflightOwner.get(token)
  if (!k) return
  inflightOwner.delete(token)
  inflight.get(k)?.delete(token)
}

/** Tests only. */
export function _resetAffinityCapsForTest(): void {
  rateWindows.clear()
  inflight.clear()
  inflightOwner.clear()
  settingsCache = null
  settingsLoader = null
}
