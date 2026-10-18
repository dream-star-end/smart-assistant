/**
 * OCV5-424 — Antigravity (Google AI subscription) usage quota for the admin
 * 服务池 page. Read-only: loadCodeAssist (→ project) then
 * v1internal:retrieveUserQuotaSummary, with the account's own access token.
 * Each account has groups (e.g. "Gemini Models", "Claude and GPT models"),
 * each with a 5-hour and a weekly bucket { remainingFraction, resetTime }.
 * Cached in memory per account (10 min) so the admin page never hammers
 * Google; never on the chat path. No token is logged or returned.
 */
import { request } from 'undici'
import { query } from '../db/queries.js'
import { getFreshAntigravityAccessToken } from './antigravityOAuth.js'
import { directEgressDispatcher } from './egressDispatcher.js'

export const ANTIGRAVITY_QUOTA_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_QUOTA_TTL_MS = 10 * 60 * 1000
/**
 * Google only returns the current tier and project to the Antigravity client:
 * without this user-agent loadCodeAssist answers allowedTiers/ineligibleTiers
 * only (no project), so the quota call cannot be made. Matches the pinned CLI.
 */
export const ANTIGRAVITY_QUOTA_USER_AGENT = 'antigravity/1.4.0'
const TIMEOUT_MS = 8_000

export interface QuotaWindow {
  /** e.g. "Gemini · 5 小时". */
  label: string
  /** 0–100, used share; null when the bucket gives no fraction. */
  usedPct: number | null
  resetsAt: string | null
}

export interface MemberQuota {
  windows: QuotaWindow[]
  updatedAt: string | null
  /** Why there is no (or partial) data; shown instead of an empty cell. */
  note: string | null
  paidTier?: string | null
  tierUpdatedAt?: string | null
}

interface Bucket {
  bucketId?: string
  window?: string
  remainingFraction?: number
  resetTime?: string
}
interface Group {
  displayName?: string
  buckets?: Bucket[]
}

const WINDOW_LABEL: Record<string, string> = { '5h': '5 小时', weekly: '每周' }

function groupLabel(name: string | undefined): string {
  if (!name) return '额度'
  if (/gemini/i.test(name)) return 'Gemini'
  if (/claude|gpt/i.test(name)) return 'Claude/GPT'
  return name
}

/** Pure: retrieveUserQuotaSummary body → windows (unit-tested). */
export function parseQuotaSummary(body: unknown): QuotaWindow[] {
  const groups = (body as { groups?: Group[] } | null)?.groups
  if (!Array.isArray(groups)) return []
  const out: QuotaWindow[] = []
  for (const g of groups) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction) ? b.remainingFraction : null
      out.push({
        label: `${groupLabel(g.displayName)} · ${WINDOW_LABEL[b.window ?? ''] ?? b.window ?? b.bucketId ?? '窗口'}`,
        usedPct: frac === null ? null : Math.max(0, Math.min(100, Math.round((1 - frac) * 1000) / 10)),
        resetsAt: typeof b.resetTime === 'string' ? b.resetTime : null,
      })
    }
  }
  return out
}

export type AntigravityModelAvailability = Record<string, { remainingFraction: number | null; resetTime: string | null }>

export async function saveAntigravityMetadata(accountId: string, paidTier: string | null, models: AntigravityModelAvailability | null): Promise<void> {
  await query(`UPDATE gemini_oauth_accounts SET paid_tier=$2, tier_updated_at=NOW(),
    available_models=COALESCE($3::jsonb, available_models), updated_at=NOW() WHERE id=$1`,
    [accountId, paidTier, models === null ? null : JSON.stringify(models)])
}

export interface AntigravityQuotaDeps {
  clientSecret: () => string
  freshToken?: (accountId: bigint) => Promise<Buffer>
  post?: (path: string, token: string, body: unknown) => Promise<{ status: number; json: unknown }>
  now?: () => number
  saveMetadata?: typeof saveAntigravityMetadata
}

const cache = new Map<string, { at: number; value: MemberQuota }>()

