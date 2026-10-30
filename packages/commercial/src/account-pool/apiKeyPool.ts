/**
 * OCV5-424 — API-key members of the service pools (pool_api_keys).
 *
 * One table holds the API keys of every service that has no account row:
 * Anthropic keys (the claude pool's API tier), static providers (deepseek,
 * minimax, ark, zai, kimi, moonshot, bailian, opencodego), Gemini and OpenAI. Each
 * service is its own pool; selection, cooldowns and recovery are the shared
 * policy (policy/select, policy/decide, policy/registry) — nothing here decides
 * a cooldown on its own.
 *
 * Credentials: AES-256-GCM with the KMS key (same as OAuth tokens), decrypted
 * only in `selectKey` for the request that uses it; admin/API surfaces only ever
 * see `fingerprint` (sha256 prefix) and `key_hint` (last 4).
 *
 * Env keys (DEEPSEEK_API_KEY, ...) are imported at boot as members with
 * source='env', so existing deployments keep working and gain extra keys by
 * adding them in the admin 服务池 page.
 */

import { createHash } from 'node:crypto'
import { resolveAffinity } from './policy/affinity.js'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey } from '../crypto/keys.js'
import { query } from '../db/queries.js'
import type { CooldownReason, PoolOutcome } from './policy/outcome.js'
import type { DueProbe, PoolAdapter, PoolMemberView, ProbeResult } from './policy/registry.js'
import { healthWeight, rankWRH } from './policy/select.js'
import {
  API_KEY_MEMBERS,
  RELAY_KEY_MEMBERS,
  applyTableMemberOutcome,
  applyTableProbeResult,
  halfOpenTableMembers,
  listDueTableProbes,
} from './policy/tableMembers.js'

export const API_KEY_SERVICE_RE = /^[a-z][a-z0-9-]{1,31}$/
/** Default tier for API keys; subscriptions are tier 0 in the claude pool. */
export const API_KEY_DEFAULT_TIER = 1

export interface ApiKeyMemberRow {
  id: string
  service: string
  label: string
  fingerprint: string
  key_hint: string
  source: 'admin' | 'env'
  tier: number
  weight: number
  status: 'active' | 'cooldown' | 'disabled'
  disabled_by: string | null
  health_score: number
  cooldown_until: Date | null
  cooldown_reason: CooldownReason | null
  backoff_level: number
  next_probe_at: Date | null
  last_error: string | null
  last_used_at: Date | null
}

interface SecretRow extends ApiKeyMemberRow {
  key_enc: Buffer
  key_nonce: Buffer
}

export function apiKeyFingerprint(service: string, key: string): string {
  return createHash('sha256').update(`${service}:${key}`).digest('hex').slice(0, 16)
}

export function apiKeyHint(key: string): string {
  const k = key.trim()
  return k.length <= 8 ? '' : `…${k.slice(-4)}`
}

const MEMBER_COLUMNS = `id::text AS id, service, label, fingerprint, key_hint, source, tier, weight, status,
  disabled_by, health_score, cooldown_until, cooldown_reason, backoff_level, next_probe_at, last_error, last_used_at`

// ── snapshot cache (per process) ─────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 15_000
let snapshot: { at: number; rows: SecretRow[] } | null = null
let loading: Promise<SecretRow[]> | null = null

async function loadSnapshot(): Promise<SecretRow[]> {
  const res = await query<SecretRow>(
    `SELECT ${MEMBER_COLUMNS}, key_enc, key_nonce FROM pool_api_keys ORDER BY service, id`,
  )
  snapshot = { at: Date.now(), rows: res.rows }
  return res.rows
}

async function rows(): Promise<SecretRow[]> {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.rows
  // at === 0 means a member changed state (admin disable, cooldown, new key): the
  // cached rows are known to be out of date and must not be used for selection.
  const invalidated = snapshot !== null && snapshot.at === 0
  if (!loading) {
    loading = loadSnapshot().finally(() => {
      loading = null
    })
  }
  try {
    return await loading
  } catch {
    // Plain TTL expiry + DB hiccup: keep serving the last snapshot. After an explicit
    // state change, fail closed (no selectable rows → pool_unavailable) so a key that
    // was just disabled or cooled can never be picked from stale data.
    return invalidated ? [] : (snapshot?.rows ?? [])
  }
}

