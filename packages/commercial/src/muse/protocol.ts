// Muse media bridge — shared constants and pure validation (OCV5-561).
//
// The bridge (packages/commercial/muse-bridge/muse_bridge.py) runs inside the Meta Muse VM,
// dials out to the selfhost master over HTTPS long-poll, and runs
// /opt/hatch/bin/media-generation one job at a time. Containers submit jobs through
// /internal/v3/muse-media (oc-muse). Design: docs/ocv5-561-muse-media-design.md,
// plan: docs/ocv5-561-muse-media-plan.md.

import { z } from 'zod'

export const MUSE_BRIDGE_PREFIX = '/api/muse-bridge/'
export const MUSE_BRIDGE_API = '/api/muse-bridge/v1'
export const MUSE_INTERNAL_PREFIX = '/internal/v3/muse-media'

const MIB = 1024 * 1024

/** Sent to the bridge in /hello; the bridge clamps them to its own hard limits. */
export const MUSE_LIMITS = Object.freeze({
  image_max_bytes: 25 * MIB,
  video_max_bytes: 64 * MIB,
  max_files: 4,
  job_max_bytes: 80 * MIB,
  chunk_bytes: 4 * MIB,
  source_max_bytes: 10 * MIB,
  max_source_images: 4,
  /** One Range request when a bridge >= 0.5 downloads a source image (GET …/sources/:n). */
  source_chunk_bytes: 1 * MIB,
})

export const POLL_HOLD_SEC = 25
export const HEARTBEAT_SEC = 15
/** media-generation --timeout-secs. Video measured ~40 s for a 10 s clip; give it room. */
export const CLI_TIMEOUT_SEC = Object.freeze({ image: 120, video: 300 })
/** Whole-job deadline from dispatch, including chunk upload. */
export const JOB_DEADLINE_MS = Object.freeze({ image: 180_000, video: 390_000 })
/** Extra deadline when source images must be uploaded first (--upload-only step). */
export const SOURCE_UPLOAD_EXTRA_MS = 120_000
/** A dispatched job not acked within this window was never started: requeue it. */
export const ACK_TIMEOUT_MS = 20_000
export const MAX_DISPATCH_ATTEMPTS = 3
/**
 * Bridges from this version get source images by reference and download them after the ack
 * (GET /jobs/:id/sources/:n); older bridges keep receiving them inline in the poll response.
 * Multi-MB inline claims were never acked through the CDN in production (OCV5-591, 0 of 12).
 */
export const SOURCE_REFS_MIN_BRIDGE: readonly [number, number, number] = [0, 5, 0]
/**
 * Total decoded source bytes per job while the connected bridge is older than 0.5 (inline only).
 * Production claims of 3.1–3.9 MB were acked 0 of 12 times and a 217 KB one on its third
 * dispatch; this keeps an inline claim under ~0.7 MB. Bridges >= 0.5 are not limited by it.
 */
export const INLINE_SOURCE_MAX_BYTES = 512 * 1024
export const HEARTBEAT_LOST_MS = 60_000
export const BRIDGE_ONLINE_MS = 60_000
/** Defaults for the personal edition (one bridge slot); commercial overrides them through config. */
export const QUEUE_MAX = 3
export const QUEUE_WAIT_MS = 240_000
/** Hard ceiling for OC_MUSE_CONCURRENCY; the bridge clamps to its own --max-concurrency too. */
export const MAX_CONCURRENCY = 32
/** Finished jobs (and their files) stay fetchable this long. */
export const DONE_RETAIN_MS = 60 * 60_000

export const JOB_ID_RE = /^mj_[0-9a-f-]{36}$/
export const SNAPSHOT_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/
const UPSTREAM_CODE_RE = /^[A-Za-z0-9_.:-]{1,100}$/

export type MuseKind = 'image' | 'video'

/** Error codes the bridge itself may report in a failed result (DESIGN §9). */
export const BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set([
  'MUSE_VIDEO_REGION_BLOCKED',
  'MUSE_UPSTREAM_ERROR',
  'MUSE_UPSTREAM_REJECTED',
  'MUSE_UPLOAD_FAILED',
  'MUSE_BAD_ARGS',
  'MUSE_BAD_OUTPUT',
  'MUSE_CLI_MISSING',
  'MUSE_TIMEOUT',
  'MUSE_FILE_TOO_LARGE',
  'MUSE_INVALID_INPUT',
  'MUSE_CANCELLED',
  'MUSE_BRIDGE_LOST',
  'MUSE_SOURCE_FETCH_FAILED',
])

const ALLOWED_MIME: Record<MuseKind, ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp']),
  video: new Set(['video/mp4', 'video/webm']),
}

export const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
})

export class MuseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'MuseError'
  }
}

