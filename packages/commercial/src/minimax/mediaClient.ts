import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { Dispatcher } from 'undici'

import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import { HttpError } from '../http/util.js'
import { settleMiniMaxMediaSuccess } from './mediaBilling.js'
import {
  type MiniMaxMediaCostResult,
  calculateMiniMaxSpeechCost,
  calculateMiniMaxVoiceDesignCost,
} from './mediaPricing.js'
import {
  type SystemVoice,
  type SystemVoiceCache,
  beginVoiceCreation,
  checkVoiceAccess,
  completeVoiceCreation,
  failVoiceCreation,
  touchOwnedVoice,
  voiceSettleRequestId,
} from './voices.js'

/**
 * Master-side MiniMax media client (OCV5-589).
 *
 * Shared by the container proxy (`/internal/v3/minimax`, mediaProxy.ts) and by
 * the media studio orchestrator, which runs in master without a container.
 * Every paid call: balance pre-check → upstream → settle once by requestId.
 * Voice design / clone are master-only (not exposed to containers).
 */

export const MINIMAX_API_BASE = 'https://api.minimaxi.com'
const UPSTREAM_TIMEOUT_MS = 300_000
const MAX_CLONE_SAMPLE_BYTES = 20 * 1024 * 1024
const RATE_LIMIT_CODES = new Set([1002, 1039])

export const SPEECH_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
] as const
export type SpeechEmotion = (typeof SPEECH_EMOTIONS)[number]
export type SpeechModel = 'speech-2.8-turbo' | 'speech-2.8-hd'
export type AudioFormat = 'mp3' | 'wav' | 'flac' | 'pcm'

export function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function baseRespCode(json: unknown): number | undefined {
  if (!isObj(json) || !isObj(json.base_resp)) return undefined
  const code = json.base_resp.status_code
  return typeof code === 'number' ? code : undefined
}

export function baseRespMessage(json: unknown): string {
  if (!isObj(json)) return 'upstream error'
  const br = json.base_resp
  if (isObj(br) && typeof br.status_msg === 'string') return br.status_msg.slice(0, 200)
  return 'upstream error'
}

export function traceId(json: unknown): string | null {
  return isObj(json) && typeof json.trace_id === 'string' ? json.trace_id : null
}

async function readUpstreamJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned invalid JSON')
  }
}

function upstreamError(res: Response, json: unknown): HttpError {
  const code = baseRespCode(json)
  if (res.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return new HttpError(429, 'MINIMAX_UPSTREAM_RATE_LIMIT', baseRespMessage(json))
  }
  return new HttpError(502, 'MINIMAX_UPSTREAM_ERROR', baseRespMessage(json))
}

function checkUpstream(res: Response, json: unknown): void {
  const code = baseRespCode(json)
  if (!res.ok || (code !== undefined && code !== 0)) throw upstreamError(res, json)
}

const direct = () => ({ dispatcher: directEgressDispatcher() }) as { dispatcher: Dispatcher }

export async function postJson(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchFn(`${MINIMAX_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    // minimax 新加坡端点显式直连,绕开 gateway 全局 EnvHttpProxyAgent(给 Anthropic 出海的日本节点)。
    ...direct(),
  } as RequestInit)
  const json = await readUpstreamJson(res)
  checkUpstream(res, json)
  return json
}

export async function getJson(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${MINIMAX_API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    // minimax 端点显式直连,绕开全局日本代理(理由同 postJson)。
    ...direct(),
  } as RequestInit)
  const json = await readUpstreamJson(res)
  checkUpstream(res, json)
  return json
}

async function postMultipart(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  form: FormData,
): Promise<unknown> {
  const res = await fetchFn(`${MINIMAX_API_BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...direct(),
  } as RequestInit)
  const json = await readUpstreamJson(res)
  checkUpstream(res, json)
  return json
}

export function hexToBuffer(hex: string): Buffer {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned invalid hex audio')
  }
  return Buffer.from(hex, 'hex')
}