/** Apply a known state change to the cached row right away (selection and config gate). */
function patchCachedStatus(id: string, status: SecretRow['status']): void {
  if (!snapshot) return
  snapshot = {
    at: 0,
    rows: snapshot.rows.map((r) => (r.id === id ? { ...r, status, cooldown_until: status === 'active' ? null : r.cooldown_until } : r)),
  }
}

/**
 * Mark the snapshot stale so the next selection re-reads the table. The rows are
 * kept: the sync config gate (`apiKeyPoolConfiguredServices`) must not see an empty
 * pool just because one member changed state.
 */
export function invalidateApiKeyPoolCache(): void {
  if (snapshot) snapshot = { at: 0, rows: snapshot.rows }
}

/**
 * Services that have at least one member that is not admin-disabled (cooling
 * members recover on their own, so the service counts as configured). Sync, from
 * the last snapshot: used by the request-time config gate.
 */
export function apiKeyPoolConfiguredServices(): ReadonlySet<string> {
  const out = new Set<string>()
  for (const r of snapshot?.rows ?? []) if (r.status !== 'disabled') out.add(r.service)
  return out
}

/**
 * True when the pool holds any member for `service` (any status) in the last
 * snapshot. When it does, the pool is the authority: callers must not fall back to
 * the raw env key, which would bypass admin disables and cooldowns.
 */
export function apiKeyPoolHasMembers(service: string): boolean {
  return (snapshot?.rows ?? []).some((r) => r.service === service)
}

/**
 * Whether embedding lookup should call selectApiKey for `service`.
 *
 * No snapshot (unit tests, or pool prime failed) means "not configured":
 * callers keep today's backend instead of blocking on a DB timeout.
 * An invalidated snapshot may be missing a key just written, so callers reload.
 */
export function apiKeyPoolShouldQuery(service: string): boolean {
  if (!snapshot) return false
  if (snapshot.at === 0) return true
  return snapshot.rows.some((r) => r.service === service)
}

export interface ApiKeyPoolSnapshotMember {
  id: string
  service: string
  status: 'active' | 'cooldown' | 'disabled'
  /** When set on an active row, the member stays unusable until this time. */
  cooldownUntil?: Date | null
}

/**
 * Install a pool snapshot without reading the database. Tests use this to
 * prove a disabled or cooling pool stays authoritative. Never call it from
 * production paths.
 */
export function installApiKeyPoolSnapshotForTests(members: ApiKeyPoolSnapshotMember[]): void {
  snapshot = {
    at: Date.now(),
    rows: members.map((member) => ({
      id: member.id,
      service: member.service,
      label: 'test',
      fingerprint: '0000000000000000',
      key_hint: '…test',
      source: 'admin' as const,
      tier: API_KEY_DEFAULT_TIER,
      weight: 1,
      status: member.status === 'cooldown' ? 'cooldown' : member.status,
      disabled_by: member.status === 'disabled' ? 'admin' : null,
      health_score: 100,
      cooldown_until: member.cooldownUntil ?? null,
      cooldown_reason: member.status === 'active' && member.cooldownUntil == null ? null : 'rate_limited',
      backoff_level: 0,
      next_probe_at: null,
      last_error: null,
      last_used_at: null,
      key_enc: Buffer.alloc(0),
      key_nonce: Buffer.alloc(0),
    })),
  }
  loading = null
}

/** Drop the in-process pool snapshot. Tests only. */
export function resetApiKeyPoolSnapshotForTests(): void {
  snapshot = null
  loading = null
}

/** Load the snapshot now (boot); throws if the DB is unreachable. */
export async function primeApiKeyPool(): Promise<void> {
  await loadSnapshot()
}

/** Load the snapshot now (boot) and keep it fresh in the background. */
export function startApiKeyPoolCache(opts: { intervalMs?: number } = {}): { stop(): void } {
  void rows().catch(() => {})
  const t = setInterval(() => {
    void loadSnapshot().catch(() => {})
  }, Math.max(1000, opts.intervalMs ?? SNAPSHOT_TTL_MS))
  if (typeof t.unref === 'function') t.unref()
  return { stop: () => clearInterval(t) }
}

// ── selection ────────────────────────────────────────────────────────────────

export interface SelectedApiKey {
  service: string
  memberId: string
  apiKey: string
}

