/**
 * Pending permission snapshot: the catch-up frames a reconnecting client gets for
 * permission prompts that are still waiting, and the runtime permission snapshot
 * attached to session reads. Moved verbatim out of server.ts (FINDINGS §7 step 2a,
 * OCV5-465) because both the WebSocket hello replay (server.ts) and the client
 * session routes (routes/clientSessions.ts) use it; one module, no import back
 * into server.ts. server.ts re-exports these names for existing importers.
 */
import { AUTHORITY_TURN_MAX_LIFETIME_MS } from '@openclaude/protocol'

export const GATEWAY_PENDING_PERMISSION_TTL_MS = 30 * 60_000

/**
 * Tools whose permission prompt is the turn's only way forward: the engine
 * cannot proceed, retry or degrade until the user decides (AskUserQuestion
 * answers; ExitPlanMode 按此计划执行 / 继续规划). Their prompts must not be
 * auto-denied by the 30-minute idle TTL nor by a bridge disconnect — the
 * user simply may not be looking. Ordinary tool approvals (Bash/Edit/…)
 * keep the short TTL because a timed-out deny is a safe, recoverable answer.
 * INC-20260904-EXITPLAN-PROMPT-BURIED (the same buried card was auto-denied
 * at 30 min and the plan degraded into a text dump).
 */
export const BLOCKING_USER_INPUT_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
])

export function _isBlockingUserInputTool(toolName: string): boolean {
  return BLOCKING_USER_INPUT_TOOLS.has(toolName)
}

export function _permissionRequestExpiresAt(
  blockingUserInput: boolean,
  nowMs: number = Date.now(),
): number {
  return (
    nowMs + (blockingUserInput ? AUTHORITY_TURN_MAX_LIFETIME_MS : GATEWAY_PENDING_PERMISSION_TTL_MS)
  )
}

export interface PendingPermissionCatchupEntry {
  sessionKey: string
  peerKey: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  clientMessageId?: string
  channel: string
  peer: { id: string; kind: 'dm' | 'group' }
  expiresAt: number
  detachedAskUser?: boolean
}

/**
 * INC-20260903-PENDING-PERMISSION-LOST — hello-time catch-up for prompts that
 * are still waiting for the user. `_sendStampedSessionFrame` only reaches
 * sockets registered at emit time; a browser that (re)attaches during the
 * bridge reconnect window never sees the request, while the engine sits in
 * waitingForUserInput with the watchdog legitimately suppressed. The pending
 * map is the gateway's authority for "still answerable", so replay it to the
 * newly registered socket. Frames are deliberately unstamped (no frameSeq):
 * the reducer dedupes permission prompts by requestId and a fresh ring seq
 * would collide with the client cursor.
 */
export function _pendingPermissionCatchupFrames(
  pending: ReadonlyMap<string, PendingPermissionCatchupEntry>,
  sessionKey: string,
  peerKey: string,
  nowMs: number = Date.now(),
): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  for (const [requestId, entry] of pending) {
    if (entry.sessionKey !== sessionKey || entry.peerKey !== peerKey) continue
    if (!(typeof entry.expiresAt === 'number' && entry.expiresAt > nowMs)) continue
    frames.push({
      type: 'outbound.permission_request',
      sessionKey,
      channel: entry.channel,
      peer: entry.peer,
      requestId,
      toolName: entry.toolName,
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
      ...(entry.clientMessageId ? { clientMessageId: entry.clientMessageId } : {}),
      inputPreview: JSON.stringify(entry.input).slice(0, 400),
      inputJson: entry.input,
      expiresAt: entry.expiresAt,
      ...(entry.detachedAskUser ? { detachedAskUser: true } : {}),
      ts: nowMs,
    })
  }
  return frames
}

const PERMISSION_LOOKUP_MAX_IDS = 16

export function parsePermissionLookupQuery(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id === '' || seen.has(id) || id.length > 200) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= PERMISSION_LOOKUP_MAX_IDS) break
  }
  return ids
}

type RuntimePermissionSnapshotItem = {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  inputJson: Record<string, unknown>
  status: 'pending'
  behavior: null
  reason: null
  answers: null
  expiresAt: number
  createdAt: number
  updatedAt: number
}

/** SQLite / no-PG session GET: project still-answerable runtime pending entries.
 *  Never forges responded/cancelled/expired — those require PG. Completeness is
 *  therefore `unavailable` so the client will not treat absence as "all answered". */
export function projectRuntimePermissionSnapshot(
  pending: ReadonlyMap<string, PendingPermissionCatchupEntry>,
  sessionId: string,
  userId: string,
  nowMs: number = Date.now(),
): {
  items: RuntimePermissionSnapshotItem[]
  completeness: 'unavailable'
  source: 'runtime'
} {
  const items: RuntimePermissionSnapshotItem[] = []
  const userColon = `${userId}:`
  const userPipe = `${userId}|`
  for (const [requestId, entry] of pending) {
    if (entry.peer?.id !== sessionId) continue
    if (
      typeof entry.peerKey !== 'string' ||
      !(entry.peerKey.startsWith(userColon) || entry.peerKey.startsWith(userPipe))
    )
      continue
    if (!(typeof entry.expiresAt === 'number' && entry.expiresAt > nowMs)) continue
    items.push({
      requestId,
      clientMessageId: entry.clientMessageId ?? null,
      toolUseId: entry.toolUseId ?? null,
      toolName: entry.toolName,
      inputJson: entry.input,
      status: 'pending',
      behavior: null,
      reason: null,
      answers: null,
      expiresAt: entry.expiresAt,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
  }
  return { items, completeness: 'unavailable', source: 'runtime' }
}

export function attachPermissionSnapshotIfMissing<
  T extends {
    id: string
    userId?: string
    permissionPrompts?: unknown
  },
>(
  session: T,
  pending: ReadonlyMap<string, PendingPermissionCatchupEntry>,
  userId: string,
  nowMs: number = Date.now(),
): T {
  if (session.permissionPrompts != null) return session
  return {
    ...session,
    permissionPrompts: projectRuntimePermissionSnapshot(pending, session.id, userId, nowMs),
  }
}
