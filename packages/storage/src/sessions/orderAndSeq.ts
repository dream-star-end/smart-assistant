import type { MessageLike } from './types.js'

export const isValidOrderSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isValidSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function tapeOrdinalOf(message: MessageLike): number | null {
  if (typeof message._turnTapeId !== 'string' || message._turnTapeId.length === 0) return null
  if (
    typeof message._turnTapeOrdinal === 'number' &&
    Number.isSafeInteger(message._turnTapeOrdinal) &&
    message._turnTapeOrdinal >= 0
  ) {
    return message._turnTapeOrdinal
  }
  return null
}

/** Stable total order for persisted history. */
export function compareMessagesByOrder(a: MessageLike, b: MessageLike): number {
  const ao = isValidOrderSeq(a?._orderSeq) ? a._orderSeq : Number.MAX_SAFE_INTEGER
  const bo = isValidOrderSeq(b?._orderSeq) ? b._orderSeq : Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  const atape = tapeOrdinalOf(a)
  const btape = tapeOrdinalOf(b)
  const arank = a._turnTapeProcess === true ? 0 : atape !== null ? 1 : 2
  const brank = b._turnTapeProcess === true ? 0 : btape !== null ? 1 : 2
  if (arank !== brank) return arank - brank
  if (atape !== null && btape !== null && atape !== btape) return atape - btape
  const at = typeof a?.ts === 'number' && Number.isFinite(a.ts) ? a.ts : 0
  const bt = typeof b?.ts === 'number' && Number.isFinite(b.ts) ? b.ts : 0
  return at - bt
}

function normalizeOldOrderSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  floor: number,
  onWarn?: (message: string) => void,
): { oldById: Map<string, T & { _orderSeq: number }>; nextAlloc: number } {
  let maxExisting = floor
  for (const message of oldMsgs) {
    if (isValidOrderSeq(message?._orderSeq) && message._orderSeq > maxExisting) {
      maxExisting = message._orderSeq
    }
  }
  let alloc = maxExisting + 1
  const seenOld = new Set<number>()
  const duplicateOrderSeqs: number[] = []
  const oldById = new Map<string, T & { _orderSeq: number }>()
  for (const message of oldMsgs) {
    const orderSeq = message?._orderSeq
    let normalized: T & { _orderSeq: number }
    if (isValidOrderSeq(orderSeq) && !seenOld.has(orderSeq)) {
      seenOld.add(orderSeq)
      normalized = message as T & { _orderSeq: number }
    } else {
      if (isValidOrderSeq(orderSeq)) duplicateOrderSeqs.push(orderSeq)
      const assigned = alloc++
      seenOld.add(assigned)
      normalized = { ...message, _orderSeq: assigned } as T & { _orderSeq: number }
    }
    if (typeof normalized?.id === 'string' && !oldById.has(normalized.id)) {
      oldById.set(normalized.id, normalized)
    }
  }
  if (duplicateOrderSeqs.length > 0 && onWarn) {
    const unique = [...new Set(duplicateOrderSeqs)].sort((a, b) => a - b)
    onWarn(
      `${duplicateOrderSeqs.length} row(s) carried duplicate _orderSeq in oldMsgs ` +
        `(order ${unique.join(', ')}); kept first occurrence and reassigned duplicates`,
    )
  }
  return { oldById, nextAlloc: alloc }
}

/** Freeze the independent history-order axis. */
export function normalizeAndAssignOrderSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  finalMsgs: readonly T[],
  currentArchivedThroughOrderSeq = 0,
  onWarn?: (message: string) => void,
): { messages: T[]; maxOrderSeq: number } {
  const floor = isValidOrderSeq(currentArchivedThroughOrderSeq)
    ? currentArchivedThroughOrderSeq
    : 0
  const { oldById, nextAlloc } = normalizeOldOrderSeqs(oldMsgs, floor, onWarn)
  let alloc = nextAlloc
  const used = new Set<number>()
  const stamped = finalMsgs.map((message, index) => {
    const old = typeof message?.id === 'string' ? oldById.get(message.id) : undefined
    let orderSeq = old?._orderSeq
    if (!isValidOrderSeq(orderSeq) || used.has(orderSeq)) orderSeq = alloc++
    used.add(orderSeq)
    const value =
      message._orderSeq === orderSeq ? message : ({ ...message, _orderSeq: orderSeq } as T)
    return { value, index }
  })
  stamped.sort((a, b) => compareMessagesByOrder(a.value, b.value) || a.index - b.index)
  let maxOrderSeq = floor
  const messages = stamped.map(({ value }) => {
    if (isValidOrderSeq(value._orderSeq) && value._orderSeq > maxOrderSeq) {
      maxOrderSeq = value._orderSeq
    }
    return value
  })
  return { messages, maxOrderSeq }
}

