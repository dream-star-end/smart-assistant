// OCV5-591 A2-0 — one provider contract for every media kind (user decision 2026-10-23 09:44).
// The orchestrator only sees MediaProvider; adding a vendor is an adapter + a config entry.

export const MEDIA_KINDS = ['image', 'video', 'voice', 'music'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export const MEDIA_OPS = [
  'image.generate',
  'image.edit',
  'video.from_image',
  'video.from_text',
  'video.extend',
  'voice.tts',
  'voice.design',
  'voice.clone',
  'music.generate',
  // OCV5-591 M1: turn a chosen catalog / library track into a music take.
  'music.fetch',
] as const
export type MediaOp = (typeof MEDIA_OPS)[number]

export function kindOf(op: MediaOp): MediaKind {
  return op.slice(0, op.indexOf('.')) as MediaKind
}

export type ProviderState = 'ready' | 'unconfigured' | 'disabled' | 'offline'
export type ProviderReason =
  | 'MISSING_KEY'
  | 'KEY_UNREADABLE'
  | 'DISABLED_BY_CONFIG'
  | 'INVALID_CONFIG'
  | 'FEATURE_OFF'
  | 'BRIDGE_OFFLINE'
  | 'NOT_ALLOWED_FOR_USER'

export interface ProviderStatus {
  state: ProviderState
  reason?: ProviderReason
}

export interface ModelInfo {
  id: string
  label: string
  ops: MediaOp[]
  isDefault?: boolean
}

export interface StudioUser {
  id: string
  role?: string
}

export interface MediaInput {
  role: 'reference' | 'first_frame' | 'last_frame' | 'source'
  blobSha: string
}

export interface MediaRequest {
  op: MediaOp
  /** Omitted → the provider's default model for this op. */
  model?: string
  prompt?: string
  /** voice.tts */
  text?: string
  voiceId?: string
  durationSec?: number
  aspect?: '16:9' | '9:16' | '1:1'
  inputs?: MediaInput[]
  /** Muse continuation (video.extend). */
  resumeSnapshotId?: string
  /** voice.design / voice.clone: a label for the new voice. */
  label?: string
  /** music.fetch: the track to take (catalog row or the user's own track). */
  trackId?: string
  /** voice.clone: the uploader's statement that the sample is their own voice or authorized. */
  consent?: { statement: 'self_or_authorized'; acceptedAt: string }
}

export interface MediaRunContext {
  userId: bigint
  /** studio:<task id>; stable across re-leases (A1 plan §3), so every provider call is idempotent. */
  execRequestId: string
  /** Credits already reserved atomically for this task (A1 §4). */
  maxCostCredits: bigint
  signal: AbortSignal
  /** Reads a blob the user holds a reference to (StudioBlobStore.open); throws otherwise. */
  readInput(sha: string): Promise<Buffer>
}

export interface MediaOutput {
  bytes: Buffer
  mime: string
  durationMs?: number
}

export interface MediaResult {
  outputs: MediaOutput[]
  model: string
  /**
   * Credits charged to the user for this execRequestId, including a charge made by an earlier
   * attempt that is now replayed — this is what the budget reconciliation adds to spent (A1 §4).
   */
  costCredits: bigint
  /** true when this call made the debit; false on a replay of an earlier, already-charged attempt. */
  charged: boolean
  /**
   * The settled charge exceeded ctx.maxCostCredits (e.g. upstream changed how it counts TTS
   * characters). The orchestrator books the overrun and pauses the project (plan r2).
   */
  overReservation: boolean
  /** The provider's own ledger row, for budget reconciliation. */
  providerRef: { table: string; id: string } | null
  meta?: Record<string, unknown>
}

export class MediaProviderError extends Error {
  constructor(
    readonly code: string,
    /** false when the upstream may already have produced (and billed) output. */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'MediaProviderError'
  }
}

/** OCV5-591 M1 — what a music source can be searched by (MUSIC-PLAN §2). */
export interface MusicQuery {
  text?: string
  moods?: string[]
  genres?: string[]
  bpmMin?: number
  bpmMax?: number
  minSec?: number
  maxSec?: number
  vocals?: boolean
  limit?: number
  cursor?: string
}

export interface MusicTrack {
  id: string
  title: string
  artist: string
  durationMs: number | null
  bpm: number | null
  moods: string[]
  genres: string[]
  vocals: boolean
  license: 'CC0-1.0' | 'CC-BY-3.0' | 'CC-BY-4.0' | 'PIXABAY-CL' | 'USER-STATEMENT'
  licenseUrl: string | null
  attributionRequired: boolean
  attributionText: string
  landingUrl: string | null
  /** Where the track came from (incompetech, openverse, user-upload, …). */
  origin: string
  /** Blob to preview (playable through a blob ticket). */
  previewSha: string
  /** How far BPM and moods can be trusted: from the source, measured by us, or our guess. */
  metadata: {
    bpm: 'source' | 'measured' | 'unknown'
    moods: 'source' | 'guessed' | 'unknown'
  }
}

export interface MusicSearchResult {
  tracks: MusicTrack[]
  next: string | null
}

export interface MediaProvider {
  /** Config instance id, e.g. `gpt-image`, `muse-video`. */
  readonly id: string
  /** Adapter type, e.g. `gpt-image`, `muse`, `minimax-speech`. */
  readonly adapter: string
  readonly kind: MediaKind
  readonly label: string
  readonly priority: number
  models(): ModelInfo[]
  /** Synchronous and IO-free: key presence is resolved once when the registry is built. */
  status(user?: StudioUser): ProviderStatus
  /** Upper bound used for the atomic budget reservation. */
  estimateMaxCost(req: MediaRequest): bigint
  /** Queue affinity (A1 §3), e.g. `muse`; null when any slot may run it. */
  affinity(): string | null
  /** Credits actually debited for one execution id (0 when nothing was charged). */
  chargedFor(userId: bigint, execRequestId: string): Promise<bigint>
  run(ctx: MediaRunContext, req: MediaRequest): Promise<MediaResult>
  /** Music sources only (OCV5-591 M1): search the source's tracks. */
  search?(user: StudioUser, q: MusicQuery): Promise<MusicSearchResult>
}

/** Ops the provider can run for the given model (or any of its models). */
export function supportsOp(p: MediaProvider, op: MediaOp, model?: string): boolean {
  return p.models().some((m) => (model === undefined || m.id === model) && m.ops.includes(op))
}

export function defaultModelFor(p: MediaProvider, op: MediaOp): ModelInfo | undefined {
  const usable = p.models().filter((m) => m.ops.includes(op))
  return usable.find((m) => m.isDefault) ?? usable[0]
}
