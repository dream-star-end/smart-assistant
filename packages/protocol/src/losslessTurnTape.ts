/**
 * Lossless turn-tape wire contract (runtime container -> commercial master).
 *
 * A completed/interrupted/crashed turn is canonical JSON bytes split into
 * independently content-addressed parts.  The per-request part cap is a
 * resource guard; it is not a per-turn data cap.
 */

import { createHash } from 'node:crypto'

export const LOSSLESS_TURN_TAPE_VERSION = 2 as const
/** Release/runtime capability token. Once any finalized v2 tape exists,
 * deploy tooling must never activate a reader or writer that lacks it. */
export const LOSSLESS_TURN_TAPE_CAPABILITY = 'lossless-turn-tape-v2' as const
/** Master-only reader/writer capability for compressed physical runtime-event
 * records. It is intentionally separate from the v2 container wire capability:
 * an older master can parse v2 tapes but cannot hydrate this storage format. */
export const LOSSLESS_TURN_TAPE_RUNTIME_BATCH_CAPABILITY = 'lossless-turn-runtime-batch-v1' as const
export const LOSSLESS_TURN_TAPE_PART_BYTES = 192 * 1024
/** Compact visible envelope budget; full text remains in canonical parts. */
export const LOSSLESS_TURN_TAPE_VISIBLE_TEXT_BYTES = 128 * 1024
export const LOSSLESS_TURN_TAPE_SHA256_RE = /^[0-9a-f]{64}$/
/** Reserved envelope identity used only when upgrading a pre-agentId v1
 * retry entry to the v2 tape protocol. Materialization maps it back to the
 * historical `srv-${sessionId}-tN` record namespace so an ACK-lost v1 write
 * is replaced idempotently rather than duplicated. */
export const LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID = "__legacy_v1__" as const

/** 平台自动免单的稳定原因码。只进签名/持久化控制面，不携带上游原文。 */
export type TurnWaiveReason =
  | 'idle_timeout'
  | 'no_response'
  | 'platform_authority_expired'
  | 'turn_limit'

/** Engine-reported Codex billing evidence stored inside the same immutable
 * tape as the paid reply. Master-owned journal context supplies pricing and
 * identity; this payload supplies the final usage and exact turn locators. */
export interface DurableCodexBilling {
  requestId: string
  turnKey?: string
  parentTurnKey?: string
  parentSessionId?: string
  delegateAgentId?: string
  engineSessionId: string
  status: 'success' | 'error'
  /** Stable, content-free terminal classification. Optional only for rolling
   * compatibility with runtime images predating product-friction telemetry. */
  terminalCode?: 'USER_CANCELLED' | 'CODEX_ERROR'
  durationMs: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_output_tokens?: number
  }
  rateLimits?: {
    util5h?: number
    reset5h?: string
    util7d?: number
    reset7d?: string
  }
}

export interface LosslessTurnTapePartRequest {
  protocolVersion: typeof LOSSLESS_TURN_TAPE_VERSION
  action: 'part'
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  /** 终态携带即要求 master 原子封账并异步完成退款+定向站内信。 */
  waiveReason?: TurnWaiveReason
  /** Executed model copied from the hashed canonical payload. Master uses it
   * only to attribute exact idle-timeout health evidence. */
  model?: string
  turnKey: string
  tapeId: string
  tapeSha256: string
  totalBytes: number
  partCount: number
  partIndex: number
  partSha256: string
  /** Standard base64 (not base64url) of this part's raw canonical bytes. */
  data: string
  createdAt: number
  /** RFC-v5-durable-turn-dispatch §2.4:sink 首片带 dispatch 身份 → 落 tape header,
   * finalize 据此同事务收敛 turn_dispatches → terminal。可选(legacy tape / 非 durable lane 无)。 */
  dispatchId?: string
  attemptNo?: number
}

export interface LosslessTurnTapeSettlement {
  billingAnchorId: string
  requestId?: string
  engineBillings: DurableCodexBilling[]
  text: string
  ts: number
  /** Visible head is clipped; canonical multipart bytes still contain the full text. */
  truncated?: boolean
  errorCode?: string
}

/**
 * Small, independently acknowledged visibility commit. It deliberately
 * precedes multipart upload so a broken/slow part path cannot make a completed
 * answer disappear. Master commits the visible head + terminal dispatch from
 * this envelope; parts/finalize remain the lossless audit/materialization path.
 */
export interface LosslessTurnTapeVisibleRequest {
  protocolVersion: typeof LOSSLESS_TURN_TAPE_VERSION
  action: 'visible'
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  waiveReason?: TurnWaiveReason
  model?: string
  turnKey: string
  tapeId: string
  tapeSha256: string
  totalBytes: number
  partCount: number
  createdAt: number
  dispatchId?: string
  attemptNo?: number
  settlement: LosslessTurnTapeSettlement
}