export async function ensureSufficientBalance(
  pool: Pool,
  userId: bigint,
  cost: MiniMaxMediaCostResult,
): Promise<void> {
  if (cost.costCredits <= 0n) return
  // 双钱包（0096）：前置门按"总可用"= users.credits 持久钱包 + active 未过期订阅 period_credits
  // 期内桶，否则钱包 0、套餐桶有余额的订阅用户会被误拒 402。
  const out = await pool.query<{ credits: string }>(
    `SELECT (u.credits + COALESCE(us.period_credits, 0))::text AS credits
       FROM users u
       LEFT JOIN user_subscriptions us
         ON us.user_id = u.id AND us.status = 'active' AND us.period_end > NOW()
      WHERE u.id = $1`,
    [userId.toString()],
  )
  const balance = out.rowCount === 0 ? 0n : BigInt(out.rows[0]!.credits)
  // Media calls have a known planned cost before the upstream request, unlike
  // streaming LLM calls whose final cost is only known after SSE completes. Hard
  // reject insufficient balance here so a 1-credit account cannot submit a
  // high-priced job and rely on settle() clamping after delivery.
  if (balance < cost.costCredits) {
    throw new HttpError(
      402,
      'INSUFFICIENT_CREDITS',
      `insufficient credits: balance=${balance} required=${cost.costCredits}`,
    )
  }
}

/** Optional global 5-hour soft cap on successful MiniMax media calls (OC_MINIMAX_MEDIA_WINDOW_MAX_CALLS). */
export async function checkMediaWindowCap(pool: Pool, maxCalls: number | undefined): Promise<void> {
  if (!maxCalls || maxCalls <= 0) return
  const r = await pool.query<{ n: string; oldest: Date | null }>(
    `SELECT COUNT(*)::text AS n, MIN(created_at) AS oldest FROM minimax_media_usage_records
      WHERE status='success' AND created_at > NOW() - INTERVAL '5 hours'`,
  )
  const n = Number(r.rows[0]?.n ?? '0')
  if (n < maxCalls) return
  const oldest = r.rows[0]?.oldest
  const retryAfterSec = oldest
    ? Math.max(60, Math.ceil((oldest.getTime() + 5 * 3600_000 - Date.now()) / 1000))
    : 3600
  const err = new HttpError(
    429,
    'MINIMAX_QUOTA_WINDOW',
    `minimax media window is full; retry in ${retryAfterSec}s`,
  )
  ;(err as HttpError & { retryAfterSec?: number }).retryAfterSec = retryAfterSec
  throw err
}

export interface MiniMaxClientDeps {
  pool: Pool
  key?: string
  fetchImpl?: typeof fetch
  voices: SystemVoiceCache
  windowCap?: number
}

function requireKey(deps: MiniMaxClientDeps): string {
  if (!deps.key)
    throw new HttpError(503, 'MINIMAX_NOT_CONFIGURED', 'minimax upstream not configured')
  return deps.key
}

export type Settled = Awaited<ReturnType<typeof settleMiniMaxMediaSuccess>>

export interface VoiceSetting {
  speed?: number
  vol?: number
  pitch?: number
  emotion?: SpeechEmotion
}

export function sanitizeVoiceSetting(raw: unknown): VoiceSetting {
  if (raw === undefined || raw === null) return {}
  if (!isObj(raw)) throw new HttpError(400, 'BAD_BODY', 'voice_setting must be an object')
  const out: VoiceSetting = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'voice_id') continue // the validated voice always wins
    if (k === 'speed' && typeof v === 'number' && v >= 0.5 && v <= 2) out.speed = v
    else if (k === 'vol' && typeof v === 'number' && v > 0 && v <= 10) out.vol = v
    else if (k === 'pitch' && Number.isInteger(v) && (v as number) >= -12 && (v as number) <= 12)
      out.pitch = v as number
    else if (
      k === 'emotion' &&
      typeof v === 'string' &&
      (SPEECH_EMOTIONS as readonly string[]).includes(v)
    )
      out.emotion = v as SpeechEmotion
    else throw new HttpError(400, 'BAD_BODY', `unsupported voice_setting.${k}`)
  }
  return out
}

