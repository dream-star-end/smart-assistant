import { TEAM_CARD_CLIENT_DISPLAY_FIELDS } from '@openclaude/protocol/teamCards'
import { isValidOrderSeq } from './orderAndSeq.js'
import type { MessageLike } from './types.js'

const CLIENT_PUT_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  'id', 'role', 'text', 'ts', 'createdAt', 'completedAt',
  'explanation', 'steps',
  'childBlocks', 'agentName', 'agentId',
  'toolName', 'toolIcon', 'toolInput', 'toolUseId', 'parentToolUseId',
  'blockId',
  '_emptyTurn', '_emptyTurnSoft', '_emptyTurnStopReason', 'cronJob',
  '_media', '_modelText', '_teamRun',
  '_recoveryOfClientMessageId', '_recoveryMode', '_automaticRecovery',
  'requestId', 'inputPreview', 'inputJson',
  '_resolved', '_behavior', '_settledReason', '_answers', '_detachedAskUser',
  '_askUserSessionKey', '_askUserExpiresAt', '_askUserUserId',
  '_askUserChannel', '_askUserPeer',
])

const CLIENT_PUT_ALLOWED_STATUSES: ReadonlySet<string> = new Set<string>([
  'sending',
  'queued',
  'sent',
  'read',
])

const CLIENT_PUT_TEAM_MESSAGE_FIELDS: ReadonlySet<string> = new Set<string>(
  TEAM_CARD_CLIENT_DISPLAY_FIELDS,
)

const SERVER_AUTHORITATIVE_FIELDS: ReadonlySet<string> = new Set<string>([
  '_source',
  '_seq',
  '_orderSeq',
  '_turnTapeOrdinal',
  'usage',
  '_truncated',
  '_errorCode',
  '_errorDetail',
])

const _clientPutBlockedFieldCounts: Record<string, number> = Object.create(null)

export function getClientPutBlockedFieldCounts(): Record<string, number> {
  return { ..._clientPutBlockedFieldCounts }
}

export function _resetClientPutBlockedFieldCountsForTest(): void {
  for (const k of Object.keys(_clientPutBlockedFieldCounts)) {
    delete _clientPutBlockedFieldCounts[k]
  }
}

export function _stripClientPutMessage(msg: unknown): MessageLike | null {
  if (!msg || typeof msg !== 'object') return null
  const src = msg as Record<string, unknown>
  const role = typeof src.role === 'string' ? src.role : ''
  const teamOwned = role === 'agent-group' || role === 'delegate-progress'
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    if (CLIENT_PUT_ALLOWED_FIELDS.has(k)) {
      out[k] = src[k]
    } else if (teamOwned && CLIENT_PUT_TEAM_MESSAGE_FIELDS.has(k)) {
      out[k] = src[k]
    } else if (k === 'status') {
      const v = src[k]
      if (typeof v === 'string' && CLIENT_PUT_ALLOWED_STATUSES.has(v)) {
        out.status = v
      }
    } else if (SERVER_AUTHORITATIVE_FIELDS.has(k)) {
      _clientPutBlockedFieldCounts[k] = (_clientPutBlockedFieldCounts[k] ?? 0) + 1
    }
  }
  return out as MessageLike
}

export function _stripClientPutMessages(
  messages: readonly unknown[],
  serverSideMsgs: readonly MessageLike[] = [],
): MessageLike[] {
  const completeTapeIds = new Set<string>()
  for (const message of serverSideMsgs) {
    if (
      message?._source === 'server' &&
      (message as { _turnTapeComplete?: unknown })._turnTapeComplete === true &&
      typeof (message as { _turnTapeId?: unknown })._turnTapeId === 'string'
    ) {
      completeTapeIds.add((message as { _turnTapeId: string })._turnTapeId)
    }
  }
  const out: MessageLike[] = []
  for (const m of messages) {
    if (m && typeof m === 'object') {
      const projected = m as { _turnTapeExpanded?: unknown; _turnTapeId?: unknown }
      if (
        projected._turnTapeExpanded === true &&
        typeof projected._turnTapeId === 'string' &&
        completeTapeIds.has(projected._turnTapeId)
      ) {
        continue
      }
    }
    const cleaned = _stripClientPutMessage(m)
    if (cleaned !== null) out.push(cleaned)
  }
  return out
}