export interface LosslessTurnTapeFinalizeRequest {
  protocolVersion: typeof LOSSLESS_TURN_TAPE_VERSION
  action: 'finalize'
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  /** 与每个 part 同值；finalize 事务以它创建 pending 免单封账标记。 */
  waiveReason?: TurnWaiveReason
  /** Same immutable execution-model metadata carried on every part. */
  model?: string
  turnKey: string
  tapeId: string
  tapeSha256: string
  totalBytes: number
  partCount: number
  createdAt: number
  /** 同 part:dispatch 身份(master 收敛以 tape header 存量为准,finalize 携带仅为对称冗余)。 */
  dispatchId?: string
  attemptNo?: number
  /**
   * Compact billing/visible envelope from the same tape builder identity
   * (docs/design/2026-08-19-turn-finalize-decoupling.md rev2 B1).
   */
  settlement?: LosslessTurnTapeSettlement
}

/** Record id namespace used by materializeLosslessTurn. */
export function losslessRecordPrefix(sessionId: string, agentId: string, turnIndex: number): string {
  const idPart = agentId === LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID ? sessionId : `${sessionId}-${agentId}`
  return `srv-${idPart}-t${turnIndex}`
}

/** Minimal record identity needed to choose the physical billing anchor. */
type LosslessAnchorCandidate = {
  id: string
  role: string
  ts: number
  eventOrdinal?: number
  runtime?: {
    source: 'ccb' | 'codex-jsonrpc' | 'gateway'
    payloadBytes: Buffer
    payloadSha256: string
    bashTail: boolean
  }
}

const LOSSLESS_RUNTIME_BATCH_MIN_RECORDS = 4
const LOSSLESS_RUNTIME_BATCH_MAX_RECORDS = 128
const LOSSLESS_RUNTIME_BATCH_MAX_BYTES = 512 * 1024

function anchorSha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function anchorInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function anchorString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function compareAnchorCandidates(a: LosslessAnchorCandidate, b: LosslessAnchorCandidate): number {
  const ao = a.eventOrdinal ?? Number.MAX_SAFE_INTEGER
  const bo = b.eventOrdinal ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id.localeCompare(b.id)
}

function batchRuntimeAnchorCandidates(
  prefix: string,
  sorted: LosslessAnchorCandidate[],
): LosslessAnchorCandidate[] {
  const physical: LosslessAnchorCandidate[] = []
  let pending: LosslessAnchorCandidate[] = []
  let pendingBytes = 0
  const flush = (): void => {
    if (pending.length < LOSSLESS_RUNTIME_BATCH_MIN_RECORDS) {
      physical.push(...pending)
      pending = []
      pendingBytes = 0
      return
    }
    let offset = 0
    const manifest = pending.map((item) => {
      const runtime = item.runtime!
      const entry = {
        id: item.id,
        eventOrdinal: item.eventOrdinal!,
        ts: item.ts,
        source: runtime.source,
        offset,
        length: runtime.payloadBytes.length,
        payloadSha256: runtime.payloadSha256,
      }
      offset += runtime.payloadBytes.length
      return entry
    })
    const manifestSha256 = anchorSha256(Buffer.from(JSON.stringify(manifest), 'utf8'))
    const first = pending[0]!
    const last = pending.at(-1)!
    physical.push({
      id: `${prefix}-runtime-batch-${first.eventOrdinal}-${last.eventOrdinal}-${manifestSha256.slice(0, 12)}`,
      role: 'runtime-event',
      ts: first.ts,
      eventOrdinal: first.eventOrdinal,
    })
    pending = []
    pendingBytes = 0
  }
  for (const item of sorted) {
    const runtime = item.runtime
    const eligible = item.role === 'runtime-event' && runtime !== undefined && !runtime.bashTail
    if (!eligible) {
      flush()
      physical.push(item)
      continue
    }
    if (
      pending.length >= LOSSLESS_RUNTIME_BATCH_MAX_RECORDS
      || (pending.length > 0
        && pendingBytes + runtime.payloadBytes.length > LOSSLESS_RUNTIME_BATCH_MAX_BYTES)
    ) flush()
    if (runtime.payloadBytes.length > LOSSLESS_RUNTIME_BATCH_MAX_BYTES) {
      physical.push(item)
      continue
    }
    pending.push(item)
    pendingBytes += runtime.payloadBytes.length
  }
  flush()
  return physical
}

/**
 * Canonical physical billing-anchor record id shared by the runtime writer and
 * master materializer. The helper mirrors record identity/order and optional
 * runtime batching, so Phase A never hashes a logical id that Phase B cannot
 * publish as a physical record.
 */