/**
 * Text to speech with a validated voice. `extra` may tune upstream options but
 * can never swap the voice: `voice_setting` is sanitised and pinned to the
 * checked voice_id, and voice mixing (`timber_weights`) is rejected because it
 * names further voices.
 */
export async function synthesizeSpeech(
  deps: MiniMaxClientDeps,
  args: {
    userId: bigint
    containerId: bigint | null
    requestId: string
    model: SpeechModel
    text: string
    voiceId: string
    format: AudioFormat
    voiceSetting?: unknown
    extra?: Record<string, unknown>
    /**
     * OCV5-591 A2-0: never charge more than this (the studio task's budget reservation). The
     * upstream bills by its own character count, so the cap is enforced before settlement and the
     * platform absorbs any excess. Container calls leave it unset (unchanged behaviour).
     */
    costCap?: bigint
  },
): Promise<{
  audio: Buffer
  format: AudioFormat
  usageCharacters: number | null
  settled: Settled
}> {
  const key = requireKey(deps)
  if (args.extra && 'timber_weights' in args.extra) {
    throw new HttpError(400, 'BAD_BODY', 'timber_weights is not supported')
  }
  const { voice_setting: extraVoiceSetting, ...extraRest } = args.extra ?? {}
  const voiceSetting = sanitizeVoiceSetting(args.voiceSetting ?? extraVoiceSetting)
  const access = await checkVoiceAccess(deps.pool, deps.voices, args.userId, args.voiceId)
  if (!access.ok)
    throw new HttpError(403, 'MINIMAX_VOICE_FORBIDDEN', 'voice is not available to this user')
  const plannedCost = calculateMiniMaxSpeechCost({ model: args.model, text: args.text })
  await ensureSufficientBalance(deps.pool, args.userId, plannedCost)
  await checkMediaWindowCap(deps.pool, deps.windowCap)
  const json = await postJson(deps.fetchImpl ?? fetch, key, '/v1/t2a_v2', {
    model: args.model,
    text: args.text,
    stream: false,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: args.format, channel: 1 },
    subtitle_enable: false,
    ...extraRest,
    voice_setting: { speed: 1, vol: 1, pitch: 0, ...voiceSetting, voice_id: args.voiceId },
  })
  const audioHex =
    isObj(json) && isObj(json.data) && typeof json.data.audio === 'string' ? json.data.audio : null
  if (!audioHex) throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned no audio')
  const usageCharacters =
    isObj(json) && isObj(json.extra_info) && typeof json.extra_info.usage_characters === 'number'
      ? json.extra_info.usage_characters
      : null
  const priced = calculateMiniMaxSpeechCost({
    model: args.model,
    text: args.text,
    usageCharacters: usageCharacters ?? undefined,
  })
  const cost =
    args.costCap !== undefined && priced.costCredits > args.costCap
      ? {
          ...priced,
          costCredits: args.costCap,
          snapshot: {
            ...priced.snapshot,
            cost_credits: args.costCap.toString(),
            notes: `capped from ${priced.costCredits} at the studio budget reservation`,
          },
        }
      : priced
  const audio = hexToBuffer(audioHex)
  const settled = await settleMiniMaxMediaSuccess(deps.pool, {
    userId: args.userId,
    containerId: args.containerId,
    requestId: args.requestId,
    cost,
    upstreamTraceId: traceId(json),
    outputMeta: {
      format: args.format,
      usage_characters: usageCharacters,
      voice_owned: access.owned,
    },
  })
  if (access.owned) await touchOwnedVoice(deps.pool, args.userId, args.voiceId).catch(() => {})
  return { audio, format: args.format, usageCharacters, settled }
}

