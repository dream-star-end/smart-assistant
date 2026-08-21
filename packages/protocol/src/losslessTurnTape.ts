/**
 * Lossless turn-tape wire contract (runtime container -> commercial master).
 *
 * A completed/interrupted/crashed turn is canonical JSON bytes split into
 * independently content-addressed parts.  The per-request part cap is a
 * resource guard; it is not a per-turn data cap.
 */

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

/** Canonical billing-anchor record id matching materializeLosslessTurn. */
export function losslessBillingAnchorId(input: {
  sessionId: string
  agentId: string
  turnIndex: number
  assistantSegments?: Array<{ index: number }>
  text?: string
  errorCode?: string
  tools?: Array<{ blockId: string }>
  agentGroups?: Array<{ runId: string }>
  structuredBlocks?: Array<{ kind: string; blockId?: string; platformGoalId?: string }>
  runtimeEvents?: Array<{ ordinal: number }>
}): string {
  const prefix = losslessRecordPrefix(input.sessionId, input.agentId, input.turnIndex)
  const segs = input.assistantSegments
  if (segs && segs.length > 0) return `${prefix}-s${segs[segs.length - 1]!.index}`
  if ((input.text && input.text.length > 0) || input.errorCode) return prefix
  const groups = input.agentGroups ?? []
  if (groups.length > 0) return `${prefix}-agentgroup-${groups[groups.length - 1]!.runId}`
  const tools = input.tools ?? []
  if (tools.length > 0) return `${prefix}-tool-${tools[tools.length - 1]!.blockId}`
  const runtime = input.runtimeEvents ?? []
  if (runtime.length > 0) return `${prefix}-runtime-${runtime[runtime.length - 1]!.ordinal}`
  return prefix
}

export type LosslessTurnTapeRequest =
  | LosslessTurnTapeVisibleRequest
  | LosslessTurnTapePartRequest
  | LosslessTurnTapeFinalizeRequest
