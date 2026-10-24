// Muse image / video through the in-process bridge hub. Submission is idempotent: the job id is
// derived from the execution id, so a re-leased task finds its original job (A1 plan §3).

import { createHash } from 'node:crypto'

import type { MuseJobSpec } from '../../../muse/protocol.js'
import type { AdapterFactory, AdapterImpl } from '../registry.js'
import { type MediaKind, MediaProviderError, type ModelInfo } from '../types.js'
import type { BuiltinAdapterDeps } from './deps.js'

/** RFC 4122 v5 (SHA-1, name-based) uuid. */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest()
  h[6] = (h[6]! & 0x0f) | 0x50
  h[8] = (h[8]! & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

const STUDIO_MUSE_NAMESPACE = '6f1d2c4e-8a35-4b7e-9c10-3d5e7f9a1b2c'
export const museJobIdFor = (execRequestId: string) =>
  `mj_${uuidV5(execRequestId, STUDIO_MUSE_NAMESPACE)}`

const WAIT_SLICE_MS = 25_000
const ORIENTATION = { '16:9': 'landscape', '9:16': 'vertical', '1:1': 'square' } as const

function museImpl(kind: 'image' | 'video', deps: BuiltinAdapterDeps): AdapterImpl {
  const muse = deps.muse
  return {
    status(user) {
      if (!muse) return { state: 'disabled', reason: 'FEATURE_OFF' }
      if (user && !muse.hub.isAllowed(user.id))
        return { state: 'disabled', reason: 'NOT_ALLOWED_FOR_USER' }
      return muse.hub.bridgeOnline() ? null : { state: 'offline', reason: 'BRIDGE_OFFLINE' }
    },
    estimateMaxCost: () => (muse ? muse.prices[kind] : 0n),
    affinity: () => 'muse',
    async run(ctx, req) {
      if (!muse) throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'Muse is not enabled')
      const uid = String(ctx.userId)
      const sources = (req.inputs ?? []).filter((i) => i.role !== 'last_frame')
      const spec: MuseJobSpec = {
        kind,
        prompt: req.prompt ?? '',
        ...(req.aspect ? { orientation: ORIENTATION[req.aspect] } : {}),
        ...(sources.length
          ? {
              source_images: (await Promise.all(sources.map((i) => ctx.readInput(i.blobSha)))).map(
                (b) => b.toString('base64'),
              ),
            }
          : {}),
        ...(req.op === 'video.extend' && req.resumeSnapshotId
          ? { resume_snapshot_id: req.resumeSnapshotId }
          : {}),
      }
      if (req.op === 'video.extend' && !req.resumeSnapshotId) {
        throw new MediaProviderError('INVALID_REQUEST', false, 'video.extend needs a snapshot')
      }
      const jobId = museJobIdFor(ctx.execRequestId)
      try {
        await muse.hub.submit(uid, null, spec, { jobId })
      } catch (err) {
        const e = err as { code?: string; retryable?: boolean; message?: string }
        throw new MediaProviderError(
          e.code ?? 'MUSE_SUBMIT_FAILED',
          e.retryable === true,
          e.message ?? 'submit failed',
        )
      }
      for (;;) {
        if (ctx.signal.aborted) throw new MediaProviderError('ABORTED', false, 'aborted')
        const view = await muse.hub.view(uid, jobId, WAIT_SLICE_MS)
        if (!view) throw new MediaProviderError('MUSE_JOB_LOST', false, 'muse job not found')
        if (view.status === 'queued' || view.status === 'running') continue
        if (view.status !== 'succeeded') {
          throw new MediaProviderError(
            view.error?.code ?? 'MUSE_FAILED',
            view.error?.retryable === true,
            view.error?.message ?? `muse job ${view.status}`,
          )
        }
        const outputs = []
        for (const f of view.files ?? []) {
          const found = await muse.hub.fileFor(uid, jobId, f.idx)
          if (!found)
            throw new MediaProviderError('MUSE_FILE_MISSING', false, 'muse output missing')
          outputs.push({ bytes: await muse.readFile(found.path), mime: found.file.mime })
        }
        if (outputs.length === 0)
          throw new MediaProviderError('MUSE_NO_OUTPUT', false, 'muse returned no files')
        const charged = view.charged_credits !== undefined ? BigInt(view.charged_credits) : 0n
        return {
          outputs,
          model: kind === 'image' ? 'muse-image' : 'muse-video',
          costCredits: charged,
          charged: charged > 0n,
          providerRef: { table: 'muse_media_jobs', id: jobId },
          meta: view.snapshot_id ? { snapshotId: view.snapshot_id } : {},
        }
      }
    },
  }
}

function museFactory(kind: 'image' | 'video'): AdapterFactory<BuiltinAdapterDeps> {
  const models: ModelInfo[] =
    kind === 'image'
      ? [
          {
            id: 'muse-image',
            label: 'Muse 图片',
            ops: ['image.generate', 'image.edit'],
            isDefault: true,
          },
        ]
      : [
          {
            id: 'muse-video',
            label: 'Muse 视频',
            ops: ['video.from_image', 'video.from_text', 'video.extend'],
            isDefault: true,
          },
        ]
  return {
    adapter: `muse-${kind}`,
    kind: kind as MediaKind,
    label: 'Muse',
    models: () => models,
    create: ({ deps }) => museImpl(kind, deps),
  }
}

export const museImageAdapter = museFactory('image')
export const museVideoAdapter = museFactory('video')