function voiceCostWithPreview(
  operation: 'voice_design' | 'voice_clone',
  previewChars: number | null,
): MiniMaxMediaCostResult {
  const base = calculateMiniMaxVoiceDesignCost({ operation })
  if (!previewChars) return base
  const preview = calculateMiniMaxSpeechCost({
    model: 'speech-2.8-turbo',
    usageCharacters: previewChars,
  })
  const costCredits = base.costCredits + preview.costCredits
  return {
    ...base,
    units: {
      ...base.units,
      preview_characters: previewChars,
      preview_cost_credits: preview.costCredits.toString(),
    },
    costCredits,
    snapshot: {
      ...base.snapshot,
      cost_credits: costCredits.toString(),
      notes: `${base.snapshot.notes ?? ''} Includes preview synthesis.`.trim(),
    },
  }
}

function sha256Hex(...parts: Array<string | Buffer>): string {
  const h = createHash('sha256')
  for (const p of parts) {
    h.update(p)
    h.update('\0')
  }
  return h.digest('hex')
}

/**
 * Run one idempotent voice creation: bind (user, requestId) → voice id first
 * (minimax_voices 'pending'), call upstream, settle, then activate. A replay of
 * an active request returns the original voice and the original settlement.
 */
async function createVoiceOnce<T extends { voiceId: string; settled: Settled }>(
  deps: MiniMaxClientDeps,
  args: {
    userId: bigint
    requestId: string
    kind: 'design' | 'clone'
    paramsSha256: string
    label: string
    prompt: string | null
    consent: Record<string, unknown> | null
    plannedCost: MiniMaxMediaCostResult
  },
  run: (voiceId: string) => Promise<{
    cost: MiniMaxMediaCostResult
    traceId: string | null
    fileId?: string | null
    extra: Omit<T, 'voiceId' | 'settled'>
  }>,
  replayExtra: Omit<T, 'voiceId' | 'settled'>,
): Promise<T> {
  const begun = await beginVoiceCreation(deps.pool, {
    userId: args.userId,
    requestId: args.requestId,
    paramsSha256: args.paramsSha256,
    kind: args.kind,
    label: args.label,
    prompt: args.prompt,
    consent: args.consent,
  })
  if (begun.state === 'done') {
    const settled = await settleMiniMaxMediaSuccess(deps.pool, {
      userId: args.userId,
      containerId: null,
      requestId: voiceSettleRequestId(args.kind, args.requestId),
      cost: args.plannedCost,
      outputMeta: { voice_id: begun.voiceId },
    })
    return { ...replayExtra, voiceId: begun.voiceId, settled } as T
  }
  const voiceId = begun.voiceId
  let result: Awaited<ReturnType<typeof run>>
  try {
    await ensureSufficientBalance(deps.pool, args.userId, args.plannedCost)
    await checkMediaWindowCap(deps.pool, deps.windowCap)
    result = await run(voiceId)
  } catch (err) {
    await failVoiceCreation(deps.pool, {
      userId: args.userId,
      requestId: args.requestId,
      voiceId,
    }).catch(() => {})
    throw err
  }
  const settled = await settleMiniMaxMediaSuccess(deps.pool, {
    userId: args.userId,
    containerId: null,
    requestId: voiceSettleRequestId(args.kind, args.requestId),
    cost: result.cost,
    upstreamTraceId: result.traceId,
    upstreamFileId: result.fileId ?? null,
    outputMeta: { voice_id: voiceId },
  })
  await completeVoiceCreation(deps.pool, {
    userId: args.userId,
    requestId: args.requestId,
    voiceId,
    usageId: settled.usageId,
  })
  return { ...result.extra, voiceId, settled } as T
}

