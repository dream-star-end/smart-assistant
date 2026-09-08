import { extractApiMediaFilename } from '../http/mediaSign.js'
import { canonicalDigestHex } from '../connectors/canonicalJson.js'
import { AUTOMATIC_TURN_RETRY_MAX, turnRecoveryAttemptIdentity } from '@openclaude/protocol'

/** R0 compatibility release: changing this requires a second physical release.
 * Deliberately not controlled by the shared production environment. */
export const PREPARATION_RECOVERY_WRITER_ENABLED = false
export const PREPARATION_RETRY_MAX = 2

export interface PreparationSnapshot {
  version: 1
  request: Record<string, unknown>
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))
}

function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(containsNul)
  if (value && typeof value === 'object') return Object.entries(value).some(([key,item]) => containsNul(key) || containsNul(item))
  return false
}

/** Only local immutable content-addressed media survives an automatic replay.
 * A remote URL, expiring signed URL or arbitrary filesystem path is not proof. */
export function preparationMediaIsDurable(media: unknown): boolean {
  return media === undefined || (Array.isArray(media) && media.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const url = (item as Record<string, unknown>).url
    return typeof url === 'string' && extractApiMediaFilename(url) !== null
  }))
}

/** Snapshot absence and null are intentional and differ from current settings.
 * Never include executionDescriptor, billing identity or client recovery hints. */
export function freezePreparationRequest(frame: Record<string, unknown>): PreparationSnapshot | null {
  if (frame.type !== 'inbound.message' || typeof frame.agentId !== 'string') return null
  if (!frame.content || typeof frame.content !== 'object' || Array.isArray(frame.content)) return null
  const content = frame.content as Record<string, unknown>
  if (content.recovery !== undefined || !preparationMediaIsDurable(content.media)) return null
  const request = pick(frame, [
    'type', 'channel', 'peer', 'agentId', 'model', 'effortLevel', 'contextTier', 'teamMode',
    'conversationMode', 'modelSwitchId', 'replyToId', 'ts', 'clientMessageId', 'idempotencyKey',
  ])
  request.content = pick(content, ['text', 'displayText', 'media', 'replyTo', 'imageEdit'])
  try {
    // Detach from the mutable inbound frame before enrichment can amend it.
    const snapshot: PreparationSnapshot = JSON.parse(JSON.stringify({ version: 1, request }))
    // Existing exact user BYTEA storage accepts NUL; PG JSONB does not. Keep
    // ordinary admission intact rather than making an imprecise retry copy.
    if (containsNul(snapshot)) return null
    canonicalDigestHex(snapshot)
    return snapshot
  } catch { return null }
}

export function validPreparationSnapshot(snapshot: unknown, digest: unknown): snapshot is PreparationSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof digest !== 'string') return false
  const value = snapshot as PreparationSnapshot
  if (value.version !== 1 || !value.request || typeof value.request !== 'object') return false
  try {
    const rebuilt = freezePreparationRequest(value.request)
    return rebuilt !== null && canonicalDigestHex(rebuilt) === digest && canonicalDigestHex(value) === digest
  } catch { return false }
}

export function preparationChildRequest(snapshot: PreparationSnapshot, sessionId: string, sourceClientMessageId: string): Record<string, unknown> {
  const identity = turnRecoveryAttemptIdentity(sessionId, sourceClientMessageId, 1)
  return {
    ...snapshot.request,
    clientMessageId: identity.clientMessageId,
    idempotencyKey: identity.idempotencyKey,
    content: {
      ...(snapshot.request.content as Record<string, unknown>),
      displayText: '↻ 自动重新准备',
      recovery: { sourceClientMessageId, rootClientMessageId: sourceClientMessageId,
        automatic: true, mode: 'replay', attempt: 1, max: AUTOMATIC_TURN_RETRY_MAX, cause: 'preparation' },
    },
  }
}

export function preparationRequestMatches(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): boolean {
  if (!actual) return false
  const keys = ['agentId','model','effortLevel','contextTier','teamMode','conversationMode','modelSwitchId','replyToId','clientMessageId','content']
  try { return canonicalDigestHex(pick(actual,keys)) === canonicalDigestHex(pick(expected,keys)) } catch { return false }
}

/** Shared by both full/archive and unified timeline status readers. */
export const PREPARATION_SOURCE_VISIBLE_SQL = `NOT EXISTS (
  SELECT 1 FROM turn_recovery_jobs preparation_successor
   WHERE preparation_successor.job_origin='pre_transfer_enrichment'
     AND preparation_successor.source_dispatch_id=turn_dispatches.dispatch_id
     AND (preparation_successor.dispatch_id IS NOT NULL
       OR preparation_successor.status IN ('queued','leased','sent','forwarded'))
)`
