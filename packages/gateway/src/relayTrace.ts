/**
 * OCV5-580 (plan v3.6 §7.3 rows 2-3): which turn's canonical traceId a request through a container
 * loopback relay belongs to, so the relay can send it to egress as `x-openclaude-trace-id`.
 *
 * Neither CLI sends our trace itself. The relays run in the same gateway process as the adapters,
 * so the adapters register their running turn here and the relay looks it up by something the
 * request itself carries:
 *   - Grok: the route token in the request path. Grok spawns per turn and a token serves one session,
 *     so while the turn's process lives, the token names exactly that turn.
 *   - Codex: `x-codex-turn-metadata.turn_id`, Codex's own JSON-RPC turn id (verified on codex-cli
 *     0.163: equals `turn/start` → `turn.id`, differs per turn). `root_turn_id` covers subagent turns.
 *     Before `turn/start` answers, a request on the thread can only belong to the turn being started,
 *     so the thread's pending trace covers that window.
 * Anything else gets no trace (egress counts it as `relay-without-trace`); a guess is never sent.
 */
import { parseTraceIdCandidate } from '@openclaude/protocol'

/** Recent Codex turn ids kept so a late request of a finished turn still names its own trace. */
const MAX_CODEX_TURNS = 512
const MAX_TURN_METADATA_CHARS = 8192

const grokRoutes = new Map<string, { traceId: string }>()
const codexThreads = new Map<string, { traceId: string; turnId?: string }>()
const codexTurns = new Map<string, string>()

function validTraceId(traceId: string | undefined): string | undefined {
  if (traceId === undefined) return undefined
  const trace = parseTraceIdCandidate(traceId)
  return trace.ok ? trace.traceId : undefined
}

/** Grok turn start: requests on this route token belong to `traceId` until the returned release. */
export function bindGrokRouteTrace(routeToken: string, traceId: string | undefined): () => void {
  const trace = validTraceId(traceId)
  if (trace === undefined) {
    grokRoutes.delete(routeToken)
    return () => {}
  }
  const entry = { traceId: trace }
  grokRoutes.set(routeToken, entry)
  return () => {
    if (grokRoutes.get(routeToken) === entry) grokRoutes.delete(routeToken)
  }
}

/** The trace for a Grok relay request path (`…/route/<token>/…`), if its turn is running. */
export function grokRelayTrace(pathname: string): string | undefined {
  const m = /\/route\/([0-9a-f]{64})(?:\/|$)/.exec(pathname)
  return m ? grokRoutes.get(m[1]!)?.traceId : undefined
}

/** Codex, before `turn/start`: the thread's next turn belongs to `traceId` until the returned release. */
export function bindCodexThreadTrace(threadId: string, traceId: string | undefined): () => void {
  const trace = validTraceId(traceId)
  if (trace === undefined) {
    codexThreads.delete(threadId)
    return () => {}
  }
  const entry: { traceId: string; turnId?: string } = { traceId: trace }
  codexThreads.set(threadId, entry)
  return () => {
    if (codexThreads.get(threadId) === entry) codexThreads.delete(threadId)
  }
}

/** Codex, `turn/start` answered: record the turn id under the thread's pending trace. */
export function adoptCodexTurnTrace(threadId: string, turnId: string): void {
  const entry = codexThreads.get(threadId)
  if (!entry) return
  entry.turnId = turnId
  codexTurns.delete(turnId)
  codexTurns.set(turnId, entry.traceId)
  while (codexTurns.size > MAX_CODEX_TURNS) {
    const oldest = codexTurns.keys().next().value
    if (oldest === undefined) break
    codexTurns.delete(oldest)
  }
}

/**
 * Wraps Codex's `turn/start` call: the thread's pending trace covers requests sent before it
 * answers, its returned `turn.id` is then recorded, and the pending binding ends either way.
 */
export async function withCodexTurnTrace<T>(
  threadId: string | null,
  traceId: string | undefined,
  turnStart: () => Promise<T>,
): Promise<T> {
  const release = threadId ? bindCodexThreadTrace(threadId, traceId) : () => {}
  try {
    const res = await turnStart()
    const turnId = (res as { turn?: { id?: unknown } } | undefined)?.turn?.id
    if (threadId && typeof turnId === 'string' && turnId) adoptCodexTurnTrace(threadId, turnId)
    return res
  } finally {
    release()
  }
}

/** The trace for a Codex relay request, from its own `x-codex-turn-metadata` header value. */
export function codexRelayTrace(turnMetadata: string | string[] | undefined): string | undefined {
  if (typeof turnMetadata !== 'string' || turnMetadata.length > MAX_TURN_METADATA_CHARS) return undefined
  let meta: unknown
  try {
    meta = JSON.parse(turnMetadata)
  } catch {
    return undefined
  }
  if (!meta || typeof meta !== 'object') return undefined
  const field = (k: string): string | undefined => {
    const v = (meta as Record<string, unknown>)[k]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const turnId = field('turn_id')
  const rootTurnId = field('root_turn_id')
  const byTurn = (turnId && codexTurns.get(turnId)) || (rootTurnId && codexTurns.get(rootTurnId))
  if (byTurn) return byTurn
  const threadId = field('thread_id')
  const pending = threadId ? codexThreads.get(threadId) : undefined
  return pending && pending.turnId === undefined ? pending.traceId : undefined
}

export function _resetRelayTraceForTests(): void {
  grokRoutes.clear()
  codexThreads.clear()
  codexTurns.clear()
}
