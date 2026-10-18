import type { AgentSession } from './sessionTypes.js'

type Host = { sessions: Map<string, AgentSession>; _promptQueueHolds: (session: AgentSession) => boolean }
type Reservation = { session: AgentSession; runner: AgentSession['runner']; timer?: ReturnType<typeof setTimeout> }
const owners = new WeakMap<object, Map<string, Reservation>>()
export const UNUSED_PREHEAT_TTL_MS = 60_000

/** One unused speculative runner per user container; no queue and no passive TTL renewal. */
export function reserveUnusedPreheat(host: Host, session: AgentSession): 'reserved' | 'already_running' | 'skipped_cap' {
  let entries = owners.get(host)
  if (!entries) { entries = new Map(); owners.set(host, entries) }
  if (entries.has(session.sessionKey)) return 'already_running'
  if (entries.size >= 1) return 'skipped_cap'
  entries.set(session.sessionKey, { session, runner: session.runner })
  return 'reserved'
}
/** Called only after runner.submitTurn; rejected/cancelled admissions retain their TTL. */
export function consumeUnusedPreheat(host: object, session: AgentSession): void {
  const entries = owners.get(host)
  const entry = entries?.get(session.sessionKey)
  if (!entry || entry.session !== session) return
  if (entry.timer) clearTimeout(entry.timer)
  entries!.delete(session.sessionKey)
}
export function clearUnusedPreheats(host: object): void {
  const entries = owners.get(host)
  if (!entries) return
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer)
  entries.clear()
}
export function armUnusedPreheat(host: Host, session: AgentSession, ttlMs = UNUSED_PREHEAT_TTL_MS): void {
  const entries = owners.get(host)
  const entry = entries?.get(session.sessionKey)
  if (!entry || entry.session !== session || entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    void (async () => {
      const prev = session.lock
      let release = () => {}
      session.lock = new Promise<void>(r => { release = r })
      try {
        await prev
        if (entries!.get(session.sessionKey) !== entry) return
        if (host.sessions.get(session.sessionKey) !== session || session.runner !== entry.runner ||
          session._plannedTeardown || session._replacing) {
          consumeUnusedPreheat(host, session)
          return
        }
        if ((session._activeTurnCount ?? 0) > 0 || (session._idleInternalTurns ?? 0) > 0 ||
          host._promptQueueHolds(session)) {
          // A pending admission has not used the engine yet. Keep both capacity and
          // a retry timer, so a Stop/permission rejection cannot leak an unused CLI.
          armUnusedPreheat(host, session, 1_000)
          return
        }
        await entry.runner.shutdown()
        consumeUnusedPreheat(host, session)
      } finally { release() }
    })().catch(() => { /* keep the reservation on shutdown failure; never grow speculative residence */ })
  }, ttlMs)
  entry.timer.unref?.()
}