export async function designVoice(
  deps: MiniMaxClientDeps,
  args: { userId: bigint; requestId: string; prompt: string; previewText: string; label?: string },
): Promise<{ voiceId: string; trialAudio: Buffer | null; settled: Settled }> {
  const key = requireKey(deps)
  if (!args.prompt.trim() || args.prompt.length > 2000)
    throw new HttpError(400, 'BAD_BODY', 'prompt must be 1..2000 chars')
  if (!args.previewText.trim() || args.previewText.length > 500)
    throw new HttpError(400, 'BAD_BODY', 'preview_text must be 1..500 chars')
  const planned = voiceCostWithPreview('voice_design', countPreviewChars(args.previewText))
  return await createVoiceOnce<{ voiceId: string; trialAudio: Buffer | null; settled: Settled }>(
    deps,
    {
      userId: args.userId,
      requestId: args.requestId,
      kind: 'design',
      paramsSha256: sha256Hex('design', args.prompt, args.previewText),
      label: args.label ?? args.prompt.slice(0, 60),
      prompt: args.prompt,
      consent: null,
      plannedCost: planned,
    },
    async (voiceId) => {
      const json = await postJson(deps.fetchImpl ?? fetch, key, '/v1/voice_design', {
        prompt: args.prompt,
        preview_text: args.previewText,
        voice_id: voiceId,
      })
      const returned = isObj(json) && typeof json.voice_id === 'string' ? json.voice_id : null
      if (returned !== voiceId)
        throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned an unexpected voice_id')
      const trialHex = isObj(json) && typeof json.trial_audio === 'string' ? json.trial_audio : null
      const trialAudio = trialHex ? hexToBuffer(trialHex) : null
      return {
        cost: voiceCostWithPreview(
          'voice_design',
          trialAudio ? countPreviewChars(args.previewText) : null,
        ),
        traceId: traceId(json),
        extra: { trialAudio },
      }
    },
    { trialAudio: null },
  )
}

function countPreviewChars(text: string): number {
  let total = 0
  for (const ch of text) total += /\p{Script=Han}/u.test(ch) ? 2 : 1
  return Math.max(1, total)
}

export interface CloneConsent {
  statement: 'self_or_authorized'
  acceptedAt: string
}

export function parseCloneConsent(raw: unknown): CloneConsent {
  if (
    !isObj(raw) ||
    raw.statement !== 'self_or_authorized' ||
    typeof raw.acceptedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.acceptedAt))
  ) {
    throw new HttpError(
      400,
      'CLONE_CONSENT_REQUIRED',
      'voice cloning requires the self_or_authorized consent statement',
    )
  }
  return { statement: 'self_or_authorized', acceptedAt: new Date(raw.acceptedAt).toISOString() }
}