export function losslessBillingAnchorId(input: {
  sessionId: string
  agentId: string
  turnIndex: number
  status?: 'completed' | 'interrupted' | 'crashed'
  createdAt?: number
  clientMessageId?: string
  continuationOfTurnKey?: string
  assistantSegments?: Array<{ index: number }>
  text?: string
  errorCode?: string
  thinkingText?: string
  thinkingSegments?: Array<{ index: number; ts?: number; eventOrdinal?: number }>
  tools?: Array<{ blockId?: unknown; arrivedAt?: unknown; eventOrdinal?: unknown }>
  agentGroups?: Array<{ runId?: unknown; completedAt?: unknown; _ocEventOrdinal?: unknown }>
  structuredBlocks?: Array<Record<string, unknown>>
  runtimeEvents?: Array<{
    ordinal: number
    observedAt?: number
    source?: 'ccb' | 'codex-jsonrpc' | 'gateway'
    payload?: unknown
  }>
  runtimeBatching?: boolean
}): string {
  const prefix = losslessRecordPrefix(input.sessionId, input.agentId, input.turnIndex)
  const segs = input.assistantSegments
  if (segs && segs.length > 0) return `${prefix}-s${segs[segs.length - 1]!.index}`
  if ((input.text && input.text.length > 0) || input.errorCode) return prefix

  const baseTs = input.createdAt ?? 0
  const candidates: LosslessAnchorCandidate[] = []
  const thinking = input.thinkingSegments ?? []
  if (thinking.length > 0) {
    for (const segment of thinking) {
      candidates.push({
        id: `${prefix}-thinking-s${segment.index}`,
        role: 'thinking',
        ts: anchorInt(segment.ts) ?? 0,
        eventOrdinal: anchorInt(segment.eventOrdinal),
      })
    }
  } else if (input.thinkingText) {
    candidates.push({
      id: `${prefix}-thinking`,
      role: 'thinking',
      ts: baseTs - (input.tools?.length ?? 0) - 1,
    })
  }

  const tools = input.tools ?? []
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!
    const blockId = anchorString(tool.blockId)
    if (!blockId) continue
    candidates.push({
      id: `${prefix}-tool-${blockId}`,
      role: 'tool',
      ts: anchorInt(tool.arrivedAt) ?? (baseTs - tools.length + i),
      eventOrdinal: anchorInt(tool.eventOrdinal),
    })
  }

  for (const group of input.agentGroups ?? []) {
    const runId = anchorString(group.runId)
    if (!runId) continue
    candidates.push({
      id: `${prefix}-agentgroup-${runId}`,
      role: 'agent-group',
      ts: anchorInt(group.completedAt) ?? baseTs,
      eventOrdinal: anchorInt(group._ocEventOrdinal),
    })
  }

  const structured = new Map<
    string,
    { kind: 'plan' | 'goal'; blockId: string; events: Array<Record<string, unknown>> }
  >()
  for (let ordinal = 0; ordinal < (input.structuredBlocks ?? []).length; ordinal++) {
    const block = input.structuredBlocks![ordinal]!
    const kind = block.kind
    if (kind !== 'plan' && kind !== 'goal') continue
    const platformGoalId = kind === 'goal' ? anchorString(block.platformGoalId) : undefined
    const blockId = platformGoalId
      ? `platform-goal-${platformGoalId}`
      : anchorString(block.blockId) ?? `${kind}-${ordinal}`
    const key = `${kind}\0${blockId}`
    const current = structured.get(key) ?? { kind, blockId, events: [] }
    current.events.push(block)
    structured.set(key, current)
  }
  for (const [key, group] of structured) {
    const last = group.events.at(-1)!
    candidates.push({
      id: `${prefix}-${group.kind}-${anchorSha256(Buffer.from(key, 'utf8'))}`,
      role: group.kind,
      ts: anchorInt(last._ocObservedAt) ?? baseTs,
      eventOrdinal: anchorInt(last._ocEventOrdinal),
    })
  }

  for (const event of input.runtimeEvents ?? []) {
    const id = `${prefix}-runtime-${event.ordinal}`
    const observedAt = anchorInt(event.observedAt) ?? baseTs
    const source = event.source ?? 'gateway'
    const eventBody = event.payload ?? null
    const payload: Record<string, unknown> = {
      id,
      role: 'runtime-event',
      text: JSON.stringify(eventBody),
      ts: observedAt,
      status: input.status,
      _runtimeSource: source,
      _runtimeEvent: eventBody,
      _ocEventOrdinal: event.ordinal,
      _hiddenRuntimeEvent: true,
      ...(input.continuationOfTurnKey
        ? { _continuationOfTurnKey: input.continuationOfTurnKey }
        : {}),
      ...(input.clientMessageId ? { _clientMessageId: input.clientMessageId } : {}),
    }
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
    const eventPayload = eventBody && typeof eventBody === 'object' && !Array.isArray(eventBody)
      ? eventBody as Record<string, unknown>
      : null
    candidates.push({
      id,
      role: 'runtime-event',
      ts: observedAt,
      eventOrdinal: event.ordinal,
      runtime: {
        source,
        payloadBytes,
        payloadSha256: anchorSha256(payloadBytes),
        bashTail: eventPayload?.type === 'system'
          && eventPayload.subtype === 'bash_output_tail',
      },
    })
  }

  candidates.sort(compareAnchorCandidates)
  const physical = input.runtimeBatching
    ? batchRuntimeAnchorCandidates(prefix, candidates)
    : candidates
  return physical.at(-1)?.id ?? prefix
}

export type LosslessTurnTapeRequest =
  | LosslessTurnTapeVisibleRequest
  | LosslessTurnTapePartRequest
  | LosslessTurnTapeFinalizeRequest
