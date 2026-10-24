import { readFileSync } from 'node:fs'

/**
 * ElevenLabs Music provider for the media studio (OCV5-590).
 *
 * MiniMax music is closed to new customers (HTTP 410 / 2153, D11 probe 2026-10-23), so studio
 * music uses ElevenLabs (user decision D11'). Master-side only: the key lives in a root-only file
 * and never reaches containers, logs or responses. Billing is done by the studio orchestrator.
 */

export const ELEVENLABS_MUSIC_URL = 'https://api.elevenlabs.io/v1/music'
const TIMEOUT_MS = 300_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024
const KEY_RE = /^[\x21-\x7e]{8,256}$/

export type MusicErrorCode =
  | 'MUSIC_NOT_CONFIGURED'
  | 'MUSIC_PROVIDER_AUTH'
  | 'MUSIC_INVALID'
  | 'MUSIC_RATE_LIMIT'
  | 'MUSIC_UPSTREAM'

export class MusicProviderError extends Error {
  constructor(
    readonly code: MusicErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MusicProviderError'
  }
}

export function resolveElevenLabsKey(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): { key?: string; error?: string } {
  const file = env.ELEVENLABS_API_KEY_FILE?.trim()
  if (!file) return {}
  let raw: string
  try {
    raw = read(file)
  } catch {
    return { error: 'ELEVENLABS_API_KEY_FILE is not readable' }
  }
  const key = raw.trim()
  if (!KEY_RE.test(key))
    return { error: 'ELEVENLABS_API_KEY_FILE does not contain a single printable token' }
  return { key }
}

const MAX_ERROR_BYTES = 64 * 1024

function upstreamFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'music provider timed out'
    : 'music provider is unreachable'
}

/** Remove the configured key and any key-shaped token (sk_…, xi-… style) from upstream text. */
export function redactSecrets(text: string, key: string): string {
  let out = key ? text.split(key).join('[redacted]') : text
  out = out.replace(/\b(sk|xi)[_-][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
  return out
}

async function readBoundedBytes(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        throw new MusicProviderError(
          'MUSIC_UPSTREAM',
          502,
          'music provider response exceeds size limit',
        )
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

async function readBounded(res: Response, max: number): Promise<string> {
  return (await readBoundedBytes(res, max)).toString('utf8')
}

export function musicCostCredits(durationMs: number, perMinute = 150): bigint {
  const minutes = Math.max(1, Math.ceil(Math.max(0, durationMs) / 60_000))
  return BigInt(minutes) * BigInt(Math.max(1, Math.trunc(perMinute)))
}

function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3') return true
  return head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0
}

export interface ComposeMusicArgs {
  prompt: string
  durationMs: number
  instrumental: boolean
  modelId?: 'music_v1' | 'music_v2' | 'music_v2_5'
}

export interface ComposedMusic {
  audio: Buffer
  mime: 'audio/mpeg'
  durationMs: number
  songId: string | null
}

export async function composeMusic(
  deps: { key?: string; fetchImpl?: typeof fetch },
  args: ComposeMusicArgs,
): Promise<ComposedMusic> {
  if (!deps.key)
    throw new MusicProviderError('MUSIC_NOT_CONFIGURED', 503, 'music provider is not configured')
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length < 1 || prompt.length > 2000)
    throw new MusicProviderError('MUSIC_INVALID', 400, 'prompt must be 1..2000 chars')
  if (!Number.isInteger(args.durationMs) || args.durationMs < 3000 || args.durationMs > 600_000) {
    throw new MusicProviderError(
      'MUSIC_INVALID',
      400,
      'durationMs must be an integer in [3000, 600000]',
    )
  }
  const url = new URL(ELEVENLABS_MUSIC_URL)
  url.searchParams.set('output_format', 'mp3_44100_128')
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'xi-api-key': deps.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        prompt,
        music_length_ms: args.durationMs,
        model_id: args.modelId ?? 'music_v1',
        force_instrumental: args.instrumental,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // Network failures and timeouts map to the documented code (code r1 P1-3).
    throw new MusicProviderError('MUSIC_UPSTREAM', 502, upstreamFailure(err))
  }
  if (!res.ok) {
    let detail = ''
    try {
      // Bounded read of the error body (code r1 P1-2): never buffer more than 64 KiB.
      const j = JSON.parse(await readBounded(res, MAX_ERROR_BYTES)) as {
        detail?: Array<{ msg?: string }> | { message?: string } | string
      }
      detail = Array.isArray(j.detail)
        ? j.detail
            .map((d) => d.msg ?? '')
            .filter(Boolean)
            .join('; ')
        : typeof j.detail === 'string'
          ? j.detail
          : (j.detail?.message ?? '')
    } catch {
      /* non-JSON error body */
    }
    // Upstream text may echo the request's key: redact it and anything key-shaped (code r1 P1-1).
    detail = redactSecrets(detail, deps.key).slice(0, 200)
    if (res.status === 401 || res.status === 403)
      throw new MusicProviderError(
        'MUSIC_PROVIDER_AUTH',
        503,
        'music provider rejected the platform key',
      )
    if (res.status === 400 || res.status === 422)
      throw new MusicProviderError('MUSIC_INVALID', 400, detail || 'music request rejected')
    if (res.status === 429)
      throw new MusicProviderError(
        'MUSIC_RATE_LIMIT',
        429,
        'music provider is rate limited; retry later',
      )
    throw new MusicProviderError('MUSIC_UPSTREAM', 502, `music provider error ${res.status}`)
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.startsWith('audio/') && !ct.startsWith('application/octet-stream')) {
    throw new MusicProviderError(
      'MUSIC_UPSTREAM',
      502,
      'music provider returned a non-audio response',
    )
  }
  if (!res.body)
    throw new MusicProviderError('MUSIC_UPSTREAM', 502, 'music provider returned no body')
  let audio: Buffer
  try {
    audio = await readBoundedBytes(res, MAX_AUDIO_BYTES)
  } catch (err) {
    if (err instanceof MusicProviderError) throw err
    throw new MusicProviderError('MUSIC_UPSTREAM', 502, upstreamFailure(err))
  }
  if (!looksLikeMp3(audio.subarray(0, 4)))
    throw new MusicProviderError('MUSIC_UPSTREAM', 502, 'music provider returned invalid mp3 data')
  return {
    audio,
    mime: 'audio/mpeg',
    durationMs: args.durationMs,
    songId: res.headers.get('song-id'),
  }
}
