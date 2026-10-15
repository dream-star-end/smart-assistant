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
}

export function createGeminiPoolAdapter(deps: GeminiPoolAdapterDeps): PoolAdapter {
  const freshToken = deps.freshToken ?? ((id, oauth) => getFreshAntigravityAccessToken(id, oauth))
  return {
    name: 'gemini-oauth',
    memberKind: 'account',
    halfOpenDue: () => halfOpenTableMembers(GEMINI_OAUTH_MEMBERS),
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
        `SELECT id::text AS id, label, email, status, disabled_by, health_score, cooldown_reason, cooldown_until,
                next_probe_at, last_error, last_used_at
           FROM gemini_oauth_accounts ORDER BY id`,
      )
      return res.rows.map((r) => ({
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
        hints: { plan: 'Antigravity', name: r.label !== r.email ? r.label : null, manage: 'antigravity' },
      }))
    },
  }
}