/**
 * Best usable key for `service`, or null when the pool has none (callers then fall
 * back to the env key, if any). Usable = active; cooling members come back through
 * the shared recovery actor.
 */
export async function selectApiKey(
  service: string,
  stickyKey: string,
  keyFn: () => Buffer = loadKmsKey,
  opts: { userId?: bigint | string | null } = {},
): Promise<SelectedApiKey | null> {
  const now = Date.now()
  const usable = (await rows()).filter(
    (r) => r.service === service && r.status === 'active' && (r.cooldown_until === null || r.cooldown_until.getTime() <= now),
  )
  if (usable.length === 0) return null
  let ranked = rankWRH(usable, {
    key: stickyKey,
    id: (r) => r.id,
    weight: (r) => healthWeight(r.health_score, r.weight),
    tier: (r) => r.tier,
  })
  // OCV5-424 user affinity: within the best available tier, the user's bound key
  // first (spill/migrate per the shared rules); the WRH order stays the fallback.
  if (opts.userId !== undefined && opts.userId !== null && String(opts.userId) !== '') {
    try {
      const bestTier = Math.min(...usable.map((r) => r.tier))
      const tierRows = usable.filter((r) => r.tier === bestTier)
      const resolved = await resolveAffinity({
        service: `apikey:${service}`,
        userId: opts.userId,
        candidates: tierRows.map((r) => ({
          memberKind: 'api_key' as const,
          id: r.id,
          capacity: healthWeight(r.health_score, r.weight),
          lastUsedAt: r.last_used_at,
        })),
        maxUsers: null,
        boundState: async (b) => {
          const row = (await rows()).find((r) => r.id === b.memberId)
          return row
            ? { status: row.status, cooldownReason: row.cooldown_reason, cooldownUntil: row.cooldown_until }
            : { status: null, cooldownReason: null, cooldownUntil: null }
        },
      })
      if (resolved) {
        const first = ranked.find((r) => r.id === resolved.member.id)
        if (first) ranked = [first, ...ranked.filter((r) => r !== first)]
      }
    } catch {
      /* affinity is best-effort: the WRH order still serves */
    }
  }
  const key = keyFn()
  try {
    for (const r of ranked) {
      try {
        const buf = decryptToBuffer(r.key_enc, r.key_nonce, key)
        const apiKey = buf.toString('utf8')
        buf.fill(0)
        return { service, memberId: r.id, apiKey }
      } catch {
        void reportApiKeyOutcome(r.id, { kind: 'credential_corrupt', detail: 'aead_select' }).catch(() => {})
      }
    }
    return null
  } finally {
    key.fill(0)
  }
}

// ── outcome reporting (shared decide via policy/tableMembers) ────────────────

/** Report what happened to a request made with this member. Never throws. */
export async function reportApiKeyOutcome(memberId: string, outcome: PoolOutcome): Promise<void> {
  try {
    // A provider 5xx says nothing about this key (every key of the provider gets it), and
    // most services hold a single key: counting it as a strike would cool the only key
    // and turn a provider blip into a 10-minute outage. Visible, not a strike (same rule
    // as the Grok relay). 429 / 401 / quota stay key-specific.
    const effective: PoolOutcome =
      outcome.kind === 'upstream_error' && /^http_5\d\d$/.test(outcome.detail ?? '')
        ? { kind: 'network', detail: outcome.detail }
        : outcome
    if (await applyTableMemberOutcome(API_KEY_MEMBERS, memberId, effective)) {
      // Any transition the policy writes here takes the member out of 'active'
      // (success never changes status), so drop it from selection immediately.
      if (effective.kind !== 'success') patchCachedStatus(memberId, 'cooldown')
      invalidateApiKeyPoolCache()
    }
  } catch (err) {
    // eslint-disable-next-line no-console -- reporting must never break the request path
    console.warn('[apiKeyPool] report failed:', (err as Error)?.message ?? err)
  }
}

// ── admin / boot writes ──────────────────────────────────────────────────────

