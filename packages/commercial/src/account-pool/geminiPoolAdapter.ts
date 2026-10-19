/**
 * OCV5-424 — the gemini pool's subscription members: Antigravity Google AI
 * accounts (gemini_oauth_accounts, OCV5-415). Same shared recovery actor as
 * every other pool: expired plain cooldowns half-open, auth/credential
 * cooldowns are probed. Probe = the stored grant still yields an access token
 * (refreshes it when the cached one has expired; an auth cooldown expires the
 * cached token, so the probe really asks Google).
 */
import {
  AntigravityOAuthError,
  getFreshAntigravityAccessToken,
  type AntigravityOAuthDeps,
} from './antigravityOAuth.js'
import { query } from '../db/queries.js'
import { ANTIGRAVITY_QUOTA_TTL_MS, antigravityAccountQuota, type AntigravityQuotaDeps } from './antigravityQuota.js'
import { isAntigravityUltra } from './antigravityPool.js'
import type { CooldownReason } from './policy/outcome.js'
import type { DueProbe, PoolAdapter, PoolMemberView, ProbeResult } from './policy/registry.js'
import {
  GEMINI_OAUTH_MEMBERS,
  applyTableProbeResult,
  halfOpenTableMembers,
  listDueTableProbes,
} from './policy/tableMembers.js'

export interface GeminiPoolAdapterDeps {
  /** OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET; empty → probes report transient (re-check later). */
  clientSecret: () => string
  freshToken?: (accountId: bigint, deps: AntigravityOAuthDeps) => Promise<Buffer>
  /** Admin quota reader (tests inject); default reads Google with the account's token, cached. */
  quota?: (accountId: string) => Promise<NonNullable<PoolMemberView['quota']>>
}

export function createGeminiPoolAdapter(deps: GeminiPoolAdapterDeps): PoolAdapter {
  const freshToken = deps.freshToken ?? ((id, oauth) => getFreshAntigravityAccessToken(id, oauth))
  const quotaDeps: AntigravityQuotaDeps = { clientSecret: deps.clientSecret }
  const readQuota = deps.quota ?? ((id: string) => antigravityAccountQuota(id, quotaDeps))
  let refreshAt = 0
  let refreshing = false
  const refreshMetadata = async (): Promise<void> => {
    if (refreshing || Date.now() < refreshAt || !deps.clientSecret()) return
    refreshing = true
    refreshAt = Date.now() + ANTIGRAVITY_QUOTA_TTL_MS
    try {
      const rows = await query<{ id: string }>('SELECT id::text AS id FROM gemini_oauth_accounts WHERE disabled_by IS NULL ORDER BY id')
      for (const row of rows.rows) await readQuota(row.id)
    } finally { refreshing = false }
  }
  return {
    name: 'gemini-oauth',
    memberKind: 'account',
    halfOpenDue: () => {
      // Reuse the one recovery actor's timer; never put metadata HTTP on the chat path.
      void refreshMetadata().catch(() => {})
      return halfOpenTableMembers(GEMINI_OAUTH_MEMBERS)
    },
    listDueProbes: (limit: number): Promise<DueProbe[]> => listDueTableProbes(GEMINI_OAUTH_MEMBERS, limit),
    async probe(m: DueProbe): Promise<ProbeResult> {
      const clientSecret = deps.clientSecret()
      if (!clientSecret) return { ok: false, transient: true, detail: 'oauth_not_configured' }
      try {
        ;(await freshToken(BigInt(m.id), { clientSecret })).fill(0)
        return { ok: true }
      } catch (err) {
        if (err instanceof AntigravityOAuthError && err.authInvalid) return { ok: false, detail: err.message }
        if (err instanceof Error && err.message === 'ANTIGRAVITY_ACCOUNT_NOT_FOUND') {
          return { ok: false, detail: 'member_missing' }
        }
        return { ok: false, transient: true, detail: err instanceof Error ? err.message.slice(0, 120) : 'probe_failed' }
      }
    },
    async applyProbeResult(m: DueProbe, result: ProbeResult): Promise<void> {
      await applyTableProbeResult(GEMINI_OAUTH_MEMBERS, m, result)
    },
    async listMembers(): Promise<PoolMemberView[]> {
      const res = await query<{
        id: string
        paid_tier: string | null
        tier_updated_at: Date | null
        label: string
        email: string
        status: string
        disabled_by: string | null
        health_score: number
        cooldown_reason: CooldownReason | null
        cooldown_until: Date | null
        next_probe_at: Date | null
        last_error: string | null
        last_used_at: Date | null
      }>(
        `SELECT id::text AS id, paid_tier, tier_updated_at, label, email, status, disabled_by, health_score, cooldown_reason, cooldown_until,
                next_probe_at, last_error, last_used_at
           FROM gemini_oauth_accounts ORDER BY id`,
      )
      const quotas = await Promise.all(res.rows.map((r) => readQuota(r.id)))
      return res.rows.map((r, i) => ({
        service: 'gemini',
        memberKind: 'account' as const,
        id: r.id,
        credentialType: 'subscription' as const,
        label: r.email,
        status: r.status,
        disabledBy: r.disabled_by,
        healthScore: r.health_score,
        cooldownReason: r.cooldown_reason,
        cooldownUntil: r.cooldown_until?.toISOString() ?? null,
        nextProbeAt: r.next_probe_at?.toISOString() ?? null,
        lastError: r.last_error ? r.last_error.slice(0, 160) : null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        hints: { plan: isAntigravityUltra(r.paid_tier) ? 'Google AI Ultra (Antigravity)' : r.paid_tier === 'g1-pro-tier' ? 'Google AI Pro (Antigravity)' : 'Antigravity · 等级未知', paid_tier: r.paid_tier, tier_updated_at: r.tier_updated_at?.toISOString() ?? null, name: r.label !== r.email ? r.label : null, manage: 'antigravity' },
        quota: quotas[i],
      }))
    },
  }
}
