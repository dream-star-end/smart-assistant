// OCV5-591 media studio — build the browser API deps and the GC tick from config (kept out of
// index.ts). Off unless OC_STUDIO_ENABLED=1; a failed start leaves the feature off instead of
// failing master boot.

import { mkdir } from 'node:fs/promises'
import type { Pool } from 'pg'

import type { CommercialConfig } from '../config.js'
import { rootLogger } from '../logging/logger.js'
import { studioAccess } from './access.js'
import { StudioBlobStore } from './blobs.js'
import { STUDIO_GC_INTERVAL_MS, runStudioGc } from './gc.js'
import type { StudioHttpDeps } from './http.js'
import { StudioStore } from './store.js'

export const STUDIO_DEFAULT_ROOT = '/var/lib/openclaude-v5/studio'

export async function createStudioFromConfig(
  cfg: CommercialConfig,
  pool: Pool,
): Promise<StudioHttpDeps | undefined> {
  const log = rootLogger.child({ subsys: 'mediaStudio' })
  const access = studioAccess(cfg, (msg, meta) => log.warn(msg, meta))
  if (!access.enabled) return undefined
  const root = cfg.OC_STUDIO_ROOT ?? STUDIO_DEFAULT_ROOT
  try {
    await mkdir(root, { recursive: true, mode: 0o750 })
  } catch (err) {
    log.error('studio_root_unavailable', { err: err as Error })
    return undefined
  }
  const blobs = new StudioBlobStore({ pool, root })
  const timer = setInterval(() => {
    void runStudioGc({ pool, blobs })
      .then((out) => {
        if (out.projects + out.takes + out.blobs > 0) log.info('studio_gc', out)
      })
      .catch((err) => log.warn('studio_gc_failed', { err: err as Error }))
  }, STUDIO_GC_INTERVAL_MS)
  timer.unref?.()
  return { access, store: new StudioStore(pool), blobs }
}
