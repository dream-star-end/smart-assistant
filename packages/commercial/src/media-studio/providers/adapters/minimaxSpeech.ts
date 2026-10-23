// MiniMax TTS through the OCV5-589 client (voice access check, balance pre-check, pro-rata
// per-character settlement). voice.design / voice.clone are declared for the UI but not wired:
// no real calls for them yet (user decision 2026-10-23 09:44).

import { HttpError } from '../../../http/util.js'
import { type SpeechModel, synthesizeSpeech } from '../../../minimax/mediaClient.js'
import { calculateMiniMaxSpeechCost } from '../../../minimax/mediaPricing.js'
import type { AdapterFactory } from '../registry.js'
import { MediaProviderError, type ModelInfo } from '../types.js'
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
]

export const minimaxSpeechAdapter: AdapterFactory<BuiltinAdapterDeps> = {
  adapter: 'minimax-speech',
  kind: 'voice',
  label: 'MiniMax 语音',
  models: () => MODELS,
  defaultKey(deps) {
    const k = deps.minimax?.mediaKey
    if (k?.key) return { key: k.key }
    return { missing: k?.error ? 'KEY_UNREADABLE' : 'MISSING_KEY' }
  },
  create({ deps, key }) {
    const client = deps.minimax?.client
    return {
      status: () => (client ? null : { state: 'disabled', reason: 'FEATURE_OFF' }),
      estimateMaxCost: (req, model) =>
        calculateMiniMaxSpeechCost({
          model: model.id,
          usageCharacters: speechCharBound(req.text ?? ''),
        }).costCredits,
      async run(ctx, req, model) {
        if (!client)
          throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'MiniMax is not enabled')
        if (req.op !== 'voice.tts') {
          throw new MediaProviderError('UNSUPPORTED_OP', false, `${req.op} is not available yet`)
        }
        if (!req.text || !req.voiceId) {
          throw new MediaProviderError('INVALID_REQUEST', false, 'voice.tts needs text and voiceId')
        }
        try {
          const out = await synthesizeSpeech(
            { ...client, key },
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
          // A clamped debit (balance ran out mid-settle) charged less than the price.
          const cost = s.debitedCredits ?? s.costCredits
          return {
            outputs: [{ bytes: out.audio, mime: 'audio/mpeg' }],
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