export async function upsertApiKey(input: {
  service: string
  apiKey: string
  label?: string
  source: 'admin' | 'env'
  tier?: number
  weight?: number
  keyFn?: () => Buffer
}): Promise<{ id: string; created: boolean }> {
  const service = input.service.trim()
  const apiKey = input.apiKey.trim()
  if (!API_KEY_SERVICE_RE.test(service)) throw new RangeError('invalid_service')
  if (apiKey.length < 8 || apiKey.length > 4096 || /\s/.test(apiKey)) throw new RangeError('invalid_api_key')
  const fp = apiKeyFingerprint(service, apiKey)
  const key = (input.keyFn ?? loadKmsKey)()
  try {
    const enc = encrypt(apiKey, key)
    const res = await query<{ id: string; created: boolean }>(
      `INSERT INTO pool_api_keys (service, label, key_enc, key_nonce, fingerprint, key_hint, source, tier, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (service, fingerprint) DO UPDATE SET updated_at = pool_api_keys.updated_at
       RETURNING id::text AS id, (xmax = 0) AS created`,
      [
        service,
        (input.label ?? '').trim().slice(0, 80),
        enc.ciphertext,
        enc.nonce,
        fp,
        apiKeyHint(apiKey),
        input.source,
        input.tier ?? API_KEY_DEFAULT_TIER,
        input.weight ?? 100,
      ],
    )
    invalidateApiKeyPoolCache()
    return res.rows[0]
  } finally {
    key.fill(0)
  }
}

