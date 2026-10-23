// GPT Image through the A0 server-side runner (billing/image2Run.ts): same journey, daily cap,
// completed-request replay and flat per-image price as container traffic.

import { Image2RunError } from '../../../billing/image2Run.js'
import { IMAGE2_UNIT_COST } from '../../../billing/imageBilling.js'
import type { AdapterFactory } from '../registry.js'
import { MediaProviderError, type ModelInfo } from '../types.js'
import type { BuiltinAdapterDeps } from './deps.js'

export function sniffImageMime(b: Buffer): string {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return 'application/octet-stream'
}

const SIZES = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' } as const

export const gptImageAdapter: AdapterFactory<BuiltinAdapterDeps> = {
  adapter: 'gpt-image',
  kind: 'image',
  label: 'GPT Image',
  models: (deps) => {
    const policy = deps.image2?.policy
    if (!policy) return []
    return [...policy.allowed].sort().map(
      (id): ModelInfo => ({
        id,
        label: id,
        ops: ['image.generate', 'image.edit'],
        isDefault: id === policy.editDefault,
      }),
    )
  },
  create({ deps }) {
    const image2 = deps.image2
    return {
      status: () => (image2?.enabled ? null : { state: 'disabled', reason: 'FEATURE_OFF' }),
      estimateMaxCost: () => IMAGE2_UNIT_COST,
      async run(ctx, req, model) {
        if (!image2?.enabled) {
          throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'Image 2 is not enabled')
        }
        const refs = (req.inputs ?? []).filter((i) => i.role === 'reference' || i.role === 'source')
        if (req.op === 'image.edit' && refs.length === 0) {
          throw new MediaProviderError('INVALID_REQUEST', false, 'image.edit needs a source image')
        }
        const referenceImages = await Promise.all(refs.map((i) => ctx.readInput(i.blobSha)))
        try {
          const out = await image2.run({
            userId: ctx.userId,
            requestKey: ctx.execRequestId,
            prompt: req.prompt ?? '',
            model: model.id,
            n: 1,
            ...(req.aspect ? { size: SIZES[req.aspect] } : {}),
            ...(referenceImages.length ? { referenceImages } : {}),
            signal: ctx.signal,
          })
          return {
            outputs: out.images.map((bytes) => ({ bytes, mime: sniffImageMime(bytes) })),
            model: out.model,
            costCredits: out.costCredits,
            charged: out.charged,
            providerRef: { table: 'image_generation_usage_records', id: out.requestId },
          }
        } catch (err) {
          if (err instanceof Image2RunError) {
            throw new MediaProviderError(err.code, err.retryable, err.message)
          }
          throw err
        }
      },
    }
  },
}
