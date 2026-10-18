/** Bounded workspace-open preparation. Never submits messages or engine turns. */
export function makeWorkspacePreparation(deps: {
  authorize: (uid: bigint) => Promise<void>
  ensureReady: (uid: bigint) => Promise<void>
  warn: (fields: { uid: string; outcome: string }) => void
  now?: () => number
}): (uid: bigint) => Promise<boolean> {
  const pending = new Set<string>()
  const recent = new Map<string, number>()
  const now = deps.now ?? Date.now
  return async uid => {
    const key = uid.toString()
    const time = now()
    for (const [id, at] of recent) if (time - at >= 60_000) recent.delete(id)
    if (pending.has(key) || recent.has(key) || pending.size >= 2 || recent.size >= 256) return false
    pending.add(key)
    try { await deps.authorize(uid) } catch (err) { pending.delete(key); throw err }
    recent.set(key, now())
    void Promise.resolve().then(() => deps.ensureReady(uid)).catch(() => {
      try { deps.warn({ uid: key, outcome: 'failed' }) } catch { /* Observation must not reject background work. */ }
    }).finally(() => { pending.delete(key) })
    return true
  }
}