interface TurnGroupSummary {
  hasServerAsst: boolean
  hasServerThinking: boolean
  serverToolBlockIds: Set<string>
  hasCompleteTurnTape: boolean
  clientAgentGroupRunIds: Set<string>
  tapeServerAgentGroupRunIds: Set<string>
  tapeStructuredRoles: Set<string>
}

function emptyTurnGroup(): TurnGroupSummary {
  return {
    hasServerAsst: false,
    hasServerThinking: false,
    serverToolBlockIds: new Set<string>(),
    hasCompleteTurnTape: false,
    clientAgentGroupRunIds: new Set<string>(),
    tapeServerAgentGroupRunIds: new Set<string>(),
    tapeStructuredRoles: new Set<string>(),
  }
}

function agentGroupRunId(m: MessageLike): string | null {
  const r = m as { _delegateRunId?: unknown; runId?: unknown }
  if (typeof r._delegateRunId === 'string' && r._delegateRunId.length > 0) return r._delegateRunId
  if (typeof r.runId === 'string' && r.runId.length > 0) return r.runId
  return null
}

function isTurnBoundary(m: MessageLike): boolean {
  const role = (m as { role?: unknown }).role
  return role === 'user' || role === 'system'
}

function recordServerMessageInGroup(cur: MessageLike, group: TurnGroupSummary): void {
  if ((cur as { _turnTapeComplete?: unknown })._turnTapeComplete === true) {
    group.hasCompleteTurnTape = true
    const roles = (cur as { _turnTapeStructuredRoles?: unknown })._turnTapeStructuredRoles
    if (Array.isArray(roles)) {
      for (const role of roles) {
        if (role === 'plan' || role === 'goal') group.tapeStructuredRoles.add(role)
      }
    }
  }
  const role = (cur as { role?: string }).role
  if (role === 'assistant') group.hasServerAsst = true
  else if (role === 'thinking') group.hasServerThinking = true
  else if (role === 'tool') {
    const bid = (cur as { blockId?: unknown }).blockId
    if (typeof bid === 'string' && bid.length > 0) group.serverToolBlockIds.add(bid)
  } else if (role === 'agent-group' && typeof (cur as { _turnTapeId?: unknown })._turnTapeId === 'string') {
    const rid = agentGroupRunId(cur)
    if (rid !== null) group.tapeServerAgentGroupRunIds.add(rid)
  }
}

function partitionTurnGroups<T extends MessageLike>(
  merged: readonly T[],
): { turnGroup: number[]; groups: TurnGroupSummary[] } {
  const turnGroup: number[] = new Array(merged.length)
  const groups: TurnGroupSummary[] = []
  let curGroup = emptyTurnGroup()
  let groupId = 0
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]
    if (cur && isTurnBoundary(cur)) {
      groups.push(curGroup)
      groupId++
      curGroup = emptyTurnGroup()
    }
    turnGroup[i] = groupId
    if (cur && cur._source === 'server') {
      recordServerMessageInGroup(cur, curGroup)
    } else if (cur && (cur as { role?: string }).role === 'agent-group') {
      const rid = agentGroupRunId(cur)
      if (rid !== null) curGroup.clientAgentGroupRunIds.add(rid)
    }
  }
  groups.push(curGroup)
  return { turnGroup, groups }
}

function shouldDropNonServerInGroup(cur: MessageLike, group: TurnGroupSummary): boolean {
  const role = (cur as { role?: string }).role
  const isAsst = role === 'assistant'
  const isThink = role === 'thinking'
  const isTool = role === 'tool'
  const isGroup = role === 'agent-group'
  if (group.hasCompleteTurnTape) {
    if (isAsst || isThink || isTool || isGroup) return true
    if (typeof role === 'string' && group.tapeStructuredRoles.has(role)) return true
  }
  if (isGroup) {
    const rid = agentGroupRunId(cur)
    return rid !== null && group.tapeServerAgentGroupRunIds.has(rid)
  }
  if (isAsst && group.hasServerAsst) return true
  if (isThink && group.hasServerThinking) return true
  if (isTool) {
    const bid = (cur as { blockId?: unknown }).blockId
    return typeof bid === 'string' && bid.length > 0 && group.serverToolBlockIds.has(bid)
  }
  return false
}

function shouldDropMergedMessage(cur: MessageLike, group: TurnGroupSummary): boolean {
  if ((cur as { _turnTapeExpanded?: unknown })._turnTapeExpanded === true && group.hasCompleteTurnTape) {
    return true
  }
  if (cur._source === 'server') {
    if ((cur as { role?: string }).role !== 'agent-group') return false
    const rid = agentGroupRunId(cur)
    const tapeBacked = typeof (cur as { _turnTapeId?: unknown })._turnTapeId === 'string'
    return !tapeBacked && rid !== null && group.clientAgentGroupRunIds.has(rid)
  }
  return shouldDropNonServerInGroup(cur, group)
}