export function deriveOrderSeqsForRead<T extends MessageLike>(
  messages: readonly T[],
  currentArchivedThroughOrderSeq = 0,
): T[] {
  return normalizeAndAssignOrderSeqs(messages, messages, currentArchivedThroughOrderSeq).messages
}

export function deriveArchivedOrderSeqsForRead<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages
    .map((message) => {
      if (isValidOrderSeq(message?._orderSeq)) return message
      const legacy = message?._seq
      return isValidOrderSeq(legacy) ? ({ ...message, _orderSeq: legacy } as T) : message
    })
    .map((value, index) => ({ value, index }))
    .sort((a, b) => compareMessagesByOrder(a.value, b.value) || a.index - b.index)
    .map(({ value }) => value)
}

const _SEQ_CONTENT_IGNORE_FIELDS = new Set(['_seq', '_orderSeq', 'status'])

function stableStringifyForSeq(v: unknown): string | null {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const keys = Object.keys(val)
          .sort()
          .filter((k) => !_SEQ_CONTENT_IGNORE_FIELDS.has(k))
        const sorted: Record<string, unknown> = {}
        for (const k of keys) sorted[k] = (val as Record<string, unknown>)[k]
        return sorted
      }
      return val
    })
  } catch {
    return null
  }
}

export function _messageContentEqualForSeq(a: MessageLike, b: MessageLike): boolean {
  const sa = stableStringifyForSeq(a)
  const sb = stableStringifyForSeq(b)
  if (sa === null || sb === null) return false
  return sa === sb
}

const _SEQ_WARN_INTERVAL_MS = 60_000
let _lastSeqWarnAt = 0

export function _warnSeqAnomaly(message: string): void {
  const now = Date.now()
  if (now - _lastSeqWarnAt < _SEQ_WARN_INTERVAL_MS) return
  _lastSeqWarnAt = now
  console.warn(`[sessionsDb._seq] normalizeAndAssignSeqs: ${message}`)
}

function normalizeOldSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  currentNextSeq: number,
  onWarn?: (message: string) => void,
): { oldNormalized: Array<T & { _seq: number }>; nextSeq: number } {
  let maxValidSeq = 0
  let anyValidSeq = false
  for (const mm of oldMsgs) {
    const s = mm ? (mm as MessageLike)._seq : undefined
    if (isValidSeq(s)) {
      anyValidSeq = true
      if (s > maxValidSeq) maxValidSeq = s
    }
  }
  if (!anyValidSeq && currentNextSeq <= 1) {
    return {
      oldNormalized: oldMsgs.map(
        (m, idx) => ({ ...(m as object), _seq: idx + 1 }) as T & { _seq: number },
      ),
      nextSeq: oldMsgs.length + 1,
    }
  }
  let alloc = Math.max(currentNextSeq, maxValidSeq + 1)
  const seenSeqs = new Set<number>()
  const duplicateSeqs: number[] = []
  const oldNormalized = oldMsgs.map((m) => {
    const s = m ? (m as MessageLike)._seq : undefined
    if (isValidSeq(s) && !seenSeqs.has(s)) {
      seenSeqs.add(s)
      return m as T & { _seq: number }
    }
    if (isValidSeq(s)) duplicateSeqs.push(s)
    const assigned = alloc++
    seenSeqs.add(assigned)
    return { ...(m as object), _seq: assigned } as T & { _seq: number }
  })
  if (duplicateSeqs.length > 0 && onWarn) {
    const uniq = [...new Set(duplicateSeqs)].sort((a, b) => a - b)
    onWarn(
      `${duplicateSeqs.length} row(s) carried duplicate _seq in oldMsgs (seq ${uniq.join(', ')}); ` +
        `kept first occurrence, reassigned duplicates above ${maxValidSeq}`,
    )
  }
  return { oldNormalized, nextSeq: alloc }
}