export function sniffCloneSampleMime(
  sample: Buffer,
): 'audio/mpeg' | 'audio/wav' | 'audio/mp4' | null {
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString('latin1') === 'RIFF' &&
    sample.subarray(8, 12).toString('latin1') === 'WAVE'
  )
    return 'audio/wav'
  if (sample.length >= 3 && sample.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
  if (sample.length >= 2 && sample[0] === 0xff && (sample[1]! & 0xe0) === 0xe0) return 'audio/mpeg'
  if (sample.length >= 12 && sample.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4'
  return null
}

export async function cloneVoice(
  deps: MiniMaxClientDeps,
  args: {
    userId: bigint
    requestId: string
    sample: Buffer
    consent: unknown
    label: string
    previewText?: string
  },
): Promise<{ voiceId: string; demoAudioUrl: string | null; settled: Settled }> {
  const key = requireKey(deps)
  const consent = parseCloneConsent(args.consent)
  if (args.sample.length === 0 || args.sample.length > MAX_CLONE_SAMPLE_BYTES) {
    throw new HttpError(400, 'BAD_BODY', 'clone sample must be 1 byte..20 MB')
  }
  const mime = sniffCloneSampleMime(args.sample)
  if (!mime) throw new HttpError(400, 'BAD_BODY', 'clone sample must be mp3, m4a or wav')
  if (
    args.previewText !== undefined &&
    (args.previewText.length < 1 || args.previewText.length > 1000)
  ) {
    throw new HttpError(400, 'BAD_BODY', 'preview_text must be 1..1000 chars')
  }
  const planned = voiceCostWithPreview(
    'voice_clone',
    args.previewText ? countPreviewChars(args.previewText) : null,
  )
  const fetchFn = deps.fetchImpl ?? fetch
  return await createVoiceOnce<{ voiceId: string; demoAudioUrl: string | null; settled: Settled }>(
    deps,
    {
      userId: args.userId,
      requestId: args.requestId,
      kind: 'clone',
      paramsSha256: sha256Hex(
        'clone',
        createHash('sha256').update(args.sample).digest(),
        args.previewText ?? '',
        args.label,
      ),
      label: args.label,
      prompt: null,
      consent: { ...consent },
      plannedCost: planned,
    },
    async (voiceId) => {
      const ext = mime === 'audio/wav' ? 'wav' : mime === 'audio/mp4' ? 'm4a' : 'mp3'
      const form = new FormData()
      form.set('purpose', 'voice_clone')
      form.set('file', new Blob([new Uint8Array(args.sample)], { type: mime }), `sample.${ext}`)
      const uploaded = await postMultipart(fetchFn, key, '/v1/files/upload', form)
      const fileId =
        isObj(uploaded) &&
        isObj(uploaded.file) &&
        (typeof uploaded.file.file_id === 'number' || typeof uploaded.file.file_id === 'string')
          ? uploaded.file.file_id
          : null
      if (fileId === null)
        throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned no file_id')
      const json = await postJson(fetchFn, key, '/v1/voice_clone', {
        file_id: typeof fileId === 'string' ? Number(fileId) : fileId,
        voice_id: voiceId,
        need_noise_reduction: true,
        need_volume_normalization: true,
        ...(args.previewText ? { text: args.previewText, model: 'speech-2.8-turbo' } : {}),
      })
      // Official response: boolean input_sensitive + top-level input_sensitive_type (0 = normal).
      if (isCloneSampleRejected(json)) {
        throw new HttpError(
          422,
          'MINIMAX_CLONE_REJECTED',
          'the voice sample was rejected by content moderation',
        )
      }
      const demoAudioUrl =
        isObj(json) && typeof json.demo_audio === 'string' && json.demo_audio
          ? json.demo_audio
          : null
      const usageChars =
        isObj(json) &&
        isObj(json.extra_info) &&
        typeof json.extra_info.usage_characters === 'number'
          ? json.extra_info.usage_characters
          : null
      return {
        cost: voiceCostWithPreview(
          'voice_clone',
          args.previewText ? (usageChars ?? countPreviewChars(args.previewText)) : null,
        ),
        traceId: traceId(json),
        fileId: String(fileId),
        extra: { demoAudioUrl },
      }
    },
    { demoAudioUrl: null },
  )
}

export function isCloneSampleRejected(json: unknown): boolean {
  if (!isObj(json)) return false
  if (json.input_sensitive === true) return true
  const type = json.input_sensitive_type
  return typeof type === 'number' && type !== 0
}

export async function fetchSystemVoices(
  fetchFn: typeof fetch,
  key: string,
): Promise<SystemVoice[]> {
  const json = await postJson(fetchFn, key, '/v1/get_voice', { voice_type: 'system' })
  const list = isObj(json) && Array.isArray(json.system_voice) ? json.system_voice : []
  const out: SystemVoice[] = []
  for (const item of list) {
    if (!isObj(item) || typeof item.voice_id !== 'string') continue
    out.push({
      voiceId: item.voice_id,
      voiceName: typeof item.voice_name === 'string' ? item.voice_name : item.voice_id,
      description: Array.isArray(item.description)
        ? item.description.filter((d): d is string => typeof d === 'string')
        : [],
    })
  }
  if (out.length === 0)
    throw new HttpError(502, 'MINIMAX_BAD_RESPONSE', 'minimax returned no system voices')
  return out
}
