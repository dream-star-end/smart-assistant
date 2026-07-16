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
export const LOSSLESS_TURN_TAPE_SHA256_RE = /^[0-9a-f]{64}$/
/** Reserved envelope identity used only when upgrading a pre-agentId v1
 * retry entry to the v2 tape protocol. Materialization maps it back to the
 * historical `srv-${sessionId}-tN` record namespace so an ACK-lost v1 write
 * is replaced idempotently rather than duplicated. */
export const LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID = "__legacy_v1__" as const

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
}

export interface LosslessTurnTapeFinalizeRequest {
  protocolVersion: typeof LOSSLESS_TURN_TAPE_VERSION
  action: 'finalize'
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  turnKey: string
  tapeId: string
  tapeSha256: string
  totalBytes: number
  partCount: number
  createdAt: number
}

export type LosslessTurnTapeRequest =
  | LosslessTurnTapePartRequest
  | LosslessTurnTapeFinalizeRequest