export function mergePreservingServerAuthored<T extends MessageLike>(
  serverSideMsgs: readonly T[],
  clientMsgs: readonly T[],
): T[] | readonly T[] {
  const serverAuthored = new Map<string, T>()
  for (const m of serverSideMsgs) {
    if (m && m._source === 'server' && typeof m.id === 'string') {
      serverAuthored.set(m.id, m)
    }
  }
  const orderedClientInput =
    serverSideMsgs.length > 0 ? sortForMergeByOrderAnchor(serverSideMsgs, clientMsgs) : clientMsgs
  const planDedupedClientMsgs = dedupeClientPlanRowsWithinTurns(orderedClientInput)
  if (serverAuthored.size === 0) {
    return planDedupedClientMsgs === orderedClientInput ? clientMsgs : planDedupedClientMsgs
  }

  const orderedClientMsgs = sortForMergeByOrderAnchor(serverSideMsgs, planDedupedClientMsgs)
  const clientIds = new Set<string>()
  for (const m of orderedClientMsgs) {
    if (m && typeof m.id === 'string') clientIds.add(m.id)
  }

  const merged: T[] = orderedClientMsgs.map((m) =>
    m && typeof m.id === 'string' && serverAuthored.has(m.id)
      ? (serverAuthored.get(m.id) as T)
      : m,
  )
  for (const [, msg] of serverAuthored) {
    if (typeof msg.id === 'string' && !clientIds.has(msg.id)) merged.push(msg)
  }
  const orderedMerged = sortForMergeByOrderAnchor(serverSideMsgs, merged)
  const { turnGroup, groups } = partitionTurnGroups(orderedMerged)

  const deduped: T[] = []
  for (let i = 0; i < orderedMerged.length; i++) {
    const cur = orderedMerged[i]
    if (!cur || !shouldDropMergedMessage(cur, groups[turnGroup[i]!]!)) {
      deduped.push(cur)
    }
  }
  return dedupeClientPlanRowsWithinTurns(deduped) as T[]
}

function buildExistingOrderIndex<T extends MessageLike>(existing: readonly T[]): {
  existingOrderById: Map<string, number>
  existingByTs: Array<{ order: number; ts: number }>
  maxExistingOrder: number
} {
  const existingOrderById = new Map<string, number>()
  const existingByTs: Array<{ order: number; ts: number }> = []
  let legacyOrder = 0
  let maxExistingOrder = 0
  for (const message of existing) {
    legacyOrder++
    const order = isValidOrderSeq(message?._orderSeq) ? message._orderSeq : legacyOrder
    if (order > maxExistingOrder) maxExistingOrder = order
    if (typeof message?.id === 'string' && !existingOrderById.has(message.id)) {
      existingOrderById.set(message.id, order)
    }
    if (typeof message?.ts === 'number' && Number.isFinite(message.ts)) {
      existingByTs.push({ order, ts: message.ts })
    }
  }
  existingByTs.sort((a, b) => a.ts - b.ts || a.order - b.order)
  let prefixMaxOrder = 0
  for (const persisted of existingByTs) {
    prefixMaxOrder = Math.max(prefixMaxOrder, persisted.order)
    persisted.order = prefixMaxOrder
  }
  return { existingOrderById, existingByTs, maxExistingOrder }
}

function findOrderAtOrBeforeTs(
  existingByTs: ReadonlyArray<{ order: number; ts: number }>,
  ts: number,
): number {
  let lo = 0
  let hi = existingByTs.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (existingByTs[mid]!.ts <= ts) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? existingByTs[lo - 1]!.order : 0
}

