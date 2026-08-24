import { AUTO_DREAM_POLICY_PATH } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

export { AUTO_DREAM_POLICY_PATH }
const FETCH_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 30_000
const MAX_BODY_BYTES = 64 * 1024

export type AutoDreamPolicy =
  | { enabled: false }
  | {
      enabled: true
      mode: 'legacy_memory_v1' | 'optimizer_v2'
      modelId: string
      modelName: string
      minIntervalHours: number
      minNewSessions: number
      auditContext?: {
        preferences: Record<string, unknown>
        installedPlugins: Array<{ slug: string; kind: string }>
      }
    }

export type AutoDreamOptimizerPolicy = Exclude<AutoDreamPolicy, { enabled: false }> & {
  mode: 'optimizer_v2'
}

export interface AutoDreamPolicyClientDeps {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
}

/** Fail-closed container client. Any config/network/schema error means off. */
export class AutoDreamPolicyClient {
  private readonly env: NodeJS.ProcessEnv
  private readonly fetcher: typeof undiciRequest
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly ttlMs: number
  private cached: { at: number; policy: AutoDreamPolicy } | null = null

  constructor(deps: AutoDreamPolicyClientDeps = {}) {
    this.env = deps.env ?? process.env
    this.fetcher = deps.fetcher ?? undiciRequest
    this.now = deps.now ?? Date.now
    this.timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS
    this.ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  }

  async get(options: { fresh?: boolean } = {}): Promise<AutoDreamPolicy> {
    // Only fail-closed results are cached. Reusing an enabled result across
    // triggers could start a paid call just after opt-out/plan expiry/admin
    // model disable. The claim path additionally requests a forced fresh read.
    if (
      !options.fresh &&
      this.cached?.policy.enabled === false &&
      this.now() - this.cached.at < this.ttlMs
    )
      return this.cached.policy
    const policy = await this.fetch().catch(() => ({ enabled: false as const }))
    this.cached = policy.enabled ? null : { at: this.now(), policy }
    return policy
  }

  private async fetch(): Promise<AutoDreamPolicy> {
    const base = this.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = this.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) return { enabled: false }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetcher(`${base}${AUTO_DREAM_POLICY_PATH}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (res.statusCode !== 200) {
        for await (const _chunk of res.body) {
          /* drain */
        }
        return { enabled: false }
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const raw of res.body) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        size += chunk.length
        if (size > MAX_BODY_BYTES) return { enabled: false }
        chunks.push(chunk)
      }
      return parseAutoDreamPolicy(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally {
      clearTimeout(timer)
    }
  }
}

export function parseAutoDreamPolicy(raw: unknown): AutoDreamPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false }
  const row = raw as Record<string, unknown>
  if (row.enabled !== true) return { enabled: false }
  if (
    typeof row.modelId !== 'string' ||
    row.modelId.length < 1 ||
    row.modelId.length > 64 ||
    typeof row.modelName !== 'string' ||
    row.modelName.length < 1 ||
    row.modelName.length > 160 ||
    typeof row.minIntervalHours !== 'number' ||
    !Number.isInteger(row.minIntervalHours) ||
    row.minIntervalHours < 24 ||
    typeof row.minNewSessions !== 'number' ||
    !Number.isInteger(row.minNewSessions) ||
    row.minNewSessions < 1 ||
    row.minNewSessions > 100
  )
    return { enabled: false }
  const mode =
    row.mode === 'optimizer_v2'
      ? 'optimizer_v2'
      : row.mode === 'legacy_memory_v1' || row.mode === undefined
        ? 'legacy_memory_v1'
        : null
  if (mode === null) return { enabled: false }
  let auditContext:
    | {
        preferences: Record<string, unknown>
        installedPlugins: Array<{ slug: string; kind: string }>
      }
    | undefined
  if (mode === 'optimizer_v2') {
    const rawContext = row.auditContext
    if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
      return { enabled: false }
    }
    const context = rawContext as Record<string, unknown>
    if (
      !context.preferences ||
      typeof context.preferences !== 'object' ||
      Array.isArray(context.preferences) ||
      !Array.isArray(context.installedPlugins)
    )
      return { enabled: false }
    const installedPlugins: Array<{ slug: string; kind: string }> = []
    for (const plugin of context.installedPlugins) {
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return { enabled: false }
      const item = plugin as Record<string, unknown>
      if (
        typeof item.slug !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.slug) ||
        typeof item.kind !== 'string' ||
        item.kind.length < 1 ||
        item.kind.length > 40
      )
        return { enabled: false }
      installedPlugins.push({ slug: item.slug, kind: item.kind })
    }
    auditContext = {
      preferences: context.preferences as Record<string, unknown>,
      installedPlugins,
    }
  }
  return {
    enabled: true,
    mode,
    modelId: row.modelId,
    modelName: row.modelName,
    minIntervalHours: row.minIntervalHours,
    minNewSessions: row.minNewSessions,
    ...(auditContext ? { auditContext } : {}),
  }
}