/** Tests only. */
export function _resetAntigravityQuotaCacheForTest(): void {
  cache.clear()
}

async function defaultPost(path: string, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await request(`${ANTIGRAVITY_QUOTA_BASE_URL}${path}`, {
    method: 'POST',
    dispatcher: directEgressDispatcher(),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_QUOTA_USER_AGENT },
    body: JSON.stringify(body),
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  })
  const text = await res.body.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON error body */
  }
  return { status: res.statusCode, json }
}

/** Quota for one account (cached); never throws — failures come back as a note. */
export async function antigravityAccountQuota(accountId: string, deps: AntigravityQuotaDeps): Promise<MemberQuota> {
  const now = (deps.now ?? Date.now)()
  const hit = cache.get(accountId)
  if (hit && now - hit.at < ANTIGRAVITY_QUOTA_TTL_MS) return hit.value
  const value = await fetchQuota(accountId, deps, now)
  // Keep the last good windows when a refresh fails (with the failure as the note).
  const kept = value.windows.length === 0 && hit && hit.value.windows.length > 0 ? { ...hit.value, note: value.note } : value
  cache.set(accountId, { at: now, value: kept })
  return kept
}

async function fetchQuota(accountId: string, deps: AntigravityQuotaDeps, now: number): Promise<MemberQuota> {
  const secret = deps.clientSecret()
  if (!secret) return { windows: [], updatedAt: null, note: '未配置 Antigravity OAuth，无法读取额度' }
  const post = deps.post ?? defaultPost
  let token: string
  try {
    const buf = await (deps.freshToken ?? ((id) => getFreshAntigravityAccessToken(id, { clientSecret: secret })))(BigInt(accountId))
    token = buf.toString('utf8')
    buf.fill(0)
  } catch {
    return { windows: [], updatedAt: null, note: '登录凭证无法刷新，读不到额度（账号处于认证冷却时由恢复探测处理）' }
  }
  try {
    // A tier upgrade must be visible without restarting the process. Reload on
    // the existing ten-minute quota TTL, even when the project is unchanged.
    const lca = await post('/v1internal:loadCodeAssist', token, { metadata: { ideType: 'ANTIGRAVITY' } })
    const loaded = lca.json as { cloudaicompanionProject?: string | { id?: string }; paidTier?: { id?: string } } | null
    const p = loaded?.cloudaicompanionProject
    const project = typeof p === 'string' ? p : p?.id
    if (lca.status !== 200 || !project) {
      return { windows: [], updatedAt: null, note: `上游未返回项目信息（loadCodeAssist HTTP ${lca.status}），读不到额度` }
    }
    const paidTier = typeof loaded?.paidTier?.id === 'string' ? loaded.paidTier.id.slice(0, 120) : null
    const directory = await post('/v1internal:fetchAvailableModels', token, { project }).catch(() => null)
    const rawModels = (directory?.json as { models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }> } | null)?.models
    let models: AntigravityModelAvailability | null = null
    if (directory?.status === 200 && rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
      models = {}
      for (const [id, value] of Object.entries(rawModels)) {
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) continue
        const q = value?.quotaInfo
        models[id] = {
          remainingFraction: typeof q?.remainingFraction === 'number' && Number.isFinite(q.remainingFraction) ? q.remainingFraction : null,
          resetTime: typeof q?.resetTime === 'string' ? q.resetTime : null,
        }
      }
    }
    await (deps.saveMetadata ?? saveAntigravityMetadata)(accountId, paidTier, models)
    const q = await post('/v1internal:retrieveUserQuotaSummary', token, { project })
    if (q.status !== 200) {
      return { windows: [], updatedAt: null, note: `上游额度接口返回 HTTP ${q.status}` }
    }
    const windows = parseQuotaSummary(q.json)
    return {
      windows,
      paidTier, tierUpdatedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      note: windows.length === 0 ? '上游额度接口没有返回任何窗口' : null,
    }
  } catch (err) {
    return { windows: [], updatedAt: null, note: `读取额度失败：${err instanceof Error ? err.message.slice(0, 80) : '网络错误'}` }
  } finally {
    token = ''
  }
}
