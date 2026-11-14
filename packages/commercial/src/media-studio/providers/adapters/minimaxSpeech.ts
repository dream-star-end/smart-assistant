// MiniMax voice through the OCV5-589 client: TTS (voice access check, balance pre-check, pro-rata
// per-character settlement capped at the reservation), voice design and voice clone (990 credits a
// voice plus the preview characters, ownership recorded, clone consent required). User decision
// 2026-10-23 13:03: all three make real calls. The MiniMax plan / account must allow design and
// clone; when it does not, the upstream refusal is reported as a clear, non-retryable code.

import { HttpError } from '../../../http/util.js'
import { miniMaxDebitedCredits } from '../../../minimax/mediaBilling.js'
import {
  type SpeechModel,
  cloneVoice,
  designVoice,
  fetchSystemVoices,
  synthesizeSpeech,
} from '../../../minimax/mediaClient.js'
import {
  calculateMiniMaxSpeechCost,
  calculateMiniMaxVoiceDesignCost,
} from '../../../minimax/mediaPricing.js'
import { SystemVoiceCache, voiceSettleRequestId } from '../../../minimax/voices.js'
import { ledgerDebited } from '../charges.js'
import type { AdapterFactory } from '../registry.js'
import {
  MediaProviderError,
  type MediaRequest,
  type MediaResult,
  type MediaRunContext,
  type ModelInfo,
} from '../types.js'
import type { BuiltinAdapterDeps } from './deps.js'

/**
 * Upper bound on MiniMax's billed characters: CJK counts 2 and everything else 1 (10-23 live test:
 * 14 CJK chars billed 26, local count 26), so every code point at 2 plus slack for markers.
 */
export function speechCharBound(text: string): number {
  return 2 * [...text].length + 16
}

const MODELS: ModelInfo[] = [
  { id: 'speech-2.8-turbo', label: 'Speech 2.8 Turbo', ops: ['voice.tts'], isDefault: true },
  { id: 'speech-2.8-hd', label: 'Speech 2.8 HD', ops: ['voice.tts'] },
  { id: 'voice-design', label: '声音设计', ops: ['voice.design'], isDefault: true },
  { id: 'voice-clone', label: '快速复刻', ops: ['voice.clone'], isDefault: true },
]

/**
 * User 2026-10-24 05:02: voice design / clone (MiniMax paid features) are reserved, not wired up —
 * off unless OC_STUDIO_VOICE_CUSTOM=on. Off, the provider lists only text-to-speech (system voices
 * are untouched) and design / clone requests are refused; the web shows the entries as 即将开放.
 */
export function voiceCustomOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OC_STUDIO_VOICE_CUSTOM ?? '').trim().toLowerCase() === 'on'
}

const listedModels = (): ModelInfo[] =>
  voiceCustomOn() ? MODELS : MODELS.filter((m) => m.ops.every((op) => op === 'voice.tts'))

/** MiniMax refusals that mean "not in this plan / not enabled for this account" (10-23 live test). */
export function voiceRefusal(err: HttpError): MediaProviderError | null {
  const m = err.message.toLowerCase()
  if (m.includes('not support model') && m.includes('voice_design'))
    return new MediaProviderError(
      'MINIMAX_PLAN_NO_VOICE_DESIGN',
      false,
      '当前 MiniMax 套餐不包含声音设计',
    )
  if (m.includes('voice clone') && m.includes('forbidden'))
    return new MediaProviderError(
      'MINIMAX_CLONE_NOT_ENABLED',
      false,
      'MiniMax 账号还没有开通声音克隆',
    )
  return null
}

const MAX_PREVIEW_AUDIO_BYTES = 10 * 1024 * 1024