function assignFinalSeqs<T extends MessageLike>(
  oldNormalized: ReadonlyArray<T & { _seq: number }>,
  finalMsgs: readonly T[],
  startNextSeq: number,
): { out: T[]; nextSeq: number; maxSeq: number } {
  const oldById = new Map<string, T & { _seq: number }>()
  for (const m of oldNormalized) {
    if (m && typeof m.id === 'string') oldById.set(m.id, m)
  }
  let nextSeq = startNextSeq
  const out: T[] = new Array(finalMsgs.length)
  for (let i = 0; i < finalMsgs.length; i++) {
    const m = finalMsgs[i] as T & { _seq?: number }
    const mId = typeof m?.id === 'string' ? m.id : null
    const old = mId ? oldById.get(mId) : undefined
    if (old && _messageContentEqualForSeq(m, old)) {
      out[i] = m._seq === old._seq ? m : { ...m, _seq: old._seq }
    } else {
      out[i] = { ...m, _seq: nextSeq }
      nextSeq++
    }
  }
  let maxSeq = 0
  for (const m of out) {
    const s = (m as MessageLike)._seq
    if (typeof s === 'number' && s > maxSeq) maxSeq = s
  }
  return { out, nextSeq, maxSeq }
}

export function normalizeAndAssignSeqs<T extends MessageLike>(
  oldMsgs: readonly T[],
  finalMsgs: readonly T[],
  currentNextSeq: number,
  onWarn?: (message: string) => void,
  currentArchivedThroughOrderSeq = 0,
): { messages: T[]; nextSeq: number; maxSeq: number } {
  const { oldNormalized, nextSeq: afterOld } = normalizeOldSeqs(oldMsgs, currentNextSeq, onWarn)
  const { out, nextSeq, maxSeq } = assignFinalSeqs(oldNormalized, finalMsgs, afterOld)
  const ordered = normalizeAndAssignOrderSeqs(
    oldNormalized,
    out,
    currentArchivedThroughOrderSeq,
    onWarn,
  )
  return { messages: ordered.messages, nextSeq, maxSeq }
}

export function hasInvisibleMessageRemoval(
  oldMessages: readonly MessageLike[],
  finalMessages: readonly MessageLike[],
): boolean {
  const remainingById = new Map<string, number>()
  const remainingAnonymous = new Set<MessageLike>()
  for (const message of finalMessages) {
    if (typeof message?.id === 'string') {
      remainingById.set(message.id, (remainingById.get(message.id) ?? 0) + 1)
    } else if (message && typeof message === 'object') {
      remainingAnonymous.add(message)
    }
  }
  for (const message of oldMessages) {
    if (typeof message?.id === 'string') {
      const count = remainingById.get(message.id) ?? 0
      if (count === 0) return true
      remainingById.set(message.id, count - 1)
    } else if (!remainingAnonymous.has(message)) {
      return true
    }
  }
  return false
}

export function hasInvisibleHistoryMutation(
  oldMessages: readonly MessageLike[],
  finalMessages: readonly MessageLike[],
  visibleMessages: readonly MessageLike[],
): boolean {
  if (hasInvisibleMessageRemoval(oldMessages, finalMessages)) return true

  const oldSeqById = new Map<string, number | undefined>()
  for (const message of oldMessages) {
    if (typeof message?.id === 'string' && !oldSeqById.has(message.id)) {
      oldSeqById.set(message.id, typeof message._seq === 'number' ? message._seq : undefined)
    }
  }
  const visibleVersions = new Set<string>()
  const visibleAnonymous = new Set<MessageLike>()
  for (const message of visibleMessages) {
    if (typeof message?.id === 'string' && typeof message._seq === 'number') {
      visibleVersions.add(`${message.id}\u0000${message._seq}`)
    } else if (message && typeof message === 'object') {
      visibleAnonymous.add(message)
    }
  }
  for (const message of finalMessages) {
    if (typeof message?.id === 'string') {
      const oldSeq = oldSeqById.get(message.id)
      const seq = typeof message._seq === 'number' ? message._seq : undefined
      if (oldSeq !== seq && !visibleVersions.has(`${message.id}\u0000${String(seq)}`)) return true
    } else if (!visibleAnonymous.has(message)) {
      return true
    }
  }
  return false
}