function sortForMergeByOrderAnchor<T extends MessageLike>(
  existing: readonly T[],
  messages: readonly T[],
): T[] {
  const { existingOrderById, existingByTs, maxExistingOrder } = buildExistingOrderIndex(existing)
  let anchor = 0
  return messages
    .map((message, index) => {
      const own = isValidOrderSeq(message?._orderSeq)
        ? message._orderSeq
        : typeof message?.id === 'string'
          ? existingOrderById.get(message.id)
          : undefined
      if (own !== undefined) anchor = own
      const ts = typeof message?.ts === 'number' && Number.isFinite(message.ts) ? message.ts : 0
      let inferredAnchor = Math.max(anchor, findOrderAtOrBeforeTs(existingByTs, ts))
      if (own === undefined && isTurnBoundary(message)) {
        inferredAnchor = Math.max(inferredAnchor, maxExistingOrder)
        anchor = inferredAnchor
      }
      return { message, index, anchor: own ?? inferredAnchor, ts }
    })
    .sort((a, b) => a.anchor - b.anchor || a.ts - b.ts || a.index - b.index)
    .map(({ message }) => message)
}

function planBlockId(m: MessageLike): string | null {
  const blockId = (m as { blockId?: unknown }).blockId
  return typeof blockId === 'string' && blockId.length > 0 ? blockId : null
}

function isClientPlanWithBlockId(m: MessageLike): boolean {
  return (
    m._source !== 'server' &&
    (m as { role?: unknown }).role === 'plan' &&
    planBlockId(m) !== null
  )
}

function planRank(m: MessageLike): [number, number, number, number] {
  const partial = (m as { _partial?: unknown })._partial
  const partialRank = partial === false ? 2 : partial === true ? 0 : 1
  const steps = Array.isArray((m as { steps?: unknown }).steps)
    ? (m as { steps: unknown[] }).steps
    : []
  const completed = steps.filter(
    (s) => s && typeof s === 'object' && (s as { status?: unknown }).status === 'completed',
  ).length
  const completedAt = (m as { completedAt?: unknown }).completedAt
  const time = Math.max(
    typeof completedAt === 'number' && Number.isFinite(completedAt) ? completedAt : 0,
    typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0,
  )
  return [partialRank, completed, steps.length, time]
}

function comparePlan(a: MessageLike, b: MessageLike): number {
  const ar = planRank(a)
  const br = planRank(b)
  for (let i = 0; i < ar.length; i++) {
    if (ar[i] !== br[i]) return ar[i]! - br[i]!
  }
  return 0
}

function flushPlanGroup<T extends MessageLike>(group: readonly T[], out: T[]): void {
  if (group.length === 0) return
  const keepByBlockId = new Map<string, T>()
  for (const m of group) {
    if (!isClientPlanWithBlockId(m)) continue
    const blockId = planBlockId(m)!
    const prev = keepByBlockId.get(blockId)
    if (!prev || comparePlan(m, prev) > 0) keepByBlockId.set(blockId, m)
  }
  for (const m of group) {
    if (!isClientPlanWithBlockId(m)) {
      out.push(m)
      continue
    }
    const blockId = planBlockId(m)!
    if (keepByBlockId.get(blockId) === m) out.push(m)
  }
}

function dedupeClientPlanRowsWithinTurns<T extends MessageLike>(
  msgs: readonly T[],
): T[] | readonly T[] {
  let hasDuplicate = false
  const seen = new Set<string>()
  for (const m of msgs) {
    if (isTurnBoundary(m)) seen.clear()
    if (!isClientPlanWithBlockId(m)) continue
    const blockId = planBlockId(m)!
    if (seen.has(blockId)) {
      hasDuplicate = true
      break
    }
    seen.add(blockId)
  }
  if (!hasDuplicate) return msgs

  const out: T[] = []
  let group: T[] = []
  for (const m of msgs) {
    if (isTurnBoundary(m)) {
      flushPlanGroup(group, out)
      group = []
      out.push(m)
      continue
    }
    group.push(m)
  }
  flushPlanGroup(group, out)
  return out
}

export function appendServerAuthoredPure<T extends MessageLike>(
  existing: readonly T[],
  message: T & { id: string },
  now: number = Date.now(),
): { applied: true; messages: T[] } | { applied: false; reason: 'already_exists' } {
  const idx = existing.findIndex((m) => m && m.id === message.id)
  if (idx >= 0) {
    const cur = existing[idx] as (T & { _source?: string }) | undefined
    if (cur && cur._source === 'server') {
      return { applied: false, reason: 'already_exists' }
    }
    const stamped = {
      ...message,
      _source: 'server',
      ts: message.ts ?? cur?.ts ?? now,
    } as T
    const next = existing.slice()
    next[idx] = stamped
    next.sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0))
    return { applied: true, messages: next }
  }
  const stamped = { ...message, _source: 'server', ts: message.ts ?? now } as T
  const next = [...existing, stamped]
  next.sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0))
  return { applied: true, messages: next }
}