export const minimaxSpeechAdapter: AdapterFactory<BuiltinAdapterDeps> = {
  adapter: 'minimax-speech',
  kind: 'voice',
  label: 'MiniMax 语音',
  models: listedModels,
  defaultKey(deps) {
    const k = deps.minimax?.mediaKey
    if (k?.key) return { key: k.key }
    return { missing: k?.error ? 'KEY_UNREADABLE' : 'MISSING_KEY' }
  },
  create({ deps, key }) {
    const mm = deps.minimax
    const client = mm?.client
    const speech = mm?.speech ?? synthesizeSpeech
    const fetchVoices = mm?.fetchVoices ?? ((k: string) => fetchSystemVoices(fetch, k))
    const debitedFor =
      mm?.debitedFor ?? ((usageId: bigint) => miniMaxDebitedCredits(client!.pool, usageId))
    // System voices are listed with this provider's own key (keyFile / keyEnv / default), code r1 P1.
    const voices = new SystemVoiceCache(async () => {
      if (!key) throw new Error('minimax media key missing')
      return await fetchVoices(key)
    })
    const design = mm?.design ?? designVoice
    const clone = mm?.clone ?? cloneVoice
    const fetchPreview =
      mm?.fetchPreview ??
      (async (url: string) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) return null
        const buf = Buffer.from(await res.arrayBuffer())
        return buf.length > 0 && buf.length <= MAX_PREVIEW_AUDIO_BYTES ? buf : null
      })
    /** Design or clone one voice; the preview audio (when there is one) becomes the take's blob. */
    const createVoice = async (
      ctx: MediaRunContext,
      req: MediaRequest,
    ): Promise<Omit<MediaResult, 'overReservation'>> => {
      if (!client)
        throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'MiniMax is not enabled')
      if (!voiceCustomOn())
        throw new MediaProviderError(
          'VOICE_CUSTOM_OFF',
          false,
          'voice design and clone are not open yet',
        )
      const label =
        (req.label ?? '').trim().slice(0, 60) ||
        (req.op === 'voice.design' ? '设计音色' : '复刻音色')
      if (req.op === 'voice.design') {
        if (!req.prompt || !req.text)
          throw new MediaProviderError(
            'INVALID_REQUEST',
            false,
            'voice.design needs a description and a preview line',
          )
        const out = await design(
          { ...client, key, voices },
          {
            userId: ctx.userId,
            requestId: ctx.execRequestId,
            prompt: req.prompt,
            previewText: req.text,
            label,
          },
        )
        const s = out.settled
        return {
          outputs: out.trialAudio ? [{ bytes: out.trialAudio, mime: 'audio/mpeg' }] : [],
          model: 'voice-design',
          costCredits: s.replayed ? await debitedFor(s.usageId) : (s.debitedCredits ?? 0n),
          charged: !s.replayed,
          providerRef: {
            table: 'minimax_media_usage_records',
            id: voiceSettleRequestId('design', ctx.execRequestId),
          },
          meta: { voiceId: out.voiceId },
        }
      }
      const source = (req.inputs ?? []).find((i) => i.role === 'source')
      if (!source)
        throw new MediaProviderError(
          'INVALID_REQUEST',
          false,
          'voice.clone needs an uploaded sample',
        )
      if (!req.consent)
        throw new MediaProviderError(
          'CLONE_CONSENT_REQUIRED',
          false,
          'voice cloning needs the consent statement',
        )
      const sample = await ctx.readInput(source.blobSha)
      const out = await clone(
        { ...client, key, voices },
        {
          userId: ctx.userId,
          requestId: ctx.execRequestId,
          sample,
          consent: req.consent,
          label,
          ...(req.text ? { previewText: req.text } : {}),
        },
      )
      const s = out.settled
      const preview = out.demoAudioUrl
        ? await fetchPreview(out.demoAudioUrl).catch(() => null)
        : null
      return {
        outputs: preview ? [{ bytes: preview, mime: 'audio/mpeg' }] : [],
        model: 'voice-clone',
        costCredits: s.replayed ? await debitedFor(s.usageId) : (s.debitedCredits ?? 0n),
        charged: !s.replayed,
        providerRef: {
          table: 'minimax_media_usage_records',
          id: voiceSettleRequestId('clone', ctx.execRequestId),
        },
        meta: { voiceId: out.voiceId },
      }
    }
    return {
      status: () => (client ? null : { state: 'disabled', reason: 'FEATURE_OFF' }),
      async chargedFor(userId, execRequestId) {
        const pool = deps.pool ?? client?.pool
        if (!pool) return 0n
        const rows = await pool.query<{ id: string }>(
          'SELECT id::text AS id FROM minimax_media_usage_records WHERE user_id = $1 AND request_id = $2',
          [userId.toString(), `voice:tts:${execRequestId}`],
        )
        const created = await pool.query<{ id: string }>(
          'SELECT id::text AS id FROM minimax_media_usage_records WHERE user_id = $1 AND request_id = ANY($2::text[])',
          [
            userId.toString(),
            [
              voiceSettleRequestId('design', execRequestId),
              voiceSettleRequestId('clone', execRequestId),
            ],
          ],
        )
        return ledgerDebited(pool, 'minimax_media_usage_record', [
          ...rows.rows.map((r) => r.id),
          ...created.rows.map((r) => r.id),
        ])
      },
      estimateMaxCost: (req, model) =>
        req.op === 'voice.design' || req.op === 'voice.clone'
          ? calculateMiniMaxVoiceDesignCost({
              operation: req.op === 'voice.design' ? 'voice_design' : 'voice_clone',
            }).costCredits +
            calculateMiniMaxSpeechCost({
              model: 'speech-2.8-turbo',
              usageCharacters: speechCharBound(req.text ?? ''),
            }).costCredits
          : calculateMiniMaxSpeechCost({
              model: model.id,
              usageCharacters: speechCharBound(req.text ?? ''),
            }).costCredits,
      async run(ctx, req, model) {
        if (!client)
          throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'MiniMax is not enabled')
        if (req.op === 'voice.design' || req.op === 'voice.clone') {
          try {
            return await createVoice(ctx, req)
          } catch (err) {
            if (err instanceof HttpError) {
              throw (
                voiceRefusal(err) ??
                new MediaProviderError(err.code, err.status === 429, err.message)
              )
            }
            throw err
          }
        }
        if (req.op !== 'voice.tts') {
          throw new MediaProviderError('UNSUPPORTED_OP', false, `${req.op} is not available`)
        }
        if (!req.text || !req.voiceId) {
          throw new MediaProviderError('INVALID_REQUEST', false, 'voice.tts needs text and voiceId')
        }
        try {
          const out = await speech(
            { ...client, key, voices },
            {
              userId: ctx.userId,
              containerId: null,
              requestId: `voice:tts:${ctx.execRequestId}`,
              model: model.id as SpeechModel,
              text: req.text,
              voiceId: req.voiceId,
              format: 'mp3',
              // The reservation is a hard cap: settle never exceeds it (A2-0 plan r2 P1).
              costCap: ctx.maxCostCredits,
            },
          )
          const s = out.settled
          // What was actually debited (code r1 P1): a clamped settle debits less than the price,
          // and a replay carries no debit of its own, so the original is read from the ledger.
          const cost = s.replayed ? await debitedFor(s.usageId) : (s.debitedCredits ?? 0n)
          return {
            outputs: [
              {
                bytes: out.audio,
                mime: 'audio/mpeg',
                ...(out.audioMs !== null ? { durationMs: out.audioMs } : {}),
              },
            ],
            model: model.id,
            costCredits: cost,
            charged: !s.replayed && cost > 0n,
            providerRef: {
              table: 'minimax_media_usage_records',
              id: `voice:tts:${ctx.execRequestId}`,
            },
            meta: { usageCharacters: out.usageCharacters },
          }
        } catch (err) {
          if (err instanceof HttpError) {
            const retryable = err.status === 429 || err.code === 'MINIMAX_UPSTREAM_ERROR'
            throw new MediaProviderError(err.code, retryable, err.message)
          }
          throw err
        }
      },
    }
  },
}
