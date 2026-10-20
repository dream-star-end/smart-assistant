import { isHiddenSystemAgentId } from '@openclaude/protocol'

/** Public hint: all execution/route/workspace authority stays on the server. */
export interface DraftPreparationHint {
  viewId: string
  revision: number
  sessionId: string
  agentId: string
  modelId: string
  effortLevel?: string | null
  cancel?: boolean
}
const safeId = /^[a-zA-Z0-9_-]{8,50}$/
export function parseDraftPreparation(value: unknown): DraftPreparationHint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid draft preparation')
  const row = value as Record<string, unknown>
  if (!safeId.test(String(row.viewId ?? '')) || !safeId.test(String(row.sessionId ?? '')) ||
    typeof row.viewId !== 'string' || typeof row.sessionId !== 'string' ||
    !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 ||
    typeof row.agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.agentId) ||
    isHiddenSystemAgentId(row.agentId) ||
    typeof row.modelId !== 'string' || row.modelId.length < 1 || row.modelId.length > 128 ||
    (row.effortLevel !== undefined && row.effortLevel !== null &&
      (typeof row.effortLevel !== 'string' || !/^[a-z]{1,16}$/.test(row.effortLevel))) ||
    (row.cancel !== undefined && typeof row.cancel !== 'boolean')) throw Error('invalid draft preparation')
  return { viewId: row.viewId, revision: row.revision as number, sessionId: row.sessionId,
    agentId: row.agentId, modelId: row.modelId,
    ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel as string | null } : {}),
    ...(row.cancel === true ? { cancel: true } : {}) }
}

/** Shared by login and draft hints; no additional speculative container-start slots. */
export function makePreparationReady(ensureReady: (uid: bigint) => Promise<void>): (uid: bigint) => Promise<void> {
  const pending = new Map<string, Promise<void>>()
  return uid => {
    const key = uid.toString()
    const existing = pending.get(key)
    if (existing) return existing
    if (pending.size >= 2) return Promise.reject(Error('preparation capacity'))
    const work = Promise.resolve().then(() => ensureReady(uid)).finally(() => { pending.delete(key) })
    pending.set(key, work)
    return work
  }
}

/** At most one latest intent per user, bounded metadata, no poll/retry or inference. */
export function makeDraftPreparation(deps: {
  enabled: () => boolean
  authorize: (uid: bigint) => Promise<void>
  ensureReady: (uid: bigint) => Promise<void>
  prepareEngine: (uid: bigint, hint: DraftPreparationHint, isCurrent: () => boolean) => Promise<void>
  observe: (fields: { uid: string; outcome: 'accepted' | 'cancelled' | 'failed' | 'ready'; ready_ms?: number }) => void
  now?: () => number
}): (uid: bigint, hint: DraftPreparationHint) => Promise<boolean> {
  const latest = new Map<string, { hint: DraftPreparationHint; at: number }>()
  const workers = new Set<string>()
  const now = deps.now ?? Date.now
  const observe = (fields: Parameters<typeof deps.observe>[0]) => { try { deps.observe(fields) } catch { /* timing only */ } }
  return async (uid, hint) => {
    if (!deps.enabled()) return false
    await deps.authorize(uid)
    const key = uid.toString()
    for (const [id, entry] of latest) if (now() - entry.at >= 60_000) latest.delete(id)
    const old = latest.get(key)
    if (old?.hint.viewId === hint.viewId && old.hint.revision >= hint.revision) return false
    if (!old && latest.size >= 256) return false
    const entry = { hint, at: now() }
    latest.set(key, entry)
    if (hint.cancel) { observe({ uid: key, outcome: 'cancelled' }); return false }
    if (workers.has(key)) return true
    if (workers.size >= 2) return false
    workers.add(key)
    observe({ uid: key, outcome: 'accepted' })
    void (async () => {
      try {
        const started = now()
        await deps.ensureReady(uid)
        observe({ uid: key, outcome: 'ready', ready_ms: Math.max(0, now() - started) })
        let processed: typeof entry | undefined
        for (;;) {
          const current = latest.get(key)
          if (!current || current === processed || current.hint.cancel || now() - current.at >= 60_000) return
          processed = current
          const isCurrent = () => latest.get(key) === current && !current.hint.cancel && now() - current.at < 60_000
          await deps.prepareEngine(uid, current.hint, isCurrent)
        }
      } catch { observe({ uid: key, outcome: 'failed' }) }
      finally { workers.delete(key) }
    })()
    return true
  }
}
