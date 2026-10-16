/**
 * OCV5-424 — pool adapter for subscription accounts in claude_accounts
 * (services claude / codex / grok / cursor·Box). Storage + probes only; all
 * cooldown rules live in policy/decide, recovery runs in policy/registry.
 *
 * Probes (auth/credential cooldowns that came due):
 *   - credential: the stored ciphertext decrypts again (KMS restored / re-saved).
 *   - claude: OAuth refresh through the account's own egress (fail-closed: a bound
 *     egress that cannot be resolved is a transient result, never the default route).
 *   - codex: OAuth refresh (resolves its own egress).
 *   - grok: getFreshGrokAccessToken (refreshes when near expiry).
 *   - cursor: session/API credential still decrypts and is not past its expiry.
 * A refresh rejection inside these calls already moves the account one backoff
 * level further (refresh.ts → applyOutcome); applyProbeResult then leaves it alone.
 */

import { loadKmsKey } from '../crypto/keys.js'
import { query } from '../db/queries.js'
import { getDispatcherForAccount, resolveAccountEgressDispatcher } from './egressDispatcher.js'
import { getFreshGrokAccessToken, GrokOAuthRefreshError } from './grokOAuth.js'
import type { AccountHealthTracker } from './health.js'
import type { CooldownReason } from './policy/outcome.js'
import type { DueProbe, PoolAdapter, PoolMemberView, ProbeResult } from './policy/registry.js'
import { refreshAccountToken, refreshCodexAccountToken, RefreshError } from './refresh.js'
import { getTokenForUse } from './store.js'

export interface AccountPoolAdapterDeps {
  health: AccountHealthTracker
  keyFn?: () => Buffer
  triggerCodexDisableFanout?: (accountId: bigint) => void
}

function zero(b: Buffer | null | undefined): void {
  if (b) b.fill(0)
}

async function probeDecrypt(id: string, keyFn: () => Buffer): Promise<ProbeResult & { expiresAt?: Date | null }> {
  try {
    const t = await getTokenForUse(id, keyFn)
    if (!t) return { ok: false, detail: 'account_missing' }
    zero(t.token)
    zero(t.refresh)
    return { ok: true, expiresAt: t.expires_at }
  } catch {
    return { ok: false, detail: 'decrypt_failed' }
  }
}

function refreshFailure(err: unknown): ProbeResult {
  if (err instanceof RefreshError) {
    return err.code === 'network_transient'
      ? { ok: false, transient: true, detail: 'refresh_transient' }
      : { ok: false, detail: `refresh_${err.code}` }
  }
  if (err instanceof GrokOAuthRefreshError) {
    return err.terminal
      ? { ok: false, detail: 'grok_oauth_terminal' }
      : { ok: false, transient: true, detail: `grok_oauth_${err.statusCode}` }
  }
  return { ok: false, transient: true, detail: `probe_error:${(err as Error)?.name ?? 'error'}` }
}

export function createAccountPoolAdapter(deps: AccountPoolAdapterDeps): PoolAdapter {
  const keyFn = deps.keyFn ?? loadKmsKey
  return {
    name: 'accounts',
    memberKind: 'account',
    async halfOpenDue(): Promise<number> {
      return (await deps.health.halfOpen()).length
    },
    async listDueProbes(limit: number): Promise<DueProbe[]> {
      const rows = await deps.health.listDueProbes(limit)
      return rows.map((r) => ({ id: r.id.toString(), service: r.provider, reason: r.reason }))
    },
    async probe(m: DueProbe): Promise<ProbeResult> {
      const dec = await probeDecrypt(m.id, keyFn)
      if (!dec.ok || m.reason === 'credential') return dec.ok ? { ok: true } : dec
      try {
        switch (m.service) {
          case 'claude': {
            const t = await getTokenForUse(m.id, keyFn)
            if (!t) return { ok: false, detail: 'account_missing' }
            zero(t.token)
            zero(t.refresh)
            const egress = await resolveAccountEgressDispatcher(
              m.id,
              {
                egressProxy: t.egress_proxy,
                egressTarget: t.egress_target,
                egressProxyId: t.egress_proxy_id,
                egressHostUuid: t.egress_host_uuid,
              },
              getDispatcherForAccount,
            )
            if (egress.kind === 'unavailable') return { ok: false, transient: true, detail: 'egress_unavailable' }
            const r = await refreshAccountToken(m.id, {
              health: deps.health,
              dispatcher: egress.kind === 'ready' ? egress.dispatcher : undefined,
            })
            zero(r.token)
            zero(r.refresh)
            return { ok: true }
          }
          case 'codex': {
            const r = await refreshCodexAccountToken(m.id, {
              health: deps.health,
              triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
            })
            zero(r.token)
            zero(r.refresh)
            return { ok: true }
          }
          case 'grok': {
            const tok = await getFreshGrokAccessToken(m.id)
            zero(tok)
            return { ok: true }
          }
          case 'cursor': {
            // Session JWTs cannot be refreshed server-side: usable again only if not expired.
            const exp = dec.expiresAt
            return exp == null || exp.getTime() > Date.now() + 60_000
              ? { ok: true }
              : { ok: false, detail: 'session_expired' }
          }
          default:
            return { ok: true }
        }
      } catch (err) {
        return refreshFailure(err)
      }
    },
    async applyProbeResult(m: DueProbe, result: ProbeResult): Promise<void> {
      await deps.health.applyProbeResult(m.id, result)
    },
    async listMembers(): Promise<PoolMemberView[]> {
      const res = await query<{
        id: string
        provider: string
        label: string
        plan: string
        status: string
        disabled_by: string | null
        health_score: number
        cooldown_reason: CooldownReason | null
        cooldown_until: Date | null
        next_probe_at: Date | null
        last_error: string | null
        last_used_at: Date | null
        quota_5h_pct: number | null
        quota_7d_pct: number | null
        cursor_credential_kind: string | null
      }>(
        `SELECT id::text AS id, provider, label, plan, status, disabled_by, health_score,
                cooldown_reason, cooldown_until, next_probe_at, last_error, last_used_at,
                quota_5h_pct::float8 AS quota_5h_pct, quota_7d_pct::float8 AS quota_7d_pct,
                cursor_credential_kind
           FROM claude_accounts
          ORDER BY provider, id`,
      )
      return res.rows.map((r) => ({
        // Box runs on Cursor-provider accounts: the pool is shown as 'box'.
        service: r.provider === 'cursor' ? 'box' : r.provider,
        memberKind: 'account' as const,
        id: r.id,
        credentialType:
          r.provider === 'cursor' && r.cursor_credential_kind === 'api_key' ? ('api_key' as const) : ('subscription' as const),
        label: r.label,
        status: r.status,
        disabledBy: r.disabled_by,
        healthScore: r.health_score,
        cooldownReason: r.cooldown_reason,
        cooldownUntil: r.cooldown_until?.toISOString() ?? null,
        nextProbeAt: r.next_probe_at?.toISOString() ?? null,
        lastError: r.last_error ? r.last_error.slice(0, 160) : null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        hints: { plan: r.plan, quota_5h_pct: r.quota_5h_pct, quota_7d_pct: r.quota_7d_pct },
      }))
    },
  }
}