/** Import configured env keys as pool members (idempotent by fingerprint). */
export async function importEnvApiKeys(
  keys: Partial<Record<string, string | undefined>>,
  keyFn: () => Buffer = loadKmsKey,
): Promise<number> {
  let created = 0
  for (const [service, value] of Object.entries(keys)) {
    if (!value || value.trim() === '' || !API_KEY_SERVICE_RE.test(service)) continue
    try {
      const r = await upsertApiKey({ service, apiKey: value, source: 'env', label: 'env', keyFn })
      if (r.created) created += 1
      // env is the authority for env-sourced members: a rotated env key replaces the old one.
      await query(
        `DELETE FROM pool_api_keys WHERE service = $1 AND source = 'env' AND fingerprint <> $2`,
        [service, apiKeyFingerprint(service, value.trim())],
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[apiKeyPool] env import for ${service} skipped:`, (err as Error)?.message ?? err)
    }
  }
  return created
}

/** Admin enable/disable. Disabling records disabled_by='admin' in the same UPDATE. */
export async function setApiKeyAdminStatus(id: string, status: 'active' | 'disabled'): Promise<ApiKeyMemberRow | null> {
  const res = await query<ApiKeyMemberRow>(
    status === 'disabled'
      ? `UPDATE pool_api_keys SET status = 'disabled', disabled_by = 'admin', cooldown_until = NULL,
           cooldown_reason = NULL, next_probe_at = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`
      : `UPDATE pool_api_keys SET status = 'active', disabled_by = NULL, cooldown_until = NULL,
           cooldown_reason = NULL, next_probe_at = NULL, backoff_level = 0, health_score = 100,
           last_error = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING ${MEMBER_COLUMNS}`,
    [id],
  )
  if (res.rows[0]) patchCachedStatus(id, res.rows[0].status)
  invalidateApiKeyPoolCache()
  return res.rows[0] ?? null
}

export async function listApiKeyMembers(): Promise<ApiKeyMemberRow[]> {
  const res = await query<ApiKeyMemberRow>(`SELECT ${MEMBER_COLUMNS} FROM pool_api_keys ORDER BY service, tier, id`)
  return res.rows
}

// ── registry adapter ─────────────────────────────────────────────────────────

/**
 * API keys have no refresh endpoint, so an auth/credential cooldown is probed
 * by decrypting (credential) or optimistically (auth): the member rejoins the
 * pool when the cooldown expires and the next real request decides. The backoff
 * level survives reactivation, so a key that keeps failing waits 5min·2^level
 * (max 6h) between tries — automatic, bounded, no human needed.
 */
export function createApiKeyPoolAdapter(keyFn: () => Buffer = loadKmsKey): PoolAdapter {
  return {
    name: 'api-keys',
    memberKind: 'api_key',
    async halfOpenDue(): Promise<number> {
      const n = await halfOpenTableMembers(API_KEY_MEMBERS)
      if (n > 0) invalidateApiKeyPoolCache()
      return n
    },
    listDueProbes: (limit: number): Promise<DueProbe[]> => listDueTableProbes(API_KEY_MEMBERS, limit),
    async probe(m: DueProbe): Promise<ProbeResult> {
      const res = await query<{ key_enc: Buffer; key_nonce: Buffer }>(
        'SELECT key_enc, key_nonce FROM pool_api_keys WHERE id = $1',
        [m.id],
      )
      const r = res.rows[0]
      if (!r) return { ok: false, detail: 'member_missing' }
      const key = keyFn()
      try {
        decryptToBuffer(r.key_enc, r.key_nonce, key).fill(0)
        return { ok: true }
      } catch {
        return { ok: false, detail: 'decrypt_failed' }
      } finally {
        key.fill(0)
      }
    },
    async applyProbeResult(m: DueProbe, result: ProbeResult): Promise<void> {
      if (await applyTableProbeResult(API_KEY_MEMBERS, m, result)) invalidateApiKeyPoolCache()
    },
    async listMembers(): Promise<PoolMemberView[]> {
      return (await listApiKeyMembers()).map((r) => ({
        service: r.service,
        memberKind: 'api_key' as const,
        id: r.id,
        credentialType: 'api_key' as const,
        label: r.label,
        status: r.status,
        disabledBy: r.disabled_by,
        healthScore: r.health_score,
        cooldownReason: r.cooldown_reason,
        cooldownUntil: r.cooldown_until?.toISOString() ?? null,
        nextProbeAt: r.next_probe_at?.toISOString() ?? null,
        lastError: r.last_error ? r.last_error.slice(0, 160) : null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        hints: { key: r.key_hint, fingerprint: r.fingerprint.slice(0, 8), source: r.source, tier: r.tier, weight: r.weight },
      }))
    },
  }
}

/**
 * Codex relay keys (api_relay_credentials) are the codex pool's API-key members.
 * Same shared recovery as pool_api_keys; probe = the stored key still decrypts.
 */
export function createRelayKeyPoolAdapter(keyFn: () => Buffer = loadKmsKey): PoolAdapter {
  return {
    name: 'relay-keys',
    memberKind: 'relay_key',
    halfOpenDue: () => halfOpenTableMembers(RELAY_KEY_MEMBERS),
    listDueProbes: (limit: number) => listDueTableProbes(RELAY_KEY_MEMBERS, limit),
    async probe(m: DueProbe): Promise<ProbeResult> {
      const res = await query<{ api_key_enc: Buffer | null; api_key_nonce: Buffer | null }>(
        'SELECT api_key_enc, api_key_nonce FROM api_relay_credentials WHERE id = $1',
        [m.id],
      )
      const r = res.rows[0]
      if (!r || !r.api_key_enc || !r.api_key_nonce) return { ok: false, detail: 'member_missing' }
      const key = keyFn()
      try {
        decryptToBuffer(r.api_key_enc, r.api_key_nonce, key).fill(0)
        return { ok: true }
      } catch {
        return { ok: false, detail: 'decrypt_failed' }
      } finally {
        key.fill(0)
      }
    },
    async applyProbeResult(m: DueProbe, result: ProbeResult): Promise<void> {
      await applyTableProbeResult(RELAY_KEY_MEMBERS, m, result)
    },
    async listMembers(): Promise<PoolMemberView[]> {
      const res = await query<{
        id: string
        label: string | null
        status: string
        disabled_by: string | null
        health_score: number
        cooldown_reason: CooldownReason | null
        cooldown_until: Date | null
        next_probe_at: Date | null
        last_error: string | null
        last_used_at: Date | null
        provider_name: string | null
      }>(
        `SELECT id::text AS id, label, status, disabled_by, health_score, cooldown_reason, cooldown_until,
                next_probe_at, last_error, last_used_at, provider_name
           FROM api_relay_credentials ORDER BY id`,
      )
      return res.rows.map((r) => ({
        service: 'codex',
        memberKind: 'relay_key' as const,
        id: r.id,
        credentialType: 'api_key' as const,
        label: r.label ?? '',
        status: r.status,
        disabledBy: r.disabled_by,
        healthScore: r.health_score,
        cooldownReason: r.cooldown_reason,
        cooldownUntil: r.cooldown_until?.toISOString() ?? null,
        nextProbeAt: r.next_probe_at?.toISOString() ?? null,
        lastError: r.last_error ? r.last_error.slice(0, 160) : null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        hints: { relay: r.provider_name },
      }))
    },
  }
}
