/**
 * Parent-session tape ingest proof for InlinePush reclaim.
 *
 * Dual-send is judged by model-visible consumption (design v3 §10-9), not by
 * stdin write counts. A stdin push dies with the engine process; the durable
 * proof that the parent model consumed `notifyId` is a tape row whose id or
 * body carries that id (or the paired ResumeInject `dlgcb.*` clientMessageId).
 */
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'

export type ParentTapeMessage = {
  id?: unknown
  text?: unknown
  content?: unknown
}

/**
 * Tape ingest oracle result. Dual-send is judged by model-visible consumption
 * (design v3 §10-9). A thrown / incomplete read is `unknown`, never absence.
 * A complete read that finds no session (missing or deleted) is `not_ingested`.
 */
export type ParentTapeIngestState = 'ingested' | 'not_ingested' | 'unknown'

/** Persisted `ClientSession.messages` is `unknown[]`; rows are narrowed per-message. */
export type ParentTapeSession = {
  messages?: ReadonlyArray<unknown> | null
}

/**
 * Authoritative parent-tape lookup. Missing identity / parse failure /
 * thrown IO stay `unknown` (probe failed ≠ absence). A successful load
 * that returns no row is `not_ingested`.
 */
export async function resolveParentTapeIngestState(args: {
  notifyId: string
  parentSessionKey: string | undefined
  clientMessageId?: string
  callbackOriginUserId?: string | null
  liveSessionUserId?: string | null
  envUserId?: string | null
  loadSession: (peerId: string, userId: string) => Promise<ParentTapeSession | null | undefined>
}): Promise<ParentTapeIngestState> {
  const origin = parseOriginWebchatSessionKey(args.parentSessionKey ?? '')
  if (!origin) return 'unknown'
  const userId =
    args.callbackOriginUserId?.trim() || args.liveSessionUserId?.trim() || args.envUserId?.trim()
  if (!userId) return 'unknown'
  try {
    const session = await args.loadSession(origin.peerId, userId)
    if (!session) return 'not_ingested'
    return parentTapeHasNotifyId(session.messages, args.notifyId, args.clientMessageId)
      ? 'ingested'
      : 'not_ingested'
  } catch {
    return 'unknown'
  }
}

export function parentTapeHasNotifyId(
  messages: ReadonlyArray<unknown> | undefined | null,
  notifyId: string,
  clientMessageId?: string,
): boolean {
  if (!notifyId) return false
  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== 'object') continue
    if (messageCarriesNotifyId(msg as ParentTapeMessage, notifyId, clientMessageId)) return true
  }
  return false
}

function messageCarriesNotifyId(
  msg: ParentTapeMessage,
  notifyId: string,
  clientMessageId?: string,
): boolean {
  if (typeof msg.id === 'string' && msg.id.length > 0) {
    if (msg.id === notifyId) return true
    if (clientMessageId && msg.id === clientMessageId) return true
  }
  if (textCarriesNotifyId(msg.text, notifyId)) return true
  if (textCarriesNotifyId(msg.content, notifyId)) return true
  return false
}

function textCarriesNotifyId(value: unknown, notifyId: string): boolean {
  if (typeof value === 'string') return value.includes(notifyId)
  if (Array.isArray(value)) {
    return value.some((part) => {
      if (typeof part === 'string') return part.includes(notifyId)
      if (part && typeof part === 'object' && 'text' in part) {
        return (
          typeof (part as { text?: unknown }).text === 'string' &&
          (part as { text: string }).text.includes(notifyId)
        )
      }
      return false
    })
  }
  return false
}