/** Magic-number sniffing; extensions and bridge-declared types are never trusted. */
export function sniffMime(head: Buffer): string | null {
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg'
  if (
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4'
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'
  return null
}

export function mimeAllowed(kind: MuseKind, mime: string): boolean {
  return ALLOWED_MIME[kind].has(mime)
}

export function perFileLimit(kind: MuseKind): number {
  return kind === 'video' ? MUSE_LIMITS.video_max_bytes : MUSE_LIMITS.image_max_bytes
}

/** Base64 length bound for a decoded size cap (4/3 plus padding slack). */
const SOURCE_B64_MAX = Math.ceil((MUSE_LIMITS.source_max_bytes * 4) / 3) + 8

const SubmitSchema = z
  .object({
    kind: z.enum(['image', 'video']),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .refine((v) => v.trim().length > 0, 'prompt is blank'),
    orientation: z.enum(['square', 'vertical', 'landscape']).optional(),
    aspect_ratio: z.enum(['4:5', '7:12', '9:16']).optional(),
    image_format: z.enum(['png', 'jpg', 'jpeg', 'webp']).optional(),
    source_images: z
      .array(z.object({ base64: z.string().min(1).max(SOURCE_B64_MAX) }).strict())
      .max(MUSE_LIMITS.max_source_images)
      .optional(),
    resume_snapshot_id: z.string().regex(SNAPSHOT_ID_RE).optional(),
  })
  .strict()

export interface MuseJobSpec {
  kind: MuseKind
  prompt: string
  orientation?: 'square' | 'vertical' | 'landscape'
  aspect_ratio?: '4:5' | '7:12' | '9:16'
  image_format?: 'png' | 'jpg' | 'jpeg' | 'webp'
  /** Validated base64 (decoded size and magic checked), forwarded to the bridge as-is. */
  source_images?: string[]
  resume_snapshot_id?: string
}

/** Validate a container submission. Throws MuseError(400, MUSE_INVALID_INPUT). */
export function parseSubmission(raw: unknown): MuseJobSpec {
  const r = SubmitSchema.safeParse(raw)
  if (!r.success) {
    const issue = r.error.issues[0]
    throw new MuseError(
      400,
      'MUSE_INVALID_INPUT',
      `invalid ${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'bad request'}`,
    )
  }
  const v = r.data
  // --image-output-format only means something for images; video has no
  // format/duration/resolution knobs (fixed ~10 s; size from backend or source image).
  if (v.kind === 'video' && v.image_format) {
    throw new MuseError(400, 'MUSE_INVALID_INPUT', 'image_format applies to images only')
  }
  const sources: string[] = []
  for (const [n, item] of (v.source_images ?? []).entries()) {
    const data = Buffer.from(item.base64, 'base64')
    // Buffer.from tolerates junk; require a canonical round-trip so the bridge's strict
    // decoder sees exactly what we checked.
    if (data.length === 0 || data.toString('base64') !== item.base64.replace(/\s+/g, '')) {
      throw new MuseError(400, 'MUSE_INVALID_INPUT', `source image ${n + 1} is not valid base64`)
    }
    if (data.length > MUSE_LIMITS.source_max_bytes) {
      throw new MuseError(400, 'MUSE_INVALID_INPUT', `source image ${n + 1} exceeds 10 MiB`)
    }
    const mime = sniffMime(data.subarray(0, 16))
    if (!mime || !mimeAllowed('image', mime)) {
      throw new MuseError(400, 'MUSE_INVALID_INPUT', 'source images must be png, jpg or webp')
    }
    sources.push(data.toString('base64'))
  }
  return {
    kind: v.kind,
    prompt: v.prompt,
    ...(v.orientation ? { orientation: v.orientation } : {}),
    ...(v.aspect_ratio ? { aspect_ratio: v.aspect_ratio } : {}),
    ...(v.image_format ? { image_format: v.image_format } : {}),
    ...(sources.length ? { source_images: sources } : {}),
    ...(v.resume_snapshot_id ? { resume_snapshot_id: v.resume_snapshot_id } : {}),
  }
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * True when a bridge of this version downloads source images itself: SemVer >= 0.5.0. A
 * pre-release of 0.5.0 (0.5.0-rc.1) precedes 0.5.0 and stays inline; anything unparseable too.
 * Same rule as the personal edition (#1102).
 */
export function bridgeFetchesSources(version: string | null): boolean {
  const m = SEMVER_RE.exec(version ?? '')
  if (!m) return false
  const pre = m[4]
  if (pre?.split('.').some((id) => /^0\d+$/.test(id))) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== SOURCE_REFS_MIN_BRIDGE[i]) return v[i]! > SOURCE_REFS_MIN_BRIDGE[i]!
  }
  return pre === undefined
}

/** Decoded size of canonical base64 (parseSubmission and the studio adapter only produce that). */
export function base64DecodedBytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}

export function jobDeadlineMs(spec: MuseJobSpec): number {
  return JOB_DEADLINE_MS[spec.kind] + (spec.source_images?.length ? SOURCE_UPLOAD_EXTRA_MS : 0)
}

/** Bridge-reported failure, normalized: unknown codes become MUSE_BAD_OUTPUT. */
export function normalizeBridgeFailure(body: Record<string, unknown>): {
  code: string
  message: string
  retryable: boolean
  upstreamCode: string | null
} {
  const raw = typeof body.error_code === 'string' ? body.error_code : ''
  const code = BRIDGE_ERROR_CODES.has(raw) ? raw : 'MUSE_BAD_OUTPUT'
  const message =
    typeof body.error_message === 'string' && body.error_message
      ? body.error_message.slice(0, 500)
      : code
  const upstream =
    typeof body.upstream_error_code === 'string' && UPSTREAM_CODE_RE.test(body.upstream_error_code)
      ? body.upstream_error_code
      : null
  return { code, message, retryable: body.retryable === true, upstreamCode: upstream }
}

/** Who may submit jobs: a set of uids, or every signed-in account (commercial, OCV5-574). */
export type MuseAllowlist = ReadonlySet<string> | 'all'

/** Parse comma-separated decimal uids; uid 4 is never enabled in a list (selfhost task rule).
 * The single token `all` opens Muse to every account. */
export function parseAllowedUids(
  raw: readonly string[] | undefined,
  warn: (msg: string, meta: Record<string, unknown>) => void = () => {},
): MuseAllowlist {
  if (raw?.length === 1 && raw[0] === 'all') return 'all'
  const out = new Set<string>()
  for (const uid of raw ?? ['3']) {
    if (uid === '4') {
      warn('muse_allowlist_uid_ignored', { uid })
      continue
    }
    out.add(uid)
  }
  return out
}
